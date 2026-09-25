import Foundation
import XCTest
@testable import OrbitKit

/// The wiki reads decode as the user door answers them, a value this build has never heard of lands
/// on `.unknown` rather than failing the read it is in, and the two writes encode the bodies
/// `dto.ts` accepts.
final class WikiCodableTests: XCTestCase {

    // MARK: reads

    func testTheSpacesListCarriesTheCountTheDrawerSums() throws {
        let spaces = try WikiFixtures.decode([WikiSpace].self, WikiFixtures.spaces)
        XCTAssertEqual(spaces.map(\.slug), ["orbit", "wikova"])
        XCTAssertEqual(spaces.map(\.pendingOps), [3, 0])
        XCTAssertEqual(spaces[0].repoUrlNorm, "github.com/jianghailong-xy/orbit")
        XCTAssertEqual(spaces[0].settings?.push, true)
        XCTAssertNil(spaces[1].rootCommitSha)
        XCTAssertNil(spaces[0].usage, "only the one-space read carries usage")
    }

    func testOneSpaceCarriesItsUsageWindow() throws {
        let space = try WikiFixtures.decode(WikiSpace.self, WikiFixtures.space)
        XCTAssertNil(space.pendingOps, "the one-space read carries no count")
        let usage = try XCTUnwrap(space.usage)
        XCTAssertEqual(usage.days, 7)
        XCTAssertEqual(usage.sessionsPushed, 214)
        XCTAssertEqual(usage.searches, 38)
        XCTAssertEqual(usage.entries?.map(\.total), [41, 33, 29])
        XCTAssertEqual(usage.entries?.first?.id, WikiFixtures.pitfallID)
    }

    func testEntriesDecodeWithEveryField() throws {
        let entries = try WikiFixtures.decode([WikiEntry].self, WikiFixtures.entries)
        XCTAssertEqual(entries.count, 9)
        let principle = try XCTUnwrap(entries.first { $0.id == WikiFixtures.principleID })
        XCTAssertEqual(principle.kind, .principle)
        XCTAssertEqual(principle.status, .active)
        XCTAssertEqual(principle.trust, .owner)
        XCTAssertEqual(principle.anchorState, .verified)
        XCTAssertEqual(principle.anchorCheckedRef, WikiFixtures.sha)
        XCTAssertEqual(principle.pinned, true)
        XCTAssertEqual(principle.topics, ["tasks-dispatch"])
        XCTAssertEqual(principle.fields, .object([:]))
        XCTAssertFalse(principle.isEnded)
        let retired = try XCTUnwrap(entries.first { $0.status == .retired })
        XCTAssertTrue(retired.isEnded)
        XCTAssertEqual(retired.anchorState, .missing)
    }

    func testAnEntrysPageDecodesItsSourcesHistoryAndExposure() throws {
        let detail = try WikiFixtures.decode(WikiEntryDetail.self, WikiFixtures.entryDetail)
        XCTAssertEqual(detail.entry.id, WikiFixtures.pitfallID)
        XCTAssertEqual(detail.entry.kind, .pitfall)
        XCTAssertEqual(detail.entry.currentRevision, 2)
        XCTAssertEqual(detail.entry.anchors?.count, 2)
        XCTAssertEqual(detail.entry.anchors?.first?.type, .symbol)
        XCTAssertEqual(detail.entry.anchors?.first?.symbol, "askBeforeCreate")
        XCTAssertEqual(detail.entry.anchors?.first?.check?.state, .verified)
        XCTAssertEqual(detail.sources.map(\.kind), [.turn, .task, .commit])
        XCTAssertEqual(detail.sources.first?.quoteVerified, true)
        XCTAssertEqual(detail.sources.first?.locator?["seq"]?.intValue, 412)
        XCTAssertEqual(detail.history.map(\.revision), [2, 1])
        XCTAssertEqual(detail.history.map(\.authorKind), [.owner, .agent])
        XCTAssertEqual(detail.exposure.map(\.channel), [.push, .get, .push])

        // The three lists are what `include` asked for; an answer without them is still an entry.
        let bare = try WikiFixtures.decode(WikiEntryDetail.self, """
        {"id":"e1","kind":"concept","title":"t"}
        """)
        XCTAssertEqual(bare.entry.id, "e1")
        XCTAssertTrue(bare.sources.isEmpty && bare.history.isEmpty && bare.exposure.isEmpty)
    }

