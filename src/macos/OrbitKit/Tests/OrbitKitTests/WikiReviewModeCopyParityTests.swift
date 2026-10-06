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
                    struct Field: Decodable {
                        let label: String
                        let note: String
                    }
                    struct Defaults: Decodable {
                        let provider: String
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
                    let fields: [Field]
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
                struct ProviderLabel: Decodable {
                    let provider: String
                    let model: String?
                    let says: String
                }
                let name: String
                let note: String
                let off: String
                let on: String
                let setUp: String
                let form: Form
                let rows: [String]
                let edit: String
                let turnOff: String
                let runsADay: [Runs]
                let lookbacks: [LookbackCase]
                let workspaceLabels: [WorkspaceLabel]
                let providerLabels: [ProviderLabel]
            }
            struct Fallback: Decodable {
                let settings: WikiSpaceSettings
                let says: String?
            }
            let title: String
            let crumb: String
            let sections: [String]
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
            let answers: [String]
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

        let maintenance = settings.maintenance
        XCTAssertEqual([WikiModeCopy.maintenanceName, WikiModeCopy.maintenanceNote, WikiModeCopy.off, WikiModeCopy.on,
                        WikiModeCopy.setUp],
                       [maintenance.name, maintenance.note, maintenance.off, maintenance.on, maintenance.setUp])
        XCTAssertEqual(WikiModeCopy.setUpTitle, maintenance.form.title)
        XCTAssertEqual([WikiModeCopy.workspace, WikiModeCopy.provider, WikiModeCopy.dailyLimit, WikiModeCopy.lookback],
                       maintenance.form.fields.map(\.label))
        XCTAssertEqual([WikiModeCopy.workspaceNote, WikiModeCopy.providerNote, WikiModeCopy.dailyLimitNote,
                        WikiModeCopy.lookbackNote],
                       maintenance.form.fields.map(\.note))
        XCTAssertEqual(WikiModeCopy.runsADayUnit, maintenance.form.unit)
        XCTAssertEqual([WikiModeCopy.cancel, WikiModeCopy.turnOn, WikiModeCopy.save],
                       [maintenance.form.cancel, maintenance.form.turnOn, maintenance.form.save])
        XCTAssertEqual(WikiMaintenanceSettings.default.provider, maintenance.form.defaults.provider)
        XCTAssertEqual(WikiMaintenanceSettings.default.dailyRunLimit, maintenance.form.defaults.dailyRunLimit)
        XCTAssertEqual(WikiMaintenanceSettings.dailyRunLimitRange, maintenance.form.defaults.min...maintenance.form.defaults.max)
        XCTAssertEqual([WikiModeCopy.status, WikiModeCopy.workspace, WikiModeCopy.provider, WikiModeCopy.dailyLimit,
                        WikiModeCopy.lookback],
                       maintenance.rows)
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
        for row in maintenance.providerLabels {
            XCTAssertEqual(WikiModeLogic.providerLabel(row.provider, model: row.model), row.says)
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
        XCTAssertEqual([WikiModeCopy.reconfirm, WikiModeCopy.amend, WikiModeCopy.retire], shared.challenge.answers)
        XCTAssertEqual(WikiModeCopy.challengeWaits, shared.challenge.waits)
        XCTAssertEqual(WikiModeCopy.challenged, shared.challenge.challenged)
        XCTAssertEqual(WikiModeCopy.amendNote, shared.challenge.amendNote)
        // The answers are the contract's decide actions for a challenge.
        XCTAssertTrue(WikiDecideAction.allCases.contains(.reconfirm))
        XCTAssertTrue(WikiDecideAction.allCases.contains(.amend))
        XCTAssertTrue(WikiDecideAction.allCases.contains(.retire))
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
            ("WIKI_MAINTENANCE_NOTE", WikiModeCopy.maintenanceNote),
            ("WIKI_OFF", WikiModeCopy.off),
            ("WIKI_ON", WikiModeCopy.on),
            ("WIKI_SET_UP", WikiModeCopy.setUp),
            ("WIKI_SET_UP_TITLE", WikiModeCopy.setUpTitle),
            ("WIKI_STATUS", WikiModeCopy.status),
            ("WIKI_WORKSPACE", WikiModeCopy.workspace),
            ("WIKI_WORKSPACE_NOTE", WikiModeCopy.workspaceNote),
            ("WIKI_PROVIDER", WikiModeCopy.provider),
            ("WIKI_PROVIDER_NOTE", WikiModeCopy.providerNote),
            ("WIKI_PINNED_NO_FALLBACK", WikiModeCopy.pinnedNoFallback),
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
            ("WIKI_RETIRE", WikiModeCopy.retire),
            ("WIKI_CHALLENGE_WAITS", WikiModeCopy.challengeWaits),
            ("WIKI_CHALLENGED", WikiModeCopy.challenged),
            ("WIKI_AMEND_NOTE", WikiModeCopy.amendNote),
        ]
        for (name, word) in pairs { assertDeclares(lib, name, word) }
        // The sentence for a run Review no longer held is gone with the branch that said it.
        XCTAssertFalse(lib.contains("WIKI_NO_SUCH_RUN"), "\(Self.lib) still says a run cannot be opened")
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
        assertSays(lib, "export const WIKI_SETTINGS_SECTIONS = [WIKI_REVIEW_MODE, WIKI_MAINTENANCE] as const;", in: Self.lib)
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
    /// floors; maintenance off, its form and its rows once on.
    func testTheSettingsPagesDrawTheSameBlocksInTheSameOrder() throws {
        let page = try web(Self.settingsPage)
        assertOrder(page, ["title={WIKI_REVIEW_MODE}", "title={WIKI_MAINTENANCE}"], "the web page's cards")
        let reviewMode = try slice(page, from: "title={WIKI_REVIEW_MODE}", to: "title={WIKI_MAINTENANCE}")
        assertSays(page, "const fallback = wikiModeFallback(settings);", in: Self.settingsPage)
        assertOrder(reviewMode, ["{fallback && (", "{WIKI_REVIEW_MODE_LEAD}", "WIKI_MODE_ORDER.map(",
                                 "{WIKI_MODE_DEFAULT}", "{WIKI_MODE_NOTES[value]}", "{WIKI_SPOT_CHECK}",
                                 "{WIKI_SPOT_CHECK_NOTE}", "{WIKI_FLOORS_LEAD}"], "the web's Review mode card")
        assertSays(reviewMode, "disabled={mode !== 'automatic' || write.isPending}", in: Self.settingsPage)
        let on = try slice(page, from: "function MaintenanceOn(", to: "function MaintenanceSetUp(")
        assertOrder(on, ["{WIKI_STATUS}", "{WIKI_WORKSPACE}", "{WIKI_PROVIDER}", "{WIKI_DAILY_LIMIT}", "{WIKI_LOOKBACK}",
                         "{wikiLookbackLabel(maintenance.lookbackDays)}", "{WIKI_MAINTENANCE_EDIT}", "{WIKI_TURN_OFF}"],
                    "the web's maintenance rows")
        let form = try slice(page, from: "function MaintenanceSetUp(", to: "</Modal>")
        assertOrder(form, ["{WIKI_MAINTENANCE_NOTE}", "{WIKI_WORKSPACE}", "{WIKI_WORKSPACE_NOTE}", "{WIKI_PROVIDER}",
                           "{WIKI_PROVIDER_NOTE}", "{WIKI_DAILY_LIMIT}", "{WIKI_RUNS_A_DAY}", "{WIKI_DAILY_LIMIT_NOTE}",
                           "{WIKI_LOOKBACK}", "WIKI_LOOKBACK_CHOICES.map(", "{lookback === 'days' && (",
                           "<span>{WIKI_LOOKBACK_UNIT}</span>", "{WIKI_LOOKBACK_NOTE}"],
                    "the web's Set up form")
        assertSays(form, "okText={maintenance.enabled ? WIKI_SAVE : WIKI_TURN_ON}", in: Self.settingsPage)
        assertSays(form, "lookbackDays: wikiLookbackDays(lookback, days)", in: Self.settingsPage)

        let native = try self.native("Views/WikiSettingsView.swift")
        let nativePage = try slice(native, from: "struct WikiSettingsPage: View {", to: "struct WikiPickerOption")
        XCTAssertTrue(nativePage.contains("ForEach(WikiModeLogic.SettingsSection.allCases, id: \\.self) { section in"))
        assertOrder(nativePage, ["WikiModeLogic.modeFallback(space.settings)", "ForEach(WikiModeLogic.SettingsSection.allCases"],
                    "the fallback leads the native page")
        let arms = try slice(nativePage, from: "switch section {", to: "private func modeRow(")
        assertOrder(arms, ["case .reviewMode:", "ForEach(WikiModeLogic.modes, id: \\.self)", "Text(WikiModeCopy.spotCheck)",
                           "Text(WikiModeCopy.spotCheckNote)", ".disabled(mode != .automatic)", "Text(WikiModeCopy.floorsLead)",
                           "case .maintenance:", "WikiModeCopy.status", "WikiModeCopy.workspace", "WikiModeCopy.provider",
                           "WikiModeCopy.dailyLimit", "WikiModeCopy.lookbackLabel(maintenance.lookbackDays)",
                           "WikiModeCopy.maintenanceName", "WikiModeCopy.setUp",
                           "WikiModeCopy.maintenanceEdit + \"…\"", "WikiModeCopy.turnOff"], "the native page's sections")
        let row = try slice(nativePage, from: "private func modeRow(", to: "private func fallbackBanner(")
        assertOrder(row, ["WikiModeCopy.modeLabel(value)", "WikiModeCopy.modeDefault", "WikiModeCopy.modeNote(value)",
                          "Image(systemName: \"checkmark\")"], "a mode's row")
        let nativeForm = try slice(native, from: "struct WikiMaintenanceForm: View {", to: "struct WikiSettingsView: View {")
        assertOrder(nativeForm, ["Text(WikiModeCopy.maintenanceNote)", "Text(WikiModeCopy.workspace)", "Text(WikiModeCopy.workspaceNote)",
                                 "Text(WikiModeCopy.provider)", "Text(WikiModeCopy.providerNote)", "WikiModeCopy.runsADay(",
                                 "Text(WikiModeCopy.dailyLimitNote)", "Picker(WikiModeCopy.lookback, selection: $choice.lookback)",
                                 "ForEach(WikiModeLogic.LookbackChoice.allCases", "if choice.lookback == .days {",
                                 "Text(WikiModeCopy.lookback)", "Text(WikiModeCopy.lookbackNote)"], "the native Set up form")
        assertSays(nativeForm, "Button(enabled ? WikiModeCopy.save : WikiModeCopy.turnOn)", in: "WikiSettingsView.swift")
        assertSays(nativeForm, "Stepper(value: $choice.dailyRunLimit, in: WikiMaintenanceSettings.dailyRunLimitRange)",
                   in: "WikiSettingsView.swift")
        assertSays(nativeForm, "Stepper(value: $choice.lookbackDays, in: 1...WikiMaintenanceSettings.lookbackDaysRange.upperBound)",
                   in: "WikiSettingsView.swift")
        // All of history goes out as null: a key left out would leave the look-back as it was.
        let screen = try slice(native, from: "struct WikiSettingsView: View {", to: "private func actions(")
        assertSays(screen, "lookbackDays: .some(WikiModeLogic.lookbackDays(choice.lookback, days: choice.lookbackDays))",
                   in: "WikiSettingsView.swift")
    }

    /// An entry a mode applied: Confirm, then Reject ▾ with the four reasons and where the reason goes,
    /// then the bar — before Details, at both ends.
    func testTheEntrysAnswersAndBarAreInTheSameOrder() throws {
        let drawer = try web(Self.drawer)
        assertOrder(drawer, ["<WikiEntryAnswers entry={data} />", "<>{WIKI_ACTION_EDIT}</>", "<WikiMarkBar entry={data} />",
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
        assertOrder(run, ["...WIKI_REJECT_MENU.map(({ reason, label }) => ({ key: reason, label }))", "{WIKI_REJECT_ON_RECORD}"],
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
        let confirm = try slice(run, from: "export function useRevertRun(", to: "onOk:")
        assertOrder(confirm, ["title: WIKI_REVERT_TITLE", "{wikiRevertBody(summary)}", "{WIKI_REVERT_KEEPS}",
                              "okText: WIKI_REVERT_RUN_CONFIRM", "okButtonProps: { danger: true }", "cancelText: WIKI_CANCEL"],
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

    /// The head's way into the settings: the web's Settings button beside New entry, the native gear.
    func testTheWikiHeadOpensTheSettings() throws {
        let page = try web(Self.page)
        assertOrder(page, ["<WikiSettingsButton spaceSlug={space.slug} />", "<WikiNewEntryButton spaceId={space.id} />"],
                    "the web head's actions")
        assertSays(page, "if (route === 'settings') return <WikiSettingsPage space={resolved} />;", in: Self.page)
        let view = try native("Views/WikiView.swift")
        let home = try slice(view, from: "struct WikiHomePage: View {", to: "private struct WikiRowLabel: View {")
        let toolbar = try slice(home, from: ".toolbar {", to: ".task(id: query) {")
        assertOrder(toolbar, ["Button(action: actions.openSettings)", "Image(systemName: \"gearshape\")",
                              ".accessibilityLabel(WikiModeCopy.settings)"], "the native gear")
        let screens = try native("Views/WikiScreens.swift")
        XCTAssertTrue(screens.contains("openSettings: { open(.wikiSettings) }"))
        XCTAssertTrue(screens.contains("openRun: { id in open(.wikiRun(changesetID: id)) }"))
        let shell = try native("Views/CompactShell.swift")
        XCTAssertTrue(shell.contains("case .wikiSettings:           WikiSettingsView()"))
        XCTAssertTrue(shell.contains("case .wikiRun(let changesetID): WikiRunView(changesetID: changesetID)"))
        let pane = try slice(screens, from: "struct WikiDetailPane: View {", to: "struct WikiEntryView: View {")
        assertOrder(pane, ["model.nav.wikiReviewOnTop", "model.nav.wikiSettingsOnTop", "WikiSettingsView()",
                           "model.nav.selectedWikiRunID", "WikiRunView(changesetID: run)"], "the wide shells' detail pane")
    }

    /// A challenge's line and answers at both ends: which anchor broke and how, then Re-confirm, Amend, Retire.
    func testAChallengeCardSaysWhatBrokeAndOffersTheThreeAnswers() throws {
        let review = try web(Self.review)
        let actions = try slice(review, from: ") : challenge ? (", to: ") : (")
        assertOrder(actions, ["action: 'reconfirm'", "{WIKI_RECONFIRM}", "setAmending(true)", "{WIKI_AMEND}",
                              "action: 'retire'", "{WIKI_RETIRE}", "{WIKI_CHALLENGE_WAITS}"], "the web's challenge answers")
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
