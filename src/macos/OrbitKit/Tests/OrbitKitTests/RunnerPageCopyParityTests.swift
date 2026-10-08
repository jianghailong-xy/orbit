import Foundation
import XCTest
@testable import OrbitKit

/// The two clients say the same words about the same machine, and this is the tripwire that keeps
/// them saying them.
///
/// `RunnerPageCopy` is a hand-copy of the web's `src/web/src/lib/runnerCopy.ts`: the Runners list's
/// third line, a runner page's Needs Attention card and the web card are one sentence, and the Swift
/// client and the browser bundle share no compiler. runnerCopy.ts is written to be read as text (its
/// header says so, and its own spec holds it to the shape): one `export const X = '…'` per fixed
/// sentence, and one `export function` per sentence with values in it, whose body is a single
/// template literal. So this reads it as text, puts each `'…' + '…'` wrap back together, holds every
/// Swift constant to the web declaration of the same name, and renders every Swift template with
/// sentinel values to compare the whole sentence.
///
/// Names correspond one to one: a sentence added at one end and not the other fails here too.
/// Shaped after `EvidenceDecisionCopyParityTests`, including that a missing counterpart is a failure
/// and never an `XCTSkip`.
final class RunnerPageCopyParityTests: XCTestCase {

    private static let webCopy = "src/web/src/lib/runnerCopy.ts"
    private static let swiftCopy = "src/macos/OrbitKit/Sources/OrbitKit/App/RunnerPageCopy.swift"

    private enum ParityError: Error, CustomStringConvertible {
        case noRepo
        var description: String {
            "\(RunnerPageCopyParityTests.webCopy) was not found above this test file. OrbitKit's "
                + "RunnerPageCopy is one half of a pair; if the web half moved, move this check with "
                + "it rather than deleting it."
        }
    }

