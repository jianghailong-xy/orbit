import Foundation
import XCTest
@testable import OrbitKit

/// The projects index lanes, orders and chips, case for case with the web's
/// `src/web/src/lib/projectAttention.test.ts` — the two clients must put the same project in the
/// same lane under the same words.
final class ProjectAttentionTests: XCTestCase {

    private static let now = RelativeTime.parse("2026-08-23T18:55:05.000Z")!
    private static let minute: TimeInterval = 60
    private static let hour: TimeInterval = 3_600
    private static let quiet = ProjectAttention.quietInterval

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// An instant `seconds` before now (negative: in the future).
    private func at(_ seconds: TimeInterval) -> String {
        Self.iso.string(from: Self.now.addingTimeInterval(-seconds))
    }

    private var nextID = 0

    /// A row shaped like the web fixture: the buckets it names, a task total that sums them, and —
    /// unless told otherwise — activity an hour ago when it has any task at all.
    private func project(title: String? = nil, id: String? = nil, status: ProjectStatus = .open,
                         taskCount: Int? = nil, running: Int = 0, ready: Int = 0, blocked: Int = 0,
                         done: Int = 0, cancelled: Int = 0,
                         lastActivityAt: String?? = nil,
                         attention: ProjectListAttention? = nil,
                         integration: ProjectListIntegration? = nil) -> ProjectSummary {
        nextID += 1
        let bucketed = running + ready + blocked + done + cancelled
        let activity: String?
        switch lastActivityAt {
        case .none: activity = bucketed > 0 ? at(Self.hour) : nil
        case .some(let explicit): activity = explicit
        }
        return ProjectSummary(
            id: id ?? String(format: "0195c0de-0000-7000-8000-%012d", nextID),
            title: title ?? "Project \(nextID)",
            status: status,
            createdAt: "2026-01-01T00:00:00.000Z",
            taskCount: taskCount ?? bucketed,
            // No `failed` lane, like the web fixture: it is derived from the total.
            buckets: ProjectBuckets(running: running, ready: ready, blocked: blocked, done: done,
                                    failed: nil, cancelled: cancelled),
            lastActivityAt: activity,
            attention: attention,
            integration: integration)
    }

    private func ownerItem(_ kind: OwnerItemKind, _ count: Int, waited: TimeInterval) -> ProjectListOwnerItem {
        ProjectListOwnerItem(kind: kind, count: count, oldestWaitingSince: at(waited))
    }

    private func coordinatorItems(_ lead: CoordinatorLeadKind, waited: TimeInterval) -> ProjectListCoordinatorItems {
        ProjectListCoordinatorItems(count: 1, leadKind: lead, oldestWaitingSince: at(waited),
                                    nextEscalationAt: at(-90 * Self.minute))
    }

    private func reason(_ p: ProjectSummary) -> ProjectAttentionReason? {
        ProjectAttention.reason(of: p, now: Self.now)
    }

    private func section(_ p: ProjectSummary) -> ProjectAttentionSection {
        ProjectAttention.section(of: p, now: Self.now)
    }

    private func chip(_ p: ProjectSummary) -> ProjectAttentionChip? {
        ProjectAttention.chip(of: p, now: Self.now)
    }

    // MARK: classification

    func testCoordinatorOrSystemBlockerRoutesFreshRunningWorkToAutoRemediation() {
        for (coordinator, system) in [(1, 0), (0, 1)] {
            let row = project(running: 1, ready: 2, attention: ProjectListAttention(
                coordinatorBlockers: coordinator, systemBlockers: system, maxSeverity: .critical,
                attentionSinceAt: at(Self.hour)))
            XCTAssertEqual(reason(row), .autoRemediation)
            XCTAssertEqual(section(row), .attention)
            XCTAssertEqual(chip(row), ProjectAttentionChip(
                tone: .warning, text: "Auto-remediation · Coordinator-owned · Critical · <1d · 1 blocker"))
        }
    }

    func testFreshRunKeepsRunningWhileShowingItsUserBlocker() {
        let row = project(running: 1, attention: ProjectListAttention(
            userBlockers: 1, maxSeverity: .warning, attentionSinceAt: at(2 * Self.quiet),
            nextCheckAt: at(-Self.hour)))
        XCTAssertEqual(reason(row), .needsUser)
        XCTAssertEqual(chip(row), ProjectAttentionChip(tone: .warning,
                                                       text: "Needs you · Warning · 2d · 1 blocker"))
        XCTAssertEqual(section(row), .running)
    }

