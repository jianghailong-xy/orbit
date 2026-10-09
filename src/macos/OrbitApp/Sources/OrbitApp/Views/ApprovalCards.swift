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
        Group {
            switch approval.kind {
            case .question: QuestionCard(console: console, approval: approval)
            case .plan:     PlanCard(console: console, approval: approval)
            case .tool:     ToolApprovalCard(console: console, approval: approval)
            }
        }
        .environment(\.approvalReviewTarget, .approval(id: approval.id))
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
enum ApprovalMetrics {
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

extension View {
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
}

extension View {
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
struct ApprovalHeader: View {
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
/// a natural row. Wiki Review's cards answer through this same stack (`WikiReviewCard`).
struct ApprovalActions<Content: View>: View {
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
    @Environment(\.dismissApprovalReview) private var dismissReview
    let console: ConsoleModel
    let approval: PendingApproval

    /// The two folds a single create draws, and the card's own state: the description is written
    /// for the agent that will execute the task and the criteria is the owner's own ruler, so both
    /// are one press away rather than gone — and a press here must not reopen them on the next read
    /// of the transcript.
    @State private var descriptionOpen = false
    @State private var criteriaOpen = false

    private var rememberRules: [PermissionRule] {
        // A runtime that drops remember rules (Harness) gets Allow / Deny only.
        guard Approvals.rememberOffered(runtime: SessionProviderChoices.executingRuntime(
            console.provider, configured: console.configuredProviders)) else { return [] }
        return approval.input.map { Approvals.rememberRules(toolName: approval.toolName ?? "", input: $0) } ?? []
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
    /// Ending a project's blocker: the sentence the blocker was filed with — addressed to whoever
    /// reads this — over the agent's argument that it no longer applies. The two sentences are the
    /// decision; web renders the same pair under the same two captions.
    private var blocker: BlockerResolvePreview? {
        approval.input.flatMap {
            Approvals.blockerResolvePreview(toolName: approval.toolName ?? "", from: $0)
        }
    }

    /// The field written for the agent that will execute the task, folded to a line that carries its
    /// length. It is the longest thing on the card by an order of magnitude — 1.4k to 3.9k characters
    /// across the last twenty single creates in this deployment — and the one field nobody decides
    /// from: you are agreeing to the task, not reading its prompt.
    @ViewBuilder
    private func descriptionFold(_ create: CreateApprovalPreview) -> some View {
        let text = create.descriptionText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty {
            DisclosureToggle(open: descriptionOpen,
                             label: descriptionOpen
                                 ? Approvals.createFoldHide(create.foldNoun)
                                 : Approvals.createFold(create.foldNoun, text.count)) {
                descriptionOpen.toggle()
            }
            if descriptionOpen {
                // Opened, it is the Markdown the runner actually sent: headings, lists, fenced
                // commands — folded is a line, open is the document.
                MarkdownView(source: text).font(.orbitProse)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// What would settle it: the owner's own standard, so it stays on the card rather than moving
    /// into the same fold the prompt does. Folded at the same ceiling, and by the same helper, as
    /// the report on the owner-confirmation card — the same field deserves the same treatment in
    /// both places, and a criterion the owner cannot finish reading is one they cannot decide from.
    @ViewBuilder
    private func criteriaBlock(_ create: CreateApprovalPreview) -> some View {
        let full = OwnerConfirmations.plainText(create.criteriaText)
        let folded = OwnerConfirmations.foldedBody(create.criteriaText)
        if !full.isEmpty {
            Text(Approvals.createDoneWhen)
                .font(.orbitLabel).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(criteriaOpen ? full : folded.text)
                .font(.orbitLabel).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            if folded.folded {
                DisclosureToggle(open: criteriaOpen,
                                 label: criteriaOpen ? OwnerConfirmations.showLess
                                                     : OwnerConfirmations.showAll) {
                    criteriaOpen.toggle()
                }
            }
            // Approving a new project is not confirming its criteria: the start card asks that,
            // once the coordinator has a plan to start. Said here so this press is not read as it.
            if create.isProject {
                Text(Approvals.createCriteriaConfirmedAtStart)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    var body: some View {
        if batch != nil || dag != nil || blocker != nil {
            ApprovalReviewLayout(title: reviewTitle, symbol: "checklist", tone: .orange,
                                 summary: reviewSummary, grouped: batch != nil) {
                details
            } actions: {
                actions
            }
        } else {
            VStack(alignment: .leading, spacing: ApprovalMetrics.spacing) {
                details
                actions
            }
            .approvalChrome(.orange)
        }
    }

    private var reviewTitle: String {
        if let batch { return "Create \(batch.taskCount) tasks?" }
        if let dag { return "Restructure dependencies in \(dag.listTitle)?" }
        return "Resolve blocker"
    }

    private var reviewSummary: String {
        if let batch { return Approvals.batchImpactLines(batch).joined(separator: " · ") }
        if let dag { return "\(dag.ops.count) changes · \(dag.edgesBefore) → \(dag.edgesAfter) edges" }
        return blocker?.requiredAction ?? ""
    }

    private var actions: some View {
        ApprovalActions {
            allowButton
            if !rememberRules.isEmpty { rememberButton(rememberRules) }
            denyButton
        }
    }

    @ViewBuilder private var details: some View {
        if let batch {
            // No header of its own: the review's navigation bar already asks "Create 3 tasks?", and
            // the transcript's preview draws its own. The tasks are listed by level, each one push
            // from its page, which reads the full body the runner is about to send.
            BatchCreateReviewBody(batch: batch,
                                  details: approval.input.map(Approvals.batchTaskDetails) ?? [],
                                  close: dismissReview)
        } else if let dag {
            ApprovalHeader(symbol: "point.3.connected.trianglepath.dotted",
                           title: "Restructure dependencies in \(dag.listTitle)?",
                           tone: .orange, badge: "dependencies")
            OrbitAskBody(impact: Approvals.dagImpactLines(dag),
                         note: dag.note,
                         detail: "\(dag.edgesBefore) → \(dag.edgesAfter) edges",
                         rows: dag.ops.map { $0.noop ? "\($0.sentence) (already so)" : $0.sentence })
        } else if let create {
            // A single create wears the batch card's skeleton — the count, the consequence, where
            // it lands, the name in the tree's own slot — and folds the two fields that made it
            // a wall: the description is written for the agent that will execute it, and the
            // criteria is folded at the ceiling the owner-confirmation card already folds a
            // run's report at. Before this the whole of both fields was the card, and on a phone
            // the buttons sat three screens below the header.
            ApprovalHeader(symbol: create.isProject ? "folder.badge.plus" : "checklist",
                           // A project has no count to lead with, so it keeps its name up here —
                           // the same split web draws.
                           title: create.isProject
                               ? "Create project “\(create.title)”?"
                               : Approvals.createHeading,
                           tone: .orange, badge: create.isProject ? "new project" : "new task")
            VStack(alignment: .leading, spacing: 6) {
                ForEach(create.impactRows) { BatchImpactRowView(row: $0) }
                if !create.detail.isEmpty {
                    Text(create.detail).font(.orbitLabel).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if !create.titleLine.isEmpty {
                    Text(create.titleLine).font(.orbitProse)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                descriptionFold(create)
                criteriaBlock(create)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else if let blocker {
            // What it asked for is the headline; why the agent says that no longer applies is
            // the evidence under it — the same fork the batch card makes between counts and
            // titles, and the same order web reads these two sentences in.
            ApprovalHeader(symbol: "exclamationmark.octagon.fill",
                           title: blocker.projectTitle.isEmpty
                               ? "Unblock this blocker?"
                               : "Unblock “\(blocker.projectTitle)”?",
                           tone: .orange, badge: "blocker")
            if !blocker.about.isEmpty {
                Text(blocker.about)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            OrbitAskBody(impact: [],
                         note: blocker.requiredAction,
                         detail: "The agent says it no longer blocks",
                         rows: blocker.reason.isEmpty ? [] : [blocker.reason],
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
    }

    private var allowButton: some View {
        Button { decide(console, approval, .allow) } label: {
            Text(allowLabel)
                .approvalActionLabel()
        }
        .buttonStyle(.borderedProminent)
    }

    /// The yes, in the words of what it does. A batch names its count, because the question above
    /// it scrolls away on a long batch. Web's card says the same.
    private var allowLabel: String {
        if let batch { return Approvals.batchCreateAction(batch.taskCount) }
        if create != nil { return "Create it" }
        if dag != nil { return "Apply changes" }
        if blocker != nil { return "Resolve it" }
        return "Allow"
    }
    // Secondary "allow": same intent as Allow, so a bordered button (not plain text) that keeps
    // Allow the one filled/prominent action. The exact scope it will remember rides in monospace.
    private func rememberButton(_ rules: [PermissionRule]) -> some View {
        Button {
            decide(console, approval, .allow, remember: true)
        } label: {
            (Text("Allow & remember ") + Text(Approvals.rememberLabel(rules)).font(.orbitMono))
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
            dismissReview()
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
        if let blocker { return blocker.declineName }
        return approval.toolName ?? ""
    }
}

/// One consequence line of a restructure, in the card's own accent. The batch and single-create
/// cards draw theirs as `BatchImpactRowView`, with a mark per kind of consequence; a restructure's
/// lines carry no kind, so they keep the pill.
private struct ImpactPill: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.orbitLabel).fontWeight(.semibold)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(.tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 7))
    }
}

/// The body of the restructure and blocker cards: the consequence first and largest, then the
/// reason, then the rows it is made of.
private struct OrbitAskBody: View {
    let impact: [String]
    let note: String
    let detail: String
    let rows: [String]
    /// The note and rows are the agent's own prose — a create's description and its acceptance
    /// criteria, written as Markdown — so they render as Markdown, the way web draws both with its
    /// Markdown component. The DAG slots are sentences this app generates itself and stay literal
    /// (web draws the DAG note as a plain paragraph too).
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
                ImpactPill(text: line)
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
                    Text(verbatim: "• \(row)")
                        .font(.orbitLabel).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct QuestionCard: View {
    let console: ConsoleModel
    let approval: PendingApproval
    @Environment(ApprovalReviewDrafts.self) private var drafts
    @Environment(\.dismissApprovalReview) private var dismissReview
    private var draft: QuestionReviewDraft { drafts.question(approval.id) }

    private var questions: [AskQuestion] {
        approval.input.map { Approvals.parseQuestions(from: $0) } ?? []
    }
    private var allAnswered: Bool {
        Approvals.allAnswered(questions, selections: draft.selections, custom: draft.custom)
    }

    var body: some View {
        ApprovalReviewLayout(title: "A question for you", symbol: "questionmark.circle.fill", tone: .blue,
                             summary: "\(questions.count) question\(questions.count == 1 ? "" : "s")\n\(questions.first?.question ?? "")") {
            ForEach(questions) { q in questionBlock(q) }
        } actions: {
            ApprovalActions {
                submitButton
                chatButton
            }
        }
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
                   answers: Approvals.buildAnswers(questions, selections: draft.selections, custom: draft.custom))
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
            dismissReview()
            console.startChatReply(approvalID: approval.id,
                                   question: Approvals.chatReplyLabel(questions))
        } label: {
            Label("Chat about this", systemImage: "bubble.left.and.bubble.right")
                .approvalActionLabel()
        }
        .buttonStyle(.bordered)
    }

    private func isSelected(_ q: AskQuestion, _ label: String) -> Bool {
        draft.selections[q.question]?.contains(label) ?? false
    }
    private func toggle(_ q: AskQuestion, _ label: String) {
        var set = draft.selections[q.question] ?? []
        if q.multiSelect {
            if set.contains(label) { set.remove(label) } else { set.insert(label) }
        } else {
            set = [label]
            draft.custom[q.question] = ""           // single-select: a listed option and free text are exclusive
        }
        draft.selections[q.question] = set
    }
    /// Binding for a question's free-text field; for single-select, typing clears any picked option.
    private func customBinding(_ q: AskQuestion) -> Binding<String> {
        Binding(
            get: { draft.custom[q.question] ?? "" },
            set: { value in
                draft.custom[q.question] = value
                if !q.multiSelect, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    draft.selections[q.question] = []
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
            // Under the buttons rather than in the second one's tooltip: a touch screen has no
            // hover, so the one sentence saying the task stays open was unreadable on a phone.
            Text(EvidenceDecisions.sendBackHint)
                .font(.orbitLabel).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .approvalChrome(.blue)
    }

    // MARK: actions
    //
    // The one rule both clients are under: an action that cannot succeed is disabled rather than
    // lit and refused.

    /// 'Confirm done' answers on the press: there is no pick-then-Submit step in between.
    private func confirmButton(_ standing: EvidenceDecisionStanding) -> some View {
        Button { decide(standing, .confirm) } label: {
            Text(EvidenceDecisions.confirmAction).approvalActionLabel()
        }
        .buttonStyle(.borderedProminent)
        .disabled(deciding || !standing.answerable)
    }

    /// The reason does not get a box here: the press hands it to the main composer, which is where
    /// a message to this conversation is typed anyway, and the door's "no reason, no write" rule is
    /// then the composer's own refusal to send an empty line. The same control, and the same word
    /// for it (`Approvals.chatAction`), as the other four cards that hand a reply to the composer.
    private func sendBackButton(_ standing: EvidenceDecisionStanding) -> some View {
        Button {
            guard let row = standing.row else { return }
            PlatformHaptics.tap()
            console.startEvidenceSendBackReply(row)
        } label: {
            Text(Approvals.chatAction).approvalActionLabel()
        }
        .buttonStyle(.bordered)
        .disabled(deciding || !standing.answerable)
        // The same promise the card prints under these buttons, kept as a pointer's tooltip for a
        // mouse that hovers before it presses.
        .help(EvidenceDecisions.sendBackHint)
    }

    /// The press re-checks what the buttons were rendered from, so a race between a render and a
    /// tap cannot send an answer the standing says is dead. `Confirm done` is the only answer this
    /// card presses itself: a send-back is finished at the composer, which carries its reason.
    private func decide(_ standing: EvidenceDecisionStanding, _ decision: EvidenceDecisionAnswer) {
        guard let row = standing.row, standing.answerable, !deciding else { return }
        PlatformHaptics.tap()
        deciding = true
        Task {
            await console.decideEvidence(row, decision)
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
    /// The owner's answers to the review's questions, and the REVIEW record they answer: a newer
    /// review asks its own questions, and answers chosen for the old one are not carried over.
    @Environment(ApprovalReviewDrafts.self) private var drafts
    @Environment(\.dismissApprovalReview) private var dismissReview
    private var draft: OwnerReviewDraft { drafts.owner(requestID) }

    private var standing: OwnerConfirmationStanding { console.ownerStanding(taskID, requestID) }
    private var staleDetailLabel: String { staleDetailOpen ? "Hide details" : "Details" }

    /// The answers so far for the review this card draws now, and the way to change one.
    private func answers(_ review: OwnerConfirmationReviewView?) -> Binding<[String: ReviewChoice]> {
        let recordID = review?.review?.recordId
        return Binding(
            get: { draft.choicesFor == recordID ? draft.choices : [:] },
            set: { draft.choices = $0; draft.choicesFor = recordID })
    }

    var body: some View {
        let standing = self.standing
        if let returned = standing.returned {
            returnedRecord(returned)
        } else {
            question(standing)
        }
    }

    /// What the card becomes when its reviewer sent the report back (contract §8 B6): a record,
    /// with nothing to press — the owner was not asked, so the buttons are gone, not disabled.
    private func returnedRecord(_ returned: ReviewerReturnedRequest) -> some View {
        ApprovalReviewLayout(title: OwnerConfirmations.heading, symbol: "checkmark.seal.fill", tone: .blue,
                             summary: console.ownerConfirmation?.title ?? taskID, dimmed: true) {
            Text(CriteriaDecisions.provenanceLabel)
                .font(.orbitLabel).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .help(OwnerConfirmations.authorshipTitle)
            if let view = console.ownerConfirmation {
                lead(view)
            }
            OwnerConfirmationReviewBarView(review: returned.review, place: .card)
        } actions: {
            EmptyView()
        }
    }

    private func question(_ standing: OwnerConfirmationStanding) -> some View {
        ApprovalReviewLayout(title: OwnerConfirmations.heading, symbol: "checkmark.seal.fill", tone: .blue,
                             summary: console.ownerConfirmation?.title ?? taskID,
                             dimmed: !OwnerConfirmations.isOpen(standing)) {
            // The ruler card's mark, for its reason: this card is Orbit's rather than the agent's
            // typing, and a press goes to the door rather than into the conversation.
            Text(CriteriaDecisions.provenanceLabel)
                .font(.orbitLabel).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .help(OwnerConfirmations.authorshipTitle)

            if let view = console.ownerConfirmation {
                lead(view)
                OwnerConfirmationBoxes(acceptanceCriteria: view.acceptanceCriteria,
                                       report: standing.waiting?.report, foldsCriteria: true)
                // The reviewer's box, between what the agent said and what confirming sets off
                // (contract §6 H1): where the review stands, and its questions for the owner.
                if let review = standing.waiting?.review {
                    OwnerConfirmationReviewBarView(review: review, place: .card, choices: answers(review))
                }
                // Right above the buttons: the card is taller than a phone's screen, and this is
                // what is in view at the press. Only while this card's report is the one waiting —
                // the read describes the waiting run, and a card for another report must not
                // borrow its consequences.
                ifYouConfirm(view, standing)
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

        } actions: {
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

    /// What confirming sets off, or nothing — when the read says nothing, or this card's report is
    /// no longer the one waiting.
    @ViewBuilder
    private func ifYouConfirm(_ view: OwnerConfirmationView,
                              _ standing: OwnerConfirmationStanding) -> some View {
        let rows = standing.waiting == nil ? [] : OwnerConfirmations.ifConfirmedRows(view.ifConfirmed)
        if !rows.isEmpty {
            OwnerConfirmationIfYouConfirm(rows: rows)
        }
    }

    // MARK: actions
    //
    // The one rule both clients are under: an action that cannot succeed is disabled rather than
    // lit and refused.

    /// Disabled, besides a press in flight or a card that cannot be answered, only while one of the
    /// review's questions is answered with an Other that has no words yet: the door would refuse it
    /// (contract §6 H4). Nothing about the review's state holds it back.
    private func confirmButton(_ standing: OwnerConfirmationStanding) -> some View {
        let review = standing.waiting?.review
        return Button { decide(standing, .confirm) } label: {
            Text(OwnerConfirmations.confirmAction).approvalActionLabel()
        }
        .buttonStyle(.borderedProminent)
        .disabled(deciding || !standing.answerable
                  || !OwnerConfirmations.reviewAnswersComplete(review, choices: answers(review).wrappedValue))
    }

    /// The reason does not get a box here: the press hands it to the main composer, which is where
    /// a message to this session is typed anyway, and the door's "no reason, no write" rule is then
    /// the composer's own refusal to send an empty line.
    private func sendBackButton(_ standing: OwnerConfirmationStanding) -> some View {
        Button {
            guard let waiting = standing.waiting else { return }
            PlatformHaptics.tap()
            dismissReview()
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
        let chosen = answers(waiting.review).wrappedValue
        if decision == .confirm, !OwnerConfirmations.reviewAnswersComplete(waiting.review, choices: chosen) {
            return
        }
        PlatformHaptics.tap()
        deciding = true
        // What the card drew of the review rides with the press: the record it showed, and an answer
        // to each of its questions (contract §7 Q3).
        let review = OwnerConfirmations.reviewAnswered(waiting.review, choices: chosen)
        Task {
            await console.decideOwnerConfirmation(waiting, decision, note: note, review: review)
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
    /// Fold the criteria to one row that opens in place — the card's, whose buttons need the
    /// height. The receipt's own fold already stands in front of them.
    var foldsCriteria = false

    @State private var reportOpen = false
    @State private var criteriaOpen = false

    private var criteria: String { OwnerConfirmations.plainText(acceptanceCriteria) }
    private var said: String { OwnerConfirmations.plainText(report?.text) }
    private var folded: (text: String, folded: Bool) {
        OwnerConfirmations.foldedBody(report?.text)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: ApprovalMetrics.spacing) {
            if foldsCriteria, let items = OwnerConfirmations.criteriaItemsLabel(acceptanceCriteria) {
                criteriaFold(items)
            } else {
                box(OwnerConfirmations.whatSettlesIt) {
                    quietOrText(criteria, OwnerConfirmations.noCriteria)
                }
            }
            // The heading carries the moment the run said it, when it said anything — a report
            // whose time is missing is still a report.
            box(OwnerConfirmations.reportHeading(
                    report, time: report.flatMap { OwnerConfirmations.receiptTime($0.reportedAt) })) {
                quietOrText(reportOpen ? said : folded.text, OwnerConfirmations.noReport)
                if folded.folded {
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

    /// What counts as done, as one row at rest — the box's heading, how many items are behind it, a
    /// caret — that opens in place, in the same box. The whole row is the press, a full row tall on
    /// a phone.
    private func criteriaFold(_ items: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                PlatformHaptics.tap()
                criteriaOpen.toggle()
            } label: {
                HStack(spacing: 6) {
                    Text(OwnerConfirmations.whatSettlesIt)
                        .font(.orbitMonoFine).foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                    Text(items).font(.orbitLabel).foregroundStyle(.secondary)
                    Image(systemName: criteriaOpen ? "chevron.down" : "chevron.right")
                        .font(.orbitMeta).foregroundStyle(.tertiary)
                }
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, minHeight: ApprovalMetrics.rowMinHeight,
                       alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(.isButton)
            if criteriaOpen {
                quietOrText(criteria, OwnerConfirmations.noCriteria)
                    .padding(.bottom, 8)
            }
        }
        .padding(.horizontal, 10)
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

/// What confirming sets off, right above Confirm done — web's `OwnerConfirmationIfYouConfirm`. Orbit's
/// own facts rather than anybody's words, so it is drawn unlike the two boxes above it: white, a
/// symbol per row, and no author. Every line is a row `OwnerConfirmations.ifConfirmedRows` made.
private struct OwnerConfirmationIfYouConfirm: View {
    let rows: [OwnerConfirmations.IfConfirmedRow]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(OwnerConfirmations.ifYouConfirm)
                .font(.orbitMonoFine).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Image(systemName: Self.symbol(row.kind))
                        .font(.orbitLabel)
                        .foregroundStyle(row.kind == .start ? Color.accentColor : Color.secondary)
                        .frame(width: 18)
                    VStack(alignment: .leading, spacing: 1) {
                        // Wraps rather than truncates: in the transcript's list a row's first line
                        // was cut to one line (the probe's "Goes onto the integration line; mergin…").
                        lead(row)
                            .font(.orbitSubtext.weight(.semibold))
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if let detail = row.detail {
                            Text(detail)
                                .font(.orbitLabel).foregroundStyle(.secondary)
                                .lineLimit(1).truncationMode(.tail)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Self.fill, in: RoundedRectangle(cornerRadius: ApprovalMetrics.rowRadius))
        .overlay {
            RoundedRectangle(cornerRadius: ApprovalMetrics.rowRadius)
                .strokeBorder(Color.primary.opacity(0.12))
        }
    }

    /// The first line, with the branch's added lines after it in the diff's green.
    private func lead(_ row: OwnerConfirmations.IfConfirmedRow) -> Text {
        guard let added = row.added else { return Text(row.lead) }
        return Text(row.lead) + Text(" · ") + Text(added).foregroundStyle(Color.green)
    }

    private static func symbol(_ kind: OwnerConfirmations.IfConfirmedRow.Kind) -> String {
        switch kind {
        case .start: return "play.fill"
        case .branch: return "arrow.triangle.branch"
        case .landing: return "arrow.triangle.merge"
        case .endsSession: return "power"
        }
    }

    /// White on the blue card in light mode, and a raised grey in dark, where white would glare.
    private static var fill: Color {
        Color(light: .white, dark: Color(red: 0.17, green: 0.17, blue: 0.18))
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
    /// Reopen task's question, asked once before the write (the task panel's own).
    @State private var confirmingReopen = false

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
                    .help(OwnerConfirmations.authorshipTitle)
                Text(view.title)
                    .font(.orbitProse.bold())
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(OwnerConfirmations.receiptLine(
                        decided, time: OwnerConfirmations.receiptTime(decided.decidedAt)))
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if OwnerConfirmations.reviewCameInAfter(decided) {
                    Text(OwnerConfirmations.beforeReview)
                        .font(.orbitLabel).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                // The answered report's review as it stands now — including one that came in after
                // the decision — with Reopen task once the task has settled and the review found
                // problems (contract §9 L3–L4).
                if let review = decided.review {
                    OwnerConfirmationReviewBarView(
                        review: review, place: .receipt,
                        reopen: OwnerConfirmations.reopenOffered(view) ? { confirmingReopen = true } : nil)
                }
                OwnerAnswersView(lines: OwnerConfirmations.ownerAnswerLines(decided))
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
            // The task panel's own question and write (`TaskReopen`), so this is a second place to
            // press the one door rather than a door of its own.
            .orbitConfirmation(TaskReopenCopy.modalTitle, isPresented: $confirmingReopen) {
                Button(TaskReopenCopy.modalOK) {
                    Task { await console.reopenOwnerConfirmedTask() }
                }
                Button("Cancel", role: .cancel) { }
            } message: {
                Text(TaskReopen.paragraphs(projectId: view.projectId, terminalReason: nil)
                        .joined(separator: "\n\n"))
            }
        }
    }
}

// MARK: - the review bar

/// The reviewer's box — web's `OwnerConfirmationReviewBar`: on the card between what the agent said
/// and If you confirm, and under a receipt. Every line is one `OwnerConfirmations.reviewBar` made, the
/// same lines the browser draws (both are proved against the shared fixture). On the card it carries
/// the answer blocks for the reviewer's questions; under a receipt it offers Reopen task.
private struct OwnerConfirmationReviewBarView: View {
    let review: OwnerConfirmationReviewView
    let place: ReviewPlace
    /// The card's answers so far; nil draws no answer controls (a receipt, a record).
    var choices: Binding<[String: ReviewChoice]>? = nil
    /// Reopen task, when the task has settled; the bar draws it only where it offers it.
    var reopen: (() -> Void)? = nil

    @State private var oldOpen = false

    var body: some View {
        let bar = OwnerConfirmations.reviewBar(review, place: place) { OwnerConfirmations.receiptTime($0) }
        let items = OwnerConfirmations.reviewItemsByKey(review)
        VStack(alignment: .leading, spacing: 6) {
            head(bar)
            ForEach(Array(bar.lines.enumerated()), id: \.offset) { _, line in
                lineView(line, items: items)
            }
            if !bar.folded.isEmpty {
                DisclosureToggle(open: oldOpen, label: OwnerConfirmations.showOldReview) {
                    oldOpen.toggle()
                }
                if oldOpen {
                    ForEach(Array(bar.folded.enumerated()), id: \.offset) { _, line in
                        lineView(line, items: items)
                    }
                }
            }
            if bar.reopen, let reopen {
                Button {
                    PlatformHaptics.tap()
                    reopen()
                } label: {
                    Text(TaskReopenCopy.actionLabel).approvalActionLabel()
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.05),
                    in: RoundedRectangle(cornerRadius: ApprovalMetrics.rowRadius))
    }

    /// `REVIEW · <reviewer> · <time>`, the reviewer's name giving way before the label or the time,
    /// and the commit the record was written for at the right — struck through once out of date.
    private func head(_ bar: ReviewBar) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text("\(OwnerConfirmations.reviewHeading) · ")
                .font(.orbitMonoFine).foregroundStyle(.secondary)
                .fixedSize()
            Text(bar.reviewer)
                .font(.orbitMonoFine).foregroundStyle(.secondary)
                .lineLimit(1).truncationMode(.tail)
            if let time = bar.time {
                Text(" · \(time)")
                    .font(.orbitMonoFine).foregroundStyle(.secondary)
                    .fixedSize()
            }
            Spacer(minLength: 8)
            if let sha = bar.sha {
                Text(sha)
                    .strikethrough(bar.shaStruck)
                    .font(.orbitMonoFine).foregroundStyle(.secondary)
                    .fixedSize()
            }
        }
    }

    @ViewBuilder
    private func lineView(_ line: ReviewBar.Line, items: [String: ConfirmationReviewItem]) -> some View {
        switch line.kind {
        case .status:
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if let icon = line.icon {
                    Image(systemName: icon == .clock ? "clock" : "minus.circle")
                        .font(.orbitLabel).foregroundStyle(.secondary)
                }
                Text(line.text)
                    .font(.orbitProse.weight(.semibold))
                    .foregroundStyle(line.warn == true ? AnyShapeStyle(Color.orange) : AnyShapeStyle(.primary))
                Spacer(minLength: 0)
            }
        case .note, .footer:
            Text(line.text)
                .font(.orbitLabel).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .headline:
            // Orbit's first line: one line, the whole of it in the lines below.
            Text(line.text)
                .font(.orbitProse.weight(.semibold))
                .foregroundStyle(line.warn == true ? AnyShapeStyle(Color.orange) : AnyShapeStyle(.primary))
                .lineLimit(1).truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .answers:
            if let choices {
                ReviewAnswerBlocks(questions: OwnerConfirmations.reviewQuestions(review), choices: choices)
            }
        case .row:
            ReviewRowView(line: line, items: (line.keys ?? []).compactMap { items[$0] })
        case .quote:
            Text("“\(line.text)”")
                .font(.orbitProse)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// One of the reviewer's lists: its lines joined, two lines at most, opening in place to each line
/// with what it rests on (contract §6 H3). The whole row is the press.
private struct ReviewRowView: View {
    let line: ReviewBar.Line
    let items: [ConfirmationReviewItem]
    @State private var open = false

    var body: some View {
        Button {
            PlatformHaptics.tap()
            open.toggle()
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(line.label ?? "")
                    .font(.orbitLabel).foregroundStyle(labelTone)
                    .frame(width: 84, alignment: .leading)
                if open {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(items) { item in
                            VStack(alignment: .leading, spacing: 1) {
                                Text(item.text).font(.orbitSubtext)
                                if let why = item.whyNotProven {
                                    Text(why).font(.orbitLabel).foregroundStyle(.secondary)
                                }
                                if let instead = item.coordinatorChecked {
                                    Text(instead).font(.orbitLabel).foregroundStyle(.secondary)
                                }
                                ForEach(item.evidenceRefs ?? [], id: \.self) { ref in
                                    Text(ref).font(.orbitMonoFine).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Text(line.text)
                        .font(.orbitSubtext)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
        .accessibilityAddTraits(.isButton)
    }

    private var labelTone: Color {
        switch line.row {
        case .checked?: return .green
        case .notChecked?, .problem?: return .orange
        default: return .secondary
        }
    }
}

/// One block per question only the owner can decide (contract §7 Q2) — web's `ReviewAnswerBlocks`:
/// its options with the recommendation chosen and marked, then a row for the owner's own words. The
/// first question's words are the bar's first line already, so its block starts at its options. The
/// rows are the question card's (`CoordinatorQuestionCardView.choiceRow`), in its words.
private struct ReviewAnswerBlocks: View {
    let questions: [ConfirmationNeedsYouItem]
    @Binding var choices: [String: ReviewChoice]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(questions.enumerated()), id: \.element.key) { index, item in
                VStack(alignment: .leading, spacing: 6) {
                    if index > 0 {
                        Text(item.text)
                            .font(.orbitProse.bold())
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    ReviewEvidenceFold(refs: item.evidenceRefs ?? [])
                    ForEach(Array(item.options.enumerated()), id: \.offset) { optionIndex, option in
                        row(selected: choice(item) == .option(optionIndex), label: option.label,
                            why: option.description, recommended: optionIndex == item.recommendedOption) {
                            choices[item.key] = .option(optionIndex)
                        }
                    }
                    row(selected: isOther(item), label: CoordinatorQuestions.otherOption, why: nil,
                        recommended: false) {
                        if !isOther(item) { choices[item.key] = .other("") }
                    }
                    if isOther(item) {
                        TextField(item.text, text: otherWords(item), axis: .vertical)
                            .lineLimit(2...8)
                            .textFieldStyle(.plain)
                            .font(.orbitProse)
                            .padding(.horizontal, 10).padding(.vertical, 8)
                            .background(Color.blue.opacity(0.08),
                                        in: RoundedRectangle(cornerRadius: ApprovalMetrics.rowRadius))
                    }
                }
            }
            Text(OwnerConfirmations.answersSentWithConfirm)
                .font(.orbitLabel).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func choice(_ item: ConfirmationNeedsYouItem) -> ReviewChoice {
        OwnerConfirmations.reviewChoice(item, in: choices)
    }

    private func isOther(_ item: ConfirmationNeedsYouItem) -> Bool {
        if case .other = choice(item) { return true }
        return false
    }

    private func otherWords(_ item: ConfirmationNeedsYouItem) -> Binding<String> {
        Binding(
            get: {
                if case .other(let words) = choice(item) { return words }
                return ""
            },
            set: { choices[item.key] = .other($0) })
    }

    private func row(selected: Bool, label: String, why: String?, recommended: Bool,
                     pick: @escaping () -> Void) -> some View {
        Button {
            PlatformHaptics.tap()
            pick()
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .font(.orbitMeta)
                    .foregroundStyle(selected ? Color.blue : Color.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(label).font(.orbitProse)
                        if recommended {
                            Text(CoordinatorQuestions.recommended)
                                .font(.orbitLabel).foregroundStyle(Color.blue)
                        }
                    }
                    if let why {
                        Text(why).font(.orbitLabel).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(minHeight: ApprovalMetrics.rowMinHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : [.isButton])
    }
}

/// A question's evidence, folded under it (contract §7 Q2).
private struct ReviewEvidenceFold: View {
    let refs: [String]
    @State private var open = false

    var body: some View {
        if !refs.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                DisclosureToggle(open: open, label: OwnerConfirmations.reviewEvidence) { open.toggle() }
                if open {
                    ForEach(refs, id: \.self) { ref in
                        Text(ref)
                            .font(.orbitMonoFine).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }
}

/// A receipt's `Your answers` (contract §7 Q5): each question, then what was chosen or said — and,
/// for an answer an older app recorded, that the owner was never shown the question.
private struct OwnerAnswersView: View {
    let lines: [OwnerAnswerLine]

    var body: some View {
        if !lines.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(OwnerConfirmations.yourAnswers)
                    .font(.orbitLabel.bold()).foregroundStyle(.secondary)
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    VStack(alignment: .leading, spacing: 1) {
                        Text(line.text).font(.orbitSubtext)
                            .fixedSize(horizontal: false, vertical: true)
                        if line.notShown {
                            Text(OwnerConfirmations.answerNotShown)
                                .font(.orbitLabel).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct PlanCard: View {
    let console: ConsoleModel
    let approval: PendingApproval

    private var plan: String { approval.input?["plan"]?.stringValue ?? "Plan ready for review." }

    var body: some View {
        ApprovalReviewLayout(title: "Review this plan", symbol: "list.bullet.clipboard", tone: .purple,
                             summary: OwnerConfirmations.plainText(plan)) {
            MarkdownView(source: plan).font(.orbitProse).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        } actions: {
            ApprovalActions {
                approveButton
                keepPlanningButton
            }
        }
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
            case .startProject(let itemID):
                StartProjectCardView(console: console, itemID: itemID)
            case .projectDone:
                ProjectDoneCardView(console: console)
            case .projectNotDone:
                ProjectNotDoneCardView(console: console)
            case .criteriaChange:
                CriteriaChangeCardView(console: console)
            case .acceptanceConfirmationReceipt(let confirmed):
                AcceptanceConfirmationReceiptCard(confirmed: confirmed,
                                                  changed: console.confirmedChanges(confirmed))
            case .evidenceDecision(let taskID, let evidenceRevision):
                EvidenceDecisionCard(console: console, taskID: taskID,
                                     evidenceRevision: evidenceRevision)
            case .ownerConfirmation(let taskID, let requestID):
                OwnerConfirmationCardView(console: console, taskID: taskID, requestID: requestID)
            case .ownerDecisionReceipt(let taskID, let decisionID):
                OwnerDecisionReceiptView(console: console, taskID: taskID, decisionID: decisionID)
            case .evidenceDecisionReceipt(let decided):
                EvidenceDecisionReceiptCard(decided: decided)
            case .coordinatorQuestion(let itemID):
                CoordinatorQuestionCardView(console: console, itemID: itemID)
            case .escalatedItem(let itemID):
                OwnerItemCardView(console: console, itemID: itemID, isPause: false)
            case .fusePause(let itemID):
                OwnerItemCardView(console: console, itemID: itemID, isPause: true)
            case .promotionApproval(let promotionID):
                PromotionEventLine(console: console, promotionID: promotionID)
            case .promotionReceipt(let promotion):
                PromotionReceiptLine(promotion: promotion)
            }
        }
        .environment(\.approvalReviewTarget, .delivered(card))
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
        ApprovalReviewLayout(title: CriteriaDecisions.title, symbol: "exclamationmark.triangle.fill", tone: .orange,
                             summary: standing.row.map { CriteriaDecisions.changeSummary($0.diff) } ?? CriteriaDecisions.heading(standing),
                             dimmed: CriteriaDecisions.isDimmed(standing),
                             badge: CriteriaDecisions.badge(standing)) {
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

        } actions: {
            ApprovalActions {
                approveButton(standing)
                refuseButton(standing)
            }
        }
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
    @Environment(\.dismissApprovalReview) private var dismissReview
    let console: ConsoleModel
    @State private var confirming = false
    @State private var criteriaOpen = false

    private var standing: StandardSetConfirmationStanding? { console.acceptanceConfirmation }

    var body: some View {
        let standing = self.standing
        ApprovalReviewLayout(title: AcceptanceConfirmations.title, symbol: "checkmark.seal.fill", tone: .blue,
                             summary: "\(console.projectTitle) · \(items.count) criteria",
                             dimmed: AcceptanceConfirmations.isDimmed(standing)) {
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
            // Told in the project's own tense: a project already handing work out is being
            // re-confirmed, not started (`AcceptanceConfirmations.startExplanation`).
            Text(AcceptanceConfirmations.startExplanation(count: items.count, standing: standing,
                                                          started: console.projectStarted))
                .font(.orbitProse)
                .frame(maxWidth: .infinity, alignment: .leading)

            // Two stacked actions, at the system's default height. `.controlSize(.large)`'s 50pt
            // bars were turned down on 2026-08-14 for reading as bulky three deep; there are two
            // here now, which is what that note was asking for.
        } actions: {
            ApprovalActions {
                startButton(standing)
                chatButton(standing)
            }
        }
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
    /// settle a project is what authorises work on it. The word on it follows the project: a project
    /// that is already handing work out is being re-confirmed, and `Start the project` would name an
    /// act that is not available to it (`AcceptanceConfirmations.actionLabel`).
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
            Text(AcceptanceConfirmations.actionLabel(started: console.projectStarted))
                .approvalActionLabel()
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
            dismissReview()
            console.startPlanChangeReply(standing)
        } label: {
            Text(Approvals.chatAction).approvalActionLabel()
        }
        .buttonStyle(.bordered)
        .disabled(standing == nil)
    }
}

// MARK: - the record a confirmation leaves

/// The record of a confirmation of a project's standard set, where it was made.
///
/// The fourth receipt, beside `CriteriaDecisionReceiptCard` and `EvidenceDecisionReceiptCard` above
/// it and `OwnerDecisionReceiptView` below, and for their reason: a question leaves the conversation
/// when it is answered, so a record kept by the window that pressed it is a record the next open
/// takes away. Drawn from the door's own read (`AcceptanceConfirmations.receipt`), it names what was
/// signed — the count, and the seal of the version standing when it was signed, which is not always
/// the version standing now — by whom, and when.
///
/// Blue, like the card it replaces — the same question, answered — with a green tick and no actions,
/// and the provenance mark the other receipts carry: a record of a decision the owner made is no
/// more the agent's writing than the question was.
private struct AcceptanceConfirmationReceiptCard: View {
    let confirmed: RecordedStandardSetConfirmation
    /// What a re-confirmation pressed in this console changed — "1 new, 1 stricter" — when it knows
    /// (`ConsoleModel.confirmedChanges`); the read says only the seal.
    var changed: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: ApprovalMetrics.spacing) {
            ApprovalHeader(symbol: "checkmark.circle.fill",
                           title: AcceptanceConfirmations.receiptHeading,
                           tone: .blue)
            // A start says it started the project; any other confirmation says it confirmed the
            // criteria (`AcceptanceConfirmations.receiptLine`, off the record's own `startedWith`).
            Text(AcceptanceConfirmations.receiptLine(confirmed, changed: changed))
                .font(.orbitProse)
                .frame(maxWidth: .infinity, alignment: .leading)
            // …and a start's record says what the project was started WITH: the settings the owner
            // pressed, as the start recorded them, the ones changed from the coordinator's
            // suggestion in bold. Off the record, not off today's settings.
            if let started = confirmed.startedWith {
                RunSettingsSummaryText(settings: started.settings,
                                       differs: started.differsFromRequest)
                    .font(.orbitLabel).foregroundStyle(.secondary)
            }
            Text(AcceptanceConfirmations.receiptStamp(
                    OwnerConfirmations.receiptTime(confirmed.confirmedAt)))
                .font(.orbitMonoFine).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(CriteriaDecisions.provenanceLabel)
                .font(.orbitMonoFine).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .approvalChrome(.blue)
    }
}

// MARK: - the start card, and the card that asks again once the criteria move

/// "Start this project?" in a coordinator conversation — the one card on which the account owner
/// starts a project: the criteria it will be judged by, the plan its coordinator filed, and how it
/// runs, pressed once.
///
/// ASKED, NEVER INFERRED. It is delivered once the coordinator has asked to start
/// (`project_request_start`) and the plan passed Orbit's ready check — the open `START_REQUEST`
/// (`StartProject.live`) — and never because the project holds a task. The card keeps the address of
/// the request it was drawn for and nothing else: the settings the owner edits live on the console
/// (`startDraft(for:)`), so a row the List recycles comes back with them, and everything else is
/// re-derived from the reads on every render. A request that stops standing leaves the card on
/// screen, dimmed, with Start dead and the reason above it (`StartProject.Standing`).
///
/// What it draws is `StartProjectCard` below, which the project page's own "Start…" opens too.
private struct StartProjectCardView: View {
    let console: ConsoleModel
    let itemID: String

    var body: some View {
        let standing = console.startStanding(itemID)
        if let row = console.startRequestRow, row.itemId == itemID,
           let request = row.startRequest {
            StartProjectCard(
                projectID: console.projectID ?? "",
                projectTitle: console.projectTitle,
                askedAt: row.waitingSince,
                request: request,
                criteria: console.projectCriteria.sorted { $0.ordinal < $1.ordinal },
                plan: StartProject.planView(graph: console.projectGraph,
                                            fallbackCount: console.projectTaskCount),
                escalationSeconds: console.projectEscalationSeconds,
                draft: console.startDraft(for: row),
                standing: standing,
                onDraft: { console.setStartDraft($0, for: itemID) },
                onStart: { await console.startProject(itemID: itemID) },
                // The tasks the plan names, in the list this conversation's agent created them in
                // — the same list the tray below the transcript opens.
                onViewTasks: { _ = console.openCreatedTasks() },
                // Say what should change before it starts: the same control, and the same word for
                // it, as the other cards that hand a reply to the composer. The card stays, and
                // Start stays live.
                onChatAbout: {
                    console.startPlanChangeReply(criteriaDigest: request.criteriaDigest, question: .start)
                },
                graph: console.projectGraph)
        } else {
            VStack(alignment: .leading, spacing: ApprovalMetrics.spacing) {
                ApprovalHeader(symbol: "play.fill", title: StartProject.title, tone: .blue)
                // Nothing left to draw from: the request this card was drawn for is not the one the
                // console holds. Said, rather than drawn blank.
                Text(StartProject.requestGone)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .approvalChrome(.blue, dimmed: !StartProject.isOpen(standing))
        }
    }
}

/// "Is this project done?" in a coordinator conversation — the card on which the account owner
/// records the project done, once its coordinator asked (`project_request_done`) or its row says
/// Record as done… — and, once it is recorded, that card's receipt, in place.
///
/// Everything is re-derived from the console's reads on every render: the request the card answers
/// is the one standing now (`ProjectDone.live`), so a request the coordinator filed again is this
/// card with the new request in it. What it draws is `ProjectDoneCard`, which the project page's
/// own Review and Record as done… open too.
///
/// Drawn whole where it arrived, not as a preview that opens a review: the card is the question
/// and its receipt is the answer left in the conversation (mock ⑤ ①–③, the browser's
/// `SessionProjectSettlementCard`), so neither hides behind a press. Clearing the review target
/// is what puts `ApprovalReviewLayout` on its whole-card path.
private struct ProjectDoneCardView: View {
    let console: ConsoleModel

    var body: some View {
        if let subject = console.projectDone {
            let row = console.doneRequestRow
            ProjectDoneCard(
                subject: subject,
                request: row?.doneRequest,
                askedAt: row?.waitingSince,
                confirmedAt: console.acceptanceConfirmation?.confirmation?.confirmedAt,
                openItems: ProjectDone.openItemsCount(console.openItems),
                running: ProjectDone.runningCount(subject),
                record: console.doneRecord,
                sealRead: row?.doneRequest != nil
                    || console.acceptanceConfirmation?.currentVersion.digest != nil,
                onRecord: { await console.recordProjectDone() },
                onNotYet: row == nil ? nil : { await console.declineDoneRequest(note: $0) },
                onReopen: { await console.reopenProject() })
                .environment(\.approvalReviewTarget, nil)
        }
    }
}

/// "Why is this project not done?" in a coordinator conversation: the criteria the projection is
/// waiting on, grouped by what they need — and, while the work has nobody on it, the one press that
/// hands the card's facts to the coordinator this conversation is with.
private struct ProjectNotDoneCardView: View {
    let console: ConsoleModel

    var body: some View {
        if let subject = console.projectDone {
            ProjectNotDoneCard(
                subject: subject,
                withCoordinator: console.openItems?.withCoordinator.count ?? 0,
                askedAt: nil,
                onAskCoordinator: { Task { await console.askCoordinatorAboutDone() } })
        }
    }
}

/// The start card itself, drawn from what it is given: the conversation's card above, and the
/// project page's own "Start…" (`ProjectsView`), which opens this same card over the page for a
/// project nobody has asked about — web's `StartProjectCard`, shared the same way by
/// `SessionStartProjectCard` and `OwnerStartProjectCard`.
///
/// It answers three questions, in order (mocks: docs/mocks/start-card-redesign, v2): what done is —
/// the criteria a press confirms, open; how much is delegated and what still comes to the owner —
/// Automatic, on by default, with the list of what it leaves the owner under it; and the plan, by
/// level. Start sits in the review's bottom bar with the line saying what pressing it does. The ready
/// check's warnings are the coordinator's and are not drawn (the owner, 2026-10-07).
///
/// A card no coordinator asked for (`askedAt` nil) carries the default rule's settings rather than a
/// suggestion, quotes nobody, and has no Chat about this, which has no conversation to hand a reply
/// to there. Every word is OrbitKit's `StartProject` / `RunSettings`, held to the browser's
/// `lib/projectStart.ts` by `StartProjectCardCopyParityTests`.
struct StartProjectCard: View {
    let projectID: String
    let projectTitle: String
    /// When the coordinator asked; nil for a card nobody asked for.
    let askedAt: String?
    let request: ProjectStartRequest
    /// The criteria a press confirms, in order.
    let criteria: [ProjectCriteriaDocument.Item]
    let plan: StartPlanView
    /// Whether the project has a coordinator to run it — always, once one asked. A start with
    /// Automatic on opens the first one, and the card says so.
    var hasCoordinator: Bool = true
    /// How long a problem waits on the coordinator before it reaches the owner.
    var escalationSeconds: Int = StartProject.defaultEscalationSeconds
    /// The settings as the owner has left them.
    let draft: StartSettingsDraft
    let standing: StartProject.Standing
    let onDraft: (StartSettingsDraft) -> Void
    let onStart: () async -> Void
    let onViewTasks: () -> Void
    /// Hands a reply to the conversation's composer. Nil where there is no conversation to talk in —
    /// the card opened over the project page — and then the press is not drawn.
    var onChatAbout: (() -> Void)? = nil
    /// A press the door did not take, in its own words.
    var error: String? = nil
    /// The dependency graph `plan` was read off, which the Plan draws while the whole of it fits.
    var graph: ProjectDependencyGraph? = nil
    /// Opens one task of the plan; where there is no such press, a task opens the way View tasks
    /// does.
    var onOpenTask: ((String) -> Void)? = nil
    @Environment(\.dismissApprovalReview) private var dismissReview
    @State private var starting = false
    @State private var criteriaOpen = false
    @State private var whyOpen = false
    @State private var mergeCheckOpen = false
    /// Whether the clamps hide anything: More and Read all are drawn only while they do (or once
    /// opened), since a toggle for words already in full would open nothing.
    @State private var whyCut = false
    @State private var cutCriteria: Set<String> = []
    @State private var planWidth: CGFloat = 0
    @State private var graphOpen = false
    @State private var graphExpanded: Set<String> = []

    /// Whether a coordinator asked for this card.
    private var asked: Bool { askedAt != nil }
    /// A start that turns Automatic on for a project nobody coordinates opens its first coordinator.
    private var opensCoordinator: Bool { draft.automatic && !hasCoordinator }

    var body: some View {
        ApprovalReviewLayout(title: StartProject.title, symbol: "play.fill", tone: .blue,
                             summary: "\(projectTitle) · \(criteria.count) criteria · \(plan.count) tasks",
                             dimmed: !StartProject.isOpen(standing)) {
            content
        } actions: {
            ApprovalActions {
                startButton
                if let onChatAbout { chatButton(onChatAbout) }
            }
            Text(StartProject.barCaption(opensCoordinator: opensCoordinator, startsNow: plan.startsNow,
                                         criteria: criteria.count,
                                         seal: CriteriaDecisions.shortSeal(request.criteriaDigest)))
                .font(.orbitMeta).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder
    private var content: some View {
        let editable = standing == .live && !starting
        header
        if let stale = StartProject.staleExplanation(standing) {
            Text(stale)
                .font(.orbitLabel).foregroundStyle(.secondary)
                .padding(.horizontal, 10).padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.blue.opacity(0.08),
                            in: RoundedRectangle(cornerRadius: ApprovalMetrics.rowRadius))
        }

        StartSectionHead(title: StartProject.doneWhenHead(criteria.count))
        criteriaList
        Text(StartProject.explanation(criteria.count))
            .font(.orbitLabel).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
        howItRunsSection(editable: editable)
        planSection
        if let error {
            Text(error)
                .font(.orbitLabel).foregroundStyle(Color.red)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Who is asking, and in their own words: the card is the coordinator asking to begin.
    @ViewBuilder
    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(projectTitle).font(.orbitProse.weight(.semibold))
            Text(asked ? StartProject.askedLine(askedAt.flatMap { RelativeTime.format($0) })
                       : StartProject.nobodyAskedLine(hasCoordinator: hasCoordinator))
                .font(.orbitLabel).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        if asked, !request.why.isEmpty {
            StartPanel {
                VStack(alignment: .leading, spacing: 4) {
                    Label(StartProject.coordinator, systemImage: "bubble.left.fill")
                        .font(.orbitLabel).foregroundStyle(.secondary)
                    ClampedText(text: request.why, font: .orbitSubtext, lineLimit: whyOpen ? nil : 3) { whyCut = $0 }
                    if whyOpen || whyCut {
                        Button {
                            PlatformHaptics.tap()
                            whyOpen.toggle()
                        } label: {
                            Text(whyOpen ? StartProject.less : StartProject.more)
                                .font(.orbitLabel).foregroundStyle(Color.blue)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .startRow()
            }
        }
    }

    /// The criteria, open, each clamped to two lines, the toggle taking the clamp off while the clamp
    /// hides anything — the confirmation card's rule, for its reason: a folded list is an invitation
    /// to sign unread.
    @ViewBuilder private var criteriaList: some View {
        if !criteria.isEmpty {
            ForEach(criteria) { item in
                HStack(alignment: .top, spacing: 8) {
                    Text("\(item.ordinal)")
                        .font(.orbitMonoFine).foregroundStyle(.secondary)
                        .frame(minWidth: 14, alignment: .trailing)
                    ClampedText(text: item.text, font: .orbitProse, lineLimit: criteriaOpen ? nil : 2) { cut in
                        cutCriteria = cut ? cutCriteria.union([item.id]) : cutCriteria.subtracting([item.id])
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if criteriaOpen || !cutCriteria.isEmpty {
                Button {
                    PlatformHaptics.tap()
                    criteriaOpen.toggle()
                } label: {
                    Text(criteriaOpen ? AcceptanceConfirmations.showLessLabel
                                      : AcceptanceConfirmations.readLabel(count: criteria.count))
                        .font(.orbitLabel)
                        .foregroundStyle(Color.blue)
                }
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    // MARK: How it runs — Automatic and what still comes to the owner, then the rest

    /// Automatic first, with what it leaves the owner listed under it — the switch's consequence,
    /// not a description of it — then the three settings that can change later, one row each, and
    /// whose settings these are.
    @ViewBuilder
    private func howItRunsSection(editable: Bool) -> some View {
        StartSectionHead(title: StartProject.howItRuns)
        StartPanel {
            automaticRow(editable: editable)
            Divider()
            lineRow(editable: editable)
            Divider()
            mergeCheckRow(editable: editable)
            Divider()
            atMostRow(editable: editable)
        }
        Text(StartProject.howItRunsNote(asked: asked, suggestedOff: asked && !request.settings.automatic))
            .font(.orbitLabel).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func update(_ change: (inout StartSettingsDraft) -> Void) {
        var next = draft
        change(&next)
        onDraft(next)
    }

    /// Automatic, the sentence for the line and merge check chosen, the coordinator a start opens
    /// when the project has none, and the list of what still comes to the owner.
    private func automaticRow(editable: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            // The label is its own Text and the switch trails it, on both platforms: macOS draws a
            // bare Toggle as a checkbox in front of its label.
            HStack(spacing: 8) {
                Text(RunSettings.automatic).font(.orbitProse)
                Spacer(minLength: 8)
                Toggle(RunSettings.automatic,
                       isOn: Binding(get: { draft.automatic },
                                     set: { on in update { $0.automatic = on } }))
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .disabled(!editable)
            }
            Text(RunSettings.automaticSays(automatic: draft.automatic, line: draft.line,
                                           hasMergeCheck: draft.hasMergeCheck))
                .font(.orbitLabel).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            if opensCoordinator {
                Label(StartProject.opensCoordinator, systemImage: "sparkle")
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            comesToYou
        }
        .startRow()
    }

    /// What still comes to the owner once the project starts with these settings.
    private var comesToYou: some View {
        let items = StartProject.comesToYou(automatic: draft.automatic, line: draft.line,
                                            ownerConfirmed: plan.ownerConfirmed,
                                            evidenceJudged: plan.evidenceJudged,
                                            escalationSeconds: escalationSeconds)
        return VStack(alignment: .leading, spacing: 5) {
            Text(StartProject.comesToYou)
                .font(.orbitMeta.weight(.semibold)).foregroundStyle(Color.blue)
                .textCase(.uppercase)
            ForEach(items) { item in
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    Image(systemName: "person.fill").font(.orbitMeta).foregroundStyle(Color.blue)
                    (Text(item.text)
                        + Text(verbatim: item.detail.map { " · \($0)" } ?? "").foregroundStyle(.secondary))
                        .font(.orbitSubtext)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.blue.opacity(0.10), in: RoundedRectangle(cornerRadius: ApprovalMetrics.rowRadius))
    }

    /// Where finished tasks land, picked from the platform's own menu: each option with the sentence
    /// that says what choosing it means, and the one chosen ticked. The branch's own name is in the
    /// menu, under its option.
    private func lineRow(editable: Bool) -> some View {
        HStack(spacing: 8) {
            Text(RunSettings.tasksLandOn).font(.orbitProse)
            Spacer(minLength: 8)
            Menu {
                // A Toggle rather than a Button: a menu item's second Text is its subtitle only in
                // this shape, and the tick is drawn for the one that is on.
                Toggle(isOn: lineBinding(.projectBranch, draft)) {
                    Text(RunSettings.lineProjectBranch)
                    Text("\(StartProject.branch(request, projectID: projectID)) — \(RunSettings.lineProjectBranchHint)")
                }
                Toggle(isOn: lineBinding(.main, draft)) {
                    Text(RunSettings.lineMain)
                    Text(RunSettings.lineMainHint)
                }
            } label: {
                HStack(spacing: 4) {
                    Text(draft.line == .main ? RunSettings.lineMain : RunSettings.lineProjectBranch)
                        .lineLimit(1)
                    // macOS draws its own disclosure mark beside a borderless menu's title.
                    #if os(iOS)
                    Image(systemName: "chevron.up.chevron.down").font(.orbitMeta)
                    #endif
                }
                .font(.orbitProse)
                .foregroundStyle(Color.blue)
            }
            .borderlessMenuStyle()
            // Held to its label's size on macOS, as the window probe drew it; on iOS the row lays it
            // out beside the Spacer.
            #if os(macOS)
            .fixedSize()
            #endif
            .disabled(!editable)
        }
        .startRow()
    }

    private func lineBinding(_ line: IntegrationLine, _ draft: StartSettingsDraft) -> Binding<Bool> {
        Binding(get: { draft.line == line },
                set: { on in
                    guard on else { return }
                    PlatformHaptics.tap()
                    update { $0.line = line }
                })
    }

    /// The check run on the combined tree before anything lands, folded to its value — Set, or None
    /// with what that means — and opened to its command. An empty one is a setting like any other.
    private func mergeCheckRow(editable: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                PlatformHaptics.tap()
                mergeCheckOpen.toggle()
            } label: {
                HStack(spacing: 8) {
                    Text(RunSettings.mergeCheck).font(.orbitProse).foregroundStyle(.primary)
                    Spacer(minLength: 8)
                    Text(draft.hasMergeCheck ? RunSettings.mergeCheckSet : RunSettings.mergeCheckNone)
                        .font(.orbitProse).foregroundStyle(.secondary)
                    Image(systemName: mergeCheckOpen ? "chevron.up" : "chevron.right")
                        .font(.orbitMeta).foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if mergeCheckOpen {
                TextField(RunSettings.mergeCheckPlaceholder,
                          text: Binding(get: { draft.mergeCheckCommand },
                                        set: { command in update { $0.mergeCheckCommand = command } }),
                          axis: .vertical)
                    .font(.orbitMono)
                    .textFieldStyle(.plain)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
                    .disabled(!editable)
                Text(RunSettings.mergeCheckHint)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if !draft.hasMergeCheck {
                Text(RunSettings.mergeCheckNoneSays)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .startRow()
    }

    /// How many tasks may be in flight at once, within the door's own bounds.
    private func atMostRow(editable: Bool) -> some View {
        HStack(spacing: 8) {
            Text(RunSettings.atMost).font(.orbitProse)
            Spacer(minLength: 8)
            Text("\(draft.maxConcurrentTasks) \(RunSettings.tasksAtATime(draft.maxConcurrentTasks))")
                .font(.orbitProse).foregroundStyle(.secondary)
                .lineLimit(1)
            Stepper(RunSettings.atMost,
                    value: Binding(get: { draft.maxConcurrentTasks },
                                   set: { count in update { $0.maxConcurrentTasks = count } }),
                    in: 1...StartProject.maxConcurrentTasks)
                .labelsHidden()
                .fixedSize()
                .disabled(!editable)
        }
        .startRow()
    }

    // MARK: the plan, as the task graph or by level

    /// The plan: the project page's task graph while the whole of it fits the card at
    /// `StartProject.planGraphMinFit` or better — what waits on what, task by task — and otherwise
    /// by level (what starts now, what runs side by side, the task that needs the owner, the
    /// batch-create review's rule) with the graph a press away. A drawn graph's rows are its
    /// layout's, so its head counts tasks only (docs/mocks/start-card-web-width, board 02).
    @ViewBuilder
    private var planSection: some View {
        let drawn = StartProject.planGraph(graph, availableWidth: Double(planWidth))
        StartSectionHead(title: StartProject.planHead(plan.count, levels: drawn == nil ? (plan.levels?.count ?? 1) : 1))
        StartPanel {
            VStack(alignment: .leading, spacing: 8) {
                if let drawn {
                    let scale = CGFloat(drawn.scale)
                    ProjectGraphCanvas(layout: drawn.layout, edges: drawn.edges) { mark in
                        if mark.kind == .task { openTask(mark.taskId ?? mark.id) }
                    }
                    .scaleEffect(scale, anchor: .topLeading)
                    .frame(width: CGFloat(drawn.layout.width) * scale, height: CGFloat(drawn.layout.height) * scale,
                           alignment: .topLeading)
                    .frame(maxWidth: .infinity, alignment: .center)
                } else if let levels = plan.levels {
                    ForEach(Array(levels.enumerated()), id: \.offset) { at, level in
                        planLevel(at + 1, level)
                    }
                }
                HStack(spacing: 14) {
                    Button {
                        PlatformHaptics.tap()
                        dismissReview()
                        onViewTasks()
                    } label: {
                        Text(StartProject.viewTasks).font(.orbitSubtext).foregroundStyle(Color.blue)
                    }
                    .buttonStyle(.plain)
                    if graph != nil, drawn == nil {
                        Button {
                            PlatformHaptics.tap()
                            graphOpen = true
                        } label: {
                            Label(StartProject.taskGraph, systemImage: "arrow.up.left.and.arrow.down.right")
                                .font(.orbitSubtext).foregroundStyle(Color.blue)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                GeometryReader { geo in
                    Color.clear.onChange(of: geo.size.width, initial: true) { _, width in planWidth = width }
                }
            }
            .startRow()
        }
        #if os(iOS)
        .fullScreenCover(isPresented: $graphOpen) { graphFullScreen }
        #else
        .sheet(isPresented: $graphOpen) { graphFullScreen.frame(minWidth: 720, minHeight: 520) }
        #endif
    }

    /// The project page's task graph full screen, for a plan the card lists by level.
    @ViewBuilder private var graphFullScreen: some View {
        if let graph {
            ProjectGraphFullScreen(graph: graph, expanded: $graphExpanded, onOpenTask: openTask)
        }
    }

    /// One task of the plan, opened: by the page's own press where there is one, otherwise the way
    /// View tasks opens the plan's tasks.
    private func openTask(_ taskID: String) {
        dismissReview()
        if let onOpenTask { onOpenTask(taskID) } else { onViewTasks() }
    }

    private func planLevel(_ number: Int, _ level: [StartPlanLevelTask]) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("\(number)")
                .font(.orbitMeta.weight(.semibold)).foregroundStyle(.secondary)
                .frame(width: 18, height: 18)
                .overlay(Circle().strokeBorder(Color.secondary.opacity(0.4)))
            if let only = level.first, level.count == 1 {
                Text(only.label).font(.orbitSubtext.weight(.semibold))
                Text(StartProject.planTaskRest(only.title, label: only.label))
                    .font(.orbitSubtext).lineLimit(1)
                Spacer(minLength: 4)
                if only.now { StartPlanPill(text: StartProject.now, tint: .green) }
                if only.you { StartPlanPill(text: StartProject.you, tint: .blue) }
            } else {
                Text(level.map(\.label).joined(separator: " · ")).font(.orbitSubtext.weight(.semibold))
                Spacer(minLength: 4)
                Text(StartProject.inParallel(level.count)).font(.orbitLabel).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: the two answers

    /// One press, one write: the criteria confirmed by the seal the card names, and every setting as
    /// the card shows it (`StartProject.body`). Live only while the request stands and the draft is
    /// one the door would take.
    private var startButton: some View {
        Button {
            guard standing == .live, draft.complete, !starting else { return }
            PlatformHaptics.tap()
            starting = true
            Task {
                await onStart()
                starting = false
            }
        } label: {
            Text(StartProject.action).approvalActionLabel()
        }
        .buttonStyle(.borderedProminent)
        .disabled(starting || standing != .live || !draft.complete)
    }

    /// Chat about this, where there is a conversation to talk in.
    private func chatButton(_ chat: @escaping () -> Void) -> some View {
        Button {
            PlatformHaptics.tap()
            dismissReview()
            chat()
        } label: {
            Text(Approvals.chatAction).approvalActionLabel()
        }
        .buttonStyle(.bordered)
        .disabled(criteria.isEmpty)
    }
}

/// Text clamped to `lineLimit` lines that says whether the clamp hides any of it: the same words,
/// laid out unclamped at the same width and never shown, measured against what is drawn. The start
/// card draws its More and Read all only while this says so — a toggle for words already shown in
/// full would open nothing (docs/mocks/start-card-web-width, the browser's `useClampHides`).
private struct ClampedText: View {
    let text: String
    let font: Font
    let lineLimit: Int?
    let onCut: (Bool) -> Void

    @State private var drawn: CGFloat = 0
    @State private var whole: CGFloat = 0

    var body: some View {
        Text(text).font(font).lineLimit(lineLimit)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                GeometryReader { geo in
                    Color.clear.onChange(of: geo.size.height, initial: true) { _, height in
                        drawn = height
                        onCut(whole > height + 1)
                    }
                }
            }
            .background(alignment: .topLeading) {
                Text(text).font(font)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .hidden()
                    .background {
                        GeometryReader { geo in
                            Color.clear.onChange(of: geo.size.height, initial: true) { _, height in
                                whole = height
                                onCut(height > drawn + 1)
                            }
                        }
                    }
                    .accessibilityHidden(true)
            }
    }
}

/// "Now" and "You" beside a task of the plan.
private struct StartPlanPill: View {
    let text: String
    let tint: Color

    var body: some View {
        Text(text)
            .font(.orbitMeta.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 7).padding(.vertical, 1)
            .background(tint.opacity(0.16), in: Capsule())
    }
}

/// "Confirm the new criteria?" — a started project whose criteria moved since the owner confirmed
/// them, asked about what moved and nothing else: the server's list of changes
/// (`changesSinceConfirmed`), the rest numbered, the whole set one toggle away, and the one sentence
/// that says the project keeps running meanwhile.
///
/// Re-derived from the confirmation read on every render, like the card it takes over from: a set
/// confirmed at another end leaves it on screen, dimmed, over that confirmation's own explanation.
/// Every word is OrbitKit's `CriteriaChanges`, held to the browser's by
/// `CriteriaChangeCardCopyParityTests`.
private struct CriteriaChangeCardView: View {
    @Environment(\.dismissApprovalReview) private var dismissReview
    let console: ConsoleModel
    @State private var confirming = false
    @State private var showAll = false

    private var standing: StandardSetConfirmationStanding? { console.acceptanceConfirmation }

    var body: some View {
        let standing = self.standing
        ApprovalReviewLayout(title: CriteriaChanges.title, symbol: "checkmark.seal.fill", tone: .blue,
                             summary: previewSummary,
                             dimmed: !CriteriaChanges.isOpen(standing)) {
            if let standing {
                Text(CriteriaChanges.meta(standing, projectTitle: console.projectTitle))
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !CriteriaChanges.answerable(standing),
               let stale = AcceptanceConfirmations.staleExplanation(standing) {
                Text(stale)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.blue.opacity(0.08),
                                in: RoundedRectangle(cornerRadius: ApprovalMetrics.rowRadius))
            }
            if let changes = standing?.changesSinceConfirmed {
                changeList(changes)
            }
            Text(CriteriaChanges.explains)
                .font(.orbitProse)
                .frame(maxWidth: .infinity, alignment: .leading)
        } actions: {
            ApprovalActions {
                confirmButton(standing)
                chatButton(standing)
            }
        }
    }

    private var previewSummary: String {
        guard let changes = standing?.changesSinceConfirmed else { return console.projectTitle }
        return CriteriaChanges.whatChangedHead(CriteriaChanges.rows(changes).count)
    }

    private var items: [ProjectCriteriaDocument.Item] {
        console.projectCriteria.sorted { $0.ordinal < $1.ordinal }
    }

    @ViewBuilder
    private func changeList(_ changes: CriteriaChangesSinceConfirmed) -> some View {
        let rows = CriteriaChanges.rows(changes)
        if !rows.isEmpty {
            StartSectionHead(title: CriteriaChanges.whatChangedHead(rows.count))
            StartPanel {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    if index > 0 { Divider() }
                    changeRow(row)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(CriteriaChanges.whatChanged)
        }
        // The criteria that read as they were confirmed, by number, and the way to all of them.
        HStack(spacing: 4) {
            let unchanged = CriteriaChanges.unchangedLine(changes)
            if !unchanged.isEmpty {
                Text(unchanged).foregroundStyle(.secondary)
                Text("·").foregroundStyle(.secondary)
            }
            if !items.isEmpty {
                Button {
                    PlatformHaptics.tap()
                    showAll.toggle()
                } label: {
                    Text(showAll ? AcceptanceConfirmations.showLessLabel
                                 : CriteriaChanges.showAll(items.count))
                        .foregroundStyle(Color.blue)
                }
                .buttonStyle(.plain)
            }
            Spacer(minLength: 0)
        }
        .font(.orbitLabel)
        if showAll {
            ForEach(items) { item in
                HStack(alignment: .top, spacing: 8) {
                    Text("\(item.ordinal)")
                        .font(.orbitMonoFine).foregroundStyle(.secondary)
                        .frame(minWidth: 14, alignment: .trailing)
                    Text(item.text).font(.orbitProse)
                    Spacer(minLength: 0)
                }
            }
        }
    }

    /// One change: its mark, which criterion and what happened to it, the words it has now, and —
    /// for a stricter check — the check it replaced.
    private func changeRow(_ row: CriteriaChanges.Row) -> some View {
        let tone: Color = row.mark == .new ? .green : (row.mark == .stricter ? .blue : .orange)
        return HStack(alignment: .top, spacing: 10) {
            Text(row.mark.rawValue)
                .font(.orbitProse.weight(.bold))
                .foregroundStyle(tone)
                .frame(width: 24, height: 24)
                .background(tone.opacity(0.14), in: RoundedRectangle(cornerRadius: 7))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.kind).font(.orbitLabel.weight(.semibold)).foregroundStyle(tone)
                Text(row.text).font(.orbitProse)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let was = row.was {
                    Text(was).font(.orbitLabel).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .startRow()
    }

    /// Confirm the version standing now. The project was running the whole time; this press lets it
    /// be marked done against these criteria, and leaves a receipt that says it confirmed them.
    private func confirmButton(_ standing: StandardSetConfirmationStanding?) -> some View {
        let count = standing?.currentVersion.material.count ?? 0
        return Button {
            guard CriteriaChanges.answerable(standing), !confirming else { return }
            PlatformHaptics.tap()
            confirming = true
            Task {
                await console.confirmCriteriaChange()
                confirming = false
            }
        } label: {
            Text(CriteriaChanges.confirmLabel(count)).approvalActionLabel()
        }
        .buttonStyle(.borderedProminent)
        .disabled(confirming || !CriteriaChanges.answerable(standing))
    }

    private func chatButton(_ standing: StandardSetConfirmationStanding?) -> some View {
        Button {
            guard let standing else { return }
            PlatformHaptics.tap()
            dismissReview()
            console.startPlanChangeReply(standing, question: .criteriaChange)
        } label: {
            Text(Approvals.chatAction).approvalActionLabel()
        }
        .buttonStyle(.bordered)
        .disabled(standing == nil)
    }
}

/// A section's head on the start and change cards: small, upper-cased, secondary.
private struct StartSectionHead: View {
    let title: String

    var body: some View {
        Text(title)
            .font(.orbitLabel.weight(.semibold))
            .foregroundStyle(.secondary)
            .textCase(.uppercase)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 4)
    }
}

/// The white grouped panel the start card's Plan and How it runs sit in, rows divided by hairlines.
private struct StartPanel<Content: View>: View {
    private let content: () -> Content

    init(@ViewBuilder content: @escaping () -> Content) { self.content = content }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content() }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(StartPanel.fill, in: RoundedRectangle(cornerRadius: 12))
            .overlay {
                RoundedRectangle(cornerRadius: 12).strokeBorder(Color.primary.opacity(0.05))
            }
    }

    /// White on the blue card in light mode, and a raised grey in dark, where white would glare —
    /// the grouped row's own two tones.
    private static var fill: Color {
        Color(light: .white, dark: Color(red: 0.17, green: 0.17, blue: 0.18))
    }
}

private extension View {
    /// One row of a `StartPanel`: the grouped list's own insets.
    func startRow() -> some View {
        padding(.horizontal, 12).padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The settings a start left a project running with, in one line — the receipt of the start and
/// the "Project started" card both carry it — with every setting that is not what the coordinator
/// suggested in bold, and said aloud, so whoever reads it can tell what the owner changed. Web's
/// `RunSettingsSummary`.
struct RunSettingsSummaryText: View {
    let settings: ProjectStartSettings
    var differs: [ProjectStartSettingKey] = []

    var body: some View {
        line
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityLabel(RunSettings.spokenLine(settings, differs: differs))
    }

    private var line: Text {
        var text = Text("")
        for (index, part) in RunSettings.parts(settings, differs: differs).enumerated() {
            if index > 0 { text = text + Text(" · ") }
            text = text + (part.differs ? Text(part.text).bold() : Text(part.text))
        }
        return text
    }
}

// MARK: - the two cards a project's OWNER answers

/// The question this project's coordinator put to its owner (contract §5.2, mock 5).
///
/// Same shape and same blue as the confirmation card above, because it is the same kind of moment:
/// Orbit is asking, the person reading is the only one who can answer, and nothing an agent typed
/// is on the card. The mark says so out loud — an agent's turn can write anything into a
/// conversation, so a card that asks for a decision has to say the platform filed it.
///
/// Every word here is `CoordinatorQuestions`, which is the browser's own copy
/// (`CoordinatorQuestionCard.tsx`) held to it by `OwnerItemCardsTests`. The card keeps nothing but
/// the address and what this window typed: the standing is re-derived from the read on every body
/// pass, so a question answered in a browser goes stale in place here instead of staying pressable.
private struct CoordinatorQuestionCardView: View {
    let console: ConsoleModel
    let itemID: String
    /// The row this window picked: one of the coordinator's options, or this card's own Other row.
    /// Starts on the coordinator's recommendation, where it made one.
    @Environment(ApprovalReviewDrafts.self) private var drafts
    private var draft: CoordinatorReviewDraft { drafts.coordinator(itemID) }
    @State private var sending = false
    private var standing: CoordinatorQuestionStanding { console.questionStanding(itemID) }

    var body: some View {
        let standing = self.standing
        ApprovalReviewLayout(title: draft.receipt == nil
                                ? CoordinatorQuestions.heading : CoordinatorQuestions.answeredHeading,
                             symbol: "questionmark.bubble.fill", tone: .blue,
                             summary: previewSummary,
                             dimmed: draft.receipt != nil || !CoordinatorQuestions.isOpen(standing)) {
            Text(CoordinatorQuestions.provenance)
                .font(.orbitLabel).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .help(CoordinatorQuestions.provenanceTitle)

            if let receipt = draft.receipt {
                answered(receipt)
            } else if case .open(let row) = standing, let question = row.question {
                asked(row, question)
            } else if case .unread = standing {
                Text(CoordinatorQuestions.unreadable)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Text(CoordinatorQuestions.gone)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

        } actions: {
            if draft.receipt == nil, case .open(let row) = standing, let question = row.question {
                ApprovalActions {
                    Button { send(row, question) } label: {
                        Text(CoordinatorQuestions.sendAnswer).approvalActionLabel()
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(sending
                              || !CoordinatorQuestions.sendable(question: question,
                                                                chosen: draft.chosen, text: draft.text))
                }
                Text(CoordinatorQuestions.askedLine(since: row.waitingSince))
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        // The recommendation is where the choice starts, as it does in the browser — a
        // recommendation nobody can see the shape of is not one.
        .task(id: itemID) {
            if draft.chosen == nil, draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               draft.receipt == nil, case .open(let row) = console.questionStanding(itemID) {
                draft.chosen = row.question?.recommendedOption.map { .option($0) }
            }
        }
    }

    private var previewSummary: String {
        if draft.receipt != nil { return "✓ \(draft.sent)" }
        if case .open(let row) = standing { return row.question?.question ?? row.detailLine }
        return CoordinatorQuestions.gone
    }

    /// The question, its options, the row that means "none of these", and a box to answer it in.
    private func asked(_ row: ProjectOpenItemRow, _ question: CoordinatorQuestion) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            // The question as the coordinator wrote it — Markdown, as the browser's card renders
            // it (`CoordinatorQuestionCard`), so bullets and emphasis do not arrive raw.
            MarkdownView(source: question.question).font(.orbitProse)
                .frame(maxWidth: .infinity, alignment: .leading)
            ForEach(Array(question.options.enumerated()), id: \.offset) { index, option in
                optionRow(index: index, option: option,
                          recommended: index == question.recommendedOption)
            }
            // The last row is this card's own, and it is a row rather than a hint because the owner
            // has to be able to SEE that answering in their own words is allowed before they type
            // them: beside a chosen option the box is a note on it, and that is how a coordinator
            // once received "none of these fits" as agreement with the recommendation.
            if !question.options.isEmpty {
                otherRow()
            }
            // Always there, above: none of the options may be what the owner wants, and one that is
            // may still need a condition said with it.
            TextField(CoordinatorQuestions.answerPrompt(question: question, chosen: draft.chosen),
                      text: Binding(get: { draft.text }, set: { draft.text = $0 }), axis: .vertical)
                .lineLimit(2...8)
                .textFieldStyle(.plain)
                .font(.orbitProse)
                .padding(.horizontal, 10).padding(.vertical, 8)
                .background(Color.blue.opacity(0.08),
                            in: RoundedRectangle(cornerRadius: ApprovalMetrics.rowRadius))
            // What it holds up and what happens if nobody answers, in the server's own words — the
            // same line the project page's row carries, so the two cannot say different things.
            if !row.detailLine.isEmpty {
                Text(row.detailLine)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// One of the coordinator's alternatives.
    private func optionRow(index: Int, option: CoordinatorQuestion.Option,
                           recommended: Bool) -> some View {
        choiceRow(selected: CoordinatorQuestions.optionIndex(draft.chosen) == index,
                  label: option.label, why: option.description, recommended: recommended) {
            draft.chosen = .option(index)
        }
    }

    /// The row this card adds after them. Drawn exactly like an option, because it is one: the
    /// alternatives the coordinator offered are not the only answers there are.
    private func otherRow() -> some View {
        choiceRow(selected: CoordinatorQuestions.isOther(draft.chosen),
                  label: CoordinatorQuestions.otherOption, why: nil, recommended: false) {
            draft.chosen = .other
        }
    }

    /// One row that can be picked: a radio, its label, the recommendation where it was made, and
    /// the reason the coordinator gave for it. Pressing anywhere on the row picks it — a 44pt
    /// target, not a dot.
    private func choiceRow(selected: Bool, label: String, why: String?, recommended: Bool,
                           pick: @escaping () -> Void) -> some View {
        Button {
            PlatformHaptics.tap()
            pick()
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .font(.orbitMeta)
                    .foregroundStyle(selected ? Color.blue : Color.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(label).font(.orbitProse)
                        if recommended {
                            Text(CoordinatorQuestions.recommended)
                                .font(.orbitLabel).foregroundStyle(Color.blue)
                        }
                    }
                    if let why {
                        Text(why).font(.orbitLabel).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(minHeight: ApprovalMetrics.rowMinHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// The record this window drew: what was answered, and whether anybody has been told yet.
    private func answered(_ receipt: OwnerAnswerReceipt) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("✓ \(draft.sent)")
                .font(.orbitProse)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(CoordinatorQuestions.receiptLine(delivered: receipt.delivery != nil))
                .font(.orbitLabel).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// The press re-reads what the button was rendered from, so a race between a render and a tap
    /// cannot send an answer to a question that is no longer open.
    private func send(_ row: ProjectOpenItemRow, _ question: CoordinatorQuestion) {
        guard !sending, CoordinatorQuestions.sendable(question: question, chosen: draft.chosen, text: draft.text)
        else { return }
        PlatformHaptics.tap()
        sending = true
        let words = CoordinatorQuestions.answerInWords(
            question: question, option: CoordinatorQuestions.optionIndex(draft.chosen), text: draft.text)
        Task {
            if let answered = await console.answerQuestion(row, chosen: draft.chosen, text: draft.text) {
                draft.sent = words
                draft.receipt = answered
            }
            sending = false
        }
    }
}

/// The exception that became the owner's without anybody asking, and the pause only the owner can
/// lift (§7.5 mock 5's right column, §6.3 F-T4 mock 6 ①).
///
/// One card for two kinds, because it is one situation: something stopped, nobody else can move it,
/// and the person reading is the one the project is waiting for. What differs is the press and the
/// header — a pause has one word of its own and its title says what was paused, while an escalated
/// item's title is the task or check that failed and its first line says how it got here.
///
/// Amber, not blue: the confirmation and question cards ask for a decision, and this one is the
/// project's own failure sitting in somebody's lap. Every word is `ExceptionCards`, the browser's
/// own copy (`ProjectProgressStatus.tsx`) held to it by `ExceptionCardsTests`. The card keeps
/// nothing but the address and the receipt of a press made on THIS screen: the standing is
/// re-derived from the console's read on every body pass, so an item the coordinator closed in the
/// meantime goes dead in place here instead of staying pressable.
private struct OwnerItemCardView: View {
    let console: ConsoleModel
    let itemID: String
    /// The pause, rather than an exception that became the owner's.
    let isPause: Bool
    @State private var sending = false
    /// What the door took, when the press was made HERE — the receipt, and the only thing this
    /// card remembers. The read then says the item is gone, which is the same fact twice.
    @State private var receipt: String?
    /// The reason a "Mark as handled" press would carry, and whether the field is up. The draft is
    /// kept after a refusal, so a press that was turned down does not cost the reader their words.
    @State private var askingToHandle = false
    @State private var reason = ""
    /// Whether a failed check's log is drawn whole rather than folded to its last lines.
    @State private var expandedTail = false
    @State private var expandedFacts: Set<String> = []

    @Environment(\.openURL) private var openURL

    private var standing: OwnerItemStanding { console.ownerItemStanding(itemID) }

    var body: some View {
        let standing = self.standing
        VStack(alignment: .leading, spacing: ApprovalMetrics.spacing) {
            ApprovalHeader(symbol: isPause ? "pause.circle.fill" : "exclamationmark.triangle.fill",
                           title: isPause ? ExceptionCards.pauseTitle : ExceptionCards.escalatedTitle,
                           tone: .orange)
            Text(ExceptionCards.provenance)
                .font(.orbitLabel).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .help(ExceptionCards.provenanceTitle)

            if let receipt {
                Text("✓ \(receipt)")
                    .font(.orbitProse)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if case .open(let row) = standing {
                item(row)
                ApprovalActions {
                    // The card's own presses, in the three weights of mock 7 方案 B and the order
                    // the browser draws the same doors in. A pause is a card of its own on both
                    // clients — one press, and not one of these weights.
                    if isPause {
                        if pressable(row) {
                            Button { press(row) } label: {
                                Text(ExceptionCards.resume).approvalActionLabel()
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(sending)
                        }
                    } else {
                        ForEach(ExceptionCards.presses(row), id: \.action) { cardPress in
                            cardPressButton(cardPress, row: row)
                        }
                    }
                    // And the other way out, which is a sentence rather than a press: the card
                    // hands the item to the composer, and the coordinator is told what to do about
                    // it. The same control — and the same word — as the four other cards that do
                    // this (`Approvals.chatAction`).
                    Button {
                        PlatformHaptics.tap()
                        console.startOwnerItemReply(row, isPause: isPause)
                    } label: {
                        Text(Approvals.chatAction).approvalActionLabel()
                    }
                    .buttonStyle(.bordered)
                    .disabled(sending)
                    // The owner's own ending, drawn last and quietest (方案 B): it is for an
                    // exception nobody has to act on any more, offered to the one reader who knows.
                    if !isPause && ExceptionCards.markable(row) {
                        markHandledButton()
                    }
                }
                Text(ExceptionCards.ownerLine(row))
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if case .unread = standing {
                Text(ExceptionCards.unreadable)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Text(ExceptionCards.gone)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .approvalChrome(.orange, dimmed: receipt != nil || !ExceptionCards.isOpen(standing))
        .alert(ExceptionCards.markHandledTitle, isPresented: $askingToHandle) {
            TextField(ExceptionCards.markHandledReason, text: $reason, axis: .vertical)
            Button(ExceptionCards.markHandled) { markHandled() }
            Button("Back", role: .cancel) {}
        } message: {
            Text(ExceptionCards.markHandledBody)
        }
    }

    /// What happened, in the rows of mock 5's fact block — or, for an item whose payload this build
    /// cannot read, in the three lines it drew before the rows existed: how it became the owner's,
    /// what escalated, and the fact that opened it.
    ///
    /// The rows are `ExceptionCards.facts`, which is the browser's `ItemFactRows` field for field,
    /// and the card draws the block INSTEAD of those lines — not above them. The block's first row
    /// is what the item is about, so the title beside it would print the same task twice.
    @ViewBuilder private func item(_ row: ProjectOpenItemRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(ExceptionCards.headingLine(row))
                .font(.orbitProse)
                .frame(maxWidth: .infinity, alignment: .leading)
            switch ExceptionCards.facts(row) {
            case .detailLine(let line):
                if let subject = ExceptionCards.subject(row) {
                    Text(subject)
                        .font(.orbitProse)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if !line.isEmpty {
                    Text(line)
                        .font(.orbitLabel).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            case .rows(let block):
                ForEach(block.rows, id: \.label) { fact in factRow(fact) }
                if let tail = block.logTail { logTail(tail) }
            }
        }
    }

    /// One row of the fact block: the mock's label column and the value beside it.
    private func factRow(_ fact: ExceptionCards.FactRow) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(fact.label)
                .font(.orbitLabel).foregroundStyle(.secondary)
                .frame(width: 62, alignment: .leading)
            VStack(alignment: .leading, spacing: 4) {
                Text(fact.value)
                    .font(fact.mono ? .orbitMono : .orbitLabel)
                    .lineLimit((fact.value.count > 120 || fact.value.contains("\n"))
                               && !expandedFacts.contains(fact.label) ? 3 : nil)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                if fact.value.count > 120 || fact.value.contains("\n") {
                    Button(expandedFacts.contains(fact.label) ? "Show less" : "Show details") {
                        if expandedFacts.contains(fact.label) { expandedFacts.remove(fact.label) }
                        else { expandedFacts.insert(fact.label) }
                    }
                    .buttonStyle(.plain).font(.orbitLabel)
                }
            }
        }
    }

    /// The tail of a failed check's output, folded from the END — which is where the reason a check
    /// is red always is. Folded in the view rather than in the model: what the block carries is the
    /// lines and how many the fold keeps back, and whether they are on screen yet is this card's.
    private func logTail(_ tail: ExceptionCards.CheckTail) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text((expandedTail ? tail.lines : tail.shown).joined(separator: "\n"))
                .font(.orbitMono)
                .lineLimit((tail.more != nil || tail.shown.joined(separator: "\n").count > 120)
                           && !expandedTail ? 6 : nil)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 8).padding(.vertical, 6)
                .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
            if tail.more != nil || tail.shown.joined(separator: "\n").count > 120 {
                Button(expandedTail ? ExceptionCards.CheckTail.less : (tail.more ?? "Show details")) {
                    expandedTail.toggle()
                }
                .buttonStyle(.plain).font(.orbitLabel).foregroundStyle(.tint)
            }
        }
    }

    /// One press, in the weight the card gave it (mock 7 方案 B). A door this client has no press
    /// for — `Cancel task`, which this console stops by no door of its own — draws nothing at all,
    /// which is the rule the card has always followed: a control that goes nowhere is worse than no
    /// control.
    @ViewBuilder private func cardPressButton(_ cardPress: ExceptionCards.CardPress,
                                              row: ProjectOpenItemRow) -> some View {
        switch cardPress.action {
        case .askCoordinatorAgain:
            if pressable(row) {
                weighted(cardPress.tier) {
                    Button { press(row) } label: {
                        Text(ExceptionCards.askCoordinatorAgain).approvalActionLabel()
                    }
                }
                .disabled(sending)
            }
        case .openTaskSession:
            // The way onto the work the item is about — the attempt that opened it, or the task
            // when that attempt has no session left. The app's own door for both ids, the one the
            // delivery card's links open and both shells route.
            if let url = ExceptionCards.openTaskSessionLink(row) {
                weighted(cardPress.tier) {
                    Button { openURL(url) } label: {
                        Text(ExceptionCards.openTaskSession).approvalActionLabel()
                    }
                }
                .disabled(sending)
            }
        default:
            EmptyView()
        }
    }

    /// The weight a press is drawn in (mock 7 方案 B). Two button styles and one quiet link, and the
    /// style is the only thing the tier decides here: WHICH presses exist, and in what order, is
    /// `ExceptionCards.presses` — the browser's own rule, so the two cards cannot disagree.
    @ViewBuilder private func weighted<V: View>(_ tier: ExceptionCards.PressTier,
                                                @ViewBuilder _ button: () -> V) -> some View {
        if tier == .primary {
            button().buttonStyle(.borderedProminent)
        } else if tier == .link {
            button().buttonStyle(.plain).font(.orbitLabel).foregroundStyle(.secondary)
        } else {
            button().buttonStyle(.bordered)
        }
    }

    /// The owner's own ending: the press, and the reason it is not allowed to go without (§4.7).
    private func markHandledButton() -> some View {
        Button {
            PlatformHaptics.tap()
            reason = ""
            askingToHandle = true
        } label: {
            Text(ExceptionCards.markHandled).approvalActionLabel()
        }
        .buttonStyle(.plain)
        .font(.orbitLabel)
        .foregroundStyle(.secondary)
        .disabled(sending)
    }

    /// Whether the door would take the press from here. Both are the server's own list, so a
    /// button that is drawn is a button whose press lands: a project with no live coordinator
    /// draws no "Ask the coordinator again", and a pause with no episode draws no "Resume".
    private func pressable(_ row: ProjectOpenItemRow) -> Bool {
        isPause ? ExceptionCards.resumable(row) : ExceptionCards.askable(row)
    }

    /// The ending holds the same line the door does: a reason the server would refuse is not a press,
    /// so the field is what is on screen and nothing is sent (`markItemHandled` guards it too).
    private func markHandled() {
        guard case .open(let row) = standing,
              ExceptionCards.markHandledRequest(reason) != nil else { return }
        PlatformHaptics.tap()
        sending = true
        Task {
            if await console.markItemHandled(row, note: reason) != nil {
                receipt = ExceptionCards.handled
            }
            sending = false
        }
    }

    /// The press re-reads what the button was rendered from (`returnEscalatedItem` /
    /// `resumeFuse` re-read the item list), so a race between a render and a tap cannot hand back
    /// an item somebody else already moved.
    private func press(_ row: ProjectOpenItemRow) {
        guard !sending, pressable(row) else { return }
        PlatformHaptics.tap()
        sending = true
        Task {
            if isPause {
                if await console.resumeFuse(row) != nil { receipt = ExceptionCards.resumed }
            } else {
                if await console.returnEscalatedItem(row) != nil { receipt = ExceptionCards.returned }
            }
            sending = false
        }
    }
}

/// The one merge a person is asked to confirm: this project's branch into main (§3.6, mock 4).
///
/// Four states and one card, because they are one thing happening: it is ready and waiting on you,
/// it is landing on its own, it landed, or it cannot land yet. What the card says in each is
/// `PromotionCards` — the same answers `OwnerItemCardsTests` holds to mock 4 — and what it offers
/// is what the door would take: only a READY candidate may be confirmed (§3.3), so every other
/// state's button is disabled rather than lit and refused.
///
/// WHERE IT LIVES (owner decision 2026-10-06). The card is on the project's sessions page, under its
/// progress card (`ProjectMergeCardView`). The coordinator conversation keeps one line where each
/// moment happened (`PromotionEventLine`, `PromotionReceiptLine`), and both places open the same
/// review below, which reads whichever host opened it through `PromotionReviewSource`.
struct PromotionReviewTarget: Identifiable {
    let id: String
}

/// A merge's record, opened from its line in the conversation or its row on the sessions page.
struct PromotionReceiptTarget: Identifiable {
    let promotion: ProjectPromotionView
    var id: String { promotion.promotionId }
}

private struct OpenPromotionReviewKey: EnvironmentKey {
    static let defaultValue: (String) -> Void = { _ in }
}

private struct OpenPromotionReceiptKey: EnvironmentKey {
    static let defaultValue: (ProjectPromotionView) -> Void = { _ in }
}

extension EnvironmentValues {
    var openPromotionReview: (String) -> Void {
        get { self[OpenPromotionReviewKey.self] }
        set { self[OpenPromotionReviewKey.self] = newValue }
    }

    var openPromotionReceipt: (ProjectPromotionView) -> Void {
        get { self[OpenPromotionReceiptKey.self] }
        set { self[OpenPromotionReceiptKey.self] = newValue }
    }
}

/// What the review reads and presses, from whichever host opened it: the coordinator's console, or
/// the project's sessions page (`ProjectMergeModel`). One sheet for both, so the merge is answered
/// the same way wherever the owner meets it.
@MainActor
protocol PromotionReviewSource: AnyObject {
    func promotionStanding(_ promotionID: String) -> ProjectPromotionView?
    /// The project's open items, both groups: a blocked candidate's holder is one of them.
    var promotionItems: [ProjectOpenItemRow] { get }
    /// The project's current landings, for the row that names what is in front of a blocked
    /// candidate (`PromotionCards.blockedByLine`). Empty where the host has not read them, and the
    /// row is then absent rather than wrong.
    var promotionLandings: [ProjectLandTask] { get }
    var criteriaMet: (met: Int, total: Int)? { get }
    func refreshPromotion() async
    func confirmMergeToMain(_ view: ProjectPromotionView) async -> String?
    func declineMergeToMain(_ view: ProjectPromotionView) async -> String?
    func cancelMergeToMain(_ view: ProjectPromotionView) async -> String?
}

extension ConsoleModel: PromotionReviewSource {
    var promotionItems: [ProjectOpenItemRow] {
        (openItems?.needsYou ?? []) + (openItems?.withCoordinator ?? [])
    }

    func refreshPromotion() async {
        await refreshRulerQuestions(force: true)
    }
}

/// A candidate's one line in the coordinator conversation, where the card used to be drawn: the
/// card is on the project's sessions page now (owner decision 2026-10-06). The line says the same
/// state in the same words (`PromotionCards.eventLine`) and opens the same review, which is also
/// the way in on the Mac, where there is no sessions page.
private struct PromotionEventLine: View {
    @Environment(\.openPromotionReview) private var openReview
    let console: ConsoleModel
    let promotionID: String

    var body: some View {
        let line = PromotionCards.eventLine(console.promotionStanding(promotionID))
        Button { openReview(promotionID) } label: {
            HStack(spacing: 6) {
                Image(systemName: symbol(line.tone))
                Text(line.text).lineLimit(2).multilineTextAlignment(.leading)
                if line.tone == .needsYou {
                    Text("· \(PromotionCards.review)").foregroundStyle(Color.accentColor)
                }
                Image(systemName: "chevron.right")
                    .font(.orbitMeta.weight(.semibold))
                    .foregroundStyle(line.tone == .needsYou ? Color.accentColor : Color.secondary)
            }
            .font(.orbitLabel.weight(line.tone == .quiet ? .regular : .semibold))
            .foregroundStyle(ink(line.tone))
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(ink(line.tone).opacity(line.tone == .quiet ? 0.1 : 0.13), in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity)
        .accessibilityHint("Opens the merge review")
    }

    private func symbol(_ tone: PromotionCards.EventTone) -> String {
        switch tone {
        case .needsYou, .quiet: return "arrow.triangle.merge"
        case .working: return "arrow.triangle.2.circlepath"
        case .blocked: return "exclamationmark.triangle.fill"
        }
    }

    private func ink(_ tone: PromotionCards.EventTone) -> Color {
        switch tone {
        case .needsYou, .blocked: return .orange
        case .working: return .accentColor
        case .quiet: return .secondary
        }
    }
}

/// Hosted by the console and by the sessions page, so recycling or removing the row that opened it
/// cannot dismiss the review.
struct PromotionReviewSheet: View {
    @Environment(\.dismiss) private var dismiss
    let source: any PromotionReviewSource
    let promotionID: String
    @State private var acting = false
    @State private var actionError: String?

    private var view: ProjectPromotionView? { source.promotionStanding(promotionID) }

    /// The open item filed for this candidate, when the project's read carries one: whose problem
    /// the block is, and since when. Nil before that read lands — the card then says who state D
    /// means and stops, which is what it did before the press carried the sentence at all.
    private var item: ProjectOpenItemRow? {
        source.promotionItems.first { $0.promotionId == promotionID }
    }

    var body: some View {
        let view = self.view
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: ApprovalMetrics.spacing) {
                    Text(PromotionCards.provenance)
                        .font(.orbitLabel).foregroundStyle(.secondary)
                    if let view, PromotionCards.stage(view) != nil {
                        if PromotionCards.stage(view) != .askingYou {
                            CardRow(label: "Branch", value: PromotionCards.shortRef(view.sourceRef))
                        }
                        switch PromotionCards.stage(view) {
                        case .askingYou:  askingYou(view)
                        case .merging:    merging(view)
                        case .merged:     merged(view)
                        case .blocked:    blocked(view)
                        case .none:       EmptyView()
                        }
                    } else {
                        Text(PromotionCards.superseded)
                            .font(.orbitProse).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
                .textSelection(.enabled)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if acting || actionError != nil || PromotionCards.stage(view) == .askingYou
                    || PromotionCards.stage(view) == .merging || PromotionCards.stage(view) == .blocked {
                    VStack(spacing: ApprovalMetrics.spacing) {
                        Divider()
                        if let actionError {
                            Text(actionError).font(.orbitLabel).foregroundStyle(.red)
                                .lineLimit(3)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if acting { ProgressView("Working…").font(.orbitLabel) }
                        if let view { actions(view) }
                    }
                    .padding(.horizontal).padding(.bottom)
                    .background(.bar)
                }
            }
            .navigationTitle(view.map(PromotionCards.previewTitle) ?? PromotionCards.supersededTitle)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                        .labelStyle(.iconOnly)
                }
            }
        }
        .task { await source.refreshPromotion() }
        #if os(iOS)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        #else
        .frame(minWidth: 520, minHeight: 560)
        #endif
    }

    /// A: what is being merged, what was run on it, and what will land.
    private func askingYou(_ view: ProjectPromotionView) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            CardRow(label: "Branch", value: PromotionCards.branchLine(view))
            PromotionTasksRow(label: "Tasks", summary: PromotionCards.tasksLine(view),
                              titles: view.tasks.map(\.title))
            CardRow(label: "Checks", value: PromotionCards.checksLine(view))
            CardRow(label: PromotionCards.shortRef(view.upstreamRef),
                    value: PromotionCards.upstreamLine(view))
            if let met = source.criteriaMet,
               let line = PromotionCards.criteriaLine(met: met.met, of: met.total) {
                CardRow(label: "Criteria", value: line)
            }
            CardRow(label: "Lands", value: PromotionCards.landsLine(view))
            if let files = view.filesChanged {
                // A count rather than a button: this client has no diff view, and a press that
                // opens nothing is worse than a line that says how big the merge is.
                CardRow(label: "Changes", value: "\(files) file\(files == 1 ? "" : "s")")
            }
            if let asked = PromotionCards.askedLine(view) {
                Text(asked)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// B: it is landing, and the reader may walk away.
    private func merging(_ view: ProjectPromotionView) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            CardRow(label: "Status", value: PromotionCards.mergingStatusLine(view))
            CardRow(label: "You", value: PromotionCards.nothingToDo)
        }
    }

    /// C: the receipt — and, for a merge the Automatic setting made, how to take it back.
    private func merged(_ view: ProjectPromotionView) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            CardRow(label: "Commit", value: PromotionCards.mergedLine(view))
            PromotionTasksRow(label: "Now on main", summary: PromotionCards.nowOnMainLine(view),
                              titles: view.tasks.map(\.title))
            if let undo = PromotionCards.revertLine(view) {
                CardRow(label: "Undo", value: undo)
            }
        }
    }

    /// D: it cannot land yet. Who has it is NOT a row here any more: it is on the press
    /// (`PromotionCards.resolvingLine`), which is the thing the reader looks at, and saying it
    /// twice was the whole of what this card got wrong (owner decision 2026-09-24).
    ///
    /// What IS a row is who is in FRONT of it, when the project's own line is busy: the same row the
    /// sessions page's card draws, off the same read.
    private func blocked(_ view: ProjectPromotionView) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            CardRow(label: "Why", value: PromotionCards.blockedLine(view))
            if let inFront = PromotionCards.blockedByLine(view, landings: source.promotionLandings) {
                CardRow(label: PromotionCards.blockedByLabel, value: inFront)
            }
        }
    }

    /// The presses, per state: confirm and decline while it is yours, cancel while it is landing,
    /// and nothing at all once it has.
    @ViewBuilder private func actions(_ view: ProjectPromotionView) -> some View {
        switch PromotionCards.stage(view) {
        case .askingYou:
            ApprovalActions {
                Button { act { await source.confirmMergeToMain(view) } } label: {
                    Text(PromotionCards.mergeToMain).approvalActionLabel()
                }
                .buttonStyle(.borderedProminent)
                .disabled(acting || !PromotionCards.confirmable(view))
                Button(role: .cancel) {
                    act {
                        let failure = await source.declineMergeToMain(view)
                        if failure == nil { dismiss() }
                        return failure
                    }
                } label: {
                    Text(PromotionCards.notNow).approvalActionLabel()
                }
                .buttonStyle(.bordered)
                .disabled(acting)
            }
        case .blocked:
            // The press reads rather than acts: who has the branch and how long they have had it,
            // over the same mark the merging card's own button carries. It stays disabled — the
            // door would refuse a confirm on a blocked candidate — so it is a state, not a press
            // the reader is being told they may not make.
            ApprovalActions {
                Button {} label: {
                    HStack(spacing: 6) {
                        if PromotionCards.resolvingSpins(item) {
                            ProgressView().controlSize(.mini)
                        }
                        Text(PromotionCards.resolvingLine(item))
                    }
                    .approvalActionLabel()
                }
                .buttonStyle(.borderedProminent)
                .disabled(true)
            }
        case .merging:
            ApprovalActions {
                Button {} label: { Text(PromotionCards.mergingActionLabel(view)).approvalActionLabel() }
                    .buttonStyle(.borderedProminent)
                    .disabled(true)
                Button(role: .cancel) { act { await source.cancelMergeToMain(view) } } label: {
                    Text(PromotionCards.cancel).approvalActionLabel()
                }
                .buttonStyle(.bordered)
                .disabled(acting || view.execution?.phase == "PUSH")
            }
        case .merged, .none:
            EmptyView()
        }
    }

    private func act(_ run: @escaping () async -> String?) {
        guard !acting else { return }
        PlatformHaptics.tap()
        acting = true
        actionError = nil
        Task {
            actionError = await run()
            acting = false
        }
    }
}

/// The record a merge leaves in the coordinator conversation, at the moment it HAPPENED (§3.6;
/// web's `PromotionReceiptLine`): one line where a card used to sit between two messages. The record
/// itself — the commit, the tasks, what ran on it — opens from it (`PromotionReceiptSheet`), the
/// same sheet the sessions page's timeline row opens.
///
/// A RECORD IS NOT A QUESTION: its one press opens the record, and nothing on it decides anything.
/// Where it lands is the caller's — the console anchors it at `mergedAt` (`PromotionCards.receipts`),
/// the rule the four receipts beside it are drawn by.
private struct PromotionReceiptLine: View {
    @Environment(\.openPromotionReceipt) private var openReceipt
    let promotion: ProjectPromotionView

    var body: some View {
        Button { openReceipt(promotion) } label: {
            HStack(spacing: 6) {
                Text(PromotionCards.receiptLine(promotion)).lineLimit(2).multilineTextAlignment(.leading)
                Image(systemName: "chevron.right").font(.orbitMeta.weight(.semibold))
            }
            .font(.orbitLabel)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Color.secondary.opacity(0.1), in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity)
        .accessibilityHint("Opens the merge's receipt")
    }
}

/// What a merge put on main, who merged it and when, and what was run on it — read off the terminal
/// row the record carries, never off the candidate the branch is offering now, and never off the
/// project as it stands today. Hosted by whichever page opened it, so a recycled row cannot dismiss
/// it.
struct PromotionReceiptSheet: View {
    @Environment(\.dismiss) private var dismiss
    let promotion: ProjectPromotionView

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: ApprovalMetrics.spacing) {
                    Text(PromotionCards.provenance)
                        .font(.orbitLabel).foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 6) {
                        CardRow(label: "Commit", value: PromotionCards.mergedLine(promotion))
                        PromotionTasksRow(label: "Now on main", summary: PromotionCards.nowOnMainLine(promotion),
                                          titles: promotion.tasks.map(\.title))
                        CardRow(label: "Checks", value: PromotionCards.checksLine(promotion))
                        CardRow(label: "Landed", value: PromotionCards.landsLine(promotion))
                        if let changes = PromotionCards.changesLine(promotion) {
                            CardRow(label: "Changes", value: changes)
                        }
                        if let undo = PromotionCards.revertLine(promotion) {
                            CardRow(label: "Undo", value: undo)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
                .textSelection(.enabled)
            }
            .navigationTitle(PromotionCards.title(promotion))
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                        .labelStyle(.iconOnly)
                }
            }
        }
        #if os(iOS)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        #else
        .frame(minWidth: 480, minHeight: 420)
        #endif
    }
}

/// The row that names what a merge carries: the count, then each task by its title — the server's
/// `tasks`; a server older than that field gives the count alone.
private struct PromotionTasksRow: View {
    let label: String
    let summary: String
    let titles: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(.orbitLabel).foregroundStyle(.secondary)
            Text(summary)
                .font(.orbitProse)
                .frame(maxWidth: .infinity, alignment: .leading)
            ForEach(Array(titles.enumerated()), id: \.offset) { _, title in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("•").foregroundStyle(.secondary)
                    Text(title).frame(maxWidth: .infinity, alignment: .leading)
                }
                .font(.orbitLabel)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One labelled line on an owner card: the label in the card's quiet type, the fact beside it. The
/// browser draws these as a `<dl>`; this is the same two columns with the label above on a phone,
/// where a fixed label column would leave a command or a branch name nowhere to go.
private struct CardRow: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(.orbitLabel).foregroundStyle(.secondary)
            Text(value)
                .font(.orbitProse)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
