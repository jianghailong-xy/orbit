import SwiftUI
import OrbitKit

/// One pending approval, dispatched to the right card by kind (tool permission / AskUserQuestion
/// form / ExitPlanMode). Rendered inline in the transcript as the agent's latest turn — mirroring
/// web, whose AgentView places the ApprovalPanel right after the messages. So the card scrolls with
/// the conversation and a long AskUserQuestion form wraps in full (the transcript's own scroll gives
/// it unbounded height) instead of being crushed into the fixed, non-scrolling panel that used to sit
/// above the composer and truncated every line.
///
/// All three share one shape — `ApprovalHeader` on top, `ApprovalActions` at the bottom, the toned
/// surface of `approvalChrome` around them — so the one row in the transcript that *stops the turn*
/// is recognizable as a family at a glance. The metrics inside that shape fork by platform
/// (`ApprovalMetrics`): on iPhone these controls are the only way to answer, so every target is a
/// real one, where macOS keeps the denser layout a pointer is fine with.
struct ApprovalCard: View {
    let console: ConsoleModel
    let approval: PendingApproval

    var body: some View {
        switch approval.kind {
        case .question: QuestionCard(console: console, approval: approval)
        case .plan:     PlanCard(console: console, approval: approval)
        case .tool:     ToolApprovalCard(console: console, approval: approval)
        }
    }
}

// MARK: - shared card language

/// Card metrics, forked because the two clients are answered with different instruments: a phone
/// card is roomier and its answer rows meet the 44pt touch minimum (a tap has no hover to aim with,
/// and a mis-tap here runs a command), while macOS keeps the compact sizing that suits a pointer in
/// a much wider transcript column.
///
/// The action buttons deliberately do NOT run at `.controlSize(.large)`: 50pt-tall bars read as
/// bulky stacked three-deep on a phone. They keep the system's default height and take their target
/// from spanning the card instead — a full-width 34pt bar is far easier to hit than the
/// content-width pill it replaced, even though it's under 44pt.
private enum ApprovalMetrics {
    #if os(iOS)
    static let padding: CGFloat = 14
    static let radius: CGFloat = 14
    static let spacing: CGFloat = 12
    static let rowRadius: CGFloat = 10
    static let rowMinHeight: CGFloat = 44
    #else
    static let padding: CGFloat = 10
    static let radius: CGFloat = 10
    static let spacing: CGFloat = 8
    static let rowRadius: CGFloat = 8
    static let rowMinHeight: CGFloat = 0
    #endif
}

private extension View {
    /// The card surface: the same toned wash as before — it says "this one is waiting on you"
    /// without shouting — now closed by a hairline in the same tone. The wash alone is 7% of a
    /// colour, which on the dark transcript left the card with no edge at all: it read as loose text
    /// with buttons under it rather than as one object to answer.
    func approvalChrome(_ tone: Color) -> some View {
        padding(ApprovalMetrics.padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tone.opacity(0.07), in: RoundedRectangle(cornerRadius: ApprovalMetrics.radius))
            .overlay {
                RoundedRectangle(cornerRadius: ApprovalMetrics.radius)
                    .strokeBorder(tone.opacity(0.28))
            }
    }

    /// The *label* of a card action, stretched to the card's width on iOS. It has to be the label:
    /// a bordered button draws its capsule around the label, so `.frame(maxWidth: .infinity)` applied
    /// outside `.buttonStyle` widens only the layout frame and leaves the capsule hugging its text,
    /// centred in the gap — which is exactly what shipped in v0.1.2-beta.22 (Submit and "Chat about
    /// this" came out as two centred pills of different widths instead of one stacked column).
    /// macOS keeps its labels hugging, so a row of buttons still reads as buttons.
    @ViewBuilder func approvalActionLabel() -> some View {
        #if os(iOS)
        frame(maxWidth: .infinity)
        #else
        self
        #endif
    }
}

/// A card's identity row: toned icon chip · what is being asked, in words · an optional trailing
/// badge (the tool's name). The chip is the transcript's own tool-row language, so an approval reads
/// as part of the conversation rather than as a dialog dropped into it.
private struct ApprovalHeader: View {
    let symbol: String
    let title: String
    let tone: Color
    var badge: String? = nil

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: symbol)
                .font(.orbitMeta)
                .foregroundStyle(tone)
                .frame(width: 22, height: 22)
                .background(tone.opacity(0.16), in: RoundedRectangle(cornerRadius: 6))
            Text(title)
                .font(.orbitProse.bold())
                .foregroundStyle(.primary)
                .lineLimit(1)
                .layoutPriority(1)      // a long MCP tool name truncates; the ask never does
            Spacer(minLength: 4)
            if let badge {
                Text(badge)
                    .font(.orbitMonoFine)
                    .foregroundStyle(tone)
                    .lineLimit(1)
                    .truncationMode(.middle)   // `mcp__orbit__…_create` keeps both ends
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(tone.opacity(0.16), in: Capsule())
            }
        }
    }
}