    func testClosedProjectsAreCompletedWhateverTheirBucketsSay() {
        for status in [ProjectStatus.done, .cancelled] {
            let row = project(status: status, taskCount: 8, running: 2, ready: 4)
            XCTAssertEqual(section(row), .completed)
            XCTAssertNil(reason(row))
        }
    }

    func testOrdinaryFailedRemainderStaysRunningWithoutNeedsYou() {
        let row = project(taskCount: 5, running: 1, done: 2)
        XCTAssertEqual(ProjectAttention.failedTaskCount(row), 2)
        XCTAssertNil(reason(row))
        XCTAssertNil(chip(row))
        XCTAssertEqual(section(row), .running)

        XCTAssertEqual(ProjectAttention.failedTaskCount(project(taskCount: 1, done: 2)), 0)
    }

    func testQuietRunningWorkNeedsAttention() {
        let needsUser = project(running: 1, lastActivityAt: .some(at(2 * Self.quiet)),
                                attention: ProjectListAttention(userBlockers: 1, maxSeverity: .critical,
                                                                attentionSinceAt: at(3 * Self.quiet)))
        let failed = project(taskCount: 3, running: 1, done: 1, lastActivityAt: .some(at(2 * Self.quiet)))
        XCTAssertEqual(reason(needsUser), .needsUser)
        XCTAssertEqual(section(needsUser), .attention)
        XCTAssertEqual(reason(failed), .noActivityRunning)
        XCTAssertEqual(section(failed), .attention)
    }

    func testHealthyRunVersusQuietRun() {
        let healthy = project(running: 1, ready: 3, lastActivityAt: .some(at(Self.hour)))
        let quiet = project(running: 1, ready: 3, lastActivityAt: .some(at(2 * Self.quiet)))
        XCTAssertEqual(section(healthy), .running)
        XCTAssertNil(reason(healthy))
        XCTAssertEqual(section(quiet), .attention)
        XCTAssertEqual(reason(quiet), .noActivityRunning)
    }

    func testFreshReadyWorkGetsAGracePeriod() {
        let fresh = project(ready: 9, blocked: 1, lastActivityAt: .some(at(Self.hour)))
        let quiet = project(ready: 9, blocked: 1, lastActivityAt: .some(at(2 * Self.quiet)))
        XCTAssertEqual(section(fresh), .ready)
        XCTAssertEqual(section(quiet), .attention)
        XCTAssertEqual(reason(quiet), .noActivityReady)
    }

    func testDependencyOnlyWorkIsWaitingHoweverOld() {
        let waiting = project(blocked: 4, lastActivityAt: .some(at(30 * Self.quiet)))
        XCTAssertEqual(section(waiting), .waiting)
        XCTAssertNil(reason(waiting))
    }

    func testSettledButOpenNeedsAttentionAndEmptyNeedsDefinition() {
        let settled = project(done: 5, cancelled: 7)
        XCTAssertEqual(section(settled), .attention)
        XCTAssertEqual(reason(settled), .readyToClose)
        XCTAssertEqual(section(project(title: "Unplanned project")), .definition)
    }

    func testEveryCombinationLandsInExactlyOneOfTheSixLanes() {
        var seen = Set<ProjectAttentionSection>()
        let counts = [0, 1, 2]
        for status in [ProjectStatus.open, .done, .cancelled] {
            for running in counts { for ready in counts { for blocked in counts {
                for done in counts { for cancelled in counts {
                    let any = running + ready + blocked + done + cancelled > 0
                    let row = project(status: status, running: running, ready: ready, blocked: blocked,
                                      done: done, cancelled: cancelled,
                                      lastActivityAt: .some(any ? at(Self.hour) : nil))
                    seen.insert(section(row))
                } }
            } } }
        }
        XCTAssertEqual(seen, Set(ProjectAttentionSection.allCases))
    }

    // MARK: order within a lane

