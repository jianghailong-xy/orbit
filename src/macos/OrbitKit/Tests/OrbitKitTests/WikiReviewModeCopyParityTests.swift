import Foundation
import XCTest
@testable import OrbitKit

/// The review mode says the web's words, counts what the web counts, and draws its blocks in the web
/// phone's order (criterion 8, mocks 17–20).
///
/// Three halves, each a failure — never an `XCTSkip` — when its counterpart goes missing:
/// - the cases in `src/shared/src/wiki-review-mode.fixture.json`, which the web's
///   `lib/wikiReviewMode.test.ts` reads too: the settings page's words, an entry's marks and answers,
///   one run's counts and Revert sentence, Recently changed folding a run, a challenge's anchors;
/// - every `WikiModeCopy` constant looked up as a declaration in `src/web/src/lib/wikiReviewMode.ts`,
///   and the order of the web pages' blocks read out of their source;
/// - the same order read out of the native pages (`OrbitApp/.../Views`), which nothing else compiles
///   on Linux.
final class WikiReviewModeCopyParityTests: XCTestCase {

    private static let lib = "src/web/src/lib/wikiReviewMode.ts"
    private static let settingsPage = "src/web/src/components/WikiSettingsPage.tsx"
    private static let setUpDialog = "src/web/src/components/WikiSetUpDialog.tsx"
    private static let marks = "src/web/src/components/WikiEntryMarks.tsx"
    private static let drawer = "src/web/src/components/WikiEntryDrawer.tsx"
    private static let runPage = "src/web/src/components/WikiRunPage.tsx"
    private static let review = "src/web/src/components/WikiReviewPage.tsx"
    private static let page = "src/web/src/pages/WikiPage.tsx"
    private static let activity = "src/web/src/components/WikiActivityPage.tsx"
    private static let fixturePath = "src/shared/src/wiki-review-mode.fixture.json"
    private static let app = "src/macos/OrbitApp/Sources/OrbitApp/"

    private struct Missing: Error, CustomStringConvertible {
        let file: String
        var description: String {
            "\(file) was not found above this test file. The review mode's pages are one half of a pair; if "
                + "the other half moved, move this check with it rather than deleting it."
        }
    }

