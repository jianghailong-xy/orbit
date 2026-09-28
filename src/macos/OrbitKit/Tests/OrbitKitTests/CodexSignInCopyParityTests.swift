import Foundation
import XCTest
@testable import OrbitKit

/// "Sign in with ChatGPT" and a Codex pool of one's own on iOS say what the web says. `CodexSignIn` and
/// `CodexLoginPool` carry the web dialog's and the web pool page's words over to the phone, and nothing
/// in either build notices a word changed at one end only — so each one is looked up in the web source
/// it came from. A sentence that names the pool, the account or a time is rendered with the web's own
/// expression in that place (`{pool.label}`, `${member.label}`, `{held.email}`), so the comparison is of
/// the whole sentence. A missing counterpart is a FAILURE, never an `XCTSkip`.
///
/// Deliberately not compared: "New pool" — a pool is made on the web (it opens straight to signing in),
/// as a shared pool's is; the words only a phone has to say (the swipe's own label is `Sign out`, the
/// web mark's name); and the sheet's layout, where the web's one line under the pool's name is the
/// phone's head plus the Account section's footer (both compared as that one line).
final class CodexSignInCopyParityTests: XCTestCase {

    private static let dialog = "src/web/src/components/CodexSignIn.tsx"
    private static let poolPage = "src/web/src/pages/ProviderPoolPage.tsx"
    private static let accountPools = "src/web/src/components/AccountPools.tsx"
    private static let codexLogin = "src/web/src/lib/codexLogin.ts"
    private static let providerPools = "src/web/src/lib/providerPools.ts"