    func testNeedsAttentionOrdersByReasonThenLongestQuietFirst() {
        let closing = project(title: "Close", done: 2)
        let readyNewer = project(title: "Ready newer", ready: 1, lastActivityAt: .some(at(2 * Self.quiet)))
        let readyOlder = project(title: "Ready older", ready: 1, lastActivityAt: .some(at(4 * Self.quiet)))
        let zombie = project(title: "Zombie", running: 1, lastActivityAt: .some(at(3 * Self.quiet)))
        let needsUser = project(title: "Needs user", attention: ProjectListAttention(
            userBlockers: 1, maxSeverity: .warning, attentionSinceAt: at(Self.quiet)))
        let ordered = ProjectAttention.ordered([closing, readyNewer, needsUser, zombie, readyOlder],
                                               in: .attention, now: Self.now)
        XCTAssertEqual(ordered.map(\.title), ["Needs user", "Zombie", "Ready older", "Ready newer", "Close"])
    }

    func testRawReadyCountNeverDecidesPriority() {
        let oneOlder = project(ready: 1, lastActivityAt: .some(at(10 * Self.hour)))
        let tenThousandNewer = project(ready: 10_000, lastActivityAt: .some(at(Self.hour)))
        XCTAssertEqual(ProjectAttention.ordered([tenThousandNewer, oneOlder], in: .ready, now: Self.now)
                        .map(\.id), [oneOlder.id, tenThousandNewer.id])
    }

    func testHumanBlockersOrderBySeverityThenHowLongTheyHaveBeenOwned() {
        let warningNew = project(attention: ProjectListAttention(
            userBlockers: 1, maxSeverity: .warning, attentionSinceAt: at(Self.quiet)))
        let warningOld = project(attention: ProjectListAttention(
            userBlockers: 2, maxSeverity: .warning, attentionSinceAt: at(4 * Self.quiet)))
        let criticalNew = project(attention: ProjectListAttention(
            userBlockers: 1, maxSeverity: .critical, attentionSinceAt: at(Self.hour)))
        XCTAssertEqual(ProjectAttention.ordered([warningNew, warningOld, criticalNew], in: .attention,
                                                now: Self.now).map(\.id),
                       [criticalNew.id, warningOld.id, warningNew.id])
    }

    func testRunningAndCompletedPutNewestActivityFirst() {
        let older = project(running: 1, lastActivityAt: .some(at(3 * Self.hour)))
        let newer = project(running: 1, lastActivityAt: .some(at(Self.hour)))
        XCTAssertEqual(ProjectAttention.ordered([older, newer], in: .running, now: Self.now).map(\.id),
                       [newer.id, older.id])
        let closedOlder = project(status: .done, done: 1, lastActivityAt: .some(at(3 * Self.hour)))
        let closedNewer = project(status: .done, done: 1, lastActivityAt: .some(at(Self.hour)))
        XCTAssertEqual(ProjectAttention.ordered([closedOlder, closedNewer], in: .completed,
                                                now: Self.now).map(\.id),
                       [closedNewer.id, closedOlder.id])
    }

    func testReadyAndWaitingPutOldestActivityFirst() {
        let olderReady = project(ready: 1, lastActivityAt: .some(at(10 * Self.hour)))
        let newerReady = project(ready: 1, lastActivityAt: .some(at(Self.hour)))
        XCTAssertEqual(ProjectAttention.ordered([newerReady, olderReady], in: .ready, now: Self.now)
                        .map(\.id), [olderReady.id, newerReady.id])
        let olderWait = project(blocked: 1, lastActivityAt: .some(at(5 * Self.quiet)))
        let newerWait = project(blocked: 1, lastActivityAt: .some(at(Self.quiet)))
        XCTAssertEqual(ProjectAttention.ordered([newerWait, olderWait], in: .waiting, now: Self.now)
                        .map(\.id), [olderWait.id, newerWait.id])
    }

    func testNeedsDefinitionOrdersByTitleThenID() {
        let zulu = project(title: "Zulu")
        let alphaB = project(title: "Alpha", id: "b")
        let alphaA = project(title: "Alpha", id: "a")
        XCTAssertEqual(ProjectAttention.ordered([zulu, alphaB, alphaA], in: .definition, now: Self.now)
                        .map(\.id), ["a", "b", zulu.id])
    }

