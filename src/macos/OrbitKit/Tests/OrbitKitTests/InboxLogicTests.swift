import XCTest
@testable import OrbitKit

/// The cross-project inbox: what `GET /inbox` decodes to, what a card says, and what answering one
/// sends — held to the same rules as web's `InboxView.test.tsx` / `approvalDecision.test.ts`.
final class InboxLogicTests: XCTestCase {

    private func item(_ id: String, kind: InboxApprovalKind = .permission, toolName: String = "Bash",
                      summary: String = "git status", role: SessionProjectRole = .user,
                      sessionTitle: String = "A session", taskTitle: String? = nil,
                      projectTitle: String? = nil, waitingSince: String = "2026-08-22T09:00:00Z")
    -> InboxApprovalItem {
        InboxApprovalItem(approvalId: id, kind: kind, toolName: toolName, summary: summary,
                          sessionId: "s-\(id)", sessionTitle: sessionTitle,
                          taskId: taskTitle == nil ? nil : "t-\(id)", taskTitle: taskTitle,
                          projectId: projectTitle == nil ? nil : "p-\(id)",
                          projectTitle: projectTitle, role: role, waitingSince: waitingSince)
    }

    // MARK: wire

    /// The three kinds, the four roles, and the optional halves of a card all decode; the order is
    /// the server's (waitingSince ASC) and nothing here re-sorts it.
    func testDecodesTheInboxPayloadInServerOrder() throws {
        let json = """
        {"pending":[
          {"approvalId":"a1","kind":"permission","toolName":"Bash","summary":"rm -rf build",
           "sessionId":"s1","sessionTitle":"Cleaning up","workspaceId":"w1",
           "taskId":"t1","taskTitle":"E1 · perf","projectId":"p1","projectTitle":"Redesign",
           "role":"execution","waitingSince":"2026-08-22T09:00:00.000Z"},
          {"approvalId":"a2","kind":"plan","toolName":"ExitPlanMode","summary":"Rework the list",
           "sessionId":"s2","sessionTitle":"Planning","role":"coordinator",
           "waitingSince":"2026-08-22T10:00:00.000Z"},
          {"approvalId":"a3","kind":"question","toolName":"AskUserQuestion","summary":"Which store?",
           "sessionId":"s3","sessionTitle":"Asking","role":"verification",
           "waitingSince":"2026-08-22T11:00:00.000Z"}],
         "resolved":[
          {"approvalId":"a0","kind":"permission","toolName":"Read","summary":"/etc/hosts",
           "sessionId":"s0","sessionTitle":"Earlier","role":"user",
           "waitingSince":"2026-08-22T08:00:00.000Z","status":"ALLOWED","decision":"allow",
           "resolvedAt":"2026-08-22T08:05:00.000Z","message":"go ahead"}]}
        """
        let inbox = try JSONDecoder().decode(InboxResponse.self, from: Data(json.utf8))
        XCTAssertEqual(inbox.pending.map(\.approvalId), ["a1", "a2", "a3"])
        XCTAssertEqual(inbox.pending.map(\.kind), [.permission, .plan, .question])
        XCTAssertEqual(inbox.pending.map(\.role), [.execution, .coordinator, .verification])
        XCTAssertEqual(inbox.pending[0].taskTitle, "E1 · perf")
        XCTAssertEqual(inbox.pending[0].projectTitle, "Redesign")
        XCTAssertEqual(inbox.pending[0].workspaceId, "w1")
        XCTAssertNil(inbox.pending[1].taskId)
        XCTAssertNil(inbox.pending[1].projectId)
        XCTAssertEqual(inbox.resolved.map(\.id), ["a0"])
        XCTAssertEqual(inbox.resolved[0].decision, .allow)
        XCTAssertEqual(inbox.resolved[0].resolvedAt, "2026-08-22T08:05:00.000Z")
        XCTAssertEqual(inbox.resolved[0].message, "go ahead")
        XCTAssertEqual(inbox.resolved[0].item.summary, "/etc/hosts")
    }

    /// A kind or role a newer server invents must not blank the one surface a blocked agent is
    /// unblocked from.
    func testUnknownKindAndRoleDegradeInsteadOfFailing() throws {
        let json = """
        {"pending":[{"approvalId":"a1","kind":"handshake","toolName":"X","summary":"",
          "sessionId":"s1","sessionTitle":"t","role":"auditor",
          "waitingSince":"2026-08-22T09:00:00.000Z"}],"resolved":[]}
        """
        let inbox = try JSONDecoder().decode(InboxResponse.self, from: Data(json.utf8))
        XCTAssertEqual(inbox.pending[0].kind, .permission)
        XCTAssertEqual(inbox.pending[0].role, .user)
    }

