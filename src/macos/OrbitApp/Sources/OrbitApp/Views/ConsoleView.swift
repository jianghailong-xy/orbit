import SwiftUI
import OrbitKit

/// Read-only console for one session (Phase 1): opens the live SSE stream and renders the
/// reduced transcript. No composer yet — that's Phase 2.
struct ConsoleView: View {
    let sessionID: String
    let baseURL: URL
    let tokenStore: TokenStore
    @State private var console: ConsoleModel?

    var body: some View {
        Group {
            if let console {
                VStack(spacing: 0) {
                    WorktreeBar(console: console)
                    Divider()
                    TranscriptView(state: console.state, connected: console.connected)
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
        .task {
            let c = ConsoleModel(sessionID: sessionID, baseURL: baseURL, tokenStore: tokenStore)
            console = c
            await c.run()   // lives until this view's .task is cancelled (selection change / disappear)
        }
    }
}

struct TranscriptView: View {
    let state: TranscriptState
    let connected: Bool
    private let bottomAnchor = "bottom-anchor"

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(state.items) { TranscriptItemView(item: $0) }
                    Color.clear.frame(height: 1).id(bottomAnchor)
                }
                .padding()
            }
            .onChange(of: state.items.count) {
                withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo(bottomAnchor, anchor: .bottom) }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) { statusBar }
    }

    private var statusBar: some View {
        HStack(spacing: 8) {
            Circle().fill(connected ? .green : .orange).frame(width: 7, height: 7)
            Text(state.status.rawValue.replacingOccurrences(of: "_", with: " ").capitalized)
                .font(.caption).foregroundStyle(.secondary)
            Spacer()
            if !state.pendingApprovals.isEmpty {
                Label("\(state.pendingApprovals.count) pending", systemImage: "hand.raised.fill")
                    .font(.caption).foregroundStyle(.orange)
            }
            if !state.background.isEmpty {
                Label("\(state.background.count) background", systemImage: "gearshape.2")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(.bar)
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
    var body: some View {
        HStack {
            Spacer(minLength: 60)
            VStack(alignment: .trailing, spacing: 3) {
                Text(bubble.text).textSelection(.enabled)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(.tint.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
                if bubble.pending {
                    Text("Sending…").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
    }
}

struct AssistantBubbleView: View {
    let bubble: AssistantBubble
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 6) {
                markdownText(bubble.displayText).textSelection(.enabled)
                if !bubble.isFinalized { TypingDots() }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(.gray.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
            Spacer(minLength: 60)
        }
    }
}

struct ThinkingView: View {
    let block: ThinkingBlock
    @State private var expanded = false
    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            markdownText(block.displayText).font(.callout).foregroundStyle(.secondary)
                .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            Label("Thinking", systemImage: "brain").font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct ToolCardView: View {
    let card: ToolCard
    @State private var expanded = false
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: icon).foregroundStyle(statusColor)
                Text(card.name).font(.callout.bold())
                if let summary {
                    Text(summary).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                if card.status == .running { ProgressView().controlSize(.small) }
            }
            if let result = card.result, !result.isEmpty {
                DisclosureGroup("Output", isExpanded: $expanded) {
                    Text(result).font(.caption.monospaced()).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(10)
        .background(.gray.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }

    private var summary: String? {
        card.input["command"]?.stringValue
            ?? card.input["file_path"]?.stringValue
            ?? card.input["path"]?.stringValue
            ?? card.input["description"]?.stringValue
    }
    private var icon: String {
        switch card.status {
        case .running: return "hammer.fill"
        case .ok:      return "checkmark.seal.fill"
        case .error:   return "xmark.octagon.fill"
        }
    }
    private var statusColor: Color {
        switch card.status {
        case .running: return .secondary
        case .ok:      return .green
        case .error:   return .red
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

/// Inline-markdown rendering (bold/italic/code/links), preserving newlines. Phase 1 keeps it
/// simple; full block markdown + syntax-highlighted code fences is a Phase 2 polish item.
func markdownText(_ s: String) -> Text {
    if let attributed = try? AttributedString(
        markdown: s,
        options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    ) {
        return Text(attributed)
    }
    return Text(s)
}