    func testSectionsAreTheSixLanesInNextActorOrderWithOnlyCompletedFolded() {
        let sections = ProjectAttention.sections([project(running: 1)], now: Self.now)
        XCTAssertEqual(sections.map(\.section), [.attention, .running, .ready, .waiting, .definition, .completed])
        XCTAssertEqual(sections.map(\.section.title),
                       ["Needs attention", "Running", "Ready", "Waiting", "Needs definition", "Completed"])
        XCTAssertEqual(ProjectAttentionSection.allCases.filter(\.defaultCollapsed), [.completed])
        XCTAssertEqual(sections.first { $0.section == .waiting }?.projects.count, 0)
        XCTAssertEqual(sections.first { $0.section == .running }?.projects.count, 1)
    }

    // MARK: chips

    func testAutoRemediationStaysExplicitWhenAPersonIsAlsoNeeded() {
        let row = project(attention: ProjectListAttention(
            userBlockers: 2, coordinatorBlockers: 1, maxSeverity: .critical,
            attentionSinceAt: at(2 * Self.quiet)))
        XCTAssertEqual(chip(row)?.text,
                       "Auto-remediation · Coordinator-owned · Critical · 2d · 1 blocker · 2 need you")
    }

    func testHumanBlockerChipCountsBlockers() {
        let row = project(attention: ProjectListAttention(
            userBlockers: 2, maxSeverity: .critical, attentionSinceAt: at(2 * Self.quiet)))
        XCTAssertEqual(chip(row), ProjectAttentionChip(tone: .warning,
                                                       text: "Needs you · Critical · 2d · 2 blockers"))
    }

    func testQuietRunAndIdleReadyQueueSayDifferentThings() {
        XCTAssertEqual(chip(project(running: 1, lastActivityAt: .some(at(3 * Self.quiet)))),
                       ProjectAttentionChip(tone: .warning, text: "Running · no activity 3d"))
        XCTAssertEqual(chip(project(ready: 1, lastActivityAt: .some(at(2 * Self.quiet)))),
                       ProjectAttentionChip(tone: .warning, text: "Ready · no activity 2d"))
    }

    func testSettledWorkThatStillNeedsClosing() {
        XCTAssertEqual(chip(project(done: 5, cancelled: 7)),
                       ProjectAttentionChip(tone: .brand, text: "12/12 settled · still open"))
    }

    func testQuietThresholdIsExact() {
        XCTAssertNil(chip(project(ready: 1, lastActivityAt: .some(at(Self.quiet - 1)))))
        XCTAssertEqual(chip(project(ready: 1, lastActivityAt: .some(at(Self.quiet))))?.text,
                       "Ready · no activity 1d")
    }

    func testNoSilenceIsInferredFromMissingInvalidOrFutureInstants() {
        for instant in [nil, "not a date", at(-Self.hour)] as [String?] {
            XCTAssertNil(chip(project(ready: 1, lastActivityAt: .some(instant))))
        }
    }

    func testHealthyWaitingEmptyOrClosedProjectsCarryNoChip() {
        let rows = [
            project(running: 1, lastActivityAt: .some(at(Self.hour))),
            project(ready: 1, lastActivityAt: .some(at(Self.hour))),
            project(blocked: 1, lastActivityAt: .some(at(20 * Self.quiet))),
            project(),
            project(status: .done, done: 1, lastActivityAt: .some(at(20 * Self.quiet))),
        ]
        for row in rows { XCTAssertNil(chip(row)) }
    }

    // MARK: the four owner items and the coordinator's own

    func testMergeWaitingOnTheOwnerTakesABusyProjectOutOfRunning() {
        let row = project(running: 4, ready: 2, done: 27, lastActivityAt: .some(at(12 * Self.minute)),
                          attention: ProjectListAttention(
                            ownerItems: [ownerItem(.promotionApproval, 1, waited: 2 * Self.hour)]))
        XCTAssertEqual(reason(row), .approveMergeToMain)
        XCTAssertEqual(section(row), .attention)
        XCTAssertEqual(chip(row), ProjectAttentionChip(tone: .warning,
                                                       text: "Needs you · Approve merge to main · 2h"))
    }