    private enum ParityError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let file):
                return "\(file) was not found above this test file. \"Sign in with ChatGPT\" on iOS is one half of a "
                    + "pair; if the web half moved, move this check with it rather than deleting it."
            }
        }
    }

    /// The web file, with its string concatenations joined, JSX's `{' '}` read as the space it is, and
    /// every run of whitespace made one space: where a long sentence or a JSX text node breaks its line
    /// is layout, the words are the contract.
    private func web(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
                    .replacingOccurrences(of: "'\\s*\\+\\s*'", with: "", options: .regularExpression)
                    .replacingOccurrences(of: "\\{' '\\}\\s*", with: " ", options: .regularExpression)
                    .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            }
            dir = dir.deletingLastPathComponent()
        }
        throw ParityError.missing(relative)
    }

    private func assertSays(_ source: String, _ literal: String, in file: String,
                            file testFile: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(source.contains(literal), "\(file) no longer says \(literal)", file: testFile, line: line)
    }

    /// A pool whose name is the web's own expression for it.
    private func pool(_ label: String, login: CodexLogin? = nil) -> ProviderPool {
        ProviderPool(id: "p", slug: "p", label: label, engine: "codex", login: login)
    }

    private func account(email: String?, state: String = "SIGNED_OUT") -> CodexLogin {
        CodexLogin(state: state, email: email, plan: "plus", fingerprint: "…AB12")
    }

    /// What signing in means — the lead, the three things, and the warning — and its two presses.
    func testTheNoticeSaysWhatTheWebDialogSays() throws {
        let source = try web(Self.dialog)
        assertSays(source, "title=\"\(CodexSignIn.title)\"", in: Self.dialog)
        assertSays(source, "\(CodexSignIn.leadPrefix)<b>{pool.label}</b>\(CodexSignIn.leadSuffix)", in: Self.dialog)
        // Signing in again names the account OpenAI signed out — "this account" when it has no email.
        let held = account(email: "{held?.email ?? 'this account'}")
        assertSays(source, "\(CodexSignIn.againLeadPrefix(held))<b>{pool.label}</b>\(CodexSignIn.againLeadSuffix)",
                   in: Self.dialog)
        XCTAssertEqual(CodexSignIn.againLeadPrefix(account(email: nil)),
                       "OpenAI signed this account out. Sign in with it again to put it back in ")
        for fact in CodexSignIn.facts(pool("{pool.label}")) {
            assertSays(source, "<b>\(fact.lead)</b>\(fact.rest)", in: Self.dialog)
        }
        assertSays(source, "<b>\(CodexSignIn.risk.lead)</b>\(CodexSignIn.risk.rest)", in: Self.dialog)
        assertSays(source, "<Button onClick={close}>\(CodexSignIn.cancel)</Button>", in: Self.dialog)
        assertSays(source, "onClick={() => void start()}> \(CodexSignIn.start) </Button>", in: Self.dialog)
    }

    /// The code: the page to open, what to do there, the code and its copy press, the wait, the expiry.
    func testTheCodeStepSaysWhatTheWebDialogSays() throws {
        let source = try web(Self.dialog)
        assertSays(source, "> \(CodexSignIn.openPage) </Button>", in: Self.dialog)
        assertSays(source, "'\(CodexSignIn.enterCode)'", in: Self.dialog)
        assertSays(source, "\(CodexSignIn.enterCodeAsPrefix)<b>{held.email}</b>\(CodexSignIn.enterCodeAsSuffix)",
                   in: Self.dialog)
        assertSays(source, "tooltips: ['\(CodexSignIn.copyCode)', '\(CodexSignIn.copied)']", in: Self.dialog)
        assertSays(source, "<LoadingOutlined /> \(CodexSignIn.waiting)", in: Self.dialog)
        // The expiry is one sentence around a time, formatted alike at both ends (`formatResetTime`).
        let utc = TimeZone(identifier: "UTC")!
        let now = RelativeTime.parse("2026-09-28T12:00:00.000Z")!
        XCTAssertEqual(CodexSignIn.expiry("2026-09-28T12:15:00.000Z", now: now, timeZone: utc), "The code works until 12:15.")
        assertSays(source, "The code works until {formatResetTime(step.expiresAt)}.", in: Self.dialog)
    }

    /// How it ended: in, expired, stopped, the same account twice, another account.
    func testEachEndingSaysWhatTheWebDialogSays() throws {
        let source = try web(Self.dialog)
        let label = pool("{pool.label}")
        XCTAssertEqual(CodexSignIn.doneTitle(nil, pool: label), "Your ChatGPT account is in {pool.label}")
        assertSays(source, "{step.account ? loginName(step.account) : 'Your ChatGPT account'} is in {pool.label}",
                   in: Self.dialog)
        assertSays(source, CodexSignIn.doneDetail, in: Self.dialog)
        let signedIn = account(email: "e", state: "ACTIVE")
        XCTAssertTrue(CodexSignIn.doneRow(signedIn).hasSuffix(" · its sign-in stays on the Orbit server"))
        assertSays(source, "{loginLine(step.account)} · its sign-in stays on the Orbit server", in: Self.dialog)
        assertSays(source, "<Button type=\"primary\" onClick={close}> \(CodexSignIn.done) </Button>", in: Self.dialog)

        assertSays(source, "<div className=\"pa-done-t\">\(CodexSignIn.expiredTitle)</div>", in: Self.dialog)
        assertSays(source, "<div className=\"pa-done-s\">\(CodexSignIn.expiredDetail)</div>", in: Self.dialog)
        assertSays(source, "<div className=\"pa-done-t\">\(CodexSignIn.failedTitle)</div>", in: Self.dialog)
        assertSays(source, "<div className=\"pa-done-t\">\(CodexSignIn.duplicateTitle(label))</div>", in: Self.dialog)
        assertSays(source, "<div className=\"pa-done-s\">\(CodexSignIn.duplicateDetail)</div>", in: Self.dialog)
        assertSays(source, "<div className=\"pa-done-t\">\(CodexSignIn.takenTitle(label))</div>", in: Self.dialog)
        assertSays(source, CodexSignIn.takenDetail(account(email: "{held?.email ?? 'the account it runs on'}")),
                   in: Self.dialog)
        XCTAssertEqual(CodexSignIn.takenDetail(nil),
                       "Sign in as the account it runs on instead — or sign it out first to switch accounts.")
        assertSays(source, "<Button onClick={close}>\(CodexSignIn.close)</Button>", in: Self.dialog)
        assertSays(source, "{step.kind === 'failed' ? '\(CodexSignIn.tryAgain)' : '\(CodexSignIn.newCode)'}",
                   in: Self.dialog)
    }

    /// Why a sign-in stopped, when the server's answer is not a reason of its own: the same words.
    func testTheReasonsItGivesAreTheWebDialogs() throws {
        let source = try web(Self.dialog)
        for poll in [CodexLoginPoll(status: "CANCELLED"), CodexLoginPoll(status: "FAILED"), CodexLoginPoll(status: "NONE")] {
            guard case .failed(let reason) = CodexSignIn.step(after: poll) else {
                return XCTFail("\(poll.status) did not end the sign-in")
            }
            assertSays(source, "'\(reason)'", in: Self.dialog)
        }
        guard case .failed(let gone) = CodexSignIn.step(afterPollFailure: APIError.http(status: 404, body: nil)) else {
            return XCTFail("a pool that is gone did not end the sign-in")
        }
        assertSays(source, "'\(gone)'", in: Self.dialog)
        assertSays(source, "'\(CodexSignIn.duplicateCode)'", in: Self.dialog)
        assertSays(source, "'\(CodexSignIn.takenCode)'", in: Self.dialog)
    }

    /// The pool's page: what it is, its one press while it has no account, the Account card, the way out.
    func testThePoolPageSaysWhatTheWebPageSays() throws {
        let page = try web(Self.poolPage)
        let footer = CodexLoginPool.accountFooter.prefix(1).lowercased() + CodexLoginPool.accountFooter.dropFirst()
        assertSays(page, "\(CodexLoginPool.pageTitle) · \(CodexLoginPool.justMe) · \(footer)", in: Self.poolPage)
        assertSays(page, "> \(CodexLoginPool.signIn) </Button>", in: Self.poolPage)
        assertSays(page, "<span className=\"re-runner\">\(CodexLoginPool.accountHeader)</span>", in: Self.poolPage)
        assertSays(page, "const deleteNote = '\(CodexLoginPool.deleteNote)';", in: Self.poolPage)
        assertSays(page, "title={`\(CodexLoginPool.deleteTitle(pool("${pool.label}")))`}", in: Self.poolPage)
        assertSays(page, "okText=\"\(CodexLoginPool.delete)\"", in: Self.poolPage)
        assertSays(page, "> \(CodexLoginPool.deletePool) </Button>", in: Self.poolPage)
        XCTAssertEqual(CodexLoginPool.signedOut(nil), "The account is signed out")
        assertSays(page, "message.success(`${pool.login ? loginName(pool.login) : 'The account'} is signed out`)",
                   in: Self.poolPage)
    }

    /// The account's row and the card's head: its line, its windows, why it is out, and its two presses.
    func testTheAccountsRowSaysWhatTheWebRowSays() throws {
        let row = try web(Self.accountPools)
        assertSays(row, "<div className=\"pool-note\"> \(CodexLoginPool.noAccount) </div>", in: Self.accountPools)
        assertSays(row, "<span className=\"re-summary\">\(CodexLoginPool.justMe)</span>", in: Self.accountPools)
        assertSays(row, "<span className=\"re-quota-none\">\(CodexLoginPool.noQuota)</span>", in: Self.accountPools)
        assertSays(row, "resets {formatResetTime(row.window.resetsAt)}", in: Self.accountPools)
        assertSays(row, "<div className=\"pool-why\">\(CodexLoginPool.signedOutReason)</div>", in: Self.accountPools)
        assertSays(row, "> \(CodexLoginPool.signInAgain) </Button>", in: Self.accountPools)
        let signingOut = account(email: "${member.label}")
        assertSays(row, "title={`\(CodexLoginPool.signOutTitle(signingOut))`}", in: Self.accountPools)
        assertSays(row, "description=\"\(CodexLoginPool.signOutNote)\"", in: Self.accountPools)
        assertSays(row, "okText=\"\(CodexLoginPool.signOut)\"", in: Self.accountPools)
        // One account is named, not "next".
        assertSays(row, "{member.login ? member.label : `Next: ${member.label}`}", in: Self.accountPools)

        let lib = try web(Self.codexLogin)
        XCTAssertEqual(CodexLoginPool.line(account(email: "e")), "ChatGPT Plus · …AB12")
        assertSays(lib, "`${plan ? `ChatGPT ${plan}` : 'ChatGPT'} · ${login.fingerprint}`", in: Self.codexLogin)
        assertSays(lib, "login.email ?? '\(CodexLoginPool.name(account(email: nil)))'", in: Self.codexLogin)
        assertSays(lib, "unavailable: '\(CodexLoginPool.notSignedIn)'", in: Self.codexLogin)
        assertSays(lib, "state === 'SIGNED_OUT' ? '\(CodexLoginPool.signedOutWords)' : null", in: Self.codexLogin)

        let tags = try web(Self.providerPools)
        let out = PoolMember(id: "m", slug: "m", label: "m", state: .signedOut)
        XCTAssertEqual(ProviderPools.memberStatus(out), PoolStatus(label: "Signed out", tone: .danger))
        assertSays(tags, "return { label: '\(ProviderPools.memberStatus(out).label)', color: 'red' };", in: Self.providerPools)
    }
}