/// The card's decisions. Stacked full-width on iOS: three buttons can't share a phone row without
/// the long "remember …" label crushing the others (web's ApprovalPanel does the same under 600px),
/// and stacking keeps a destructive Deny from sitting a thumb-width from Allow. macOS keeps them in
/// a natural row.
private struct ApprovalActions<Content: View>: View {
    private let content: () -> Content

    init(@ViewBuilder content: @escaping () -> Content) { self.content = content }

    var body: some View {
        #if os(iOS)
        VStack(spacing: 10) { content() }
        #else
        HStack(spacing: 8) { content() }
        #endif
    }
}

/// Answer an approval. Every card decides through here so a phone gets the confirmation it
/// otherwise lacks: the card is dropped optimistically the instant it's tapped, so without a haptic
/// a fumbled tap and a deliberate one feel identical. No-op on macOS.
private func decide(_ console: ConsoleModel, _ approval: PendingApproval,
                    _ behavior: ApprovalBehavior,
                    answers: [String: [String]]? = nil, remember: Bool = false) {
    PlatformHaptics.tap()
    Task { await console.decide(approval, behavior: behavior, answers: answers, remember: remember) }
}

/// Trimmed-non-empty, so a field that is present but blank doesn't render an empty row.
private func nonEmpty(_ s: String?) -> String? {
    guard let s, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
    return s
}

// MARK: - cards

struct ToolApprovalCard: View {
    let console: ConsoleModel
    let approval: PendingApproval

    private var rememberRule: PermissionRule? {
        approval.input.flatMap { Approvals.rememberRule(toolName: approval.toolName ?? "", input: $0) }
    }
    /// A shell line is shown as the command itself — never the model's prose `description`, since
    /// what runs is what you are agreeing to — in the transcript's own `$` block, so the tool row
    /// above and this card render one call the same way.
    private var command: String? { nonEmpty(approval.input?["command"]?.stringValue) }
    /// Otherwise: the thing the call acts on. Only `file_path` was ever shown, so approving a fetch
    /// or a search on the phone showed the tool's name and nothing else — you were agreeing to a
    /// call you couldn't see (web prints the whole input as JSON).
    private var subject: String? {
        for key in ["file_path", "notebook_path", "url", "pattern", "path"] {
            if let value = nonEmpty(approval.input?[key]?.stringValue) { return value }
        }
        return nil
    }