    func testTheReviewQueueDecodesEveryOpItCarries() throws {
        let review = try WikiFixtures.decode([WikiChangeset].self, WikiFixtures.review)
        XCTAssertEqual(review.map(\.origin), [.agent, .maintenance, .agent])
        XCTAssertEqual(review.map(\.status), [.pending, .pending, .pending])
        XCTAssertNil(review[1].sessionId, "Wiki maintenance has no session")
        let add = try XCTUnwrap(review[0].ops?.first)
        XCTAssertEqual(add.op, .add)
        XCTAssertEqual(add.decision, .pending)
        XCTAssertEqual(add.payload?["entry"]?["kind"]?.stringValue, "pitfall")
        XCTAssertEqual(add.payload?["entry"]?["fields"]?["trigger"]?["paths"],
                       .array([.string("src/apiserver/src/watches/watch-redaction.ts")]))
        let amend = try XCTUnwrap(review[2].ops?.first)
        XCTAssertEqual(amend.tainted, true)
        XCTAssertEqual(amend.similar?.first?.kind, .convention)
        XCTAssertEqual(amend.similar?.first?.score, 0.31)
        XCTAssertEqual(review[2].ops?.last?.decision, .autoApplied)
    }

    func testTheTimelineDecodes() throws {
        let timeline = try WikiFixtures.decode(WikiTimeline.self, WikiFixtures.timeline)
        let items = try XCTUnwrap(timeline.items)
        XCTAssertEqual(items.count, 5)
        XCTAssertEqual(items[0].op, .add)
        XCTAssertEqual(items[0].decision, .accepted)
        XCTAssertEqual(items[1].supersededByTitle, "Headless Chromium clamps windows under 500")
        XCTAssertEqual(items[2].decision, .autoApplied)
        XCTAssertEqual(items[2].origin, .owner)
        XCTAssertEqual(items[0].id, "0196e000-0000-7000-8000-00000000a001", "an op id stays the raw UUID")
    }

