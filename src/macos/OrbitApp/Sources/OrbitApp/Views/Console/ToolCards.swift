import SwiftUI
import Foundation
import OrbitKit

// The transcript's tool-call rendering: the folded/expandable card row, its semantic body (command /
// code / markdown / diff), the red-green diff line views, and the collapsing monospace block. The
// name→display mapping lives in `OrbitKit.ToolDisplay` so it stays in step with web and testable.
// Split out of ConsoleView.swift.

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
        let hasResult = (card.result?.isEmpty == false) || !card.resultImages.isEmpty
        _expanded = State(initialValue: display.autoOpen && (display.hasBody || hasResult))
    }

    private var hasResult: Bool { card.result?.isEmpty == false || !card.resultImages.isEmpty }
    private var hasDetail: Bool { d.hasBody || hasResult }
    private var isOpen: Bool { expanded && hasDetail }

    /// A successful `mcp__orbit__session_create` whose JSON result parsed — rendered as a tappable
    /// "jump to child session" card instead of the folded JSON (web parity: SessionCreateCard).
    private var sessionCreate: SessionCreatePayload? {
        guard card.name == "mcp__orbit__session_create", card.status == .ok,
              let result = card.result, let data = result.data(using: .utf8),
              let p = try? JSONDecoder().decode(SessionCreatePayload.self, from: data),
              !p.id.isEmpty else { return nil }
        return p
    }

    var body: some View {
        if let payload = sessionCreate {
            SessionCreateCardView(payload: payload)
        } else {
            defaultBody
        }
    }

    private var defaultBody: some View {
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
                    .font(.orbitMeta.weight(.semibold)).foregroundStyle(.tertiary)
            }
            Image(systemName: d.symbol)
                .font(.orbitMeta).foregroundStyle(d.tone.color)
                .frame(width: 20, height: 20)
                .background(d.tone.color.opacity(0.14), in: RoundedRectangle(cornerRadius: 5))
            Text(d.label)
                .font(.orbitMono.weight(.semibold))
                .foregroundStyle(.primary)
            summary
            if let meta = d.meta {
                Text(meta)
                    .font(.orbitMonoFine).foregroundStyle(.secondary)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Color.gray.opacity(0.14), in: RoundedRectangle(cornerRadius: 4))
            }
            status
            Spacer(minLength: 0)
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
                .font(.orbitMono)
                .lineLimit(1).truncationMode(.middle)
        } else if let s = d.summary, !s.isEmpty {
            Text(s)
                .font(d.summaryMono ? .orbitMono : .orbitLabel)
                .foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
        }
    }

    @ViewBuilder private var status: some View {
        switch card.status {
        case .running: ProgressView().controlSize(.small)
        case .ok:      Image(systemName: "checkmark.circle.fill").font(.orbitLabel).foregroundStyle(.green)
        case .error:   Image(systemName: "xmark.circle.fill").font(.orbitLabel).foregroundStyle(.red)
        }
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: 8) {
            ToolBodyView(kind: d.body)
            // Inline tool-result images (Read on a .png, an MCP screenshot) — above any text output,
            // mirroring web's `ToolResult`, which renders images before the monospace panel.
            if !card.resultImages.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(card.resultImages.enumerated()), id: \.offset) { _, data in
                        ToolResultImageView(data: data)
                    }
                }
            }
            if let result = card.result, !result.isEmpty {
                let isErr = card.status == .error
                // Mirrors web `.chat-result`: a tinted panel (red on error, neutral otherwise) with a
                // small uppercase label. The output text itself stays muted even on error (only the
                // panel + label carry the error colour) — matching web's muted `<Pre>`.
                VStack(alignment: .leading, spacing: 3) {
                    Text(isErr ? "ERROR" : "OUTPUT")
                        .font(.orbitSectionLabel.weight(.semibold)).tracking(0.4)
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

/// Shape of a `mcp__orbit__session_create` tool result (`{id,title,status,agentName,provider}`).
private struct SessionCreatePayload: Decodable {
    let id: String
    var title: String?
    var status: String?
    var agentName: String?
    var provider: String?
}

/// Renders a successful `mcp__orbit__session_create` as a tappable card that opens the spawned child
/// session. `payload.id` is the child's raw session id; `route(to:)` is the same entry a notification
/// / deep link uses. Web parity: Transcript.tsx `SessionCreateCard` + `.chat-session-card`.
private struct SessionCreateCardView: View {
    let payload: SessionCreatePayload
    @Environment(AppModel.self) private var app

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.triangle.branch")
                .font(.orbitMeta).foregroundStyle(Color.purple)
                .frame(width: 26, height: 26)
                .background(Color.purple.opacity(0.14), in: RoundedRectangle(cornerRadius: 6))
            VStack(alignment: .leading, spacing: 2) {
                Text((payload.title?.isEmpty == false) ? payload.title! : "New session")
                    .font(.orbitMono.weight(.semibold)).foregroundStyle(.primary)
                    .lineLimit(1).truncationMode(.tail)
                HStack(spacing: 8) {
                    if let a = payload.agentName, !a.isEmpty {
                        Text(a).font(.orbitMonoFine).foregroundStyle(.secondary)
                    }
                    if let p = payload.provider, !p.isEmpty {
                        Text(p.capitalized).font(.orbitMonoFine).foregroundStyle(.secondary)
                    }
                    if let st = payload.status, !st.isEmpty {
                        Text(st.uppercased()).font(.orbitSectionLabel).tracking(0.4)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(Color.purple.opacity(0.14), in: Capsule())
                            .foregroundStyle(Color.purple)
                    }
                }
            }
            Spacer(minLength: 0)
            (Text("Open ") + Text(Image(systemName: "chevron.right")))
                .font(.orbitLabel).foregroundStyle(Color.purple)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Color.gray.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        .overlay(alignment: .leading) { Rectangle().fill(Color.purple).frame(width: 3) }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay { RoundedRectangle(cornerRadius: 8).stroke(Color.primary.opacity(0.12), lineWidth: 1) }
        .contentShape(Rectangle())
        .onTapGesture { app.route(to: .session(payload.id)) }
    }
}

/// A single image carried by a tool_result (e.g. `Read` on a .png, or an MCP tool returning a
/// screenshot), decoded from the inline bytes the runner delivered. Rendered as a rounded thumbnail
/// fitted to a cap — web parity with the inline preview the web transcript shows. On iOS a tap opens
/// the shared full-screen zoomable viewer (like a sent-image thumbnail); macOS stays static, matching
/// the transcript's attachment thumbnails. Renders nothing if the bytes don't decode as an image.
private struct ToolResultImageView: View {
    let data: Data
    #if os(iOS)
    @State private var fullScreen = false
    private static let cap = CGSize(width: 300, height: 360)
    #else
    private static let cap = CGSize(width: 240, height: 240)
    #endif

    /// Scale to touch the cap while keeping aspect ratio, never upscaling past native size, so the
    /// rounded border hugs the image (mirrors `ChatAttachmentImage.fitted`).
    private static func fitted(_ src: CGSize) -> CGSize {
        guard src.width > 0, src.height > 0 else { return cap }
        let k = min(cap.width / src.width, cap.height / src.height, 1)
        return CGSize(width: src.width * k, height: src.height * k)
    }

    var body: some View {
        if let img = PlatformImage(data: data) {
            thumbnail(img, size: Self.fitted(img.size))
        }
    }

    @ViewBuilder
    private func thumbnail(_ img: PlatformImage, size: CGSize) -> some View {
        let view = Image(platformImage: img)
            .resizable().scaledToFit()
            .frame(width: size.width, height: size.height)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(.primary.opacity(0.08)) }
        #if os(iOS)
        view
            .contentShape(Rectangle())
            .onTapGesture { fullScreen = true }
            .fullScreenCover(isPresented: $fullScreen) { FullScreenImageView(image: img) }
        #else
        view
        #endif
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
                .font(.orbitMono).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
                .overlay { RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.18), lineWidth: 1) }
        case .code(let code):
            CollapsibleMono(text: code)
        case .markdown(let md):
            MarkdownView(source: md)
                .font(.orbitProseAside).textSelection(.enabled)
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
    // Fixed columns sized to their mono tokens: scale them with Dynamic Type or large sizes
    // truncate the line numbers / `+`-`-` signs while the code text grows.
    @ScaledMetric(relativeTo: .caption2) private var gutterWidth: CGFloat = 30
    @ScaledMetric(relativeTo: .caption) private var signWidth: CGFloat = 14
    var body: some View {
        if line.kind == .gap {
            HStack(spacing: 0) {
                gutterText("")
                gutterText("")
                Text("⋯ \(line.gapCount) unchanged \(line.gapCount == 1 ? "line" : "lines") ⋯")
                    .font(.orbitMonoFine).italic().foregroundStyle(.tertiary)
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
                Text(sign).font(.orbitDiffLine).foregroundStyle(fg)
                    .frame(width: signWidth, alignment: .center)
                Text(line.text.isEmpty ? " " : line.text)
                    .font(.orbitDiffLine).foregroundStyle(fg)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.trailing, 6)
            }
            .padding(.vertical, 1)
            .background(bg)
        }
    }
    private func gutter(_ n: Int?) -> some View { gutterText(n.map(String.init) ?? "") }
    private func gutterText(_ s: String) -> some View {
        Text(s)
            .font(.orbitMonoFine).foregroundStyle(.tertiary)
            .frame(width: gutterWidth, alignment: .trailing)
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
                .font(.orbitMono)
                .foregroundStyle(Color.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            if hidden > 0 {
                Button(open ? "Show less" : "Show \(hidden) more lines") { open.toggle() }
                    .buttonStyle(.plain).font(.orbitLabel).foregroundStyle(.blue)
            }
        }
    }
}