    /// Orbit's own asks carry a server-computed preview of what would happen. Without rendering it
    /// the card showed a tool name and nothing else — somebody was being asked to approve fifty
    /// tasks they could not see.
    private var batch: BatchApprovalPreview? {
        guard Approvals.isTaskBatch(toolName: approval.toolName ?? ""), let input = approval.input
        else { return nil }
        return Approvals.batchPreview(from: input)
    }
    private var dag: DagApprovalPreview? {
        guard Approvals.isDagChange(toolName: approval.toolName ?? ""), let input = approval.input
        else { return nil }
        return Approvals.dagPreview(from: input)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: ApprovalMetrics.spacing) {
            if let batch {
                ApprovalHeader(symbol: "square.stack.3d.up.fill",
                               title: "Create \(batch.taskCount) task\(batch.taskCount == 1 ? "" : "s")?",
                               tone: .orange, badge: "new tasks")
                OrbitAskBody(impact: Approvals.batchImpactLines(batch),
                             note: "",
                             detail: (batch.lists.isEmpty ? "" : "into \(batch.lists.joined(separator: ", "))")
                                 + (batch.edges > 0 ? " · \(batch.edges) dependency edge\(batch.edges == 1 ? "" : "s")" : "")
                                 + shapeSuffix(batch),
                             // Indented, so a chain reads as a chain and a fan-out as siblings —
                             // the part a flat list of titles cannot show. Web draws a real graph;
                             // a phone column has no room for one.
                             rows: Approvals.batchTreeRows(batch.tasks).map(\.text),
                             more: batch.titlesTruncated,
                             mono: true)
            } else if let dag {
                ApprovalHeader(symbol: "point.3.connected.trianglepath.dotted",
                               title: "Restructure dependencies in \(dag.listTitle)?",
                               tone: .orange, badge: "dependencies")
                OrbitAskBody(impact: Approvals.dagImpactLines(dag),
                             note: dag.note,
                             detail: "\(dag.edgesBefore) → \(dag.edgesAfter) edges",
                             rows: dag.ops.map { $0.noop ? "\($0.sentence) (already so)" : $0.sentence },
                             more: 0,
                             mono: false)
            } else {
                ApprovalHeader(symbol: "hand.raised.fill", title: "Approve tool call",
                               tone: .orange, badge: approval.toolName ?? "Tool")
                if let command {
                    ToolBodyView(kind: .command(command))
                } else if let subject {
                    Text(subject)
                        .font(.orbitMono).foregroundStyle(.secondary)
                        .lineLimit(3).truncationMode(.middle)   // a path keeps its root AND its filename
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            ApprovalActions {
                allowButton
                if let rule = rememberRule { rememberButton(rule) }
                denyButton
            }
        }
        .approvalChrome(.orange)
    }

    private var allowButton: some View {
        Button { decide(console, approval, .allow) } label: {
            Text(batch != nil ? "Create them" : dag != nil ? "Apply changes" : "Allow").approvalActionLabel()
        }
        .buttonStyle(.borderedProminent)
    }
    // Secondary "allow": same intent as Allow, so a bordered button (not plain text) that keeps
    // Allow the one filled/prominent action. The exact scope it will remember rides in monospace.
    private func rememberButton(_ rule: PermissionRule) -> some View {
        Button {
            decide(console, approval, .allow, remember: true)
        } label: {
            (Text("Allow & remember ") + Text(Approvals.rememberLabel(rule)).font(.orbitMono))
                .approvalActionLabel()
        }
        .buttonStyle(.bordered)
    }
    private var denyButton: some View {
        Button(role: .destructive) { decide(console, approval, .deny) } label: {
            Text(batch != nil ? "Create nothing" : dag != nil ? "Leave the graph alone" : "Deny")
                .approvalActionLabel()
        }
        .buttonStyle(.bordered)
    }
}

/// The body shared by Orbit's two own asks: the consequence first and largest, then the reason,
/// then the rows it is made of. The counts are the decision — the titles look identical whether a
/// batch costs one run or none — so the rows come last and are capped.
/// The shape, appended to the detail line: it describes the whole window even when the tree below
/// is flattened by the depth cap.
private func shapeSuffix(_ batch: BatchApprovalPreview) -> String {
    let shape = Approvals.describeBatchShape(batch.tasks)
    return shape.isEmpty ? "" : " · \(shape)"
}

private struct OrbitAskBody: View {
    let impact: [String]
    let note: String
    let detail: String
    let rows: [String]
    let more: Int
    /// Tree rows are drawn with box glyphs, which only line up in a monospaced face.
    var mono: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !note.isEmpty {
                Text(note).font(.orbitProse).frame(maxWidth: .infinity, alignment: .leading)
            }
            ForEach(impact, id: \.self) { line in
                Text(line)
                    .font(.orbitLabel).fontWeight(.semibold)
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(.tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 7))
            }
            if !detail.isEmpty {
                Text(detail).font(.orbitLabel).foregroundStyle(.secondary)
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                Text(mono ? row : "• \(row)")
                    .font(mono ? .orbitMono : .orbitLabel).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if more > 0 {
                Text("+\(more) more").font(.orbitLabel).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct QuestionCard: View {
    let console: ConsoleModel
    let approval: PendingApproval
    @State private var selections: [String: Set<String>] = [:]
    @State private var custom: [String: String] = [:]

    private var questions: [AskQuestion] {
        approval.input.map { Approvals.parseQuestions(from: $0) } ?? []
    }
    private var allAnswered: Bool {
        Approvals.allAnswered(questions, selections: selections, custom: custom)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: ApprovalMetrics.spacing) {
            ApprovalHeader(symbol: "questionmark.circle.fill", title: "A question for you", tone: .blue)
            ForEach(questions) { q in questionBlock(q) }
            ApprovalActions {
                submitButton
                chatButton
            }
        }
        .approvalChrome(.blue)
    }

    private func questionBlock(_ q: AskQuestion) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            // The header line also carries the "Multiple choice" chip: under the options (where it
            // used to sit) the hint arrived after the choice was already made.
            if nonEmpty(q.header) != nil || q.multiSelect {
                HStack(spacing: 6) {
                    if let header = nonEmpty(q.header) {
                        Text(header).font(.orbitLabel.bold()).foregroundStyle(.secondary)
                    }
                    if q.multiSelect { multiChip }
                    Spacer(minLength: 0)
                }
            }
            Text(q.question).font(.orbitProse.bold())
            ForEach(q.options) { opt in
                OptionRow(option: opt,
                          picked: isSelected(q, opt.label),
                          multiSelect: q.multiSelect) { toggle(q, opt.label) }
            }
            customField(q)
        }
    }

