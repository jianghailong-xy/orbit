import SwiftUI
import OrbitKit

/// Console for one session: renders the reduced transcript (resumed from the local store) and the
/// interactive composer/approvals/worktree. The `ConsoleModel` is owned by `ConsoleRegistry`, not
/// this view, so switching sessions reuses a warm, cached console instead of rebuilding one.
struct ConsoleView: View {
    let sessionID: String
    var agentID: String? = nil
    let registry: ConsoleRegistry

    var body: some View {
        Group {
            if let console = registry.peek(sessionID) {
                VStack(spacing: 0) {
                    WorktreeBar(console: console)
                    Divider()
                    TranscriptView(console: console)
                    if let msg = console.statusMessage {
                        HStack {
                            Text(msg).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            Spacer()
                            Button { console.statusMessage = nil } label: { Image(systemName: "xmark") }
                                .buttonStyle(.plain).foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 12).padding(.vertical, 4)
                        .background(.bar)
                    }
                    BackgroundTrayView(procs: console.state.background)
                    ApprovalsView(console: console)
                    ComposerView(console: console)
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        // Restarts only when `sessionID` changes: cancels the previous session's stream (its state
        // stays cached) and resumes this one from its persisted `maxSeq` — no full replay.
        .task(id: sessionID) {
            await registry.model(for: sessionID, agentID: agentID).run()
        }
    }
}

struct TranscriptView: View {
    let console: ConsoleModel
    private let bottomAnchor = "bottom-anchor"

    // Maps the model's `nil` (= pinned to the bottom) to the bottom anchor's id and back. Because
    // the anchor lives in the per-session model and this view persists across session switches,
    // switching to a session you'd scrolled up in restores your place instead of yanking to the
    // bottom; the value is `nil` only while you're at the latest message, so live content still
    // follows there.
    private var anchorBinding: Binding<String?> {
        Binding(
            get: { console.scrollAnchorID ?? bottomAnchor },
            set: { console.scrollAnchorID = ($0 == bottomAnchor) ? nil : $0 }
        )
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(console.state.items) { TranscriptItemView(item: $0) }
                    Color.clear.frame(height: 1).id(bottomAnchor)
                }
                .scrollTargetLayout()
                .padding()
            }
            // macOS 15+: `scrollPosition` restores each session's saved anchor on switch and keeps
            // the bottom pinned (anchor: .bottom) as content streams — so already-read sessions are
            // not re-scrolled. macOS 14 lacks the `anchor:` overload, so it falls back to the
            // jump-to-bottom below (only while pinned).
            .transcriptScrollPosition(anchorBinding)
            .onChange(of: console.state.items.count) {
                if #available(macOS 15.0, *) { return }            // handled by scrollPosition above
                if console.scrollAnchorID == nil { proxy.scrollTo(bottomAnchor, anchor: .bottom) }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) { statusBar }
    }

    private var statusBar: some View {
        HStack(spacing: 8) {
            Circle().fill(console.connected ? .green : .orange).frame(width: 7, height: 7)
            Text(console.state.status.rawValue.replacingOccurrences(of: "_", with: " ").capitalized)
                .font(.caption).foregroundStyle(.secondary)
            Spacer()
            if !console.state.pendingApprovals.isEmpty {
                Label("\(console.state.pendingApprovals.count) pending", systemImage: "hand.raised.fill")
                    .font(.caption).foregroundStyle(.orange)
            }
            if !console.state.background.isEmpty {
                Label("\(console.state.background.count) background", systemImage: "gearshape.2")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(.bar)
    }
}

private extension View {
    /// Per-session bottom-anchored scroll position. Uses the `scrollPosition(id:anchor:)` overload,
    /// gated to macOS 15+ so it compiles against the macOS 14 floor; on 14 it's a no-op and the
    /// caller's `onChange` fallback keeps the bottom followed.
    @ViewBuilder func transcriptScrollPosition(_ id: Binding<String?>) -> some View {
        if #available(macOS 15.0, *) {
            self.scrollPosition(id: id, anchor: .bottom)
        } else {
            self
        }
    }
}

struct TranscriptItemView: View {
    let item: TranscriptItem
    var body: some View {
        switch item {
        case .user(let b):      UserBubbleView(bubble: b)
        case .assistant(let b): AssistantBubbleView(bubble: b)
        case .thinking(let b):  ThinkingView(block: b)
        case .toolCall(let c):  ToolCardView(card: c)
        case .interrupt:
            Label("Interrupted", systemImage: "stop.circle").font(.caption).foregroundStyle(.secondary)
        case .error(_, let message):
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.red).textSelection(.enabled)
        }
    }
}

struct UserBubbleView: View {
    let bubble: UserBubble
    @State private var expanded = false
    // Collapse a giant pasted bubble: one huge Text lays out synchronously and stalls the UI.
    private let truncateAt = 6000
    var body: some View {
        let long = bubble.text.count > truncateAt
        let shown = long && !expanded ? String(bubble.text.prefix(truncateAt)) : bubble.text
        HStack {
            Spacer(minLength: 60)
            VStack(alignment: .trailing, spacing: 3) {
                Text(shown).textSelection(.enabled)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(.tint.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
                if long {
                    Button(expanded ? "Show less" : "Show more") { expanded.toggle() }
                        .buttonStyle(.plain).font(.caption).foregroundStyle(.secondary)
                }
                if bubble.pending {
                    Text("Sending…").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
    }
}

struct AssistantBubbleView: View {
    let bubble: AssistantBubble
    // Assistant turns are long-form Markdown — render them as a full-width document on the window
    // background (no bubble), mirroring web's `.chat-assistant`. A tinted panel here would sit
    // gray-on-gray behind the code blocks' own surface and box long content into a narrow column;
    // only the short, conversational user turn keeps a bubble. Horizontal padding matches web's
    // `padding: 0 12px` and keeps the left edge aligned with the tool-card rail.
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            MarkdownView(source: bubble.displayText).textSelection(.enabled)
            if !bubble.isFinalized { TypingDots() }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
    }
}

struct ThinkingView: View {
    let block: ThinkingBlock
    @State private var expanded = false
    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            MarkdownView(source: block.displayText).font(.callout).foregroundStyle(.secondary)
                .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            Label("Thinking", systemImage: "brain").font(.caption).foregroundStyle(.secondary)
        }
    }
}

/// A tool call rendered to match the web transcript: a compact folded row (toned icon · name ·
/// abbreviated path/summary · line-range badge · status) that expands to a semantic body (a `$`
/// command, a red/green edit diff, a plan/prompt as prose, otherwise monospace output). The
/// name→display mapping lives in `OrbitKit.ToolDisplay` so it stays in step with web and testable.
struct ToolCardView: View {
    let card: ToolCard
    private let d: ToolDisplay
    @State private var expanded: Bool