    /// A server a release ahead may add a kind, a status, a trust, an anchor state, an op or a
    /// decision. Each lands on `.unknown`, and the entry — and the list it is in — still reads.
    func testAValueFromALaterServerFallsToUnknown() throws {
        let entries = try WikiFixtures.decode([WikiEntry].self, """
        [{"id":"e1","kind":"hypothesis","status":"parked","trust":"crowd","anchorState":"stale",
          "anchors":[{"type":"url","check":{"state":"flaky"}}]},
         {"id":"e2","kind":"pitfall","status":"active","trust":"owner","anchorState":"verified"}]
        """)
        XCTAssertEqual(entries[0].kind, .unknown)
        XCTAssertEqual(entries[0].status, .unknown)
        XCTAssertEqual(entries[0].trust, .unknown)
        XCTAssertEqual(entries[0].anchorState, .unknown)
        XCTAssertEqual(entries[0].anchors?.first?.type, .unknown)
        XCTAssertEqual(entries[0].anchors?.first?.check?.state, .unknown)
        XCTAssertEqual(entries[1].kind, .pitfall)

        let changesets = try WikiFixtures.decode([WikiChangeset].self, """
        [{"id":"c1","origin":"oracle","status":"archived","ops":[
          {"id":"o1","op":"merge","decision":"deferred"}]}]
        """)
        XCTAssertEqual(changesets[0].origin, .unknown)
        XCTAssertEqual(changesets[0].status, .unknown)
        XCTAssertEqual(changesets[0].ops?.first?.op, .unknown)
        XCTAssertEqual(changesets[0].ops?.first?.decision, .unknown)

        let source = try WikiFixtures.decode(WikiSource.self, """
        {"id":"s1","kind":"hologram","state":"shredded"}
        """)
        XCTAssertEqual(source.kind, .unknown)
        XCTAssertEqual(source.state, .unknown)
        let exposure = try WikiFixtures.decode(WikiExposure.self, #"{"channel":"telepathy"}"#)
        XCTAssertEqual(exposure.channel, .unknown)
        let revision = try WikiFixtures.decode(WikiRevision.self, #"{"id":"r1","authorKind":"ghost"}"#)
        XCTAssertEqual(revision.authorKind, .unknown)
    }

    /// `wiki.changed` as the control plane sends it: user-scoped (no session), naming the space and
    /// nothing else, with the public-id twin the interceptor adds.
    func testTheWikiChangedFrameDecodes() throws {
        let frame = #"{"type":"wiki.changed","sessionId":"","agentId":null,"ts":"2026-09-25T12:00:00.000Z","data":{"id":"34UAq0rbitSpaceOrbit01","publicId":"34UAq0rbitSpaceOrbit01"},"agentPublicId":null,"workspaceId":null}"#
        let event = try JSONDecoder().decode(ControlEvent.self, from: Data(frame.utf8))
        XCTAssertEqual(event.type, .wikiChanged)
        XCTAssertEqual(event.sessionId, "")
        XCTAssertEqual(event.data?["id"]?.stringValue, "34UAq0rbitSpaceOrbit01")
        XCTAssertEqual(SSEDecoding.controlEvent(from: SSEEvent(id: nil, event: nil, data: frame))?.type,
                       .wikiChanged)
    }

    // MARK: writes

    private func json(_ value: some Encodable) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    /// `decide`'s body: one decision per op, the reason only on a reject and the owner's version only
    /// on an edit — an absent key is absent, never `null`.
    func testTheDecideBodyIsWhatTheDoorReads() throws {
        let body = try json(WikiDecideRequest(decisions: [
            WikiDecision(opId: "o1", action: .accept),
            WikiDecision(opId: "o2", action: .reject, reason: .tooSpecific),
            WikiDecision(opId: "o3", action: .edit, edited: WikiEntryChanges(title: "T", summary: "S")),
        ]))
        let decisions = try XCTUnwrap(body["decisions"] as? [[String: Any]])
        XCTAssertEqual(decisions.count, 3)
        XCTAssertEqual(decisions[0] as NSDictionary, ["opId": "o1", "action": "accept"])
        XCTAssertEqual(decisions[1] as NSDictionary, ["opId": "o2", "action": "reject", "reason": "too_specific"])
        XCTAssertEqual(decisions[2] as NSDictionary,
                       ["opId": "o3", "action": "edit", "edited": ["title": "T", "summary": "S"]])
        XCTAssertEqual(WikiRejectReason.allCases.map(\.rawValue),
                       ["not_true", "not_useful", "duplicate", "too_specific"])
    }

    /// The owner's own write: the three ops the entry page offers, each with the keys its op takes
    /// (contract `ops.<op>.keys`), and nothing else — the door refuses a key no op names.
    func testTheOwnerWriteBodyIsWhatTheDoorReads() throws {
        let body = try json(WikiChangesetRequest(
            ops: [.amend(entryId: "e1", baseRevision: 2, changes: WikiEntryChanges(title: "New")),
                  .supersede(entryId: "e1", baseRevision: 2,
                             entry: .object(["kind": .string("pitfall"), "title": .string("T")])),
                  .retire(entryId: "e1", baseRevision: 2, reason: "The fix landed")],
            rationale: "Edited from the iOS app", idempotencyKey: "ios:k1"))
        XCTAssertEqual(body["rationale"] as? String, "Edited from the iOS app")
        XCTAssertEqual(body["idempotencyKey"] as? String, "ios:k1")
        let ops = try XCTUnwrap(body["ops"] as? [[String: Any]])
        XCTAssertEqual(ops[0] as NSDictionary,
                       ["op": "amend", "entryId": "e1", "baseRevision": 2, "changes": ["title": "New"]])
        XCTAssertEqual(ops[1] as NSDictionary,
                       ["op": "supersede", "entryId": "e1", "baseRevision": 2,
                        "entry": ["kind": "pitfall", "title": "T"]])
        XCTAssertEqual(ops[2] as NSDictionary,
                       ["op": "retire", "entryId": "e1", "baseRevision": 2, "reason": "The fix landed"])
    }

    func testTheOwnerWritesAnswerDecodes() throws {
        let result = try WikiFixtures.decode(WikiChangeResult.self, """
        {"changesetId":"c1","changesetPublicId":"c1","replayed":false,"ops":[
          {"seq":0,"status":"applied","opId":"0196e000-0000-7000-8000-000000000001","entryId":"e1","revision":3},
          {"seq":1,"status":"refused","reasons":[{"code":"WIKI_SCHEMA","message":"title: is too long"}]}]}
        """)
        XCTAssertEqual(result.ops?.map(\.status), ["applied", "refused"])
        XCTAssertEqual(result.ops?.first?.revision, 3)
        XCTAssertEqual(result.ops?.last?.reasons?.first?.code, "WIKI_SCHEMA")
    }
}