    private var multiChip: some View {
        Text("Multiple choice")
            .font(.orbitMeta).foregroundStyle(.secondary)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Color.primary.opacity(0.07), in: Capsule())
    }

    /// claude's AskUserQuestion always allows a free-typed answer, not just a listed option. Left on
    /// the stock `.roundedBorder`: it's shorter than the 44pt option rows above it, but a `TextField`
    /// does not grow into an offered height — dressing it in a taller rounded box would draw a
    /// 44pt target whose top and bottom thirds don't actually take the tap.
    private func customField(_ q: AskQuestion) -> some View {
        TextField("Or type your own answer…", text: customBinding(q))
            .textFieldStyle(.roundedBorder)
            .font(.orbitControl)
    }

    private var submitButton: some View {
        Button {
            decide(console, approval, .allow,
                   answers: Approvals.buildAnswers(questions, selections: selections, custom: custom))
        } label: {
            Text("Submit").approvalActionLabel()
        }
        .buttonStyle(.borderedProminent)
        .disabled(!allAnswered)
    }
    // Reply conversationally in the main composer instead of picking an option; the text rides back
    // as a deny+message (handled by ConsoleModel.send).
    private var chatButton: some View {
        Button {
            console.startChatReply(approvalID: approval.id,
                                   question: Approvals.chatReplyLabel(questions))
        } label: {
            Label("Chat about this", systemImage: "bubble.left.and.bubble.right")
                .approvalActionLabel()
        }
        .buttonStyle(.bordered)
    }

    private func isSelected(_ q: AskQuestion, _ label: String) -> Bool {
        selections[q.question]?.contains(label) ?? false
    }
    private func toggle(_ q: AskQuestion, _ label: String) {
        var set = selections[q.question] ?? []
        if q.multiSelect {
            if set.contains(label) { set.remove(label) } else { set.insert(label) }
        } else {
            set = [label]
            custom[q.question] = ""           // single-select: a listed option and free text are exclusive
        }
        selections[q.question] = set
    }
    /// Binding for a question's free-text field; for single-select, typing clears any picked option.
    private func customBinding(_ q: AskQuestion) -> Binding<String> {
        Binding(
            get: { custom[q.question] ?? "" },
            set: { value in
                custom[q.question] = value
                if !q.multiSelect, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    selections[q.question] = []
                }
            }
        )
    }
}

/// One pickable answer. A real target: the whole row takes the tap, it is 44pt tall on a phone, and
/// being picked is legible from across the room (tinted fill + accented border, web's `.is-picked`).
/// It used to be a bare glyph beside a line of text — text-height, unbounded, with the selection
/// shown only by a small circle swapping to a checkmark. The glyph shape now also says what kind of
/// answer this is: a square where several may be picked, a circle where exactly one may.
private struct OptionRow: View {
    let option: AskOption
    let picked: Bool
    let multiSelect: Bool
    let toggle: () -> Void

    var body: some View {
        Button {
            PlatformHaptics.tap()
            toggle()
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: glyph)
                    .font(.orbitGlyph)
                    .foregroundStyle(picked ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label).font(.orbitProse).foregroundStyle(.primary)
                    if let description = nonEmpty(option.description) {
                        Text(description).font(.orbitLabel).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: ApprovalMetrics.rowMinHeight, alignment: .leading)
            .background(picked ? Color.accentColor.opacity(0.14) : Color.primary.opacity(0.05),
                        in: RoundedRectangle(cornerRadius: ApprovalMetrics.rowRadius))
            .overlay {
                RoundedRectangle(cornerRadius: ApprovalMetrics.rowRadius)
                    .strokeBorder(picked ? Color.accentColor.opacity(0.55) : Color.primary.opacity(0.10))
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(picked ? [.isButton, .isSelected] : [.isButton])
    }

    private var glyph: String {
        if multiSelect { return picked ? "checkmark.square.fill" : "square" }
        return picked ? "checkmark.circle.fill" : "circle"
    }
}

struct PlanCard: View {
    let console: ConsoleModel
    let approval: PendingApproval

    private var plan: String { approval.input?["plan"]?.stringValue ?? "Plan ready for review." }

    var body: some View {
        VStack(alignment: .leading, spacing: ApprovalMetrics.spacing) {
            ApprovalHeader(symbol: "list.bullet.clipboard", title: "Review this plan", tone: .purple)
            MarkdownView(source: plan).font(.orbitProse).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            ApprovalActions {
                approveButton
                keepPlanningButton
            }
        }
        .approvalChrome(.purple)
    }

    // "Approve & run" over a bare "Approve": approving a plan doesn't just accept it, it leaves plan
    // mode and starts the work (web parity).
    private var approveButton: some View {
        Button { decide(console, approval, .allow) } label: {
            Text("Approve & run").approvalActionLabel()
        }
        .buttonStyle(.borderedProminent)
    }
    private var keepPlanningButton: some View {
        Button(role: .cancel) { decide(console, approval, .deny) } label: {
            Text("Keep planning").approvalActionLabel()
        }
        .buttonStyle(.bordered)
    }
}
