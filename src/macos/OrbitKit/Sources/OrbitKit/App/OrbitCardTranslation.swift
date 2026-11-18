import Foundation

// Settings › Translation on Orbit's own cards (board 04-owner-cards.html, part 2): a task or project
// create, a batch, a blocker resolve and a DAG change draw their agent-written fields in the owner's
// language once the server has translated them, with one foot under the body that flips the whole
// card back to what the agent wrote. Web's `ApprovalPanel.tsx` draws the same.

public extension Approvals {

    /// The Orbit cards whose agent-written fields are translated (shared `TRANSLATED_ORBIT_CARDS`).
    static let translatedOrbitCards: Set<String> = [
        "orbit_task_create", "orbit_task_batch", "orbit_project_create",
        "orbit_blocker_resolve", "orbit_dag_change",
    ]

    /// The input an Orbit card's previews are built from: translated wherever the server translated
    /// it, or the original once the owner pressed Show original.
    static func orbitCardInput(_ approval: PendingApproval, showOriginal: Bool) -> JSONValue? {
        showOriginal ? approval.input : approval.shownInput
    }

    /// The foot under an Orbit card's body: "Translated · Show original" ↔ "Original · Show
    /// translation". Nothing on any other card, on one not translated (or whose translation failed),
    /// and on one whose translation changes nothing the card draws.
    static func orbitCardFoot(_ approval: PendingApproval, showOriginal: Bool) -> [SessionTranslation.FootPart] {
        let tool = approval.toolName ?? ""
        guard translatedOrbitCards.contains(tool), let translation = approval.translation, !translation.failed,
              orbitCardDraws(tool, approval.input) != orbitCardDraws(tool, approval.shownInput)
        else { return [] }
        return showOriginal
            ? [.text(TranslationCopy.original), .action(TranslationCopy.showTranslation, .flip)]
            : [.text(TranslationCopy.translated), .action(TranslationCopy.showOriginal, .flip)]
    }

    /// Everything an Orbit card draws from its input, to tell whether a translation reaches any of it.
    private static func orbitCardDraws(_ tool: String, _ input: JSONValue?) -> OrbitCardDraws? {
        guard let input else { return nil }
        if isTaskBatch(toolName: tool) {
            return .batch(batchPreview(from: input), batchTaskDetails(from: input))
        }
        if isDagChange(toolName: tool) { return .dag(dagPreview(from: input)) }
        if isBlockerResolve(toolName: tool) { return .blocker(blockerResolvePreview(toolName: tool, from: input)) }
        return .create(createPreview(toolName: tool, from: input))
    }

    private enum OrbitCardDraws: Equatable {
        case batch(BatchApprovalPreview?, [BatchTaskDetail])
        case dag(DagApprovalPreview?)
        case blocker(BlockerResolvePreview?)
        case create(CreateApprovalPreview?)
    }
}
