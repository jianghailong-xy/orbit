#if os(iOS)
import Foundation
import Observation
import OrbitKit

/// The merge into main as the project's sessions page shows it (owner decision 2026-10-06): the
/// candidate on offer, for the card under the progress card; the merges already made, for the
/// timeline; and the three presses. The page polls it alongside its sessions, and the review sheet
/// reads it through `PromotionReviewSource` — the same sheet the coordinator's conversation opens.
@MainActor
@Observable
final class ProjectMergeModel: PromotionReviewSource {
    let projectID: String
    private let api: APIClient

    /// The candidate on offer, or nil while the project is asking nothing. A read that fails leaves
    /// it as it was: the card says what it last read, not that the merge vanished.
    private(set) var current: ProjectPromotionView?
    /// The merges already made, newest first — the timeline's rows.
    private(set) var merged: [ProjectPromotionView] = []
    private(set) var openItems: ProjectOpenItemsView?
    private var criteria: [ProjectCriteriaDocument.Item] = []
    private var mergedReadAt: Date?
    private var itemsReadAt: Date?
    private var criteriaReadAt: Date?
    /// Bumped by every read and press, so an older poll that lands after a press cannot put back
    /// the state the press moved the candidate out of.
    private var generation = 0

    init(projectID: String, api: APIClient) {
        self.projectID = projectID
        self.api = api
    }

    var receipts: [PromotionCards.Receipt] { PromotionCards.receipts(merged: merged) }

    /// One poll. The candidate every time, since it is what the card is; then, side by side, the
    /// merges when the candidate moved and otherwise once a minute; the open items every 20 seconds
    /// while one is blocked, because its holder is on the card; the criteria once a minute while one
    /// is asking.
    func load(force: Bool = false) async {
        generation += 1
        let mine = generation
        let before = current
        do {
            let read = try await api.currentPromotion(projectID: projectID)
            guard mine == generation else { return }
            current = read
        } catch {
            guard mine == generation else { return }
        }
        let moved = before?.promotionId != current?.promotionId || before?.state != current?.state
        let stage = current.flatMap(PromotionCards.stage)
        let mergedDue = force || moved || mergedReadAt.map({ Date().timeIntervalSince($0) > 60 }) != false
        let itemsDue = force || (stage == .blocked && (moved || itemsReadAt.map({ Date().timeIntervalSince($0) > 20 }) != false))
        let criteriaDue = stage == .askingYou && (force || criteriaReadAt.map({ Date().timeIntervalSince($0) > 60 }) != false)
        let mergedRead: Task<[ProjectPromotionView], Error>? = mergedDue
            ? Task { try await api.mergedPromotions(projectID: projectID) } : nil
        let itemsRead: Task<ProjectOpenItemsView, Error>? = itemsDue
            ? Task { try await api.projectOpenItems(projectID: projectID) } : nil
        let criteriaRead: Task<ProjectCriteriaDocument, Error>? = criteriaDue
            ? Task { try await api.projectCriteria(projectID: projectID) } : nil
        defer {
            mergedRead?.cancel()
            itemsRead?.cancel()
            criteriaRead?.cancel()
        }
        if let read = try? await mergedRead?.value, mine == generation {
            merged = read
            mergedReadAt = Date()
        }
        if let items = try? await itemsRead?.value, mine == generation {
            openItems = items
            itemsReadAt = Date()
        }
        if let document = try? await criteriaRead?.value, mine == generation {
            criteria = document.acceptanceCriteriaItems ?? []
            criteriaReadAt = Date()
        }
    }

    // MARK: PromotionReviewSource

    func promotionStanding(_ promotionID: String) -> ProjectPromotionView? {
        current?.promotionId == promotionID ? current : nil
    }

    var promotionItems: [ProjectOpenItemRow] {
        (openItems?.needsYou ?? []) + (openItems?.withCoordinator ?? [])
    }

    /// Nil until the criteria have been read — "0 of 0 met" would be a claim nobody checked.
    var criteriaMet: (met: Int, total: Int)? {
        guard !criteria.isEmpty else { return nil }
        return (criteria.filter { $0.satisfied == true }.count, criteria.count)
    }

    func refreshPromotion() async {
        await load(force: true)
    }

    /// M-T4: merge it, with the candidate's own source SHA, so a card drawn before a newer
    /// candidate superseded it is refused rather than merging whatever is on the branch now.
    func confirmMergeToMain(_ view: ProjectPromotionView) async -> String? {
        await press(failure: "That merge was not confirmed") {
            try await $0.confirmPromotion(projectID: $1, promotionID: view.promotionId, sourceSha: view.sourceSha)
        }
    }

    /// M-T5: not now. The branch stays where it is, and the next landing offers it again.
    func declineMergeToMain(_ view: ProjectPromotionView) async -> String? {
        await press(failure: "That was not recorded") {
            try await $0.declinePromotion(projectID: $1, promotionID: view.promotionId)
        }
    }

    /// M-T10: call it back, while its job has not reached the push.
    func cancelMergeToMain(_ view: ProjectPromotionView) async -> String? {
        await press(failure: "That merge was not called back") {
            try await $0.cancelPromotion(projectID: $1, promotionID: view.promotionId)
        }
    }

    /// The door's answer is the candidate's new state, drawn at once; then everything the card is
    /// drawn from is read again. The failure is returned for the card or sheet to show where the
    /// press was made, in the console's words.
    private func press(failure: String,
                       _ door: (APIClient, String) async throws -> ProjectPromotionView) async -> String? {
        generation += 1
        var refused: String?
        do {
            current = try await door(api, projectID)
        } catch {
            refused = "\(failure) — \(APIClient.failureReason(error))."
        }
        await load(force: true)
        return refused
    }
}
#endif