    init(card: ToolCard) {
        self.card = card
        let display = ToolDisplay.describe(name: card.name, input: card.input, status: card.status, id: card.id)
        self.d = display
        let hasResult = (card.result?.isEmpty == false)
        _expanded = State(initialValue: display.autoOpen && (display.hasBody || hasResult))
    }

    private var hasResult: Bool { card.result?.isEmpty == false }
    private var hasDetail: Bool { d.hasBody || hasResult }
    private var isOpen: Bool { expanded && hasDetail }

    var body: some View {
        // Folded rows read as a flowing, rail-marked list; once expanded the card regains a
        // border + surface so its detail body stays visually grouped (mirrors web `.is-open`).
        VStack(alignment: .leading, spacing: 6) {
            row
            if isOpen { detail }
        }
        .padding(.leading, 11)
        .padding(.trailing, 10)
        .padding(.vertical, 6)
        .background(isOpen ? Color.gray.opacity(0.06) : Color.clear)
        .overlay(alignment: .leading) { Rectangle().fill(d.tone.color).frame(width: 3) }
        .clipShape(RoundedRectangle(cornerRadius: isOpen ? 8 : 0))
        .overlay {
            if isOpen { RoundedRectangle(cornerRadius: 8).stroke(Color.primary.opacity(0.12), lineWidth: 1) }
        }
    }

    private var row: some View {
        HStack(spacing: 7) {
            if hasDetail {
                Image(systemName: expanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 9, weight: .semibold)).foregroundStyle(.tertiary)
            }
            Image(systemName: d.symbol)
                .font(.system(size: 11)).foregroundStyle(d.tone.color)
                .frame(width: 20, height: 20)
                .background(d.tone.color.opacity(0.14), in: RoundedRectangle(cornerRadius: 5))
            Text(d.label)
                .font(.system(.caption, design: .monospaced).weight(.semibold))
                .foregroundStyle(.primary)
            summary
            if let meta = d.meta {
                Text(meta)
                    .font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Color.gray.opacity(0.14), in: RoundedRectangle(cornerRadius: 4))
            }
            Spacer(minLength: 4)
            status
        }
        .contentShape(Rectangle())
        .onTapGesture {
            guard hasDetail else { return }
            withAnimation(.easeOut(duration: 0.12)) { expanded.toggle() }
        }
    }

    @ViewBuilder private var summary: some View {
        if let p = d.path {
            (Text(p.base).fontWeight(.semibold).foregroundColor(.primary)
             + Text(p.dir.isEmpty ? "" : "  \(p.dir)").foregroundColor(.secondary))
                .font(.system(size: 11, design: .monospaced))
                .lineLimit(1).truncationMode(.middle)
        } else if let s = d.summary, !s.isEmpty {
            Text(s)
                .font(d.summaryMono ? .system(size: 11, design: .monospaced) : .caption)
                .foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
        }
    }