    func testQuestionsAreCounted() {
        let one = project(running: 2, blocked: 3, attention: ProjectListAttention(
            ownerItems: [ownerItem(.coordinatorQuestion, 1, waited: 35 * Self.minute)]))
        let two = project(running: 2, attention: ProjectListAttention(
            ownerItems: [ownerItem(.coordinatorQuestion, 2, waited: 35 * Self.minute)]))
        for row in [one, two] {
            XCTAssertEqual(reason(row), .coordinatorQuestion)
            XCTAssertEqual(section(row), .attention)
        }
        XCTAssertEqual(chip(one)?.text, "Needs you · 1 question from coordinator · 35m")
        XCTAssertEqual(chip(two)?.text, "Needs you · 2 questions from coordinator · 35m")
    }

    func testEscalationsAreCounted() {
        let row = project(blocked: 4, attention: ProjectListAttention(
            ownerItems: [ownerItem(.escalated, 3, waited: 4 * Self.hour)]))
        XCTAssertEqual(reason(row), .escalatedToYou)
        XCTAssertEqual(section(row), .attention)
        XCTAssertEqual(chip(row)?.text, "Needs you · 3 escalated to you · 4h")
    }

    func testAPauseIsStatedAsAPause() {
        let row = project(running: 1, done: 9, lastActivityAt: .some(at(Self.minute)),
                          attention: ProjectListAttention(
                            ownerItems: [ownerItem(.fusePaused, 1, waited: 20 * Self.minute)]))
        XCTAssertEqual(reason(row), .fusePaused)
        XCTAssertEqual(section(row), .attention)
        XCTAssertEqual(chip(row)?.text, "Paused · coordinator stopped itself · 20m")
    }

    func testLeadsWithTheLongestWaitAndSettlesTiesByKindOrder() {
        let row = project(attention: ProjectListAttention(ownerItems: [
            ownerItem(.coordinatorQuestion, 2, waited: 35 * Self.minute),
            ownerItem(.promotionApproval, 1, waited: 2 * Self.hour),
            ownerItem(.fusePaused, 1, waited: 20 * Self.minute),
        ]))
        XCTAssertEqual(reason(row), .approveMergeToMain)
        XCTAssertEqual(chip(row)?.text, "Needs you · Approve merge to main · 2h")

        let tie = project(attention: ProjectListAttention(ownerItems: [
            ownerItem(.fusePaused, 1, waited: Self.hour),
            ownerItem(.coordinatorQuestion, 1, waited: Self.hour),
        ]))
        XCTAssertEqual(reason(tie), .coordinatorQuestion)
    }

    func testNoAgeClaimFromAnUnreadableWait() {
        let row = project(attention: ProjectListAttention(ownerItems: [
            ProjectListOwnerItem(kind: .promotionApproval, count: 1, oldestWaitingSince: at(-Self.hour)),
        ]))
        XCTAssertEqual(chip(row)?.text, "Needs you · Approve merge to main")
    }

    func testCoordinatorExceptionIsBrandAndKeepsTheLaneItsActivityEarned() {
        let row = project(running: 3, ready: 2, done: 5, lastActivityAt: .some(at(Self.minute)),
                          attention: ProjectListAttention(
                            coordinatorItems: coordinatorItems(.integrationConflict, waited: 18 * Self.minute)))
        XCTAssertEqual(reason(row), .coordinatorHandling)
        XCTAssertEqual(section(row), .running)
        XCTAssertEqual(chip(row), ProjectAttentionChip(
            tone: .brand, text: "Coordinator · resolving a merge conflict · 18m"))

        let phrases: [(CoordinatorLeadKind, String)] = [
            (.integrationCheckFailed, "Coordinator · checks failed · 3h"),
            (.integrationError, "Coordinator · handling an integration error · 3h"),
            (.taskFailed, "Coordinator · handling a failed task · 3h"),
        ]
        for (kind, text) in phrases {
            let held = project(running: 1, lastActivityAt: .some(at(Self.minute)),
                               attention: ProjectListAttention(
                                coordinatorItems: coordinatorItems(kind, waited: 3 * Self.hour)))
            XCTAssertEqual(chip(held), ProjectAttentionChip(tone: .brand, text: text))
        }
    }

