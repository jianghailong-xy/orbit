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
    ///
    /// `dimmed` takes the whole card down to 72% — content, wash and hairline together, the mock's
    /// `opacity: .72` — for a delivered card that is no longer a question (the owner's call,
    /// 2026-09-11). It is set here and nowhere else, so no card is dimmed twice.
    func approvalChrome(_ tone: Color, dimmed: Bool = false) -> some View {
        padding(ApprovalMetrics.padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tone.opacity(0.07), in: RoundedRectangle(cornerRadius: ApprovalMetrics.radius))
            .overlay {
                RoundedRectangle(cornerRadius: ApprovalMetrics.radius)
                    .strokeBorder(tone.opacity(0.28))
            }
            .opacity(dimmed ? 0.72 : 1)
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
    private var create: CreateApprovalPreview? {
        approval.input.flatMap { Approvals.createPreview(toolName: approval.toolName ?? "", from: $0) }
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
            } else if let create {
                ApprovalHeader(symbol: create.isProject ? "folder.badge.plus" : "checklist",
                               title: "Create \(create.isProject ? "project" : "task") “\(create.title)”?",
                               tone: .orange, badge: create.isProject ? "new project" : "new task")
                OrbitAskBody(impact: [],
                             note: create.prose,
                             detail: create.criteria.isEmpty ? "" : "Done when",
                             // The same Markdown web assembles: a project's stated criteria become
                             // a list, a task's are already one Markdown block.
                             rows: create.isProject ? create.criteria.map { "- \($0)" } : create.criteria,
                             more: 0,
                             mono: false,
                             markdown: true)
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
            Text(batch != nil ? "Create them" : create != nil ? "Create it" : dag != nil ? "Apply changes" : "Allow")
                .approvalActionLabel()
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
    /// Saying no. To a tool call that is one press and done. To one of Orbit's own proposals it is
    /// the press plus what to do instead: the refusal arms the composer and rides back with the
    /// next send as one deny+message, because "not these tasks" without a sentence leaves the agent
    /// knowing only that it was refused.
    private var denyButton: some View {
        // Red for a refusal, plain for a conversation: the words are the question card's own on an
        // Orbit ask, and the same sentence cannot be red on one card and blue on the next.
        Button(role: Approvals.isOrbitAsk(toolName: approval.toolName ?? "") ? nil : .destructive) {
            let tool = approval.toolName ?? ""
            guard Approvals.isOrbitAsk(toolName: tool) else {
                decide(console, approval, .deny)
                return
            }
            PlatformHaptics.tap()
            console.startDeclineReply(approvalID: approval.id, toolName: tool,
                                      subject: declineSubject)
        } label: {
            // Orbit's own asks say what the question card says, because the press does what the
            // question card's press does. Only a plain tool call still says Deny: that one is
            // refused where it stands, with nothing to discuss.
            Text(Approvals.isOrbitAsk(toolName: approval.toolName ?? "") ? Approvals.chatAction : "Deny")
                .approvalActionLabel()
        }
        .buttonStyle(.bordered)
    }

    /// What the composer's bar names as the thing not being done: the proposal's own subject.
    private var declineSubject: String {
        if let create { return create.title }
        if let batch { return "\(batch.taskCount) new task\(batch.taskCount == 1 ? "" : "s")" }
        if let dag { return dag.listTitle }
        return approval.toolName ?? ""
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
    /// The note and rows are the agent's own prose — a create's description and its acceptance
    /// criteria, written as Markdown — so they render as Markdown, the way web draws both with its
    /// Markdown component. The batch and DAG slots are sentences this app generates itself and stay
    /// literal (web draws the DAG note as a plain paragraph too).
    var markdown: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !note.isEmpty {
                if markdown {
                    MarkdownView(source: note).font(.orbitProse)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Text(note).font(.orbitProse).frame(maxWidth: .infinity, alignment: .leading)
                }
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
            if markdown, !rows.isEmpty {
                // The criteria are one Markdown document, not a row each: a task's acceptance
                // criteria arrive verbatim and a project's stated criteria as a list, which is the
                // same string web hands its Markdown component — so a multi-line criterion reads as
                // its own list instead of as one bullet holding its raw markup. A `- [ ]` item keeps
                // its checked state and draws a checkbox, the way web's remark-gfm does.
                MarkdownView(source: rows.joined(separator: "\n"), base: .aside, ink: .secondary)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    Text(mono ? row : "• \(row)")
                        .font(mono ? .orbitMono : .orbitLabel).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
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

// MARK: - the completion decision

/// The card a person answers "is this work finished" on — drawn by Orbit from the pending read and
/// pressed at the decision door, with no agent between the two: web's `EvidenceDecisionCard`.
///
/// It is delivered like the ruler's cards (`DeliveredDecisionCardView`): no `Approval` stands
/// behind it, nothing stops a turn for it, and it keeps the address and nothing else — the standing
/// is re-derived from the console's read on every body pass, which is what makes a disabled button
/// honest rather than a guess. Every word it shows comes from `EvidenceDecisions`, so macOS, iOS and
/// the browser cannot come apart on it.
private struct EvidenceDecisionCard: View {
    let console: ConsoleModel
    let taskID: String
    let evidenceRevision: String
    @State private var deciding = false
    /// The send-back's whole state, as one value OrbitKit owns the rules of — including the one
    /// that matters: it cannot be sent without a reason, because the decision door refuses a
    /// SEND_BACK carrying none and writes nothing at all.
    @State private var sendBack = EvidenceSendBackState()

    private var standing: EvidenceDecisionStanding {
        console.evidenceStanding(taskID, evidenceRevision)
    }

    var body: some View {
        let standing = self.standing
        VStack(alignment: .leading, spacing: ApprovalMetrics.spacing) {
            ApprovalHeader(symbol: "checkmark.seal.fill",
                           title: EvidenceDecisions.heading(standing), tone: .blue)
            // The ruler card's mark, for its reason: this card is Orbit's rather than the agent's
            // typing, and a press goes to the door rather than into the conversation.
            Text(CriteriaDecisions.provenanceLabel)
                .font(.orbitLabel).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)

            if let row = standing.row {
                EvidenceDecisionFacts(row: row)
            } else {
                // The address and nothing else: a revision that has left the read is not published
                // any more, and this card kept no copy of what it said.
                Text(EvidenceDecisions.addressLine(standing))
                    .font(.orbitMonoFine).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            // Above the dead buttons, so it reads as the reason they are dead.
            if let stale = EvidenceDecisions.staleExplanation(standing) {
                Text(stale)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.blue.opacity(0.08),
                                in: RoundedRectangle(cornerRadius: ApprovalMetrics.rowRadius))
            }

            ApprovalActions {
                confirmButton(standing)
                sendBackButton(standing)
            }
            // Below the actions rather than inside them: on macOS those are one row, and a growing
            // reason box wedged into it would push Confirm off its line.
            if sendBack.open { reasonBox(standing) }
        }
        .approvalChrome(.blue)
    }

    // MARK: actions
    //
    // The one rule both clients are under: an action that cannot succeed is disabled rather than
    // lit and refused.

    /// `确认完成` answers on the press: there is no pick-then-Submit step in between.
    private func confirmButton(_ standing: EvidenceDecisionStanding) -> some View {
        Button { decide(standing, .confirm) } label: {
            Text(EvidenceDecisions.confirmAction).approvalActionLabel()
        }
        .buttonStyle(.borderedProminent)
        .disabled(deciding || !standing.answerable)
    }

    private func sendBackButton(_ standing: EvidenceDecisionStanding) -> some View {
        Button {
            PlatformHaptics.tap()
            sendBack.open.toggle()
        } label: {
            Text(EvidenceDecisions.sendBackAction).approvalActionLabel()
        }
        .buttonStyle(.bordered)
        .disabled(deciding || !standing.answerable)
    }

    private func reasonBox(_ standing: EvidenceDecisionStanding) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(EvidenceDecisions.noteLabel)
                .font(.orbitLabel).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            TextField(EvidenceDecisions.notePlaceholder, text: $sendBack.note, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .font(.orbitControl)
                .lineLimit(3...6)
                .disabled(deciding || !standing.answerable)
            Button {
                decide(standing, .sendBack, note: sendBack.trimmedNote)
            } label: {
                Text(EvidenceDecisions.sendAction).approvalActionLabel()
            }
            .buttonStyle(.bordered)
            // A send-back with no reason is refused by the door and writes nothing at all, so the
            // control that would send one is not pressable until there is one.
            .disabled(deciding || !standing.answerable || !sendBack.canSend)
        }
    }

    /// The press re-checks what the buttons were rendered from, so a race between a render and a
    /// tap cannot send an answer the standing says is dead.
    private func decide(_ standing: EvidenceDecisionStanding, _ decision: EvidenceDecisionAnswer,
                        note: String? = nil) {
        guard let row = standing.row, standing.answerable, !deciding else { return }
        PlatformHaptics.tap()
        deciding = true
        Task {
            await console.decideEvidence(row, decision, note: note)
            deciding = false
        }
    }
}

/// One row, in the order a person decides in: what is claimed, what is admitted missing, and what
/// was checked for them. Every visible string is a field of the row or a count of one.
private struct EvidenceDecisionFacts: View {
    let row: EvidenceDecisionRow

    @State private var claimOpen = false
    @State private var gapsOpen = false
    @State private var checksOpen = false

    private var claim: FoldedClaim {
        EvidenceDecisions.foldedClaim(row.claim, clamp: EvidenceDecisions.claimClamp)
    }
    private var fullClaim: String { row.claim.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var gaps: GapPreview { EvidenceDecisions.gapPreview(row) }
    private var checks: [EvidenceDecisionCheck] { EvidenceDecisions.checks(row) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(row.title)
                .font(.orbitLabel.bold()).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            standardBlock
            gapsBlock
            checksBlock
            accountBlock
            Text(EvidenceDecisions.meta(row))
                .font(.orbitMonoFine).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: body

    /// The sentence being judged, first and in its own words. A reader asked whether this evidence
    /// settles a criterion cannot answer from the criterion's KEY, which is all the card used to
    /// carry above the fold — the text was two disclosures down, inside a machine check's detail.
    private var standardBlock: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(EvidenceDecisions.criterionHeading)
                .font(.orbitLabel.bold()).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(row.criterion?.text ?? EvidenceDecisions.noCriterion)
                .font(.orbitProse)
                .foregroundStyle(row.criterion == nil ? AnyShapeStyle(.secondary)
                                                      : AnyShapeStyle(.primary))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.blue.opacity(0.08),
                    in: RoundedRectangle(cornerRadius: ApprovalMetrics.rowRadius))
    }

    /// The submitter's own account, last and folded when it is long.
    ///
    /// It used to lead the card, which put a paragraph of implementation detail between the reader
    /// and the gaps — the part most likely to change the answer — and the actions. Opening it now
    /// REPLACES the fold rather than printing underneath it: the old shape drew the clamped first
    /// 90 characters and then the whole text, so every long account began twice.
    private var accountBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            if claim.text.isEmpty {
                Text(EvidenceDecisions.noClaim)
                    .font(.orbitProse).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if claim.folded {
                DisclosureToggle(open: claimOpen,
                                 label: claimOpen ? EvidenceDecisions.claimHide
                                                  : EvidenceDecisions.claimFold(fullClaim.count)) {
                    claimOpen.toggle()
                }
                if claimOpen {
                    Text(fullClaim)
                        .font(.orbitProse)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                Text(fullClaim)
                    .font(.orbitProse)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// The body of the card. What the submitter says they did NOT establish is the part most likely
    /// to change the answer, so a narrow screen gives up the full text and the machine's checks
    /// before it gives up any of this — and what does not fit is COUNTED rather than dropped, one
    /// press from being read.
    private var gapsBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(EvidenceDecisions.gapsHeading(row.gaps.count))
                .font(.orbitLabel.bold()).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            ForEach(Array(gaps.shown.enumerated()), id: \.offset) { _, gap in
                gapRow(gap)
            }
            if !gaps.rest.isEmpty {
                DisclosureToggle(open: gapsOpen,
                                 label: gapsOpen ? "收起"
                                                 : EvidenceDecisions.gapsMore(gaps.rest.count)) {
                    gapsOpen.toggle()
                }
                if gapsOpen {
                    ForEach(Array(gaps.rest.enumerated()), id: \.offset) { _, gap in
                        gapRow(gap)
                    }
                }
            }
        }
    }

    private func gapRow(_ gap: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark").font(.orbitGlyph).foregroundStyle(.orange)
            Text(gap).font(.orbitProse).foregroundStyle(.primary)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.10),
                    in: RoundedRectangle(cornerRadius: ApprovalMetrics.rowRadius))
    }

    /// The three things nobody has to take on faith, folded into one line: they are a reason to
    /// stop reading, which is exactly why they fold and the gaps above do not.
    private var checksBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            DisclosureToggle(open: checksOpen,
                             label: EvidenceDecisions.checksHeading(
                                held: checks.filter(\.ok).count, total: checks.count),
                             symbol: "checkmark.shield") {
                checksOpen.toggle()
            }
            if checksOpen {
                ForEach(checks) { check in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: check.ok ? "checkmark" : "exclamationmark.triangle")
                                .font(.orbitGlyph)
                                .foregroundStyle(check.ok ? Color.green : Color.orange)
                            Text(check.text).font(.orbitLabel)
                            Spacer(minLength: 0)
                        }
                        if let detail = check.detail {
                            Text(detail).font(.orbitLabel).foregroundStyle(.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
}

/// A fold's own control: the label, a caret that says which way it goes, and the whole row taking
/// the press. Plain-styled so a fold never competes with the card's actual actions.
private struct DisclosureToggle: View {
    let open: Bool
    let label: String
    var symbol: String? = nil
    let toggle: () -> Void

    var body: some View {
        Button {
            PlatformHaptics.tap()
            toggle()
        } label: {
            HStack(spacing: 6) {
                if let symbol {
                    Image(systemName: symbol).font(.orbitGlyph).foregroundStyle(.secondary)
                }
                Text(label).font(.orbitLabel)
                Image(systemName: open ? "chevron.up" : "chevron.down")
                    .font(.orbitMeta).foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, minHeight: ApprovalMetrics.rowMinHeight, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(.isButton)
    }
}

// MARK: - the owner's confirmation

/// The card the ACCOUNT OWNER confirms an OWNER_CONFIRMED task done on, or sends back with a reason
/// — drawn by Orbit from `GET /tasks/:id/owner-confirmation` and pressed at the same door with the
/// owner's own sign-in, in the run's own session. Web's `OwnerConfirmationCard`.
///
/// It is delivered like the cards above: no `Approval` stands behind it, nothing stops a turn for
/// it, and it keeps the address and nothing else — the standing is re-derived from the console's
/// read on every body pass, which is what makes its buttons' disabled state honest rather than a
/// guess. Every word it shows comes from `OwnerConfirmations`, so macOS, iOS and the browser cannot
/// come apart on it.
private struct OwnerConfirmationCardView: View {
    let console: ConsoleModel
    let taskID: String
    /// The report this card was drawn for — the door's compare-and-set.
    let requestID: String
    @State private var deciding = false
    /// Whether the refusal behind the lead line is showing. Folded by default: it names a code the
    /// reader acts on only when reporting the problem.
    @State private var staleDetailOpen = false

    private var standing: OwnerConfirmationStanding { console.ownerStanding(taskID, requestID) }
    private var staleDetailLabel: String { staleDetailOpen ? "Hide details" : "Details" }

    var body: some View {
        let standing = self.standing
        VStack(alignment: .leading, spacing: ApprovalMetrics.spacing) {
            ApprovalHeader(symbol: "checkmark.seal.fill", title: OwnerConfirmations.heading,
                           tone: .blue)
            // The ruler card's mark, for its reason: this card is Orbit's rather than the agent's
            // typing, and a press goes to the door rather than into the conversation.
            Text(CriteriaDecisions.provenanceLabel)
                .font(.orbitLabel).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)

            if let view = console.ownerConfirmation {
                lead(view)
                OwnerConfirmationBoxes(acceptanceCriteria: view.acceptanceCriteria,
                                       report: standing.waiting?.report)
            } else {
                // The address and nothing else: a read that has not come back is not a description
                // of anything, and this card kept no copy of an earlier one.
                Text(taskID)
                    .font(.orbitMonoFine).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            // Above the dead buttons, so it reads as the reason they are dead. The lead line is
            // what the reader acts on; the refusal behind it, code and all, is for whoever reports
            // the problem.
            if let stale = OwnerConfirmations.staleExplanation(standing) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(stale.lead)
                        .font(.orbitLabel).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    DisclosureToggle(open: staleDetailOpen, label: staleDetailLabel) {
                        staleDetailOpen.toggle()
                    }
                    if staleDetailOpen {
                        Text(stale.detail)
                            .font(.orbitLabel).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(.horizontal, 10).padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.blue.opacity(0.08),
                            in: RoundedRectangle(cornerRadius: ApprovalMetrics.rowRadius))
            }

            ApprovalActions {
                confirmButton(standing)
                sendBackButton(standing)
            }
            // Under the buttons rather than in the second one's tooltip: a touch screen has no
            // hover, so the one sentence saying the task stays open was unreadable on a phone.
            Text(OwnerConfirmations.sendBackHint)
                .font(.orbitLabel).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .approvalChrome(.blue, dimmed: !OwnerConfirmations.isOpen(standing))
    }

    /// What is being confirmed: the task, and whose call it is — in words, with the id beside them.
    /// The line used to read `<id> · OWNER_CONFIRMED`, which spent the card's second line on an
    /// enum nobody outside this system reads.
    private func lead(_ view: OwnerConfirmationView) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(view.title)
                .font(.orbitProse.bold())
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(OwnerConfirmations.yours).font(.orbitLabel)
                Text(view.taskId).font(.orbitMonoFine)
                Spacer(minLength: 0)
            }
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: actions
    //
    // The one rule both clients are under: an action that cannot succeed is disabled rather than
    // lit and refused.

    private func confirmButton(_ standing: OwnerConfirmationStanding) -> some View {
        Button { decide(standing, .confirm) } label: {
            Text(OwnerConfirmations.confirmAction).approvalActionLabel()
        }
        .buttonStyle(.borderedProminent)
        .disabled(deciding || !standing.answerable)
    }

    /// The reason does not get a box here: the press hands it to the main composer, which is where
    /// a message to this session is typed anyway, and the door's "no reason, no write" rule is then
    /// the composer's own refusal to send an empty line.
    private func sendBackButton(_ standing: OwnerConfirmationStanding) -> some View {
        Button {
            guard let waiting = standing.waiting else { return }
            PlatformHaptics.tap()
            console.startOwnerSendBackReply(waiting,
                                            title: console.ownerConfirmation?.title ?? taskID)
        } label: {
            Text(OwnerConfirmations.sendBackAction).approvalActionLabel()
        }
        .buttonStyle(.bordered)
        .disabled(deciding || !standing.answerable)
        // The same promise the card prints under these buttons, kept as a pointer's tooltip for a
        // mouse that hovers before it presses.
        .help(OwnerConfirmations.sendBackHint)
    }

    /// The press re-checks what the buttons were rendered from, so a race between a render and a tap
    /// cannot send an answer the standing says is dead.
    private func decide(_ standing: OwnerConfirmationStanding, _ decision: OwnerDecision,
                        note: String? = nil) {
        guard let waiting = standing.waiting, standing.answerable, !deciding else { return }
        PlatformHaptics.tap()
        deciding = true
        Task {
            await console.decideOwnerConfirmation(waiting, decision, note: note)
            deciding = false
        }
    }
}

/// The two boxes the owner decides from — what settles the task, and what the run reported — in the
/// browser card's order and its own words. Every visible string is a field of the read or the
/// card's copy; nothing is summarised.
private struct OwnerConfirmationBoxes: View {
    let acceptanceCriteria: String?
    let report: OwnerConfirmationReport?

    @State private var reportOpen = false

    private var criteria: String { OwnerConfirmations.plainText(acceptanceCriteria) }
    private var said: (text: String, folded: Bool) {
        OwnerConfirmations.foldedBody(report?.text)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: ApprovalMetrics.spacing) {
            box(OwnerConfirmations.whatSettlesIt) {
                quietOrText(criteria, OwnerConfirmations.noCriteria)
            }
            // The heading carries the moment the run said it, when it said anything — a report
            // whose time is missing is still a report.
            box(OwnerConfirmations.reportHeading(
                    report, time: report.flatMap { OwnerConfirmations.receiptTime($0.reportedAt) })) {
                quietOrText(said.text.isEmpty ? "" : said.text, OwnerConfirmations.noReport)
                if said.folded {
                    // The rest of it, one press away — never dropped: a report the owner cannot
                    // finish reading is a report they cannot decide from.
                    DisclosureToggle(open: reportOpen,
                                     label: reportOpen ? OwnerConfirmations.showLess
                                                       : OwnerConfirmations.showAll) {
                        reportOpen.toggle()
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func box<Content: View>(_ heading: String,
                                    @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(heading)
                .font(.orbitMonoFine).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            content()
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.05),
                    in: RoundedRectangle(cornerRadius: ApprovalMetrics.rowRadius))
    }

    /// A body that may be blank: the card says why rather than rendering an empty box.
    @ViewBuilder
    private func quietOrText(_ text: String, _ whenEmpty: String) -> some View {
        if text.isEmpty {
            Text(whenEmpty).font(.orbitProse).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            Text(text).font(.orbitProse)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// What a decision left in the conversation it was made in, drawn at the moment it was made: folded
/// to one line, because it is a record now and not a question. A confirmation opens to what settled
/// it — the task's acceptance criteria and the report the owner confirmed. A send-back needs no
/// fold: its reason is the owner's own message, right below it.
///
/// It is read back from the task's decisions rather than kept from the press, so a reload or another
/// device shows it too — web's `OwnerDecisionReceipt`.
private struct OwnerDecisionReceiptView: View {
    let console: ConsoleModel
    let taskID: String
    let decisionID: String
    @State private var open = false

    var body: some View {
        if let decided = console.ownerReceipt(taskID, decisionID),
           let view = console.ownerConfirmation {
            let confirmed = decided.decision == .confirm
            VStack(alignment: .leading, spacing: ApprovalMetrics.spacing) {
                ApprovalHeader(symbol: confirmed ? "checkmark.seal.fill" : "arrow.uturn.backward",
                               title: confirmed ? OwnerConfirmations.confirmedHeading
                                                : OwnerConfirmations.sentBackHeading,
                               tone: .blue)
                Text(CriteriaDecisions.provenanceLabel)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(view.title)
                    .font(.orbitProse.bold())
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(OwnerConfirmations.receiptLine(
                        decided, time: OwnerConfirmations.receiptTime(decided.decidedAt)))
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if confirmed {
                    DisclosureToggle(open: open,
                                     label: open
                                        ? "\(OwnerConfirmations.hideWhatSettledIt) ▴"
                                        : "\(OwnerConfirmations.showWhatSettledIt) ▾") {
                        open.toggle()
                    }
                    if open {
                        OwnerConfirmationBoxes(acceptanceCriteria: view.acceptanceCriteria,
                                               report: decided.report)
                    }
                }
            }
            // Dimmed for the reason the criteria card's receipt is: the question is over, and the
                // record should not read as something still waiting to be pressed.
            .approvalChrome(.blue, dimmed: true)
        }
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

// MARK: - the two cards a project's ruler is moved from

/// One question the server delivered into this conversation — about the project's acceptance
/// criteria, or about one revision of its tasks' completion evidence — dispatched by kind.
///
/// These wear the `ApprovalCard` shape — the same toned surface, the same header, the same
/// full-width actions — because they are answered the same way and by the same person, and a
/// second card language for "Orbit is asking you something" would be a second thing to learn. What
/// they are NOT is approvals: no `Approval` row exists behind them, nothing stops a turn waiting
/// for one, and the conversation goes on underneath them. That is why they are a row of their own
/// (`DeliveredDecisionCard`) anchored where they arrived, and why the amber bar at the top of this
/// console now points DOWN at them instead of leaving this session out.
///
/// Nothing here is composed from anything an agent said, and nothing is kept between renders except
/// the address: `console` re-derives the standing from the server's read on every body pass, which
/// is what makes the disabled state honest rather than a guess (OrbitKit `CriteriaDecision.swift`).
struct DeliveredDecisionCardView: View {
    let console: ConsoleModel
    let card: DeliveredDecisionCard

    var body: some View {
        Group {
            switch card.kind {
            case .criteriaDecision(let intentID):
                CriteriaDecisionCard(console: console, intentID: intentID)
            case .criteriaDecisionReceipt(let settled):
                CriteriaDecisionReceiptCard(settled: settled)
            case .acceptanceConfirmation:
                AcceptanceConfirmationCard(console: console)
            case .evidenceDecision(let taskID, let evidenceRevision):
                EvidenceDecisionCard(console: console, taskID: taskID,
                                     evidenceRevision: evidenceRevision)
            case .ownerConfirmation(let taskID, let requestID):
                OwnerConfirmationCardView(console: console, taskID: taskID, requestID: requestID)
            case .ownerDecisionReceipt(let taskID, let decisionID):
                OwnerDecisionReceiptView(console: console, taskID: taskID, decisionID: decisionID)
            case .evidenceDecisionReceipt(let decided):
                EvidenceDecisionReceiptCard(decided: decided)
            }
        }
        // A card re-derives itself when it comes into view, on top of the reads the console runs
        // when it loads and when the stream reconnects: the question this card is about can be
        // answered in a browser while a phone is asleep, and the phone has to find that out by
        // asking rather than by being told.
        .task {
            // Both reads, and each is a no-op where it does not apply: the project's questions
            // belong to a coordinator conversation, the confirmation to a task's run — and a
            // receipt of one of these cards is on screen in the same conversation as the card was.
            await console.refreshRulerQuestions()
            await console.refreshOwnerConfirmation()
        }
    }
}

/// The held loosening proposal: what an agent asked for, and the two answers only the account
/// owner can give.
///
/// Orange, like the tool-approval card, because it is the same kind of moment — something wants
/// permission to change something — and the badge says which kind of permission. The provenance is
/// on the META line and not in the badge slot: `ApprovalHeader` gives the title `layoutPriority(1)`
/// and truncates the badge in the middle, so `FROM ORBIT` would render as `FR…IT`.
private struct CriteriaDecisionCard: View {
    let console: ConsoleModel
    let intentID: String
    @State private var deciding = false
    @State private var proposalOpen = false

    private var standing: CriteriaDecisionStanding { console.criteriaStanding(intentID) }

    var body: some View {
        let standing = self.standing
        VStack(alignment: .leading, spacing: ApprovalMetrics.spacing) {
            ApprovalHeader(symbol: "exclamationmark.triangle.fill",
                           title: CriteriaDecisions.title,
                           tone: .orange,
                           badge: CriteriaDecisions.badge(standing))
            // The browser's longer heading, kept for the states where it is the VERDICT rather than
            // a restatement: on a live card the title already asked the question, and saying it
            // twice is how a card teaches its reader to skip the top of it.
            if !standing.answerable {
                Text(CriteriaDecisions.heading(standing))
                    .font(.orbitProse)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            // The mark, and which ruler this was drafted against — the one line that says this card
            // is the server's rather than the conversation's.
            Text(CriteriaDecisions.meta(standing))
                .font(.orbitLabel).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)

            if let row = standing.row {
                proposal(row)
                Text(CriteriaDecisions.nothingIsOnHold)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if case .unread = standing.state {
                // Nothing: the explanation below is the whole of what can be said.
                EmptyView()
            } else {
                // Deliberately blank of content. A settled or displaced proposal is not published
                // any more, and this card kept no copy — that is the property being bought.
                Text(CriteriaDecisions.goneBody)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            // Above the dead buttons, so it reads as the reason they are dead.
            if let stale = CriteriaDecisions.staleExplanation(standing) {
                Text(stale)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.orange.opacity(0.10),
                                in: RoundedRectangle(cornerRadius: ApprovalMetrics.rowRadius))
            }

            ApprovalActions {
                approveButton(standing)
                refuseButton(standing)
            }
        }
        .approvalChrome(.orange, dimmed: CriteriaDecisions.isDimmed(standing))
    }

    /// What the proposal would CHANGE — and, in one line, how much of the ruler it leaves alone.
    ///
    /// A criteria edit restates the whole collection, so a proposal that reworded three criteria out
    /// of eight arrives stating all eight. This card used to lay out all eight; the three that moved
    /// were buried in the other five. So the rows are the diff the server derived, and the untouched
    /// ones are folded away behind their count — folded rather than hidden, because "three reworded"
    /// and "the whole set replaced with three" are the same three rows until a reader is told how
    /// many did not move.
    private func proposal(_ row: PendingCriteriaDecisionRow) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            // The legend rides on the summary's line rather than taking one of its own: on a card
            // whose whole problem is height, a row spent saying what a strikethrough means is a row
            // not spent on the criteria — and this is the line a reader is already on when they
            // meet the first mark.
            (Text(CriteriaDecisions.changeSummary(row.diff)).bold()
                + Text(CriteriaDecisions.hasRewrite(row.diff)
                       ? "  \(CriteriaDecisions.inlineDiffLegend)" : ""))
                .font(.orbitLabel).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            ForEach(CriteriaDecisions.changeRows(row)) { change in
                changeRow(change)
            }
            // The reason the proposer gave, when the edit carried one — quoted, never summarised.
            ForEach(Array(reasons(row).enumerated()), id: \.offset) { _, reason in
                Text("“\(reason)”")
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.primary.opacity(0.05),
                                in: RoundedRectangle(cornerRadius: ApprovalMetrics.rowRadius))
            }
            unchanged(row)
        }
    }

    /// One criterion the proposal moves: what it would say — with, for a rewrite, the words it
    /// drops struck through IN PLACE inside the sentence they were dropped from — and what it is
    /// called. One paragraph and not two: laid out as the proposal's words followed by the
    /// record's, three rewrites of long Chinese criteria did not fit the card at all.
    private func changeRow(_ change: CriteriaDecisions.ChangeRow) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            (Text("\(change.ordinal). ").foregroundStyle(.secondary) + rewritten(change.words))
                .font(.orbitProse)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(change.badge)
                .font(.orbitLabel).foregroundStyle(.orange)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let method = change.method {
                (Text("\(CriteriaDecisions.methodLabel): ") + rewritten(method))
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// The server's cut as one run of text: what stayed, what goes struck through, what arrives
    /// underlined.
    ///
    /// Colour is never the only carrier — the strikethrough and the underline are the marks, and
    /// they survive a monochrome screen, Increase Contrast, and colour-blind vision, which a red
    /// and a green would not.
    private func rewritten(_ runs: [CriterionSegment]) -> Text {
        runs.reduce(Text("")) { line, run in
            switch run.side {
            case .kept:
                return line + Text(run.text)
            case .removed:
                return line + Text(run.text).strikethrough().foregroundStyle(.secondary)
            case .added:
                return line + Text(run.text).underline()
            }
        }
    }

    /// The criteria this proposal leaves word for word alone: their count always on screen, their
    /// words one tap away. Nothing at all when it leaves none alone — a card that said "0 criteria
    /// are unchanged" would be noise on the one card where the reader most needs the rows.
    @ViewBuilder
    private func unchanged(_ row: PendingCriteriaDecisionRow) -> some View {
        let rows = CriteriaDecisions.unchangedRows(row)
        if !rows.isEmpty {
            DisclosureToggle(open: proposalOpen,
                             label: CriteriaDecisions.unchangedLine(rows.count)) {
                proposalOpen.toggle()
            }
            if proposalOpen {
                ForEach(Array(rows.enumerated()), id: \.offset) { _, line in
                    Text(line)
                        .font(.orbitLabel).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    /// The reasons carried by the proposed criteria, in their order. Hoisted out of the view so the
    /// chain is type-checked once rather than inside a `ForEach`.
    private func reasons(_ row: PendingCriteriaDecisionRow) -> [String] {
        row.proposed.compactMap { nonEmpty($0.completionCriterionOverrideReason) }
    }

    /// The one rule both clients are under: an action that cannot succeed is disabled rather than
    /// lit and refused.
    private func approveButton(_ standing: CriteriaDecisionStanding) -> some View {
        Button { decide(standing, .approve) } label: {
            Text(CriteriaDecisions.approveLabel).approvalActionLabel()
        }
        .buttonStyle(.borderedProminent)
        .disabled(deciding || !standing.answerable)
    }

    private func refuseButton(_ standing: CriteriaDecisionStanding) -> some View {
        Button { decide(standing, .reject) } label: {
            Text(CriteriaDecisions.refuseLabel).approvalActionLabel()
        }
        .buttonStyle(.bordered)
        .disabled(deciding || !standing.answerable)
    }

    private func decide(_ standing: CriteriaDecisionStanding, _ answer: CriteriaDecisionAnswer) {
        guard let row = standing.row, standing.answerable, !deciding else { return }
        PlatformHaptics.tap()
        deciding = true
        Task {
            await console.decideCriteria(row, answer)
            deciding = false
        }
    }
}

/// The record of an answer to a held proposal, where the decision was made.
///
/// Green and ticked, with no actions and no badge: this is not a question any more, and the only
/// thing it has to do is say which way it went and when. It is drawn from the committed answer the
/// read publishes rather than kept by the window that pressed the button, so it is here after a
/// relaunch, on a device that never saw the card, and it is what the browser's receipt says, word
/// for word (`CriteriaDecisions.recordedHeading` / `receiptLine`).
private struct CriteriaDecisionReceiptCard: View {
    let settled: SettledCriteriaDecision

    var body: some View {
        VStack(alignment: .leading, spacing: ApprovalMetrics.spacing) {
            ApprovalHeader(symbol: "checkmark.circle.fill",
                           title: CriteriaDecisions.recordedHeading,
                           tone: .green)
            Text(CriteriaDecisions.receiptLine(settled))
                .font(.orbitProse)
                .frame(maxWidth: .infinity, alignment: .leading)
            // Who is speaking, on the line that is standing in for the card's meta row: the browser
            // puts the same mark on its receipt, and a record of a decision the owner made is no
            // more the agent's writing than the question was.
            Text(CriteriaDecisions.provenanceLabel)
                .font(.orbitMonoFine).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .approvalChrome(.green)
    }
}

/// The record of an answer to one revision of a task's evidence, where the decision was made.
///
/// Blue like the card it replaces — same question, answered — with no actions, and a green tick in
/// the header: it says which way it went, with which revision, and when, and the send-back's reason
/// under it when there was one. Drawn from the answer the read publishes (`decided`), not from the
/// window that pressed, so it is here after the console is opened again; the words are the
/// browser's, held by `EvidenceDecisionCopyParityTests`.
private struct EvidenceDecisionReceiptCard: View {
    let decided: RecordedEvidenceDecision

    var body: some View {
        VStack(alignment: .leading, spacing: ApprovalMetrics.spacing) {
            ApprovalHeader(symbol: "checkmark.circle.fill",
                           title: decided.recordedByAgent ? EvidenceDecisions.agentRecordedHeading
                                                          : EvidenceDecisions.recordedHeading,
                           tone: .blue)
            Text(decided.title)
                .font(.orbitProse.bold())
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(EvidenceDecisions.receiptLine(decided))
                .font(.orbitProse)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let note = decided.note, !note.isEmpty {
                Text("\(EvidenceDecisions.receiptReasonLabel)：\(note)")
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .approvalChrome(.blue)
    }
}

/// The settlement gate: whether this set of criteria, together, is what "done" means here — asked
/// at the moment the answer is still cheap, which is before the project is started rather than
/// after every criterion has been met by its work.
///
/// Blue and question-shaped — the same shape as `A question for you` and `Review this plan`, and
/// with no badge — because that is what it is: a question about meaning, which no machine answers.
///
/// TWO ACTIONS, AND THE READING TOGGLE IS NEITHER OF THEM
/// -----------------------------------------------------
/// Start, and talk about it first. Both go in the same action row every other card uses, at its
/// own sizes, and neither carries a subtitle. The criteria are on the card already, so opening
/// them whole is a reading control and sits with the text it unfolds rather than in that row; it
/// writes nothing and is never disabled, as on the browser's card.
private struct AcceptanceConfirmationCard: View {
    let console: ConsoleModel
    @State private var confirming = false
    @State private var criteriaOpen = false

    private var standing: StandardSetConfirmationStanding? { console.acceptanceConfirmation }

    var body: some View {
        let standing = self.standing
        VStack(alignment: .leading, spacing: ApprovalMetrics.spacing) {
            ApprovalHeader(symbol: "checkmark.seal.fill",
                           title: AcceptanceConfirmations.title,
                           tone: .blue)
            Text(AcceptanceConfirmations.meta(standing, started: console.projectStarted,
                                              projectTitle: console.projectTitle))
                .font(.orbitLabel).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)

            if let stale = AcceptanceConfirmations.staleExplanation(standing) {
                Text(stale)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.blue.opacity(0.08),
                                in: RoundedRectangle(cornerRadius: ApprovalMetrics.rowRadius))
            }
            criteria
            Text(AcceptanceConfirmations.startExplanation(count: items.count, standing: standing))
                .font(.orbitProse)
                .frame(maxWidth: .infinity, alignment: .leading)

            // Two stacked actions, at the system's default height. `.controlSize(.large)`'s 50pt
            // bars were turned down on 2026-08-14 for reading as bulky three deep; there are two
            // here now, which is what that note was asking for.
            ApprovalActions {
                startButton(standing)
                chatButton(standing)
            }
        }
        .approvalChrome(.blue, dimmed: AcceptanceConfirmations.isDimmed(standing))
    }

    private var items: [ProjectCriteriaDocument.Item] {
        console.projectCriteria.sorted { $0.ordinal < $1.ordinal }
    }

    /// The set itself, open. Load-bearing rather than decorative: a folded list is an invitation to
    /// sign what was never opened, and the version digest proves only WHICH wording was signed. The
    /// web card is under the project page's own criteria list, which is where its reader reads
    /// them; a phone has to carry them. Each condition is clamped to two lines so N of them stay
    /// one card; the toggle under them takes the clamp off.
    @ViewBuilder private var criteria: some View {
        if !items.isEmpty {
            ForEach(items) { item in
                HStack(alignment: .top, spacing: 8) {
                    Text("\(item.ordinal)")
                        .font(.orbitMonoFine).foregroundStyle(.secondary)
                        .frame(minWidth: 14, alignment: .trailing)
                    Text(item.text).font(.orbitProse).lineLimit(criteriaOpen ? nil : 2)
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            // A reading control, not a decision: it writes nothing, is never disabled, and stays
            // out of the action row so the card has the two answers the browser's has.
            Button {
                PlatformHaptics.tap()
                criteriaOpen.toggle()
            } label: {
                Text(criteriaOpen ? AcceptanceConfirmations.showLessLabel
                                  : AcceptanceConfirmations.readLabel(count: items.count))
                    .font(.orbitLabel)
                    .foregroundStyle(Color.blue)
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// One press: it records the confirmation AND starts the project, because saying what would
    /// settle a project is what authorises work on it.
    private func startButton(_ standing: StandardSetConfirmationStanding?) -> some View {
        Button {
            guard AcceptanceConfirmations.answerable(standing), !confirming else { return }
            PlatformHaptics.tap()
            confirming = true
            Task {
                await console.confirmStandardSet()
                confirming = false
            }
        } label: {
            Text(AcceptanceConfirmations.startLabel).approvalActionLabel()
        }
        .buttonStyle(.borderedProminent)
        .disabled(confirming || !AcceptanceConfirmations.answerable(standing))
    }

    /// Say what should change first. The same control, and the same word for it, as the other three
    /// cards that hand a reply to the composer (`Approvals.chatAction`): the card stays and `Start
    /// the project` stays live. Dead only where there is no version to talk about — a standing that
    /// could not be read names none.
    private func chatButton(_ standing: StandardSetConfirmationStanding?) -> some View {
        Button {
            guard let standing else { return }
            PlatformHaptics.tap()
            console.startPlanChangeReply(standing)
        } label: {
            Text(Approvals.chatAction).approvalActionLabel()
        }
        .buttonStyle(.bordered)
        .disabled(standing == nil)
    }
}