    /// The repo root, found by walking up from this file until the web copy is under foot.
    /// Not a fixed number of `..` hops: the depth of this file is not the thing being asserted.
    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.webCopy).path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        // Deliberately a failure and not an `XCTSkip`: a check that quietly opts out is a check
        // that reports green on exactly the day the thing it watches went missing.
        throw ParityError.noRepo
    }

    private func source(_ relative: String) throws -> String {
        try String(contentsOf: try repoRoot().appendingPathComponent(relative), encoding: .utf8)
    }

    /// runnerCopy.ts with its string literals put back together. A long sentence wraps as
    /// `'…' + '…'`, and a value may sit on the line under its `=`; where those wraps fall is a
    /// formatting decision while the words are the contract.
    private func flatWebCopy() throws -> String {
        try source(Self.webCopy)
            .replacingOccurrences(of: "'\\s*\\+\\s*'", with: "", options: .regularExpression)
            .replacingOccurrences(of: "=\\s*\\n\\s*'", with: "= '", options: .regularExpression)
    }

    /// Every match of `pattern`, as its capture groups, in source order.
    private func captures(_ source: String, _ pattern: String) throws -> [[String]] {
        let re = try NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines])
        return re.matches(in: source, range: NSRange(source.startIndex..., in: source)).map { match in
            (1..<match.numberOfRanges).map { index in
                Range(match.range(at: index), in: source).map { String(source[$0]) } ?? ""
            }
        }
    }

    /// Every `export const NAME = '…';` the web file declares, by name.
    private func webConstants() throws -> [String: String] {
        let found = try captures(try flatWebCopy(), "^export const ([A-Z0-9_]+) = '([^'\\n]*)';$")
        return Dictionary(found.map { ($0[0], $0[1]) }, uniquingKeysWith: { first, _ in first })
    }

    /// Every `export function name(…): string { return `…`; }`, by name: the whole template.
    private func webTemplates() throws -> [String: String] {
        let found = try captures(try flatWebCopy(),
                                 "^export function (\\w+)\\([^)]*\\): string \\{\\n  return `([^`]*)`;\\n\\}$")
        return Dictionary(found.map { ($0[0], $0[1]) }, uniquingKeysWith: { first, _ in first })
    }

    // MARK: this end

    private static let constants: [(name: String, value: String)] = [
        ("RUNNER_ONLINE", RunnerPageCopy.RUNNER_ONLINE),
        ("RUNNER_OFFLINE", RunnerPageCopy.RUNNER_OFFLINE),
        ("RUNNER_LINE_SEPARATOR", RunnerPageCopy.RUNNER_LINE_SEPARATOR),
        ("RUNNER_ADD", RunnerPageCopy.RUNNER_ADD),
        ("RUNNER_ADD_FOOTER", RunnerPageCopy.RUNNER_ADD_FOOTER),
        ("RUNNER_NEEDS_ATTENTION", RunnerPageCopy.RUNNER_NEEDS_ATTENTION),
        ("RUNNER_CAPACITY", RunnerPageCopy.RUNNER_CAPACITY),
        ("RUNNER_ENGINES", RunnerPageCopy.RUNNER_ENGINES),
        ("RUNNER_WORKSPACES", RunnerPageCopy.RUNNER_WORKSPACES),
        ("RUNNER_ABOUT", RunnerPageCopy.RUNNER_ABOUT),
        ("RUNNER_MAX_CONCURRENT", RunnerPageCopy.RUNNER_MAX_CONCURRENT),
        ("RUNNER_DISK", RunnerPageCopy.RUNNER_DISK),
        ("RUNNER_KEEP_FREE", RunnerPageCopy.RUNNER_KEEP_FREE),
        ("RUNNER_KEEP_FREE_OFF", RunnerPageCopy.RUNNER_KEEP_FREE_OFF),
        ("RUNNER_KEEP_FREE_10_GB", RunnerPageCopy.RUNNER_KEEP_FREE_10_GB),
        ("RUNNER_KEEP_FREE_20_GB", RunnerPageCopy.RUNNER_KEEP_FREE_20_GB),
        ("RUNNER_KEEP_FREE_50_GB", RunnerPageCopy.RUNNER_KEEP_FREE_50_GB),
        ("RUNNER_CAPACITY_FOOTER", RunnerPageCopy.RUNNER_CAPACITY_FOOTER),
        ("RUNNER_ENGINE_SIGNED_IN", RunnerPageCopy.RUNNER_ENGINE_SIGNED_IN),
        ("RUNNER_ENGINE_SIGNED_OUT", RunnerPageCopy.RUNNER_ENGINE_SIGNED_OUT),
        ("RUNNER_ENGINE_NOT_INSTALLED", RunnerPageCopy.RUNNER_ENGINE_NOT_INSTALLED),
        ("RUNNER_ENGINE_UP_TO_DATE", RunnerPageCopy.RUNNER_ENGINE_UP_TO_DATE),
        ("RUNNER_ENGINE_NO_QUOTA", RunnerPageCopy.RUNNER_ENGINE_NO_QUOTA),
        ("RUNNER_SIGN_IN", RunnerPageCopy.RUNNER_SIGN_IN),
        ("RUNNER_UPDATE_ENGINES_NOW", RunnerPageCopy.RUNNER_UPDATE_ENGINES_NOW),
        ("RUNNER_REFRESH_MODEL_LISTS", RunnerPageCopy.RUNNER_REFRESH_MODEL_LISTS),
        ("RUNNER_ENGINES_FOOTER", RunnerPageCopy.RUNNER_ENGINES_FOOTER),
        ("RUNNER_ENGINES_OFFLINE_FOOTER", RunnerPageCopy.RUNNER_ENGINES_OFFLINE_FOOTER),
        ("RUNNER_ENGINE_RENEW", RunnerPageCopy.RUNNER_ENGINE_RENEW),
        ("RUNNER_ENGINE_ACCOUNT_SIGNED_OUT_NOTE", RunnerPageCopy.RUNNER_ENGINE_ACCOUNT_SIGNED_OUT_NOTE),
        ("RUNNER_WORKSPACE_WORKTREES", RunnerPageCopy.RUNNER_WORKSPACE_WORKTREES),
        ("RUNNER_WORKSPACES_FOOTER", RunnerPageCopy.RUNNER_WORKSPACES_FOOTER),
        ("RUNNER_ABOUT_NAME", RunnerPageCopy.RUNNER_ABOUT_NAME),
        ("RUNNER_ABOUT_HOSTNAME", RunnerPageCopy.RUNNER_ABOUT_HOSTNAME),
        ("RUNNER_ABOUT_VERSION", RunnerPageCopy.RUNNER_ABOUT_VERSION),
        ("RUNNER_ABOUT_RUNS_AS", RunnerPageCopy.RUNNER_ABOUT_RUNS_AS),
        ("RUNNER_ABOUT_REPOS_FOLDER", RunnerPageCopy.RUNNER_ABOUT_REPOS_FOLDER),
        ("RUNNER_ABOUT_LAST_CHECK_IN", RunnerPageCopy.RUNNER_ABOUT_LAST_CHECK_IN),
        ("RUNNER_ABOUT_REGISTERED", RunnerPageCopy.RUNNER_ABOUT_REGISTERED),
        ("RUNNER_ABOUT_LAST_UPDATE", RunnerPageCopy.RUNNER_ABOUT_LAST_UPDATE),
        ("RUNNER_VERSION_LATEST", RunnerPageCopy.RUNNER_VERSION_LATEST),
        ("RUNNER_VERSION_INSTALLS_WHEN_IDLE", RunnerPageCopy.RUNNER_VERSION_INSTALLS_WHEN_IDLE),
        ("RUNNER_VERSION_NOT_ROLLED_OUT", RunnerPageCopy.RUNNER_VERSION_NOT_ROLLED_OUT),
        ("RUNNER_RUNS_AS_ROOT", RunnerPageCopy.RUNNER_RUNS_AS_ROOT),
        ("RUNNER_RUNS_AS_REGULAR_USER", RunnerPageCopy.RUNNER_RUNS_AS_REGULAR_USER),
        ("RUNNER_ROOT_NO_BYPASS", RunnerPageCopy.RUNNER_ROOT_NO_BYPASS),
        ("RUNNER_ROTATE_TOKEN", RunnerPageCopy.RUNNER_ROTATE_TOKEN),
        ("RUNNER_ROTATE_TOKEN_FOOTER", RunnerPageCopy.RUNNER_ROTATE_TOKEN_FOOTER),
        ("RUNNER_REMOVE", RunnerPageCopy.RUNNER_REMOVE),
        ("RUNNER_REMOVE_FOOTER", RunnerPageCopy.RUNNER_REMOVE_FOOTER),
        ("RUNNER_ADD_LEAD", RunnerPageCopy.RUNNER_ADD_LEAD),
        ("RUNNER_PLATFORM_MACOS", RunnerPageCopy.RUNNER_PLATFORM_MACOS),
        ("RUNNER_PLATFORM_LINUX", RunnerPageCopy.RUNNER_PLATFORM_LINUX),
        ("RUNNER_PLATFORM_WINDOWS", RunnerPageCopy.RUNNER_PLATFORM_WINDOWS),
        ("RUNNER_COPY", RunnerPageCopy.RUNNER_COPY),
        ("RUNNER_SHARE", RunnerPageCopy.RUNNER_SHARE),
        ("RUNNER_WAITING_FOR_NEW", RunnerPageCopy.RUNNER_WAITING_FOR_NEW),
        ("RUNNER_NO_BROWSER", RunnerPageCopy.RUNNER_NO_BROWSER),
        ("RUNNER_DEVICE_CODE", RunnerPageCopy.RUNNER_DEVICE_CODE),
        ("RUNNER_DEVICE_CODE_PLACEHOLDER", RunnerPageCopy.RUNNER_DEVICE_CODE_PLACEHOLDER),
        ("RUNNER_DEVICE_CODE_FOOTER", RunnerPageCopy.RUNNER_DEVICE_CODE_FOOTER),
        ("RUNNER_APPROVE", RunnerPageCopy.RUNNER_APPROVE),
        ("RUNNER_LOGIN_CLAUDE", RunnerPageCopy.RUNNER_LOGIN_CLAUDE),
        ("RUNNER_LOGIN_CODEX", RunnerPageCopy.RUNNER_LOGIN_CODEX),
        ("RUNNER_LOGIN_KIMI", RunnerPageCopy.RUNNER_LOGIN_KIMI),
        ("RUNNER_UNIT_MINUTE", RunnerPageCopy.RUNNER_UNIT_MINUTE),
        ("RUNNER_UNIT_MINUTES", RunnerPageCopy.RUNNER_UNIT_MINUTES),
        ("RUNNER_UNIT_HOUR", RunnerPageCopy.RUNNER_UNIT_HOUR),
        ("RUNNER_UNIT_HOURS", RunnerPageCopy.RUNNER_UNIT_HOURS),
        ("RUNNER_UNIT_DAY", RunnerPageCopy.RUNNER_UNIT_DAY),
        ("RUNNER_UNIT_DAYS", RunnerPageCopy.RUNNER_UNIT_DAYS),
        ("ATTENTION_NEVER_CHECKED_IN", RunnerPageCopy.ATTENTION_NEVER_CHECKED_IN),
        ("ATTENTION_OFFLINE_ONE_SESSION_WAITS", RunnerPageCopy.ATTENTION_OFFLINE_ONE_SESSION_WAITS),
        ("ATTENTION_OFFLINE_WAKE", RunnerPageCopy.ATTENTION_OFFLINE_WAKE),
        ("RUNNER_REPAIR", RunnerPageCopy.RUNNER_REPAIR),
        ("RUNNER_GIT_MERGE", RunnerPageCopy.RUNNER_GIT_MERGE),
        ("RUNNER_GIT_REBASE", RunnerPageCopy.RUNNER_GIT_REBASE),
        ("RUNNER_GIT_CHERRY_PICK", RunnerPageCopy.RUNNER_GIT_CHERRY_PICK),
        ("RUNNER_GIT_REVERT", RunnerPageCopy.RUNNER_GIT_REVERT),
        ("RUNNER_GIT_CONFLICT", RunnerPageCopy.RUNNER_GIT_CONFLICT),
        ("ATTENTION_CHECKOUT_DETAIL", RunnerPageCopy.ATTENTION_CHECKOUT_DETAIL),
        ("RUNNER_QUOTA_FIVE_HOUR", RunnerPageCopy.RUNNER_QUOTA_FIVE_HOUR),
        ("RUNNER_QUOTA_DAILY", RunnerPageCopy.RUNNER_QUOTA_DAILY),
        ("RUNNER_QUOTA_WEEKLY", RunnerPageCopy.RUNNER_QUOTA_WEEKLY),
        ("RUNNER_QUOTA_WEEKLY_OPUS", RunnerPageCopy.RUNNER_QUOTA_WEEKLY_OPUS),
        ("RUNNER_QUOTA_WEEKLY_SONNET", RunnerPageCopy.RUNNER_QUOTA_WEEKLY_SONNET),
        ("RUNNER_QUOTA_MONTHLY", RunnerPageCopy.RUNNER_QUOTA_MONTHLY),
        ("RUNNER_QUOTA_ANNUAL", RunnerPageCopy.RUNNER_QUOTA_ANNUAL),
        ("RUNNER_QUOTA_OTHER", RunnerPageCopy.RUNNER_QUOTA_OTHER),
        ("RUNNER_SET_A_RESERVE", RunnerPageCopy.RUNNER_SET_A_RESERVE),
        ("ATTENTION_CANT_UPDATE_ITSELF", RunnerPageCopy.ATTENTION_CANT_UPDATE_ITSELF),
        ("RUNNER_COPY_COMMAND", RunnerPageCopy.RUNNER_COPY_COMMAND),
        ("RUNNER_UPGRADE_COMMAND", RunnerPageCopy.RUNNER_UPGRADE_COMMAND),
        ("ATTENTION_INSTALL_FOLDER_NOT_WRITABLE", RunnerPageCopy.ATTENTION_INSTALL_FOLDER_NOT_WRITABLE),
        ("RUNNER_INSTALL_FOLDER", RunnerPageCopy.RUNNER_INSTALL_FOLDER),
        ("ATTENTION_UPDATES_TURNED_OFF", RunnerPageCopy.ATTENTION_UPDATES_TURNED_OFF),
        ("ATTENTION_UPDATER_OFF", RunnerPageCopy.ATTENTION_UPDATER_OFF),
        ("ATTENTION_UPDATES_TURN_ON", RunnerPageCopy.ATTENTION_UPDATES_TURN_ON),
        ("ATTENTION_RUNNER_UPDATE_FAILED", RunnerPageCopy.ATTENTION_RUNNER_UPDATE_FAILED),
        ("ATTENTION_UPDATE_DIDNT_GO_THROUGH", RunnerPageCopy.ATTENTION_UPDATE_DIDNT_GO_THROUGH),
        ("RUNNER_UPDATE_RUNNER_NOW", RunnerPageCopy.RUNNER_UPDATE_RUNNER_NOW),
        ("RUNNER_UPDATE_RUNNER_REQUESTED", RunnerPageCopy.RUNNER_UPDATE_RUNNER_REQUESTED),
    ]

    /// A rendered line with each number sentinel put back as the web's interpolation of it.
    private static func put(_ rendered: String, _ numbers: [Int: String]) -> String {
        numbers.reduce(rendered) { line, pair in
            line.replacingOccurrences(of: String(pair.key), with: "${\(pair.value)}")
        }
    }

    /// This end's templates, rendered so the web's own interpolations come out: a string parameter is
    /// handed `${name}` itself, and a number a sentinel no sentence contains, put back as `${name}`
    /// afterwards — so the whole sentence is compared, and not only the words around a value.
    private static let templates: [(name: String, rendered: String)] = [
        ("runnerOfflineLastSeen", RunnerPageCopy.runnerOfflineLastSeen(when: "${when}")),
        ("runnerVersionTag", RunnerPageCopy.runnerVersionTag(version: "${version}")),
        ("runnerRunningOf", put(RunnerPageCopy.runnerRunningOf(active: 90_001, max: 90_002),
                                [90_001: "active", 90_002: "max"])),
        ("runnerSlots", put(RunnerPageCopy.runnerSlots(active: 90_001, max: 90_002),
                            [90_001: "active", 90_002: "max"])),
        ("runnerGb", RunnerPageCopy.runnerGb(amount: "${amount}")),
        ("runnerDiskUsed", RunnerPageCopy.runnerDiskUsed(used: "${used}", total: "${total}")),
        ("runnerEnginesChecked", RunnerPageCopy.runnerEnginesChecked(when: "${when}")),
        ("runnerEnginesReported", RunnerPageCopy.runnerEnginesReported(when: "${when}")),
        ("runnerEngineAccountsSignedIn", put(RunnerPageCopy.runnerEngineAccountsSignedIn(count: 90_001),
                                             [90_001: "count"])),
        ("runnerEngineNext", RunnerPageCopy.runnerEngineNext(account: "${account}")),
        ("runnerEngineLoginExpires", put(RunnerPageCopy.runnerEngineLoginExpires(count: 90_001, unit: "${unit}"),
                                         [90_001: "count"])),
        ("runnerEngineSignedOutAlone", RunnerPageCopy.runnerEngineSignedOutAlone(engine: "${engine}")),
        ("runnerEngineUpdateFailed", RunnerPageCopy.runnerEngineUpdateFailed(version: "${version}",
                                                                             when: "${when}")),
        ("runnerWorkspaceRunning", put(RunnerPageCopy.runnerWorkspaceRunning(count: 90_001),
                                       [90_001: "count"])),
        ("runnerInstallCommandUnix", RunnerPageCopy.runnerInstallCommandUnix(origin: "${origin}")),
        ("runnerInstallCommandWindows", RunnerPageCopy.runnerInstallCommandWindows(origin: "${origin}")),
        ("runnerNamesTwo", RunnerPageCopy.runnerNamesTwo(first: "${first}", second: "${second}")),
        ("runnerNamesMore", put(RunnerPageCopy.runnerNamesMore(first: "${first}", others: 90_001),
                                [90_001: "others"])),
        ("attentionOfflineFor", put(RunnerPageCopy.attentionOfflineFor(count: 90_001, unit: "${unit}"),
                                    [90_001: "count"])),
        ("attentionOfflineSessionsWait", put(RunnerPageCopy.attentionOfflineSessionsWait(count: 90_001),
                                             [90_001: "count"])),
        ("attentionSignedOutShort", RunnerPageCopy.attentionSignedOutShort(engine: "${engine}")),
        ("attentionSignedOutTitle", RunnerPageCopy.attentionSignedOutTitle(engine: "${engine}")),
        ("attentionSignedOutDetail", RunnerPageCopy.attentionSignedOutDetail(workspace: "${workspace}",
                                                                             engine: "${engine}")),
        ("attentionSignedOutDetailMany",
         RunnerPageCopy.attentionSignedOutDetailMany(workspaces: "${workspaces}", engine: "${engine}")),
        ("attentionCheckoutStuck", RunnerPageCopy.attentionCheckoutStuck(workspace: "${workspace}",
                                                                         operation: "${operation}")),
        ("attentionQuotaShort", put(RunnerPageCopy.attentionQuotaShort(engine: "${engine}", window: "${window}",
                                                                       percent: 90_001),
                                    [90_001: "percent"])),
        ("attentionQuotaTitle", put(RunnerPageCopy.attentionQuotaTitle(engine: "${engine}", window: "${window}",
                                                                       percent: 90_001),
                                    [90_001: "percent"])),
        ("attentionQuotaResets", RunnerPageCopy.attentionQuotaResets(when: "${when}")),
        ("attentionQuotaDetail", RunnerPageCopy.attentionQuotaDetail(workspace: "${workspace}",
                                                                     engine: "${engine}")),
        ("attentionQuotaDetailMany", RunnerPageCopy.attentionQuotaDetailMany(workspaces: "${workspaces}",
                                                                             engine: "${engine}")),
        ("attentionDiskFull", put(RunnerPageCopy.attentionDiskFull(percent: 90_001), [90_001: "percent"])),
        ("attentionDiskNoReserve", RunnerPageCopy.attentionDiskNoReserve(free: "${free}", total: "${total}")),
        ("attentionDiskBelowReserve", RunnerPageCopy.attentionDiskBelowReserve(free: "${free}", total: "${total}",
                                                                               reserve: "${reserve}")),
        ("attentionCantUpdateItselfDetail",
         RunnerPageCopy.attentionCantUpdateItselfDetail(version: "${version}", latest: "${latest}",
                                                        command: "${command}")),
        ("runnerUpdatedFromTo", RunnerPageCopy.runnerUpdatedFromTo(from: "${from}", to: "${to}")),
        ("attentionInstallFolderNotWritableDetail",
         RunnerPageCopy.attentionInstallFolderNotWritableDetail(folder: "${folder}", version: "${version}",
                                                                latest: "${latest}", command: "${command}")),
        ("attentionUpdatesTurnedOffDetail",
         RunnerPageCopy.attentionUpdatesTurnedOffDetail(reason: "${reason}", version: "${version}",
                                                        latest: "${latest}")),
        ("attentionRunnerUpdateFailedDetail",
         RunnerPageCopy.attentionRunnerUpdateFailedDetail(reason: "${reason}", version: "${version}",
                                                          latest: "${latest}")),
        ("attentionEngineUpdateFailed", RunnerPageCopy.attentionEngineUpdateFailed(engine: "${engine}")),
        ("attentionEngineUpdateDetail", RunnerPageCopy.attentionEngineUpdateDetail(note: "${note}")),
    ]

    // MARK: the words

    func testEveryConstantIsTheWebDeclarationOfTheSameName() throws {
        let web = try flatWebCopy()
        for (name, value) in Self.constants {
            XCTAssertTrue(web.contains("export const \(name) = '\(value)';"),
                          "\(name) drifted: runnerCopy.ts no longer declares it as \(value.debugDescription)")
        }
    }

    func testEveryTemplateIsTheWebTemplateWordForWord() throws {
        let web = try webTemplates()
        for (name, rendered) in Self.templates {
            XCTAssertEqual(web[name], rendered, "\(name) drifted from runnerCopy.ts's template")
        }
    }

    // MARK: the names

    /// Every sentence at either end has its counterpart under the same name. A declaration this check
    /// cannot read is named too, rather than being passed over as though it were not there.
    func testBothEndsDeclareTheSameSentencesUnderTheSameNames() throws {
        let raw = try source(Self.webCopy)
        let webConstants = try webConstants()
        let webTemplates = try webTemplates()
        XCTAssertEqual(webConstants.count, try captures(raw, "^export const (\\w+)").count,
                       "runnerCopy.ts declares a constant this check cannot read — keep each fixed "
                           + "sentence one single-quoted `export const`")
        XCTAssertEqual(webTemplates.count, try captures(raw, "^export function (\\w+)").count,
                       "runnerCopy.ts declares a function this check cannot read — keep each one a "
                           + "single `return` of one template literal")

        let swift = try source(Self.swiftCopy)
        let swiftConstants = Set(try captures(swift, "static let (\\w+)").map { $0[0] })
        let swiftTemplates = Set(try captures(swift, "static func (\\w+)").map { $0[0] })
        let tableConstants = Set(Self.constants.map(\.name))
        let tableTemplates = Set(Self.templates.map(\.name))

        XCTAssertEqual(tableConstants.count, Self.constants.count, "a constant is listed twice above")
        XCTAssertEqual(tableTemplates.count, Self.templates.count, "a template is listed twice above")
        for name in Set(webConstants.keys).subtracting(swiftConstants).sorted() {
            XCTFail("runnerCopy.ts declares \(name), which RunnerPageCopy does not")
        }
        for name in swiftConstants.subtracting(webConstants.keys).sorted() {
            XCTFail("RunnerPageCopy declares \(name), which runnerCopy.ts does not")
        }
        for name in Set(webTemplates.keys).subtracting(swiftTemplates).sorted() {
            XCTFail("runnerCopy.ts writes \(name)(…), which RunnerPageCopy does not")
        }
        for name in swiftTemplates.subtracting(webTemplates.keys).sorted() {
            XCTFail("RunnerPageCopy writes \(name)(…), which runnerCopy.ts does not")
        }
        XCTAssertEqual(tableConstants, swiftConstants, "list every RunnerPageCopy constant above")
        XCTAssertEqual(tableTemplates, swiftTemplates, "list every RunnerPageCopy template above")
    }
}