    func testACoordinatorHandledExceptionNeverLandsInNeedsAttention() {
        let shapes: [(Int, Int, Int)] = [(1, 0, 0), (0, 2, 0), (0, 0, 3), (1, 1, 1)]
        for (running, ready, blocked) in shapes {
            let row = project(running: running, ready: ready, blocked: blocked,
                              lastActivityAt: .some(at(Self.hour)),
                              attention: ProjectListAttention(
                                coordinatorItems: coordinatorItems(.integrationConflict, waited: 9 * Self.hour)))
            XCTAssertNotEqual(section(row), .attention)
        }
    }

    func testOwnerItemsOutrankAUserBlockerOldestWaitFirst() {
        let blocker = project(title: "Blocker", attention: ProjectListAttention(
            userBlockers: 1, maxSeverity: .critical, attentionSinceAt: at(9 * Self.quiet)))
        let merge = project(title: "Merge", attention: ProjectListAttention(
            ownerItems: [ownerItem(.promotionApproval, 1, waited: 2 * Self.hour)]))
        let question = project(title: "Question", attention: ProjectListAttention(
            ownerItems: [ownerItem(.coordinatorQuestion, 1, waited: 35 * Self.minute)]))
        let paused = project(title: "Paused", attention: ProjectListAttention(
            ownerItems: [ownerItem(.fusePaused, 1, waited: 20 * Self.minute)]))
        let escalated = project(title: "Escalated", attention: ProjectListAttention(
            ownerItems: [ownerItem(.escalated, 2, waited: 5 * Self.hour)]))
        XCTAssertEqual(ProjectAttention.ordered([blocker, question, merge, paused, escalated],
                                                in: .attention, now: Self.now).map(\.title),
                       ["Escalated", "Merge", "Question", "Paused", "Blocker"])
    }

    // MARK: integration line

    func testIntegrationChipNamesTheBranchAndMarksOnlyAProjectBranch() {
        XCTAssertEqual(ProjectAttention.integrationChip(of: project(
            integration: ProjectListIntegration(line: .projectBranch, ref: "project/bg-jobs"))),
                       ProjectIntegrationChip(text: "project/bg-jobs", isBranch: true))
        XCTAssertEqual(ProjectAttention.integrationChip(of: project(
            integration: ProjectListIntegration(line: .main, ref: "main"))),
                       ProjectIntegrationChip(text: "main", isBranch: false))
        XCTAssertNil(ProjectAttention.integrationChip(of: project()))
    }

    // MARK: the drawer

    func testDrawerListsOpenProjectsWaitingOnYouFirstThenByActivity() {
        let quietNeedsYou = project(title: "Question", lastActivityAt: .some(at(9 * Self.quiet)),
                                    attention: ProjectListAttention(
                                        ownerItems: [ownerItem(.coordinatorQuestion, 1, waited: Self.hour)]))
        let olderNeedsYou = project(title: "Merge", attention: ProjectListAttention(
            ownerItems: [ownerItem(.promotionApproval, 1, waited: 3 * Self.hour)]))
        let recent = project(title: "Recent", running: 1, lastActivityAt: .some(at(Self.minute)))
        let stale = project(title: "Stale", ready: 1, lastActivityAt: .some(at(5 * Self.quiet)))
        let closed = project(title: "Closed", status: .done, done: 1,
                             lastActivityAt: .some(at(Self.minute)))

        let drawer = ProjectAttention.drawerProjects([stale, closed, recent, quietNeedsYou, olderNeedsYou])
        XCTAssertEqual(drawer.map(\.title), ["Merge", "Question", "Recent", "Stale"])
        XCTAssertEqual(ProjectAttention.needsYouCount([stale, closed, recent, quietNeedsYou, olderNeedsYou]), 2)
        XCTAssertEqual(ProjectAttention.drawerMark(olderNeedsYou), .needsYou(1))
        XCTAssertEqual(ProjectAttention.drawerMark(recent), .running)
        XCTAssertEqual(ProjectAttention.drawerMark(stale), .idle)
    }