    private func find(_ relative: String) throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(file: relative)
    }

    /// A web source with string concatenations joined and every run of whitespace as one space.
    private func web(_ relative: String) throws -> String {
        try String(contentsOf: find(relative), encoding: .utf8)
            .replacingOccurrences(of: "['`]\\s*\\+\\s*['`]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "&apos;", with: "'")
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    }

    /// A native page's source without its comment lines, whitespace kept.
    private func native(_ file: String) throws -> String {
        try String(contentsOf: find(Self.app + file), encoding: .utf8)
            .split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    private func assertSays(_ text: String, _ literal: String, in file: String, line: UInt = #line) {
        XCTAssertTrue(text.contains(literal), "\(file) no longer says \(literal)", line: line)
    }

    /// A named constant of the web's, anchored on its declaration.
    private func assertDeclares(_ text: String, _ name: String, _ value: String, line: UInt = #line) {
        let single = "\(name) = '\(value.replacingOccurrences(of: "'", with: "\\'"))'"
        XCTAssertTrue(text.contains(single), "\(name) drifted: \(Self.lib) no longer declares it as \(value.debugDescription)",
                      line: line)
    }

    private func assertOrder(_ text: String, _ literals: [String], _ what: String, line: UInt = #line) {
        let positions = literals.map { text.range(of: $0)?.lowerBound }
        XCTAssertFalse(positions.contains(nil), "\(what): lost \(literals.filter { text.range(of: $0) == nil })", line: line)
        let found = positions.compactMap { $0 }
        XCTAssertEqual(found, found.sorted(), "\(what) is no longer in the order \(literals)", line: line)
    }

    private func slice(_ text: String, from start: String, to end: String) throws -> String {
        let lower = try XCTUnwrap(text.range(of: start), "no `\(start)`")
        let upper = try XCTUnwrap(text.range(of: end, range: lower.upperBound..<text.endIndex), "no `\(end)` after `\(start)`")
        return String(text[lower.lowerBound..<upper.upperBound])
    }

    // MARK: the fixture

    private struct Fixture: Decodable {
        struct Settings: Decodable {
            struct Mode: Decodable {
                let mode: WikiReviewMode
                let label: String
                let note: String
                let `default`: Bool
            }
            struct Words: Decodable {
                let title: String
                let note: String
            }
            struct Floors: Decodable {
                let lead: String
                let note: String
            }
            struct Maintenance: Decodable {
                struct Form: Decodable {
                    struct Defaults: Decodable {
                        let dailyRunLimit: Int
                        let min: Int
                        let max: Int
                    }
                    struct Lookback: Decodable {
                        let choices: [String]
                        let says: [String]
                        let unit: String
                        let defaultDays: Int
                        let min: Int
                        let max: Int
                    }
                    let title: String
                    let unit: String
                    let cancel: String
                    let turnOn: String
                    let save: String
                    let defaults: Defaults
                    let lookback: Lookback
                }
                struct Runs: Decodable {
                    let runs: Int
                    let says: String
                }
                struct LookbackCase: Decodable {
                    let days: Int?
                    let choice: String
                    let offered: Int
                    let says: String
                }
                struct WorkspaceLabel: Decodable {
                    struct Workspace: Decodable {
                        struct Runner: Decodable {
                            let name: String?
                            let displayName: String?
                        }
                        let name: String?
                        let runner: Runner?
                    }
                    let workspace: Workspace
                    let says: String
                }
                let name: String
                let off: String
                let on: String
                let setUp: String
                let form: Form
                let edit: String
                let turnOff: String
                let runsADay: [Runs]
                let lookbacks: [LookbackCase]
                let workspaceLabels: [WorkspaceLabel]
            }
            struct Fallback: Decodable {
                let settings: WikiSpaceSettings
                let says: String?
            }
            let title: String
            let crumb: String
            let sections: [String]
            struct Workspaces: Decodable {
                let lead: String
                let leftOut: String
                let join: String
                let joinNoRepository: String
                let empty: String
                let add: String
                let addGroup: String
            }
            let workspaces: Workspaces
            /// Trash (docs/mocks/wiki-trash). Two of its words are the web's alone and are not read here: a count's
            /// `settings`, the line under its card, where the native page draws a Trash row; and the page's `close`, its
            /// dialog's, where the native page is pushed.
            struct Trash: Decodable {
                struct Named: Decodable { let name: String; let text: String }
                struct ComesBack: Decodable { let repository: String; let text: String }
                struct Body: Decodable { let entries: Int?; let documents: Int; let text: String }
                struct Count: Decodable { let wikis: Int; let empty: String; let row: String }
                struct Page: Decodable {
                    struct Row: Decodable { let deletedAt: String; let purgeAt: String; let entries: Int; let text: String }
                    struct Purge: Decodable {
                        struct Body: Decodable { let entries: Int; let text: String }
                        let question: String
                        let confirm: String
                        let failedNative: String
                        let bodies: [Body]
                    }
                    let title: String
                    let lead: String
                    let empty: String
                    let restore: String
                    let deletePermanently: String
                    let deleteSwipe: String
                    let rows: [Row]
                    let restored: Named
                    let restoreFailedNative: String
                    let purge: Purge
                }
                let title: String
                let open: String
                let confirm: String
                let note: String
                let leaves: String
                let kept: String
                let failedNative: String
                let question: Named
                let moved: Named
                let comesBack: ComesBack
                let bodies: [Body]
                let openTrash: String
                let counts: [Count]
                let page: Page
                let pickerItem: String
            }
            let trash: Trash
            let reviewModeHint: String
            let lead: String
            let defaultTag: String
            let modes: [Mode]
            let spotCheck: Words
            let floors: Floors
            let maintenance: Maintenance
            let fallbacks: [Fallback]
        }
        struct Answers: Decodable {
            let confirm: String
            let reject: String
            let confirmed: String
            let rejected: String
            let reasons: [String]
            let foot: String
        }
        struct Mark: Decodable {
            struct Entry: Decodable {
                let status: WikiEntryStatus
                let trust: WikiTrust
                let tainted: Bool
            }
            struct Banner: Decodable {
                let tone: String
                let lead: String
                let text: String
            }
            let name: String
            let entry: Entry
            let confirm: Bool
            let reject: Bool
            let banner: Banner?
            let whereUsed: String?
        }
        struct CheckedLine: Decodable {
            struct Verification: Decodable {
                let verdict: WikiVerificationVerdict
                let model: String
                let evidence: WikiVerificationEvidence?
            }
            let verification: Verification?
            let tainted: Bool
            let who: String?
            let when: String?
            let says: String
        }
        struct Run: Decodable {
            let name: String
            /// The run as its read answers it: `GET /api/wiki/changesets/:id`.
            let view: WikiChangesetView
            let isRun: Bool
            let kicker: String
            let title: String
            let when: String
            let counts: [String]
            let added: [String]
            let amended: [String]
            let reinforced: [String]
            let marks: [String: String?]
            let revertOffered: Bool
            let revert: String?
        }
        struct RevertDialog: Decodable {
            let title: String
            let keeps: String
            let confirm: String
            let cancel: String
            let action: String
            let view: String
            let openSession: String
            let reverted: String
            let groups: [String]
        }
        struct Recent: Decodable {
            struct Row: Decodable {
                let run: String?
                let origin: WikiChangesetOrigin?
                let at: String?
                let items: [String]?
                let op: String?
            }
            let name: String
            let items: [WikiTimelineItem]
            let rows: [Row]
        }
        struct ChallengeWords: Decodable {
            struct After: Decodable {
                let label: String
                let keep: String
                let amend: String
                let retire: String
            }
            let answers: [String]
            let after: After
            let retireNote: String
            let waits: String
            let challenged: String
            let amendNote: String
        }
        struct Challenge: Decodable {
            struct Broken: Decodable {
                let state: WikiAnchorState
                let label: String
            }
            let name: String
            let anchors: [WikiAnchor]
            let broken: [Broken]
            let ref: String?
            let checkedOn: String?
        }
        let settings: Settings
        let answers: Answers
        let marks: [Mark]
        let checkedLines: [CheckedLine]
        let runs: [Run]
        let revertDialog: RevertDialog
        let recent: [Recent]
        let challenge: ChallengeWords
        let challenges: [Challenge]
    }

    private func fixture() throws -> Fixture {
        try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: find(Self.fixturePath)))
    }

    private let utc = TimeZone(identifier: "UTC")!

    // MARK: the settings page

    func testTheSettingsPageSaysTheFixturesWordsInItsOrder() throws {
        let settings = try fixture().settings
        XCTAssertEqual(WikiModeCopy.settingsTitle, settings.title)
        XCTAssertEqual(WikiModeCopy.settings, settings.crumb)
        XCTAssertEqual(WikiModeLogic.SettingsSection.allCases.map(\.title), settings.sections)
        XCTAssertEqual(WikiModeCopy.workspacesLead, settings.workspaces.lead)
        XCTAssertEqual(WikiModeCopy.workspaceLeftOut, settings.workspaces.leftOut)
        XCTAssertEqual(WikiModeCopy.workspacesJoin, settings.workspaces.join)
        XCTAssertEqual(WikiModeCopy.workspacesJoinNoRepository, settings.workspaces.joinNoRepository)
        XCTAssertEqual(WikiModeCopy.workspacesEmpty, settings.workspaces.empty)
        XCTAssertEqual(WikiModeCopy.addWorkspace, settings.workspaces.add)
        XCTAssertEqual(WikiModeCopy.addWorkspaceGroup, settings.workspaces.addGroup)
        XCTAssertEqual(WikiModeCopy.reviewModeHint, settings.reviewModeHint)
        XCTAssertEqual(WikiModeCopy.reviewModeLead, settings.lead)
        XCTAssertEqual(WikiModeCopy.modeDefault, settings.defaultTag)
        XCTAssertEqual(WikiModeLogic.modes, settings.modes.map(\.mode))
        for mode in settings.modes {
            XCTAssertEqual(WikiModeCopy.modeLabel(mode.mode), mode.label)
            XCTAssertEqual(WikiModeCopy.modeNote(mode.mode), mode.note)
            XCTAssertEqual(mode.mode == WikiModeLogic.defaultMode, mode.default)
        }
        XCTAssertEqual(WikiModeCopy.spotCheck, settings.spotCheck.title)
        XCTAssertEqual(WikiModeCopy.spotCheckNote, settings.spotCheck.note)
        XCTAssertEqual(WikiModeCopy.floorsLead, settings.floors.lead)
        XCTAssertEqual(WikiModeCopy.floorsNote, settings.floors.note)

        // The rows once on, the form's fields and the sentence under the card are the server-execution fixture's
        // (`WikiServerExecutionCopyParityTests`).
        let maintenance = settings.maintenance
        XCTAssertEqual([WikiModeCopy.maintenanceName, WikiModeCopy.off, WikiModeCopy.on, WikiModeCopy.setUp],
                       [maintenance.name, maintenance.off, maintenance.on, maintenance.setUp])
        XCTAssertEqual(WikiModeCopy.setUpTitle, maintenance.form.title)
        XCTAssertEqual(WikiModeCopy.runsADayUnit, maintenance.form.unit)
        XCTAssertEqual([WikiModeCopy.cancel, WikiModeCopy.turnOn, WikiModeCopy.save],
                       [maintenance.form.cancel, maintenance.form.turnOn, maintenance.form.save])
        XCTAssertEqual(WikiMaintenanceSettings.default.dailyRunLimit, maintenance.form.defaults.dailyRunLimit)
        XCTAssertEqual(WikiMaintenanceSettings.dailyRunLimitRange, maintenance.form.defaults.min...maintenance.form.defaults.max)
        XCTAssertEqual([WikiModeCopy.maintenanceEdit, WikiModeCopy.turnOff], [maintenance.edit, maintenance.turnOff])
        for row in maintenance.runsADay { XCTAssertEqual(WikiModeCopy.runsADay(row.runs), row.says) }
        // The look-back: from now on, some days, all of history — the form opening on the contract's 14 days.
        let lookback = maintenance.form.lookback
        XCTAssertEqual(WikiModeLogic.LookbackChoice.allCases.map(\.rawValue), lookback.choices)
        XCTAssertEqual(WikiModeLogic.LookbackChoice.allCases.map {
            WikiModeCopy.lookbackLabel(WikiModeLogic.lookbackDays($0, days: lookback.defaultDays))
        }, lookback.says)
        XCTAssertEqual(WikiModeCopy.lookbackUnit, lookback.unit)
        XCTAssertEqual(WikiMaintenanceSettings.default.lookbackDays, lookback.defaultDays)
        XCTAssertEqual(WikiMaintenanceSettings.lookbackDaysRange, lookback.min...lookback.max)
        for row in maintenance.lookbacks {
            let named = String(describing: row.days)
            XCTAssertEqual(WikiModeCopy.lookbackLabel(row.days), row.says, named)
            XCTAssertEqual(WikiModeLogic.lookbackChoice(row.days).rawValue, row.choice, named)
            XCTAssertEqual(WikiModeLogic.lookbackDaysOffered(row.days), row.offered, named)
            // What the picker opens on writes back the setting it was read from.
            XCTAssertEqual(WikiModeLogic.lookbackDays(WikiModeLogic.lookbackChoice(row.days),
                                                      days: WikiModeLogic.lookbackDaysOffered(row.days)), row.days, named)
        }
        for row in maintenance.workspaceLabels {
            let runner = row.workspace.runner.flatMap { $0.displayName ?? $0.name }
            XCTAssertEqual(WikiModeLogic.workspaceLabel(name: row.workspace.name, runner: runner), row.says)
        }
    }

    /// Trash's words (docs/mocks/wiki-trash), every case of the fixture's: the foot of the page and the question Move to
    /// Trash asks, the ways to Trash, and Trash itself — its rows' dates in en-US's short month, in the reader's zone.
    func testTrashSaysTheFixturesWords() throws {
        let trash = try fixture().settings.trash
        XCTAssertEqual([WikiModeCopy.trashTitle, WikiModeCopy.trashOpen, WikiModeCopy.trashConfirm, WikiModeCopy.trashNote,
                        WikiModeCopy.trashLeaves, WikiModeCopy.trashKept, WikiModeCopy.trashFailed],
                       [trash.title, trash.open, trash.confirm, trash.note, trash.leaves, trash.kept, trash.failedNative])
        XCTAssertEqual(WikiModeCopy.trashQuestion(trash.question.name), trash.question.text)
        XCTAssertEqual(WikiModeCopy.movedToTrash(trash.moved.name), trash.moved.text)
        XCTAssertEqual(WikiModeCopy.trashComesBack(trash.comesBack.repository), trash.comesBack.text)
        XCTAssertFalse(trash.bodies.isEmpty)
        for body in trash.bodies {
            XCTAssertEqual(WikiModeCopy.trashBody(entries: body.entries, documents: body.documents), body.text,
                           "\(String(describing: body.entries)) entries, \(body.documents) documents")
        }
        // The question's message, as board ② draws it: that it leaves now, what Trash keeps, what a repository's wiki
        // does meanwhile — only for one with a repository — and what stays.
        XCTAssertEqual(WikiModeCopy.trashMessage(entries: 11138, documents: 0, repository: nil),
                       [trash.leaves, WikiModeCopy.trashBody(entries: 11138, documents: 0), trash.kept].joined(separator: "\n\n"))
        XCTAssertEqual(WikiModeCopy.trashMessage(entries: nil, documents: 0, repository: trash.comesBack.repository),
                       [trash.leaves, WikiModeCopy.trashBody(entries: nil, documents: 0), trash.comesBack.text, trash.kept]
                        .joined(separator: "\n\n"))

        XCTAssertEqual(WikiModeCopy.trashOpenTrash, trash.openTrash)
        XCTAssertEqual(WikiModeCopy.trashPickerItem, trash.pickerItem)
        XCTAssertFalse(trash.counts.isEmpty)
        for count in trash.counts {
            XCTAssertEqual(WikiModeCopy.trashHoldsWhenEmpty(count.wikis), count.empty)
            XCTAssertEqual(WikiModeCopy.trashRowCount(count.wikis), count.row)
        }

        let page = trash.page
        XCTAssertEqual([WikiModeCopy.trashPageTitle, WikiModeCopy.trashPageLead, WikiModeCopy.trashPageEmpty, WikiModeCopy.trashRestore,
                        WikiModeCopy.trashDeletePermanently, WikiModeCopy.trashDeleteSwipe, WikiModeCopy.trashRestoreFailed],
                       [page.title, page.lead, page.empty, page.restore, page.deletePermanently, page.deleteSwipe, page.restoreFailedNative])
        XCTAssertFalse(page.rows.isEmpty)
        for row in page.rows {
            XCTAssertEqual(WikiModeCopy.trashRowLine(deletedAt: row.deletedAt, purgeAt: row.purgeAt, entries: row.entries, timeZone: utc),
                           row.text)
        }
        // The reader's own day: 12:00 and 12:30 UTC on Dec 31 are already Jan 1 at UTC+13.
        let last = try XCTUnwrap(page.rows.last)
        XCTAssertEqual(WikiModeCopy.trashRowLine(deletedAt: last.deletedAt, purgeAt: last.purgeAt, entries: last.entries,
                                                 timeZone: try XCTUnwrap(TimeZone(secondsFromGMT: 13 * 3600))),
                       "Moved to Trash Jan 1, 2027 · 0 entries · deleted for good Jan 1, 2027")
        XCTAssertEqual(WikiModeCopy.restored(page.restored.name), page.restored.text)
        XCTAssertEqual([WikiModeCopy.trashPurgeQuestion, WikiModeCopy.trashPurgeConfirm, WikiModeCopy.trashPurgeFailed],
                       [page.purge.question, page.purge.confirm, page.purge.failedNative])
        XCTAssertFalse(page.purge.bodies.isEmpty)
        for body in page.purge.bodies {
            XCTAssertEqual(WikiModeCopy.trashPurgeBody(entries: body.entries), body.text)
        }
    }

    func testTheModeFallbackIsSaidWhileTheSpaceIsStillInIt() throws {
        for row in try fixture().settings.fallbacks {
            XCTAssertEqual(WikiModeLogic.modeFallback(row.settings, timeZone: utc), row.says,
                           "\(String(describing: row.settings.reviewMode)) by \(String(describing: row.settings.reviewModeChangedBy))")
        }
        // A space that names no mode is Manual: it was made before review modes existed.
        XCTAssertEqual(WikiModeLogic.mode(of: nil), .manual)
        XCTAssertEqual(WikiModeLogic.mode(of: WikiSpaceSettings(reviewMode: .unknown)), .manual)
    }

    // MARK: an entry's marks

    func testAnEntrysMarksAndAnswersAreTheFixtures() throws {
        let shared = try fixture()
        for mark in shared.marks {
            let entry = mark.entry
            XCTAssertEqual(WikiModeLogic.canConfirm(status: entry.status, trust: entry.trust), mark.confirm, mark.name)
            XCTAssertEqual(WikiModeLogic.answerable(status: entry.status, trust: entry.trust), mark.reject, mark.name)
            let banner = WikiModeLogic.banner(status: entry.status, trust: entry.trust, tainted: entry.tainted)
            XCTAssertEqual(banner?.tone.rawValue, mark.banner?.tone, mark.name)
            XCTAssertEqual(banner?.lead, mark.banner?.lead, mark.name)
            XCTAssertEqual(banner?.text, mark.banner?.text, mark.name)
            XCTAssertEqual(WikiModeLogic.whereUsedNote(status: entry.status, trust: entry.trust), mark.whereUsed, mark.name)
        }
        let answers = shared.answers
        XCTAssertEqual([WikiModeCopy.confirm, WikiCopy.reject, WikiModeCopy.confirmed, WikiModeCopy.rejected],
                       [answers.confirm, answers.reject, answers.confirmed, answers.rejected])
        XCTAssertEqual(WikiRejectReason.allCases.map(WikiCopy.rejectReasonLabel), answers.reasons)
        XCTAssertEqual(WikiModeCopy.rejectOnRecord, answers.foot)
        for line in shared.checkedLines {
            XCTAssertEqual(WikiModeLogic.checkedLine(verdict: line.verification?.verdict, model: line.verification?.model,
                                                     evidence: line.verification?.evidence,
                                                     tainted: line.tainted, who: line.who, when: line.when), line.says)
        }
    }

    // MARK: one run

    func testOneRunIsCountedAndGroupedAsTheFixtureSays() throws {
        let runs = try fixture().runs
        for run in runs {
            let summary = WikiModeLogic.runSummary(run.view)
            XCTAssertEqual(WikiModeLogic.isRun(run.view), run.isRun, run.name)
            XCTAssertEqual(WikiModeCopy.runKicker(run.view.changeset.origin), run.kicker, run.name)
            XCTAssertEqual(WikiModeCopy.appliedChanges(summary.applied), run.title, run.name)
            XCTAssertEqual(WikiModeLogic.runWhen(run.view.changeset.createdAt ?? "", timeZone: utc), run.when, run.name)
            XCTAssertEqual(WikiModeLogic.runCounts(summary), run.counts, run.name)
            XCTAssertEqual(summary.added.map(\.title), run.added, run.name)
            XCTAssertEqual(summary.amended.map(\.title), run.amended, run.name)
            XCTAssertEqual(summary.reinforced.map(\.title), run.reinforced, run.name)
            var marks: [String: String?] = [:]
            // `updateValue`, not a subscript write: assigning nil through the subscript drops the key.
            for row in summary.added + summary.amended + summary.reinforced { marks.updateValue(row.trust?.rawValue, forKey: row.title) }
            XCTAssertEqual(marks, run.marks, run.name)
            // Revert run… is offered exactly when the server says it can, and says the server's numbers.
            XCTAssertEqual(summary.revertible, run.revertOffered, run.name)
            XCTAssertEqual(summary.revertible ? WikiModeLogic.revertBody(summary) : nil, run.revert, run.name)
        }
        // The case criterion 8 was missing: a run nothing of which waits in Review, read and revertible.
        XCTAssertTrue(runs.contains { run in
            run.revertOffered && (run.view.changeset.ops ?? []).allSatisfy { $0.decision != .pending }
        })
    }

    func testTheRevertDialogAndTheRunsWords() throws {
        let dialog = try fixture().revertDialog
        XCTAssertEqual([WikiModeCopy.revertTitle, WikiModeCopy.revertKeeps, WikiModeCopy.revertRunConfirm, WikiModeCopy.cancel],
                       [dialog.title, dialog.keeps, dialog.confirm, dialog.cancel])
        XCTAssertEqual([WikiModeCopy.revertRun, WikiModeCopy.viewRun, WikiModeCopy.openSession, WikiModeCopy.reverted],
                       [dialog.action, dialog.view, dialog.openSession, dialog.reverted])
        XCTAssertEqual([WikiModeCopy.runAdded, WikiModeCopy.runAmended, WikiModeCopy.runReinforced], dialog.groups)
    }

    func testRecentlyChangedFoldsEveryRunIntoOneRow() throws {
        for recent in try fixture().recent {
            let rows = WikiModeLogic.recentRows(recent.items)
            XCTAssertEqual(rows.count, recent.rows.count, recent.name)
            for (row, expected) in zip(rows, recent.rows) {
                switch row {
                case .op(let item):
                    XCTAssertEqual(item.opId, expected.op, recent.name)
                case .run(let changesetId, let origin, let at, let items):
                    XCTAssertEqual(changesetId, expected.run, recent.name)
                    XCTAssertEqual(origin, expected.origin, recent.name)
                    XCTAssertEqual(at, expected.at, recent.name)
                    XCTAssertEqual(items.map(\.opId), expected.items, recent.name)
                }
            }
        }
        // What a review mode applied is in the wiki already: `Added`, not `Proposed`.
        XCTAssertEqual(WikiLogic.changeVerb(WikiTimelineItem(opId: "o", op: .add, decision: .autoApplied, origin: .maintenance,
                                                             appliedByMode: .tiered)), "Added")
    }

    // MARK: a challenge

    func testAChallengeNamesTheAnchorsThatBrokeInTheServersWords() throws {
        let shared = try fixture()
        for challenge in shared.challenges {
            let broken = WikiModeLogic.brokenAnchors(challenge.anchors)
            XCTAssertEqual(broken.map(\.state), challenge.broken.map(\.state), challenge.name)
            XCTAssertEqual(broken.map(\.label), challenge.broken.map(\.label), challenge.name)
            let ref = WikiModeLogic.challengeRef(challenge.anchors)
            XCTAssertEqual(ref, challenge.ref, challenge.name)
            XCTAssertEqual(ref.map(WikiModeCopy.checkedOnMain), challenge.checkedOn, challenge.name)
        }
        XCTAssertEqual([WikiModeCopy.reconfirm, WikiModeCopy.amendAnswer, WikiModeCopy.retireAnswer],
                       shared.challenge.answers)
        XCTAssertEqual(WikiCopy.afterLabel, shared.challenge.after.label)
        XCTAssertEqual(WikiModeCopy.afterKeep, shared.challenge.after.keep)
        XCTAssertEqual(WikiModeCopy.afterAmend, shared.challenge.after.amend)
        XCTAssertEqual(WikiModeCopy.afterRetire, shared.challenge.after.retire)
        XCTAssertEqual(WikiCopy.retireNote, shared.challenge.retireNote, "Retire…'s dialog, here and on the entry page")
        XCTAssertEqual(WikiModeCopy.challengeWaits, shared.challenge.waits)
        XCTAssertEqual(WikiModeCopy.challenged, shared.challenge.challenged)
        XCTAssertEqual(WikiModeCopy.amendNote, shared.challenge.amendNote)
        // The answers are the contract's decide actions for a challenge.
        XCTAssertTrue(WikiDecideAction.allCases.contains(.reconfirm))
        XCTAssertTrue(WikiDecideAction.allCases.contains(.amend))
        XCTAssertTrue(WikiDecideAction.allCases.contains(.retire))
    }

    /// The After row says what each answer does to the entry: Keep, Amend, Retire, Retire's word in red. A decision
    /// is superseded and never amended (contract `kinds.decision.amendable`; the server refuses its amend), so its card
    /// offers no Amend… and its After row has no Amend line. Every other kind is the contract's too.
    func testAChallengesAfterRowAndAmendFollowTheEntrysKind() throws {
        let after = try fixture().challenge.after
        let pitfall = WikiModeLogic.challengeAfter(kind: .pitfall)
        XCTAssertEqual(pitfall.map(\.answer), [WikiModeCopy.reconfirm, WikiModeCopy.amend, WikiModeCopy.retire])
        XCTAssertEqual(pitfall.map(\.answer), ["Keep", "Amend", "Retire"])
        XCTAssertEqual(pitfall.map(\.effect), [after.keep, after.amend, after.retire])
        XCTAssertEqual(pitfall.map(\.destructive), [false, false, true], "only Retire's word is red")
        let decision = WikiModeLogic.challengeAfter(kind: .decision)
        XCTAssertEqual(decision.map(\.answer), ["Keep", "Retire"])
        XCTAssertEqual(decision.map(\.effect), [after.keep, after.retire])
        XCTAssertTrue(WikiModeLogic.amendable(nil), "an entry not read yet keeps Amend…, disabled until it is")
        XCTAssertTrue(WikiModeLogic.amendable(.unknown), "a kind this build does not know is the server's to refuse")
        let data = try Data(contentsOf: find("contracts/wiki.contract.json"))
        let contract = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let kinds = try XCTUnwrap(contract["kinds"] as? [String: Any])
        XCTAssertFalse(kinds.isEmpty)
        for (name, spec) in kinds {
            let kind = try XCTUnwrap(WikiEntryKind(rawValue: name), "\(name) is no kind this client knows")
            // A reserved placeholder (`assumption`) declares no `amendable` and has no KIND_SPECS entry yet: like a
            // kind the web does not know (`!(kind in KIND_SPECS)`), it keeps Amend… and leaves the refusal to the server.
            let amendable = (spec as? [String: Any])?["amendable"] as? Bool ?? true
            XCTAssertEqual(WikiModeLogic.amendable(kind), amendable, "kinds.\(name).amendable")
            XCTAssertEqual(WikiModeLogic.challengeAfter(kind: kind).count, amendable ? 3 : 2, name)
        }
        XCTAssertEqual(kinds.filter { ($0.value as? [String: Any])?["amendable"] as? Bool == false }.map(\.key), ["decision"],
                       "the one kind a challenge's card offers no Amend… for")
    }

    // MARK: the web's own declarations

    func testEveryWordIsDeclaredOnTheWeb() throws {
        let lib = try web(Self.lib)
        let pairs: [(String, String)] = [
            ("WIKI_SETTINGS", WikiModeCopy.settings),
            ("WIKI_SETTINGS_TITLE", WikiModeCopy.settingsTitle),
            ("WIKI_REVIEW_MODE", WikiModeCopy.reviewMode),
            ("WIKI_REVIEW_MODE_HINT", WikiModeCopy.reviewModeHint),
            ("WIKI_REVIEW_MODE_LEAD", WikiModeCopy.reviewModeLead),
            ("WIKI_MODE_DEFAULT", WikiModeCopy.modeDefault),
            ("WIKI_SPOT_CHECK", WikiModeCopy.spotCheck),
            ("WIKI_SPOT_CHECK_NOTE", WikiModeCopy.spotCheckNote),
            ("WIKI_FLOORS_LEAD", WikiModeCopy.floorsLead),
            ("WIKI_FLOORS_NOTE", WikiModeCopy.floorsNote),
            ("WIKI_MAINTENANCE", WikiModeCopy.maintenance),
            ("WIKI_OFF", WikiModeCopy.off),
            ("WIKI_ON", WikiModeCopy.on),
            ("WIKI_SET_UP", WikiModeCopy.setUp),
            ("WIKI_SET_UP_TITLE", WikiModeCopy.setUpTitle),
            ("WIKI_STATUS", WikiModeCopy.status),
            ("WIKI_DAILY_LIMIT", WikiModeCopy.dailyLimit),
            ("WIKI_RUNS_A_DAY", WikiModeCopy.runsADayUnit),
            ("WIKI_DAILY_LIMIT_NOTE", WikiModeCopy.dailyLimitNote),
            ("WIKI_LOOKBACK", WikiModeCopy.lookback),
            ("WIKI_LOOKBACK_NOTE", WikiModeCopy.lookbackNote),
            ("WIKI_LOOKBACK_NOW", WikiModeCopy.lookbackNow),
            ("WIKI_LOOKBACK_ALL", WikiModeCopy.lookbackAll),
            ("WIKI_LOOKBACK_UNIT", WikiModeCopy.lookbackUnit),
            ("WIKI_CANCEL", WikiModeCopy.cancel),
            ("WIKI_TURN_ON", WikiModeCopy.turnOn),
            ("WIKI_TURN_OFF", WikiModeCopy.turnOff),
            ("WIKI_MAINTENANCE_EDIT", WikiModeCopy.maintenanceEdit),
            ("WIKI_SAVE", WikiModeCopy.save),
            ("WIKI_NO_WORKSPACE", WikiModeCopy.noWorkspace),
            ("WIKI_TRASH_TITLE", WikiModeCopy.trashTitle),
            ("WIKI_TRASH_OPEN", WikiModeCopy.trashOpen),
            ("WIKI_TRASH_CONFIRM", WikiModeCopy.trashConfirm),
            ("WIKI_TRASH_NOTE", WikiModeCopy.trashNote),
            ("WIKI_TRASH_LEAVES", WikiModeCopy.trashLeaves),
            ("WIKI_TRASH_KEPT", WikiModeCopy.trashKept),
            ("WIKI_TRASH_OPEN_TRASH", WikiModeCopy.trashOpenTrash),
            ("WIKI_TRASH_PAGE_TITLE", WikiModeCopy.trashPageTitle),
            ("WIKI_TRASH_PAGE_LEAD", WikiModeCopy.trashPageLead),
            ("WIKI_TRASH_PAGE_EMPTY", WikiModeCopy.trashPageEmpty),
            ("WIKI_TRASH_RESTORE", WikiModeCopy.trashRestore),
            ("WIKI_TRASH_DELETE_PERMANENTLY", WikiModeCopy.trashDeletePermanently),
            ("WIKI_TRASH_PURGE_QUESTION", WikiModeCopy.trashPurgeQuestion),
            ("WIKI_TRASH_PURGE_CONFIRM", WikiModeCopy.trashPurgeConfirm),
            ("WIKI_CONFIRM", WikiModeCopy.confirm),
            ("WIKI_CONFIRMED", WikiModeCopy.confirmed),
            ("WIKI_REJECTED", WikiModeCopy.rejected),
            ("WIKI_REJECT_ON_RECORD", WikiModeCopy.rejectOnRecord),
            ("WIKI_NOT_SENT_UNREVIEWED", WikiModeCopy.notSentUnreviewed),
            ("WIKI_BANNER_AUTO", WikiModeCopy.bannerAuto),
            ("WIKI_BANNER_UNREVIEWED", WikiModeCopy.bannerUnreviewed),
            ("WIKI_BANNER_WEB_DERIVED", WikiModeCopy.bannerWebDerived),
            ("WIKI_CAPPED_AT_UNREVIEWED", WikiModeCopy.cappedAtUnreviewed),
            ("WIKI_RUN", WikiModeCopy.run),
            ("WIKI_VIEW_RUN", WikiModeCopy.viewRun),
            ("WIKI_REVERT_RUN", WikiModeCopy.revertRun),
            ("WIKI_REVERT_RUN_CONFIRM", WikiModeCopy.revertRunConfirm),
            ("WIKI_REVERT_TITLE", WikiModeCopy.revertTitle),
            ("WIKI_REVERT_KEEPS", WikiModeCopy.revertKeeps),
            ("WIKI_REVERTED", WikiModeCopy.reverted),
            ("WIKI_OPEN_SESSION", WikiModeCopy.openSession),
            ("WIKI_RUN_ADDED", WikiModeCopy.runAdded),
            ("WIKI_RUN_AMENDED", WikiModeCopy.runAmended),
            ("WIKI_RUN_REINFORCED", WikiModeCopy.runReinforced),
            ("WIKI_RECONFIRM", WikiModeCopy.reconfirm),
            ("WIKI_AMEND", WikiModeCopy.amend),
            ("WIKI_AMEND_ANSWER", WikiModeCopy.amendAnswer),
            ("WIKI_RETIRE", WikiModeCopy.retire),
            ("WIKI_RETIRE_ANSWER", WikiModeCopy.retireAnswer),
            ("WIKI_CHALLENGE_AFTER_KEEP", WikiModeCopy.afterKeep),
            ("WIKI_CHALLENGE_AFTER_AMEND", WikiModeCopy.afterAmend),
            ("WIKI_CHALLENGE_AFTER_RETIRE", WikiModeCopy.afterRetire),
            ("WIKI_CHALLENGE_WAITS", WikiModeCopy.challengeWaits),
            ("WIKI_CHALLENGED", WikiModeCopy.challenged),
            ("WIKI_AMEND_NOTE", WikiModeCopy.amendNote),
        ]
        for (name, word) in pairs { assertDeclares(lib, name, word) }
        // The sentence for a run Review no longer held is gone with the branch that said it.
        XCTAssertFalse(lib.contains("WIKI_NO_SUCH_RUN"), "\(Self.lib) still says a run cannot be opened")
        // So are the runner's: its workspace, its pinned provider and its own sentences (P11's clients' clean-up).
        for gone in ["WIKI_MAINTENANCE_NOTE =", "WIKI_WORKSPACE =", "WIKI_WORKSPACE_NOTE", "WIKI_PROVIDER", "WIKI_PINNED_NO_FALLBACK",
                     "wikiProviderLabel", "wikiModeNote", "WIKI_MODE_NOTE_AUTOMATIC_SERVER"] {
            XCTAssertFalse(lib.contains(gone), "\(Self.lib) still declares \(gone)")
        }
        // The one constant that names another, and the tables.
        assertSays(lib, "export const WIKI_MAINTENANCE_NAME = WIKI_HISTORY_MAINTENANCE;", in: Self.lib)
        XCTAssertEqual(WikiModeCopy.maintenanceName, WikiCopy.historyMaintenance)
        let labels = try slice(lib, from: "export const WIKI_MODE_LABELS", to: "};")
        let notes = try slice(lib, from: "export const WIKI_MODE_NOTES", to: "};")
        for mode in WikiModeLogic.modes {
            assertSays(labels, "\(mode.rawValue): '\(WikiModeCopy.modeLabel(mode))'", in: Self.lib)
            assertSays(notes, "\(mode.rawValue): '\(WikiModeCopy.modeNote(mode))'", in: Self.lib)
        }
        assertSays(lib, "export const WIKI_MODE_ORDER: readonly WikiReviewMode[] = ['manual', 'tiered', 'automatic'];", in: Self.lib)
        assertSays(lib, "export const WIKI_DEFAULT_REVIEW_MODE: WikiReviewMode = 'tiered';", in: Self.lib)
        let verdicts = try slice(lib, from: "export const WIKI_VERDICT_WORDS", to: "};")
        for verdict in WikiVerificationVerdict.allCases where verdict != .unknown {
            assertSays(verdicts, "\(verdict.rawValue): '\(WikiModeCopy.verdictWord(verdict))'", in: Self.lib)
        }
        let origins = try slice(lib, from: "export const WIKI_ORIGIN_WORDS", to: "};")
        for origin in [WikiChangesetOrigin.import, .agent, .watch, .owner] {
            assertSays(origins, "\(origin.rawValue): '\(WikiModeCopy.originWord(origin))'", in: Self.lib)
        }
        assertSays(origins, "maintenance: WIKI_HISTORY_MAINTENANCE", in: Self.lib)
        assertSays(lib, "export const WIKI_SETTINGS_SECTIONS = [WIKI_REVIEW_MODE, WIKI_WORKSPACES, WIKI_MAINTENANCE, WIKI_TRASH_TITLE] as const;", in: Self.lib)
        // The sentences built around a value.
        assertSays(lib, "(runs === 1 ? '1 run a day' : `${runs} ${WIKI_RUNS_A_DAY}`)", in: Self.lib)
        assertSays(lib, "days === null ? WIKI_LOOKBACK_ALL : days === 0 ? WIKI_LOOKBACK_NOW : days === 1 ? 'Last 1 day' : `Last ${days} ${WIKI_LOOKBACK_UNIT}`",
                   in: Self.lib)
        assertSays(lib, "export const WIKI_LOOKBACK_CHOICES = ['now', 'days', 'all'] as const;", in: Self.lib)
        assertSays(lib, "`Applied ${count} change${count === 1 ? '' : 's'}`", in: Self.lib)
        assertSays(lib, "`${count} rejected by the check`", in: Self.lib)
        assertSays(lib, "`${count} to review`", in: Self.lib)
        assertSays(lib, "`${WIKI_ORIGIN_WORDS[origin] ?? origin} · ${WIKI_RUN}`", in: Self.lib)
        assertSays(lib, "`checked on main at ${shortSha(ref)}`", in: Self.lib)
        assertSays(lib, "parts.push(`Checked by ${input.verification.model}: ${verdict}`);", in: Self.lib)
    }

    // MARK: the pages, in order at both ends

    /// Review mode, then Maintenance; the lead, the three modes, the spot check under Automatic, the
    /// floors; maintenance off, its form and its rows once on — where the repository is read from and,
    /// while the read says the server executes the wiki (mock 35 ①②), the System model, read-only, with the
    /// privacy note after them.
    func testTheSettingsPagesDrawTheSameBlocksInTheSameOrder() throws {
        let page = try web(Self.settingsPage)
        assertOrder(page, ["title={WIKI_REVIEW_MODE}", "title={WIKI_MAINTENANCE}"], "the web page's cards")
        let reviewMode = try slice(page, from: "title={WIKI_REVIEW_MODE}", to: "title={WIKI_MAINTENANCE}")
        assertSays(page, "const fallback = wikiModeFallback(settings);", in: Self.settingsPage)
        assertOrder(reviewMode, ["{fallback && (", "{WIKI_REVIEW_MODE_LEAD}", "WIKI_MODE_ORDER.map(",
                                 "{WIKI_MODE_DEFAULT}", "{WIKI_MODE_NOTES[value]}", "{WIKI_SPOT_CHECK}",
                                 "{WIKI_SPOT_CHECK_NOTE}", "{WIKI_FLOORS_LEAD}"], "the web's Review mode card")
        assertSays(reviewMode, "disabled={mode !== 'automatic' || write.isPending}", in: Self.settingsPage)
        let off = try slice(page, from: "<div className=\"wk-maint-off\">", to: "{setUp && (")
        assertOrder(off, ["{WIKI_MAINTENANCE_NAME}", "{WIKI_MAINTENANCE_NOTE_SERVER}",
                          "{WIKI_OFF}", "{WIKI_SET_UP}", "{server && <WikiPrivacyNote />}"], "the web's maintenance off")
        let on = try slice(page, from: "function MaintenanceOn(", to: "{WIKI_TURN_OFF}")
        assertOrder(on, ["{WIKI_STATUS}", "{WIKI_REPO_FROM}", "{server && (", "<WikiModelLine model={server} />",
                         "{WIKI_DAILY_LIMIT}", "{WIKI_LOOKBACK}",
                         "{wikiLookbackLabel(maintenance.lookbackDays)}", "{server && <WikiPrivacyNote />}",
                         "{WIKI_MAINTENANCE_EDIT}", "{WIKI_TURN_OFF}"],
                    "the web's maintenance rows")
        // The form left the page: the home's setup card opens it too, and Create wiki is the same form (mock 41).
        assertSays(page, "<WikiSetUpDialog space={space} onClose={() => setSetUp(false)} />", in: Self.settingsPage)
        let dialog = try web(Self.setUpDialog)
        let form = try slice(dialog, from: "function MaintenanceForm(", to: "</Dialog>")
        assertOrder(form, ["{note}", "{WIKI_REPO_FROM}",
                           "{workspaceNote}", "{server && (", "{WIKI_MODEL}", "<WikiModelLine model={server} />",
                           "{WIKI_MODEL_NOTE}", "{WIKI_DAILY_LIMIT}", "{WIKI_RUNS_A_DAY}", "{WIKI_DAILY_LIMIT_NOTE}",
                           "{WIKI_LOOKBACK}", "WIKI_LOOKBACK_CHOICES.map(", "{lookback === 'days' && (",
                           "<span>{WIKI_LOOKBACK_UNIT}</span>", "{WIKI_LOOKBACK_NOTE}", "{server && <WikiPrivacyNote />}"],
                    "the web's Set up form")
        let setUp = try slice(dialog, from: "export function WikiSetUpDialog(", to: "export function WikiCreateDialog(")
        for prop in ["title={WIKI_SET_UP_TITLE}", "note={WIKI_MAINTENANCE_NOTE_SERVER}", "submit={maintenance.enabled ? WIKI_SAVE : WIKI_TURN_ON}",
                     "workspaceNote={WIKI_REPO_FROM_NOTE}"] {
            assertSays(setUp, prop, in: Self.setUpDialog)
        }
        assertSays(form, "lookbackDays: wikiLookbackDays(lookback, days)", in: Self.setUpDialog)
        // Nothing writes a provider, and none is picked or shown.
        XCTAssertFalse(form.contains("provider"), "the web's Set up form still has a provider")
        XCTAssertFalse(on.contains("maintenance.provider"), "the web's maintenance rows still show a provider")
        assertSays(page, "const server = systemModel.data?.executor?.serverExecutes ? systemModel.data : null;", in: Self.settingsPage)

        let native = try self.native("Views/WikiSettingsView.swift")
        let nativePage = try slice(native, from: "struct WikiSettingsPage: View {", to: "struct WikiMaintenanceChoice")
        XCTAssertTrue(nativePage.contains("ForEach(WikiModeLogic.SettingsSection.allCases, id: \\.self) { section in"))
        assertOrder(nativePage, ["WikiModeLogic.modeFallback(space.settings)", "ForEach(WikiModeLogic.SettingsSection.allCases"],
                    "the fallback leads the native page")
        let arms = try slice(nativePage, from: "switch section {", to: "private func modeRow(")
        // A row's Toggle and Add workspace's menu both say which workspace, and whether it is to be in the wiki.
        let members = try slice(nativePage, from: "private func workspaceRow(", to: "private func fallbackBanner(")
        assertOrder(members, ["actions.setWorkspace(row.id, $0)", "Text(WikiModeCopy.workspaceLeftOut)",
                              "Section(WikiModeCopy.addWorkspaceGroup)", "actions.setWorkspace(row.id, true)", "Text(WikiModeCopy.addWorkspace)"],
                    "the native section writes each row and each addition")
        assertOrder(arms, ["case .reviewMode:", "ForEach(WikiModeLogic.modes, id: \\.self)", "Text(WikiModeCopy.spotCheck)",
                           "Text(WikiModeCopy.spotCheckNote)", ".disabled(mode != .automatic)", "Text(WikiModeCopy.floorsLead)",
                           "case .workspaces:", "Text(WikiModeCopy.workspacesEmpty)", "workspaceRow(row)", "addWorkspaceMenu(workspaces.addable)",
                           "Text(WikiModeCopy.workspacesLead)",
                           "case .maintenance:", "WikiModeCopy.status",
                           "LabeledContent(WikiModeCopy.repoFrom, value: place)", "if let server {",
                           "LabeledContent(WikiModeCopy.model) { WikiModelValue(model: server) }",
                           "WikiModeCopy.dailyLimit", "WikiModeCopy.lookbackLabel(maintenance.lookbackDays)",
                           "WikiModeCopy.maintenanceName", "WikiModeCopy.setUp",
                           "Text(WikiModeCopy.maintenanceNoteServer)", "Text(WikiModeCopy.privacyNote)",
                           "} else if !maintenance.enabled {",
                           "WikiModeCopy.maintenanceEdit + \"…\"", "WikiModeCopy.turnOff",
                           "case .trash:", "Button(WikiModeCopy.trashOpen, role: .destructive, action: actions.moveToTrash)",
                           "Text(WikiModeCopy.trashNote)", "if trashed > 0 { trashRow }",
                           "Button(action: actions.openTrash)", "Text(WikiModeCopy.trashRowCount(trashed))",
                           "Image(systemName: \"chevron.forward\")", "Text(WikiModeCopy.trashPageTitle)"], "the native page's sections")
        // The question comes first, and the page goes as soon as the wiki does; the Trash row pushes Trash over the page.
        let moving = try slice(native, from: "struct WikiSettingsView: View {", to: "private func workspaceLabel(_ id: String)")
        assertOrder(moving, ["trashed: wiki.trash.count", "wiki.entryCount(space)", ".orbitConfirmation(WikiModeCopy.trashQuestion(",
                             "Button(WikiModeCopy.trashConfirm, role: .destructive) { moveToTrash(space, from: wiki) }",
                             "Button(WikiModeCopy.cancel, role: .cancel)", "WikiModeCopy.trashMessage(",
                             ".alert(WikiModeCopy.trashFailed", "moveToTrash: { confirmingMove = true }",
                             "openTrash: { model.push(.wikiTrash) }",
                             "WikiModeCopy.movedToTrash(name(of: space, in: wiki))", "wiki.moveSpaceToTrash(space)", "model.nav.pop()",
                             "model.showToast(said)"],
                    "the native page asks before it moves the wiki to Trash")
        XCTAssertFalse(arms.contains("provider"), "the native page still shows a provider")
        let row = try slice(nativePage, from: "private func modeRow(", to: "private func fallbackBanner(")
        assertOrder(row, ["WikiModeCopy.modeLabel(value)", "WikiModeCopy.modeDefault", "WikiModeCopy.modeNote(value)",
                          "Image(systemName: \"checkmark\")"], "a mode's row")
        let model = try slice(native, from: "struct WikiModelValue: View {", to: "struct WikiMaintenanceChoice")
        assertOrder(model, ["Text(WikiRunsCopy.systemModelLabel(model.model))", "WikiModelStateText(model: model)"],
                    "the System model, its name over its state")
        let nativeForm = try slice(native, from: "struct WikiMaintenanceForm: View {", to: "struct WikiSetUpSheet: View {")
        assertOrder(nativeForm, ["Text(note)",
                                 "Text(WikiModeCopy.repoFrom)",
                                 "Text(workspaceNote(chosenChoice))",
                                 "if let server {", "LabeledContent(WikiModeCopy.model) { WikiModelValue(model: server) }",
                                 "Text(WikiModeCopy.model)", "Text(WikiModeCopy.modelNote)", "WikiModeCopy.runsADay(",
                                 "Text(WikiModeCopy.dailyLimitNote)", "Picker(WikiModeCopy.lookback, selection: $choice.lookback)",
                                 "ForEach(WikiModeLogic.LookbackChoice.allCases", "if choice.lookback == .days {",
                                 "Text(WikiModeCopy.lookback)", "Text(WikiModeCopy.lookbackNote)",
                                 "if server != nil { Text(WikiModeCopy.privacyNote) }"], "the native Set up form")
        assertSays(nativeForm, "Button(submitLabel)", in: "WikiSettingsView.swift")
        let setUpSheet = try slice(native, from: "struct WikiSetUpSheet: View {", to: "struct WikiCreateSheet: View {")
        for argument in ["title: WikiModeCopy.setUpTitle", "note: WikiModeCopy.maintenanceNoteServer",
                         "submitLabel: current.enabled ? WikiModeCopy.save : WikiModeCopy.turnOn",
                         "workspaceNote: { _ in WikiModeCopy.repoFromNote }", "server: wiki.serverModel", "await wiki.loadSystemModel()"] {
            assertSays(setUpSheet, argument, in: "WikiSettingsView.swift")
        }
        assertSays(nativeForm, "Stepper(value: $choice.dailyRunLimit, in: WikiMaintenanceSettings.dailyRunLimitRange)",
                   in: "WikiSettingsView.swift")
        assertSays(nativeForm, "Stepper(value: $choice.lookbackDays, in: 1...WikiMaintenanceSettings.lookbackDaysRange.upperBound)",
                   in: "WikiSettingsView.swift")
        // All of history goes out as null: a key left out would leave the look-back as it was.
        assertSays(native, "lookbackDays: .some(WikiModeLogic.lookbackDays(lookback, days: lookbackDays))", in: "WikiSettingsView.swift")
        let screen = try slice(native, from: "struct WikiSettingsView: View {", to: "private func actions(")
        // The System model is read with the page, and nothing picks or writes a provider.
        assertSays(screen, "server: wiki.serverModel", in: "WikiSettingsView.swift")
        assertSays(screen, "await wiki.loadSystemModel()", in: "WikiSettingsView.swift")
        XCTAssertFalse(nativeForm.contains("provider"), "the native Set up form still has a provider")
        XCTAssertFalse(setUpSheet.contains("provider"), "the native Set up sheet still writes a provider")
        XCTAssertFalse(screen.contains("provider"), "the native settings screen still writes a provider")
    }

    /// An entry a mode applied: Confirm, then Reject ▾ with the four reasons and where the reason goes,
    /// then the bar — before Details, at both ends.
    func testTheEntrysAnswersAndBarAreInTheSameOrder() throws {
        let drawer = try web(Self.drawer)
        assertOrder(drawer, ["<WikiEntryAnswers entry={data} />", "wikiEntryAnswerable(data) ? null : WIKI_ACTION_EDIT}", "<WikiMarkBar entry={data} />",
                             "<Section title={WIKI_SECTION_DETAILS}>"], "the drawer's head, bar and first section")
        assertSays(drawer, "{WIKI_NOT_SENT_UNREVIEWED}", in: Self.drawer)
        let marks = try web(Self.marks)
        assertOrder(marks, ["{wikiCanConfirm(entry) && (", "{WIKI_CONFIRM}", "<WikiRejectButton"], "Confirm, then Reject")
        assertSays(marks, "const line = wikiCheckedLine({", in: Self.marks)
        // The verdict is the entry read's own, at both ends: Review is not where it comes from.
        assertSays(marks, "verification: entry.verification ?? null,", in: Self.marks)
        XCTAssertFalse(marks.contains("wikiReviewQuery"), "\(Self.marks) reads the verdict from Review again")
        assertOrder(marks, ["<b>{banner.lead}</b> · {banner.text}", "{line && <div className=\"wk-markbar-line\">{line}</div>}"],
                    "the bar's two lines")
        let run = try web(Self.runPage)
        assertOrder(run, ["...WIKI_REJECT_MENU.map(({ reason, label }) => ({ key: reason, label, onSelect: () => onReject(reason) }))", "{WIKI_REJECT_ON_RECORD}"],
                    "the reasons, then where they go")

        let view = try native("Views/WikiView.swift")
        let page = try slice(view, from: "struct WikiEntryPage: View {", to: "struct WikiReviewActions {")
        let head = try slice(page, from: "private var head: some View {", to: "private var kindLine: some View {")
        assertOrder(head, ["chips", "WikiModeLogic.answerable(status: entry.status, trust: entry.trust)", "answers",
                           "WikiModeLogic.banner(status: entry.status, trust: entry.trust", "markBar(banner)"],
                    "the native head, answers and bar")
        let bar = try slice(page, from: "private func markBar(", to: "private static func historyWord(")
        assertSays(bar, "let verification = detail.verification", in: "WikiView.swift")
        let answers = try slice(page, from: "private var answers: some View {", to: "private func markBar(")
        assertOrder(answers, ["WikiModeLogic.canConfirm(status: entry.status, trust: entry.trust)", "WikiModeCopy.confirm",
                              "Section(WikiModeCopy.rejectOnRecord)", "ForEach(WikiRejectReason.allCases, id: \\.self)",
                              "Text(WikiCopy.reject)"], "the native answers")
        assertSays(answers, ".buttonStyle(.borderedProminent)", in: "WikiView.swift")
        let used = try slice(page, from: "@ViewBuilder private var whereUsed: some View {", to: "private func exposureRow(")
        assertSays(used, "WikiModeLogic.whereUsedNote(status: entry.status, trust: entry.trust)", in: "WikiView.swift")
    }

    /// One run: Revert run… and the session, the counts, then Added / Amended / Reinforced — and the
    /// Revert confirm in the same words, at both ends.
    func testTheRunPagesDrawTheSameBlocksInTheSameOrder() throws {
        let run = try web(Self.runPage)
        let drawer = try slice(run, from: "export function WikiRunDrawer(", to: "const RUN_GROUP_SHOWN")
        assertOrder(drawer, ["{wikiRunKicker(changeset.origin)}", "<div className=\"tdp-title\">{wikiAppliedChanges(summary.applied)}</div>",
                             "{wikiRunWhen(changeset.createdAt)}", "{WIKI_REVERT_RUN}", "{WIKI_OPEN_SESSION}",
                             "wikiRunCounts(summary).map(", "title={WIKI_RUN_ADDED}", "title={WIKI_RUN_AMENDED}",
                             "title={WIKI_RUN_REINFORCED}"], "the web's run drawer")
        let confirm = try slice(run, from: "export function useRevertRun(", to: "onConfirm:")
        assertOrder(confirm, ["title: WIKI_REVERT_TITLE", "{wikiRevertBody(summary)}", "{WIKI_REVERT_KEEPS}",
                              "confirmText: WIKI_REVERT_RUN_CONFIRM", "danger: true,", "cancelText: WIKI_CANCEL"],
                    "the web's Revert confirm")
        let row = try slice(run, from: "export function WikiRunTimelineRow(", to: "export function WikiRejectButton(")
        assertOrder(row, ["{WIKI_ORIGIN_WORDS[origin] ?? origin}", "{wikiAppliedChanges(summary?.applied ?? changes)}",
                          "counts.join(' · ')", "{WIKI_VIEW_RUN}", "{WIKI_REVERT_RUN}"], "the web's Recently changed run row")
        // Both read the run by its own id, whatever of it waits in Review, and offer Revert as the server says.
        assertSays(drawer, "const read = useQuery(wikiChangesetQuery(changesetId));", in: Self.runPage)
        assertSays(drawer, "disabled={!summary.revertible}", in: Self.runPage)
        assertSays(row, "const read = useQuery(wikiChangesetQuery(changesetId));", in: Self.runPage)
        assertSays(row, "{summary?.revertible && (", in: Self.runPage)
        XCTAssertFalse(run.contains("wikiReviewQuery"), "\(Self.runPage) opens a run from Review again")

        let native = try self.native("Views/WikiRunView.swift")
        let page = try slice(native, from: "struct WikiRunPage: View {", to: "struct WikiRunView: View {")
        assertOrder(page, ["Section { head(counted) }", "countsRow(counted)", "group(WikiModeCopy.runAdded, counted.added)",
                           "group(WikiModeCopy.runAmended, counted.amended)",
                           "group(WikiModeCopy.runReinforced, counted.reinforced)"], "the native run page")
        let head = try slice(page, from: "private func head(", to: "private func countsRow(")
        assertOrder(head, ["WikiModeCopy.runKicker(changeset.origin)", "WikiModeCopy.appliedChanges(summary.applied)",
                           "WikiModeLogic.runWhen(at)", "WikiModeCopy.revertRun", "WikiModeCopy.openSession"],
                    "the native run head")
        assertSays(page, ".swipeActions(edge: .trailing)", in: "WikiRunView.swift")
        assertSays(head, ".disabled(busy || !summary.revertible)", in: "WikiRunView.swift")
        let screen = try slice(native, from: "struct WikiRunView: View {", to: "private func actions(")
        assertOrder(screen, [".alert(WikiModeCopy.revertTitle, isPresented: $reverting)", "WikiModeCopy.cancel, role: .cancel",
                             "WikiModeCopy.revertRunConfirm, role: .destructive", "await wiki.revert(changeset)",
                             "WikiModeLogic.revertBody(summary) + \"\\n\" + WikiModeCopy.revertKeeps"],
                    "the native Revert confirm")
        assertSays(screen, ".task(id: changesetID) { await wiki.loadRun(changesetID) }", in: "WikiRunView.swift")

        // Recently changed — Activity's now (design §12.3.2) — folds a run into a row at both ends, and a row
        // opens the run's page.
        let activity = try web(Self.activity)
        assertSays(activity, "row.kind === 'run' ? ( <WikiRunTimelineRow", in: Self.activity)
        let activityPage = try self.native("Views/WikiActivityView.swift")
        XCTAssertTrue(activityPage.contains("ForEach(content.recentRows) { row in"))
        XCTAssertTrue(activityPage.contains("case .run(let changesetId, let origin, let at, let items):"))
        XCTAssertTrue(activityPage.contains("rows.runRow(changesetId, origin: origin, at: at, changes: items.count, new: isNew(at))"))
        XCTAssertTrue(activityPage.contains("openRun: { id in model.push(.wikiRun(changesetID: id)) }"))
        let rows = try self.native("Views/WikiView.swift")
        XCTAssertTrue(rows.contains("actions.openRun(changesetId)"), "the band's run row presses through to it")
    }

    /// The head's way into the settings: the web's Settings button after Activity, the native gear.
    func testTheWikiHeadOpensTheSettings() throws {
        let page = try web(Self.page)
        assertOrder(page, ["<WikiActivityButton spaceSlug={space.slug}", "<WikiSettingsButton spaceSlug={space.slug} />"],
                    "the web head's actions")
        assertSays(page, "if (route === 'settings') return <WikiSettingsPage space={resolved} />;", in: Self.page)
        let view = try native("Views/WikiView.swift")
        let home = try slice(view, from: "struct WikiHomePage: View {", to: "private struct WikiRowLabel: View {")
        let toolbar = try slice(home, from: ".toolbar {", to: ".task(id: query) {")
        assertOrder(toolbar, ["Button(action: actions.openSettings)", "Image(systemName: \"gearshape\")",
                              ".accessibilityLabel(WikiModeCopy.settings)"], "the native gear")
        let screens = try native("Views/WikiScreens.swift")
        XCTAssertTrue(screens.contains("openSettings: { open(.wikiSettings) }"))
        let shell = try native("Views/CompactShell.swift")
        XCTAssertTrue(shell.contains("case .wikiSettings:           WikiSettingsView()"))
        XCTAssertTrue(shell.contains("case .wikiRun(let changesetID): WikiRunView(changesetID: changesetID)"))
        let pane = try slice(screens, from: "struct WikiDetailPane: View {", to: "struct WikiEntryView: View {")
        assertOrder(pane, ["model.nav.wikiReviewOnTop", "model.nav.wikiSettingsOnTop", "WikiSettingsView()",
                           "model.nav.selectedWikiRunID", "WikiRunView(changesetID: run)"], "the wide shells' detail pane")
    }

    /// Trash at the native end (docs/mocks/wiki-trash ②): one page, pushed from Wiki settings' Trash row, the space menu's
    /// Trash under Manage spaces and the empty Wiki's Open Trash; a row is the wiki's name over its line; an iOS swipe
    /// shows Delete and Restore, a Mac right-click Restore and Delete permanently…; Delete asks first; and a refusal is
    /// the server's own sentence. The list is read beside the wikis, so every way to it comes and goes with them.
    func testTrashIsOnePageEveryWayToItPushes() throws {
        let file = try native("Views/WikiTrashView.swift")
        let page = try slice(file, from: "struct WikiTrashPage: View {", to: "private func row(")
        assertOrder(page, ["if rows.isEmpty {", "Text(WikiModeCopy.trashPageEmpty)", "ForEach(rows) { row in self.row(row) }",
                           "Text(WikiModeCopy.trashPageLead)", ".navigationTitle(WikiModeCopy.trashPageTitle)", ".disabled(busy)"],
                    "Trash's page: its rows, then how long a wiki stays")
        let row = try slice(file, from: "private func row(_ row: WikiTrashRow) -> some View {", to: "struct WikiTrashView: View {")
        assertOrder(row, ["Text(row.title)", "WikiModeCopy.trashRowLine(deletedAt: row.deletedAt, purgeAt: row.purgeAt, entries: row.entries)",
                          "#if os(iOS)", "#else", "#endif", ".orbitConfirmation(WikiModeCopy.trashPurgeQuestion,",
                          "Button(WikiModeCopy.trashPurgeConfirm, role: .destructive) { actions.purge(row) }",
                          "Button(WikiModeCopy.cancel, role: .cancel)", "Text(WikiModeCopy.trashPurgeBody(entries: row.entries))"],
                    "a row in Trash, and the question its Delete asks")
        let swipe = try slice(row, from: "#if os(iOS)", to: "#else")
        assertOrder(swipe, [".swipeActions(edge: .trailing, allowsFullSwipe: false)", "Button(WikiModeCopy.trashDeleteSwipe) { purging = row }",
                            ".tint(.red)", "Button(WikiModeCopy.trashRestore) { actions.restore(row) }", ".tint(.blue)"],
                    "the iOS swipe: Delete outermost, then Restore")
        XCTAssertFalse(swipe.contains("role: .destructive"), "the swipe's Delete only asks")
        let menu = try slice(row, from: "#else", to: "#endif")
        assertOrder(menu, [".contextMenu {", "Button(WikiModeCopy.trashRestore) { actions.restore(row) }",
                           "Button(WikiModeCopy.trashDeletePermanently, role: .destructive) { purging = row }"], "the Mac's right-click")
        let screen = try slice(file, from: "struct WikiTrashView: View {", to: "private func actions(")
        assertOrder(screen, ["WikiTrashPage(rows: wiki.trash, busy: wiki.busy, actions: actions(wiki))", ".task { await wiki.loadTrash() }",
                             ".alert(noticeTitle,"], "Trash's screen")
        let presses = try slice(file, from: "private func actions(_ wiki: WikiModel) -> WikiTrashActions {",
                                to: "noticeTitle = WikiModeCopy.trashPurgeFailed")
        assertOrder(presses, ["let said = WikiModeCopy.restored(row.title)", "await wiki.restoreSpace(row, restored: { model.showToast(said) })",
                              "noticeTitle = WikiModeCopy.trashRestoreFailed", "await wiki.purgeSpace(row)"],
                    "a restore says so where the app says what a press did, and a refusal says why")

        let view = try native("Views/WikiView.swift")
        let picker = try slice(view, from: "struct WikiSpacePicker: View {", to: "private extension View {")
        assertOrder(picker, ["Label(WikiCopy.manageSpaces, systemImage: \"gearshape\")", "if trashed > 0 {", "Button(action: openTrash)",
                             "Label(WikiModeCopy.trashPickerItem, systemImage: \"trash\")"], "the space menu's Trash, under Manage spaces")
        let home = try slice(view, from: "struct WikiHomePage: View {", to: "struct WikiSpacePicker: View {")
        assertSays(home, "trashed: trashed, openTrash: actions.openTrash)", in: "WikiView.swift")
        let first = try slice(view, from: "struct WikiFirstStartPage: View {", to: "struct WikiSpacePicker: View {")
        assertOrder(first, ["WikiStartSection(card: card, act: act)", "if trashed > 0 {", "Button(WikiModeCopy.trashOpenTrash, action: openTrash)",
                            "Text(WikiModeCopy.trashHoldsWhenEmpty(trashed))"], "the empty Wiki's way to Trash, under its card")
        let screens = try native("Views/WikiScreens.swift")
        for wiring in ["trashed: wiki.trash.count,", "openTrash: { open(.wikiTrash) },",
                       "WikiFirstStartPage(card: WikiStartLogic.firstCard(workspaces: workspaces), trashed: wiki.trash.count,",
                       "openTrash: { model.push(.wikiTrash) }) { _ in creating = true }"] {
            assertSays(screens, wiring, in: "WikiScreens.swift")
        }
        let pane = try slice(screens, from: "struct WikiDetailPane: View {", to: "struct WikiDisabledNote: View {")
        assertOrder(pane, ["model.nav.wikiSettingsOnTop", "WikiSettingsView()", "model.nav.wikiTrashOnTop", "WikiTrashView()"],
                    "the wide shells' detail pane")
        assertSays(try native("Views/WikiContentsColumn.swift"), "trashed: wiki.trash.count, openTrash: { open(.wikiTrash) })",
                   in: "WikiContentsColumn.swift")
        XCTAssertTrue(try native("Views/CompactShell.swift").contains("case .wikiTrash:              WikiTrashView()"))

        let model = try native("WikiModel.swift")
        let spaces = try slice(model, from: "func loadSpaces() async {", to: "func loadHome() async {")
        assertOrder(spaces, ["let trashRead = Task { await loadTrash() }", "try await api.wikiSpaces()", "await trashRead.value",
                             "try await api.wikiTrash().spaces", "} catch APIError.http(let status, _) where status == 404 {"],
                    "Trash read beside the wikis")
    }

    /// A challenge's line and answers at both ends: which anchor broke and how, the After row, then Keep, Amend… (for
    /// a kind that can be amended) and Retire…, none filled, Retire… red and opening the dialog both ends share.
    func testAChallengeCardSaysWhatBrokeAndOffersTheThreeAnswers() throws {
        let review = try web(Self.review)
        let actions = try slice(review, from: ") : challenge ? (", to: ") : (")
        assertOrder(actions, ["action: 'reconfirm'", "{WIKI_RECONFIRM}", "{amendable && (", "setAmending(true)",
                              "{WIKI_AMEND_ANSWER}",
                              "className=\"card-action card-action--danger\" onClick={() => setRetiring(true)}",
                              "{WIKI_RETIRE_ANSWER}", "{WIKI_CHALLENGE_WAITS}"], "the web's challenge answers")
        XCTAssertFalse(actions.contains("card-action--primary"), "the web's challenge has a filled answer")
        XCTAssertFalse(actions.contains("action: 'retire'"), "the web's Retire… decides straight from the card")
        assertSays(review, "const amendable = !kind || !(kind in KIND_SPECS) || KIND_SPECS[kind as WikiKind].amendable;",
                   in: Self.review)
        let after = try slice(review, from: "<span className=\"v wk-challenge-after\">", to: "</span>")
        assertOrder(after, ["<b>{WIKI_RECONFIRM}</b> · {WIKI_CHALLENGE_AFTER_KEEP}", "{amendable && (",
                            "<b>{WIKI_AMEND}</b> · {WIKI_CHALLENGE_AFTER_AMEND}",
                            "<b className=\"wk-danger\">{WIKI_RETIRE}</b> · {WIKI_CHALLENGE_AFTER_RETIRE}"], "the web's After row")
        let dialog = try slice(review, from: "function ChallengeRetireDialog(", to: "function ProposalEditor(")
        assertOrder(dialog, ["title={WIKI_ACTION_RETIRE}", "initialFocus={cancel}", "{WIKI_CANCEL}", "danger",
                             "disabled={reason.trim().length === 0}", "{WIKI_RETIRE}",
                             "<p className=\"wk-modal-note\">{WIKI_RETIRE_NOTE}</p>",
                             "placeholder={WIKI_RETIRE_REASON_PLACEHOLDER}"], "the web's Retire… dialog")
        assertSays(review, "reason={typeof payload.reason === 'string' ? payload.reason : ''}", in: Self.review)
        assertSays(review, "write.mutateAsync([{ opId: op.id, action: 'retire', note }]);", in: Self.review)
        assertSays(review, "list.current?.scrollIntoView?.({ block: 'start' })", in: Self.review)
        let nativeView = try native("Views/WikiView.swift")
        let answers = try slice(nativeView, from: "} else if isChallenge {", to: "} else {")
        assertOrder(answers, ["actions.decide(card, .reconfirm, nil)", "Text(WikiModeCopy.reconfirm)",
                              "WikiModeLogic.amendable(", "actions.amend(card)", "Text(WikiModeCopy.amendAnswer)",
                              "Button(role: .destructive) { actions.retire(card) }", "Text(WikiModeCopy.retireAnswer)"],
                    "the native challenge answers")
        XCTAssertFalse(answers.contains(".borderedProminent"), "the native challenge has a filled answer")
        let nativeScreens = try native("Views/WikiScreens.swift")
        let nativeDialog = try slice(nativeScreens, from: ".alert(WikiCopy.retire, isPresented: Binding(", to: "Text(WikiCopy.retireNote)")
        assertOrder(nativeDialog, ["TextField(WikiCopy.reasonPlaceholder, text: $retireReason)", "Button(\"Cancel\", role: .cancel)",
                                   "Button(WikiCopy.retireConfirm, role: .destructive)", "await wiki.decide(card, .retire, note: why)"],
                    "the native Retire… dialog")
        let line = try slice(review, from: "function ChallengeLine(", to: "function proposedText(")
        assertOrder(line, ["wikiBrokenAnchors(anchors)", "anchor.state === 'changed' ? 'Changed' : 'Missing'", "</b> · {anchor.label}",
                           "wikiCheckedOnMain(ref)", "{WIKI_CHALLENGED}"], "the web's challenge line")
        let view = try native("Views/WikiView.swift")
        let card = try slice(view, from: "private var challengeLine: some View {", to: "private var webDerivedWarning: some View {")
        assertOrder(card, ["WikiModeLogic.brokenAnchors(entry?.anchors)", "WikiModeLogic.challengeRef(entry?.anchors)",
                           "WikiModeCopy.challenged", "anchor.state == .changed ? \"Changed\" : \"Missing\"",
                           "WikiModeCopy.checkedOnMain(ref)"], "the native challenge line")
        let screens = try native("Views/WikiScreens.swift")
        XCTAssertTrue(screens.contains("await wiki.decide(card, .amend, edited: edited)"))
    }

    // MARK: the contract

    /// The modes, who changes them, and the four owner routes these pages call are the contract's.
    func testTheReviewModesAndTheOwnersRoutesAreTheContracts() throws {
        let data = try Data(contentsOf: find("contracts/wiki.contract.json"))
        let contract = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let reviewModes = try XCTUnwrap(contract["reviewModes"] as? [String: Any])
        XCTAssertEqual(try XCTUnwrap(reviewModes["values"] as? [String]),
                       WikiReviewMode.allCases.map(\.rawValue).filter { $0 != "unknown" })
        let space = try XCTUnwrap(contract["space"] as? [String: Any])
        let settings = try XCTUnwrap(space["settings"] as? [String: Any])
        let reviewMode = try XCTUnwrap(settings["reviewMode"] as? [String: Any])
        XCTAssertEqual(reviewMode["default"] as? String, WikiModeLogic.defaultMode.rawValue)
        XCTAssertEqual(reviewMode["unset"] as? String, WikiModeLogic.mode(of: nil).rawValue)
        let changedBy = try XCTUnwrap((settings["reviewModeChangedBy"] as? [String: Any])?["type"] as? String)
        XCTAssertEqual(changedBy.components(separatedBy: " | "),
                       WikiReviewModeChangedBy.allCases.map(\.rawValue).filter { $0 != "unknown" })
        let spotChecks = try XCTUnwrap(settings["automaticSpotChecks"] as? [String: Any])
        XCTAssertEqual(spotChecks["default"] as? Bool, false)
        let rules = try XCTUnwrap(reviewModes["rules"] as? [String: Any])
        XCTAssertEqual(rules["automaticSpotCheckEvery"] as? Int, 200, "the spot check's sentence says 1 in 200")
        let agentSurface = try XCTUnwrap(contract["agentSurface"] as? [String: Any])
        let doors = try XCTUnwrap(agentSurface["doors"] as? [String: Any])
        let routes = Set(try XCTUnwrap((doors["user"] as? [String: Any])?["routes"] as? [String]))
        for route in ["PATCH /api/wiki/spaces/:id", "POST /api/wiki/entries/:id/confirm",
                      "POST /api/wiki/entries/:id/reject", "POST /api/wiki/changesets/:id/revert",
                      "GET /api/wiki/changesets/:id"] {
            XCTAssertTrue(routes.contains(route), "\(route) is not a route the user door declares")
        }
    }
}
