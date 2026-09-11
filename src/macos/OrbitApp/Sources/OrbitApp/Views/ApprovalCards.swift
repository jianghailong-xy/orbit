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
    private var gaps: GapPreview { EvidenceDecisions.gapPreview(row) }
    private var checks: [EvidenceDecisionCheck] { EvidenceDecisions.checks(row) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(row.title)
                .font(.orbitLabel.bold()).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            claimBlock
            Text(EvidenceDecisions.meta(row))
                .font(.orbitMonoFine).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            gapsBlock
            checksBlock
        }
    }

    // MARK: body

    private var claimBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(claim.text.isEmpty ? EvidenceDecisions.noClaim : claim.text)
                .font(.orbitProse.bold())
                .foregroundStyle(claim.text.isEmpty ? AnyShapeStyle(.secondary)
                                                    : AnyShapeStyle(.primary))
                .frame(maxWidth: .infinity, alignment: .leading)
            if claim.folded {
                DisclosureToggle(open: claimOpen, label: claimOpen ? "收起" : "展开全文") {
                    claimOpen.toggle()
                }
                if claimOpen {
                    Text(row.claim.trimmingCharacters(in: .whitespacesAndNewlines))
                        .font(.orbitProse)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
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
            case .acceptanceConfirmation:
                AcceptanceConfirmationCard(console: console)
            case .evidenceDecision(let taskID, let evidenceRevision):
                EvidenceDecisionCard(console: console, taskID: taskID,
                                     evidenceRevision: evidenceRevision)
            }
        }
        // A card re-derives itself when it comes into view, on top of the reads the console runs
        // when it loads and when the stream reconnects: the question this card is about can be
        // answered in a browser while a phone is asleep, and the phone has to find that out by
        // asking rather than by being told.
        .task { await console.refreshRulerQuestions() }
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

/// The settlement gate: whether this set of criteria, together, is what "done" means here.
///
/// Blue and question-shaped — the same shape as `A question for you` and `Review this plan`, and
/// with no badge — because that is what it is: a question about meaning, which no machine answers.
/// The two ticks above the actions are not a verdict on the work; they say what holds and what is
/// still open, and the open one is the question itself.
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
            Text(AcceptanceConfirmations.meta(standing))
                .font(.orbitLabel).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)

            if let standing {
                ForEach(AcceptanceConfirmations.checks(standing)) { check in
                    checkRow(check)
                }
            }
            if let stale = AcceptanceConfirmations.staleExplanation(standing) {
                Text(stale)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.blue.opacity(0.08),
                                in: RoundedRectangle(cornerRadius: ApprovalMetrics.rowRadius))
            }
            criteria

            // Three stacked actions, at the system's default height — the shape signed off on
            // 2026-08-14, where `.controlSize(.large)`'s 50pt bars read as bulky three deep.
            ApprovalActions {
                confirmButton(standing)
                readButton
                notYetButton
            }
        }
        .approvalChrome(.blue, dimmed: AcceptanceConfirmations.isDimmed(standing))
    }

    private func checkRow(_ check: AcceptanceConfirmationCheck) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: check.ok ? "checkmark" : "questionmark")
                .font(.orbitGlyph)
                .foregroundStyle(check.ok ? Color.green : Color.orange)
            Text(check.text).font(.orbitProse).foregroundStyle(.primary)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var items: [ProjectCriteriaDocument.Item] {
        console.projectCriteria.sorted { $0.ordinal < $1.ordinal }
    }

    /// The set itself, opened by the middle action. Load-bearing rather than decorative: this card
    /// sits alone in a transcript, and confirming a set the reader cannot read is exactly the
    /// "signed unread" the version digest exists to prevent. The web card is under the project
    /// page's own criteria list, which is where its reader reads them; a phone has to carry them.
    @ViewBuilder private var criteria: some View {
        if criteriaOpen {
            ForEach(items) { item in
                HStack(alignment: .top, spacing: 8) {
                    Text("\(item.ordinal)")
                        .font(.orbitMonoFine).foregroundStyle(.secondary)
                        .frame(minWidth: 14, alignment: .trailing)
                    Text(item.text).font(.orbitProse)
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func confirmButton(_ standing: StandardSetConfirmationStanding?) -> some View {
        Button {
            guard AcceptanceConfirmations.answerable(standing), !confirming else { return }
            PlatformHaptics.tap()
            confirming = true
            Task {
                await console.confirmStandardSet()
                confirming = false
            }
        } label: {
            Text(AcceptanceConfirmations.confirmLabel).approvalActionLabel()
        }
        .buttonStyle(.borderedProminent)
        .disabled(confirming || !AcceptanceConfirmations.answerable(standing))
    }

    /// Opens the set this card is about, in place. Not a navigation: there is no project screen on
    /// this client to navigate TO, and a question about a set is best answered beside it. Absent
    /// while the criteria could not be read, because a control that would open nothing is not one.
    @ViewBuilder private var readButton: some View {
        if !items.isEmpty {
            Button {
                PlatformHaptics.tap()
                criteriaOpen.toggle()
            } label: {
                Text(criteriaOpen ? "Hide the criteria"
                                  : AcceptanceConfirmations.readLabel(count: items.count))
                    .approvalActionLabel()
            }
            .buttonStyle(.bordered)
        }
    }

    /// Writes nothing: the standing is a derived read and the question stays open, so this sets the
    /// card aside for this sitting rather than answering it. Never disabled — putting a question
    /// down is available whatever the server says about it.
    private var notYetButton: some View {
        Button(role: .cancel) {
            PlatformHaptics.tap()
            console.setAsideConfirmation()
        } label: {
            Text(AcceptanceConfirmations.notYetLabel).approvalActionLabel()
        }
        .buttonStyle(.bordered)
    }
}