    func testDrawerMarkCountsTheItemsWaitingOnYouAcrossKinds() {
        let busy = project(running: 2, attention: ProjectListAttention(ownerItems: [
            ownerItem(.promotionApproval, 1, waited: Self.hour),
            ownerItem(.coordinatorQuestion, 2, waited: Self.minute),
            ProjectListOwnerItem(kind: .unknown, count: 4, oldestWaitingSince: at(Self.hour)),
        ]))
        XCTAssertEqual(ProjectAttention.drawerMark(busy), .needsYou(3),
                       "the count is the items waiting on you, not their kinds, and it outranks running")
    }

    func testDrawerCountIgnoresQuietProjectsAndUnknownKinds() {
        let quiet = project(ready: 1, lastActivityAt: .some(at(5 * Self.quiet)))
        let unknown = project(attention: ProjectListAttention(
            ownerItems: [ProjectListOwnerItem(kind: .unknown, count: 1, oldestWaitingSince: at(Self.hour))]))
        XCTAssertEqual(ProjectAttention.needsYouCount([quiet, unknown]), 0)
    }

    // MARK: the drawer, beside the live session list

    /// A project's coordinator conversation as the Open list carries it: `projectId` in the public
    /// spelling the list serves, whatever spelling the project row came in.
    private func coordinator(of project: ProjectSummary, state: SessionRunState, lastTurn: TimeInterval,
                             engineTurnActive: Bool = false) -> Session {
        Session(id: "s-\(project.id)", title: nil, status: .cancelled, runState: state, agentId: "a",
                assignedRunnerId: nil, pendingApprovals: 0, branch: nil, updatedAt: nil,
                projectId: PublicID.toPublic(project.id), engineTurnActive: engineTurnActive,
                lastTurnAt: at(lastTurn))
    }

    func testAWorkingCoordinatorMarksItsProjectRunningAndSortsItByItsTurn() {
        let busyTasks = project(title: "FineWeb", running: 2, lastActivityAt: .some(at(20 * Self.minute)))
        let coordinated = project(title: "Claude 账号池", ready: 2, lastActivityAt: .some(at(10 * Self.quiet)))
        let quiet = project(title: "Quiet", ready: 1, lastActivityAt: .some(at(Self.hour)))
        let pulses = ProjectAttention.coordinatorPulses([
            coordinator(of: coordinated, state: .running, lastTurn: Self.minute),
            coordinator(of: quiet, state: .awaitingInput, lastTurn: 30 * Self.quiet),
        ])

        XCTAssertEqual(ProjectAttention.drawerProjects([busyTasks, coordinated, quiet], coordinators: pulses)
                        .map(\.title), ["Claude 账号池", "FineWeb", "Quiet"],
                       "a coordinator's turn a minute ago is newer than any task write")
        XCTAssertEqual(ProjectAttention.drawerProjects([busyTasks, coordinated, quiet]).map(\.title),
                       ["FineWeb", "Quiet", "Claude 账号池"], "without the session list: task activity alone")
        XCTAssertEqual(ProjectAttention.drawerMark(
            coordinated, coordinator: pulses[PublicID.storageKey(coordinated.id)]), .running)
        XCTAssertEqual(ProjectAttention.drawerMark(coordinated), .idle)
        XCTAssertEqual(ProjectAttention.drawerMark(quiet, coordinator: pulses[PublicID.storageKey(quiet.id)]), .idle,
                       "a coordinator waiting for a reply is not working")
    }

    func testACoordinatorIsWorkingExactlyWhenTheSessionListDrawsItsSpinner() {
        let p = project(title: "P")
        let selfDriven = coordinator(of: p, state: .awaitingInput, lastTurn: Self.minute, engineTurnActive: true)
        XCTAssertEqual(ProjectAttention.coordinatorPulses([selfDriven])[PublicID.storageKey(p.id)]?.working, true)
        let queued = coordinator(of: p, state: .queued, lastTurn: Self.minute)
        XCTAssertEqual(ProjectAttention.coordinatorPulses([queued])[PublicID.storageKey(p.id)]?.working, false)
        let ordinary = Session(id: "x", title: nil, status: .cancelled, runState: .running, agentId: "a",
                               assignedRunnerId: nil, pendingApprovals: 0, branch: nil, updatedAt: nil)
        XCTAssertTrue(ProjectAttention.coordinatorPulses([ordinary]).isEmpty,
                      "a session that coordinates nothing is nobody's coordinator")
    }
}