    /// A settled row from a server that sends only the durable `status` still says how it went.
    func testResolvedDecisionFallsBackToStatus() throws {
        let json = """
        {"pending":[],"resolved":[{"approvalId":"a1","kind":"permission","toolName":"Bash",
          "summary":"x","sessionId":"s1","sessionTitle":"t","role":"user",
          "waitingSince":"2026-08-22T09:00:00.000Z","status":"DENIED",
          "resolvedAt":"2026-08-22T09:01:00.000Z"}]}
        """
        let inbox = try JSONDecoder().decode(InboxResponse.self, from: Data(json.utf8))
        XCTAssertEqual(inbox.resolved[0].decision, .deny)
        XCTAssertNil(inbox.resolved[0].message)
    }

    func testEmptyResponseDecodes() throws {
        let inbox = try JSONDecoder().decode(InboxResponse.self, from: Data("{}".utf8))
        XCTAssertTrue(inbox.pending.isEmpty)
        XCTAssertTrue(inbox.resolved.isEmpty)
    }

    func testProjectCountsDecode() throws {
        let rows = try JSONDecoder().decode(
            [ProjectSessionCounts].self,
            from: Data(#"[{"projectId":"p1","needsYou":1,"running":1,"done":2,"total":4}]"#.utf8))
        XCTAssertEqual(rows, [ProjectSessionCounts(projectId: "p1", needsYou: 1, running: 1,
                                                   done: 2, total: 4)])
    }

    // MARK: card text

    func testCardTitleFallsBackToTheToolNameWhenNothingIsSummarizable() {
        XCTAssertEqual(InboxLogic.cardTitle(item("a", summary: "rm -rf build")), "rm -rf build")
        XCTAssertEqual(InboxLogic.cardTitle(item("a", toolName: "WebFetch", summary: "")), "WebFetch")
    }

    /// The second line names who is asking and what work it belongs to; absent parts are dropped
    /// rather than rendered as empty separators.
    func testMetaLineJoinsRoleTaskAndProject() {
        XCTAssertEqual(InboxLogic.metaLine(item("a", role: .execution, taskTitle: "E1 · perf",
                                                projectTitle: "Redesign")),
                       "Execution · E1 · perf · Redesign")
        // No task: the session's own title stands in, since "Direct" alone names nothing findable.
        XCTAssertEqual(InboxLogic.metaLine(item("a", role: .user, sessionTitle: "Scratch")),
                       "Direct · Scratch")
        XCTAssertEqual(InboxLogic.metaLine(item("a", role: .coordinator, sessionTitle: "",
                                                projectTitle: "Redesign")),
                       "Coordinator · Redesign")
        XCTAssertEqual(InboxLogic.roleLabel(.verification), "Verification")
    }

    // MARK: waiting

    func testWaitedLabelCountsMinutesThenHoursThenDays() {
        XCTAssertEqual(InboxLogic.waitedLabel(0), "<1m")
        XCTAssertEqual(InboxLogic.waitedLabel(59), "<1m")
        XCTAssertEqual(InboxLogic.waitedLabel(60), "1m")
        XCTAssertEqual(InboxLogic.waitedLabel(59 * 60), "59m")
        XCTAssertEqual(InboxLogic.waitedLabel(60 * 60), "1h")
        XCTAssertEqual(InboxLogic.waitedLabel(90 * 60), "1h 30m")
        XCTAssertEqual(InboxLogic.waitedLabel(24 * 3600), "1d")
        XCTAssertEqual(InboxLogic.waitedLabel(50 * 3600), "2d")
        XCTAssertEqual(InboxLogic.waitedLabel(-30), "<1m")   // never a negative age
    }

    func testWaitedReadsTheServerTimestampAndNeverGoesNegative() {
        let now = ISO8601DateFormatter().date(from: "2026-08-22T10:00:00Z")!
        XCTAssertEqual(InboxLogic.waited(item("a", waitingSince: "2026-08-22T09:00:00Z"), now: now),
                       3600, accuracy: 1)
        // Clock skew: a card stamped a second in the future reads as just arrived.
        XCTAssertEqual(InboxLogic.waited(item("a", waitingSince: "2026-08-22T10:30:00Z"), now: now), 0)
        XCTAssertEqual(InboxLogic.waited(item("a", waitingSince: "not a date"), now: now), 0)
        XCTAssertEqual(InboxLogic.urgentAfter, 30 * 60)
    }

    func testStartOfTodayIsLocalMidnightAndParsesBack() {
        let now = Date()
        let iso = InboxLogic.startOfToday(now: now)
        let parsed = RelativeTime.parse(iso)
        XCTAssertEqual(parsed, Calendar.current.startOfDay(for: now))
    }

    // MARK: decisions

    func testPermissionDecisionIsBareAllowOrDeny() {
        let allow = InboxLogic.decision(for: item("a"), behavior: .allow)
        XCTAssertEqual(allow.behavior, .allow)
        XCTAssertNil(allow.answers)
        XCTAssertNil(allow.message)
        // No "always allow" from an inbox card: the payload carries no `input` to derive a rule
        // from, and a standing workspace rule is not a thing to hand someone triaging in bulk.
        XCTAssertNil(allow.rememberRule)
        XCTAssertEqual(InboxLogic.decision(for: item("a"), behavior: .deny).behavior, .deny)
    }

    func testQuestionAnswersRideOnlyWithAnAllow() {
        let question = item("a", kind: .question, toolName: "AskUserQuestion", summary: "Which?")
        let answered = InboxLogic.decision(for: question, behavior: .allow,
                                           answers: ["Which?": ["Option A"]])
        XCTAssertEqual(answered.answers?["Which?"], ["Option A"])
        // A deny means the user answered some other way, so the picks are dropped.
        XCTAssertNil(InboxLogic.decision(for: question, behavior: .deny,
                                         answers: ["Which?": ["Option A"]]).answers)
        // Picks only make sense on the tool that asked for them.
        XCTAssertNil(InboxLogic.decision(for: item("a"), behavior: .allow,
                                         answers: ["Which?": ["Option A"]]).answers)
    }

    func testDecisionCarriesAMessageWhenOneWasTyped() {
        let d = InboxLogic.decision(for: item("a"), behavior: .deny, message: "not now")
        XCTAssertEqual(d.message, "not now")
    }

    // MARK: optimistic settle

    /// The card goes the moment it is answered, into Resolved where the user just sent it — and the
    /// frame this produces is the one the server's own refetch lands on, so nothing visibly moves.
    func testSettleMovesTheCardToTheHeadOfResolved() {
        let inbox = InboxResponse(pending: [item("a1"), item("a2")], resolved: [])
        let at = ISO8601DateFormatter().date(from: "2026-08-22T12:00:00Z")!
        let after = InboxLogic.settle(inbox, approvalID: "a1",
                                      decision: InboxLogic.decision(for: item("a1"), behavior: .allow),
                                      at: at)
        XCTAssertEqual(after.pending.map(\.approvalId), ["a2"])
        XCTAssertEqual(after.resolved.map(\.id), ["a1"])
        XCTAssertEqual(after.resolved[0].decision, .allow)
        XCTAssertEqual(after.resolved[0].resolvedAt, "2026-08-22T12:00:00Z")
        // The settled card keeps the identity it had while it waited, `waitingSince` included.
        XCTAssertEqual(after.resolved[0].item.waitingSince, "2026-08-22T09:00:00Z")
    }

    func testSettlePrependsAheadOfWhatWasAlreadyResolved() {
        let older = InboxResolvedItem(item: item("a0"), decision: .deny,
                                      resolvedAt: "2026-08-22T08:00:00Z")
        let inbox = InboxResponse(pending: [item("a1")], resolved: [older])
        let after = InboxLogic.settle(inbox, approvalID: "a1",
                                      decision: InboxLogic.decision(for: item("a1"), behavior: .deny,
                                                                    message: "no"))
        XCTAssertEqual(after.resolved.map(\.id), ["a1", "a0"])
        XCTAssertEqual(after.resolved[0].message, "no")
    }

    /// An approval answered elsewhere (or already gone from this snapshot) is left alone rather than
    /// duplicated into Resolved.
    func testSettleIsANoOpForAnApprovalThatIsNoLongerPending() {
        let inbox = InboxResponse(pending: [item("a1")], resolved: [])
        let after = InboxLogic.settle(inbox, approvalID: "gone",
                                      decision: InboxLogic.decision(for: item("a1"), behavior: .allow))
        XCTAssertEqual(after, inbox)
    }
}