    @ViewBuilder private var status: some View {
        switch card.status {
        case .running: ProgressView().controlSize(.small)
        case .ok:      Image(systemName: "checkmark.circle.fill").font(.system(size: 12)).foregroundStyle(.green)
        case .error:   Image(systemName: "xmark.circle.fill").font(.system(size: 12)).foregroundStyle(.red)
        }
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: 8) {
            ToolBodyView(kind: d.body)
            if let result = card.result, !result.isEmpty {
                let isErr = card.status == .error
                // Mirrors web `.chat-result`: a tinted panel (red on error, neutral otherwise) with a
                // small uppercase label. The output text itself stays muted even on error (only the
                // panel + label carry the error colour) — matching web's muted `<Pre>`.
                VStack(alignment: .leading, spacing: 3) {
                    Text(isErr ? "ERROR" : "OUTPUT")
                        .font(.system(size: 9, weight: .semibold)).tracking(0.4)
                        .foregroundStyle(isErr ? Color.red : Color.secondary)
                    CollapsibleMono(text: result)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 9).padding(.vertical, 6)
                .background(isErr ? Color.red.opacity(0.10) : Color.secondary.opacity(0.08),
                            in: RoundedRectangle(cornerRadius: 6))
            }
        }
    }
}

private extension ToolTone {
    var color: Color {
        switch self {
        case .read:  return .blue
        case .exec:  return .teal
        case .write: return .orange
        case .agent: return .purple
        case .plain: return .secondary
        }
    }
}

/// The expandable detail under a tool row: a shell command, file content, a markdown plan/prompt,
/// or a red/green edit diff.
struct ToolBodyView: View {
    let kind: ToolBody
    var body: some View {
        switch kind {
        case .none:
            EmptyView()
        case .command(let cmd):
            (Text("$ ").foregroundColor(.blue).fontWeight(.semibold) + Text(cmd))
                .font(.system(size: 11.5, design: .monospaced)).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
                .overlay { RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.18), lineWidth: 1) }
        case .code(let code):
            CollapsibleMono(text: code)
        case .markdown(let md):
            MarkdownView(source: md)
                .font(.callout).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .diff(let hunks):
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(hunks.enumerated()), id: \.offset) { _, hunk in
                    DiffHunkView(lines: ToolDisplay.numbered(hunk))
                }
            }
        }
    }
}

struct DiffHunkView: View {
    let lines: [ToolDisplay.NumberedDiffLine]
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, nl in
                DiffLineView(nl: nl)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay { RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.2), lineWidth: 1) }
    }
}

struct DiffLineView: View {
    let nl: ToolDisplay.NumberedDiffLine
    private var line: DiffLine { nl.line }
    var body: some View {
        if line.kind == .gap {
            HStack(spacing: 0) {
                gutterText("")
                gutterText("")
                Text("⋯ \(line.gapCount) unchanged \(line.gapCount == 1 ? "line" : "lines") ⋯")
                    .font(.system(size: 10.5, design: .monospaced)).italic().foregroundStyle(.tertiary)
                    .padding(.leading, 6)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.secondary.opacity(0.06))
        } else {
            HStack(alignment: .top, spacing: 0) {
                gutter(nl.oldNumber)
                gutter(nl.newNumber)
                Text(sign).font(.system(size: 11, design: .monospaced)).foregroundStyle(fg)
                    .frame(width: 14, alignment: .center)
                Text(line.text.isEmpty ? " " : line.text)
                    .font(.system(size: 11, design: .monospaced)).foregroundStyle(fg)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.trailing, 6)
            }
            .padding(.vertical, 1)
            .background(bg)
        }
    }
    private func gutter(_ n: Int?) -> some View { gutterText(n.map(String.init) ?? "") }
    private func gutterText(_ s: String) -> some View {
        Text(s)
            .font(.system(size: 10, design: .monospaced)).foregroundStyle(.tertiary)
            .frame(width: 30, alignment: .trailing)
            .padding(.vertical, 1)
            .background(Color.secondary.opacity(0.06))
    }
    private var sign: String { line.kind == .add ? "+" : line.kind == .del ? "-" : " " }
    private var fg: Color { line.kind == .add ? .green : line.kind == .del ? .red : .secondary }
    private var bg: Color { line.kind == .add ? Color.green.opacity(0.12) : line.kind == .del ? Color.red.opacity(0.12) : .clear }
}

/// Monospace text that collapses past a line threshold (Read/Bash output, file content) so one
/// tool call can't flood the transcript — mirrors web's `Pre`.
struct CollapsibleMono: View {
    let text: String
    @State private var open = false
    private let threshold = 16
    var body: some View {
        let lines = text.components(separatedBy: "\n")
        let hidden = max(0, lines.count - threshold)
        let shown = (open || hidden == 0) ? text : lines.prefix(threshold).joined(separator: "\n")
        VStack(alignment: .leading, spacing: 4) {
            Text(shown)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Color.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            if hidden > 0 {
                Button(open ? "Show less" : "Show \(hidden) more lines") { open.toggle() }
                    .buttonStyle(.plain).font(.caption2).foregroundStyle(.blue)
            }
        }
    }
}

struct TypingDots: View {
    @State private var animating = false
    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<3) { i in
                Circle().frame(width: 5, height: 5)
                    .opacity(animating ? 1 : 0.3)
                    .animation(.easeInOut(duration: 0.6).repeatForever().delay(Double(i) * 0.2), value: animating)
            }
        }
        .foregroundStyle(.secondary)
        .onAppear { animating = true }
    }
}
