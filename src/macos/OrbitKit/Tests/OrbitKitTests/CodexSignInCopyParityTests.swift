import Foundation
import XCTest
@testable import OrbitKit

/// "Sign in with ChatGPT" and a Codex pool of one's own on iOS say what the web says. `CodexSignIn` and
/// `CodexLoginPool` carry the web dialog's and the web pool page's words over to the phone, and nothing
/// in either build notices a word changed at one end only — so each one is looked up in the web source
/// it came from. A sentence that names the pool, the account, a count or a time is rendered with the
/// web's own expression in that place (`{pool.label}`, `${member.label}`, `{held.email}`, `{accounts}
/// account{accounts === 1 ? '' : 's'}`), so the comparison is of the whole sentence. A missing
/// counterpart is a FAILURE, never an `XCTSkip`.
///
/// Deliberately not compared: "New pool" — a pool is made on the web (it opens straight to signing in),
/// as a shared pool's is; the words only a phone has to say (the swipe's own label is `Sign out`, the
/// web mark's name); and the page the accounts are drawn on, whose words — its head, its way out, who can
/// use it — are `PoolAccessCopyParityTests`'.
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

    /// A sentence this client renders for `rendered`, with that text swapped for the web's expression in
    /// its place — a count and its plural, say — so the whole sentence can be looked up in the web source.
    private func asWeb(_ sentence: String, _ rendered: String, _ expression: String,
                       file: StaticString = #filePath, line: UInt = #line) -> String {
        XCTAssertTrue(sentence.contains(rendered), "\(sentence) does not say \(rendered)", file: file, line: line)
        return sentence.replacingOccurrences(of: rendered, with: expression)
    }

    /// A pool whose name is the web's own expression for it, holding `accounts` ChatGPT accounts.
    private func pool(_ label: String, accounts: Int = 0) -> ProviderPool {
        codexPool(label, (0..<accounts).map { CodexLogin(email: "a\($0)@example.com", fingerprint: "…000\($0)") })
    }

    /// A Codex pool of one's own as the decoder draws it: each account it holds one of its members.
    private func codexPool(_ label: String, _ logins: [CodexLogin]) -> ProviderPool {
        let drawn = CodexLoginPool.drawn(slug: "p", logins: logins)
        return ProviderPool(id: "p", slug: "p", label: label, resetsAt: drawn.resetsAt, unavailable: drawn.unavailable,
                            members: drawn.members, engine: "codex", login: logins.first, logins: logins)
    }

    private func account(email: String?, state: String = "SIGNED_OUT") -> CodexLogin {
        CodexLogin(state: state, email: email, plan: "plus", fingerprint: "…AB12")
    }

    /// What signing in means — the lead, the three things, and the warning — and its two presses: for the
    /// pool's first account, and for one OpenAI signed out going back in.
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
        // The press gets the one-time code: the sign-in itself finishes on OpenAI's page.
        assertSays(source, "onClick={() => void start()}> \(CodexSignIn.start) </Button>", in: Self.dialog)
    }

    /// Adding one more account to a pool that runs on some already: a notice of its own — what the pool
    /// runs on now, that the account stays its owner's alone even once the pool is shared, what the pool
    /// does without it — and its warning. The web shows it on exactly the condition this client does.
    func testTheNoticeForAnotherAccountSaysWhatTheWebDialogSays() throws {
        let source = try web(Self.dialog)
        assertSays(source, "step.kind === 'consent' && !again && accounts > 0 &&", in: Self.dialog)
        assertSays(source, "const again = held !== null;", in: Self.dialog)
        assertSays(source, "const accounts = poolLogins(pool).length;", in: Self.dialog)
        XCTAssertFalse(CodexSignIn.addsAnother(pool("P"), again: nil), "a pool with no account signs in its first")
        XCTAssertTrue(CodexSignIn.addsAnother(pool("P", accounts: 1), again: nil))
        XCTAssertFalse(CodexSignIn.addsAnother(pool("P", accounts: 1), again: account(email: "e")),
                       "an account going back in is not one more")

        let two = pool("{pool.label}", accounts: 2)
        XCTAssertEqual(CodexSignIn.anotherLeadSuffix(pool("P", accounts: 1)), ". It runs on 1 account now.")
        let lead = CodexSignIn.anotherLeadPrefix + "<b>{pool.label}</b>" + CodexSignIn.anotherLeadSuffix(two)
        assertSays(source, asWeb(lead, "2 accounts", "{accounts} account{accounts === 1 ? '' : 's'}"), in: Self.dialog)
        for fact in CodexSignIn.anotherFacts(two) {
            assertSays(source, "<b>\(fact.lead)</b>\(fact.rest)", in: Self.dialog)
        }
        assertSays(source, "<b>\(CodexSignIn.anotherRisk.lead)</b>\(CodexSignIn.anotherRisk.rest)", in: Self.dialog)
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

    /// How it ended: in — and how many accounts the pool holds now — expired, stopped, or the same
    /// account twice, which names it when the server does and offers a new code for a different one.
    func testEachEndingSaysWhatTheWebDialogSays() throws {
        let source = try web(Self.dialog)
        let label = pool("{pool.label}")
        XCTAssertEqual(CodexSignIn.doneTitle(nil, pool: label), "Your ChatGPT account is in {pool.label}")
        assertSays(source, "{step.account ? loginName(step.account) : 'Your ChatGPT account'} is in {pool.label}",
                   in: Self.dialog)
        let signedIn = account(email: "e", state: "ACTIVE")
        XCTAssertEqual(CodexSignIn.doneDetail(label, logins: [signedIn]),
                       "{pool.label} has 1 account now. A session moves to this one when the account it’s on runs out.")
        assertSays(source, asWeb(CodexSignIn.doneDetail(label, logins: [signedIn, signedIn]), "2 accounts",
                                 "{step.logins.length} account{step.logins.length === 1 ? '' : 's'}"),
                   in: Self.dialog)
        XCTAssertTrue(CodexSignIn.doneRow(signedIn).hasSuffix(" · its sign-in stays on the Orbit server"))
        assertSays(source, "{loginLine(step.account)} · its sign-in stays on the Orbit server", in: Self.dialog)
        assertSays(source, "<Button type=\"primary\" onClick={close}> \(CodexSignIn.done) </Button>", in: Self.dialog)

        assertSays(source, "<div className=\"pa-done-t\">\(CodexSignIn.expiredTitle)</div>", in: Self.dialog)
        assertSays(source, "<div className=\"pa-done-s\">\(CodexSignIn.expiredDetail)</div>", in: Self.dialog)
        assertSays(source, "<div className=\"pa-done-t\">\(CodexSignIn.failedTitle)</div>", in: Self.dialog)
        assertSays(source, "<div className=\"pa-done-t\">\(CodexSignIn.duplicateTitle(label))</div>", in: Self.dialog)
        assertSays(source, "`\(CodexSignIn.duplicateDetail("${step.email}"))`", in: Self.dialog)
        assertSays(source, "'\(CodexSignIn.duplicateDetail(nil))'", in: Self.dialog)
        assertSays(source, "<Button onClick={close}>\(CodexSignIn.close)</Button>", in: Self.dialog)
        assertSays(source, "{step.kind === 'failed' ? '\(CodexSignIn.tryAgain)' : '\(CodexSignIn.newCode)'}",
                   in: Self.dialog)
    }

    /// Why a sign-in stopped, when the server's answer is not a reason of its own: the same words. The one
    /// refusal with a step of its own is the same account twice, read with the account it names; another
    /// account no longer is one — the server lets a pool hold several — and neither end reads it.
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
        assertSays(source, "const email = e.body?.email;", in: Self.dialog)
        XCTAssertFalse(source.contains("POOL_CODEX_ACCOUNT_TAKEN"),
                       "\(Self.dialog) reads POOL_CODEX_ACCOUNT_TAKEN again — so should CodexSignIn")
    }

    /// The pool's page, signing one of its accounts out: the account it signs out is named — by its
    /// fingerprint to the server, by its email here.
    func testThePoolPageSaysWhatTheWebPageSays() throws {
        let page = try web(Self.poolPage)
        assertSays(page, "message.success(`\(CodexLoginPool.signedOut(account(email: "${loginName(login)}")))`)",
                   in: Self.poolPage)
        assertSays(page, "/account?fingerprint=${encodeURIComponent(login.fingerprint)}", in: Self.poolPage)
    }

    /// An account's row and the card's head: its line, its windows, why it is out, its two presses, the
    /// NEXT mark only among several, and what signing it out leaves running.
    func testTheAccountsRowSaysWhatTheWebRowSays() throws {
        let row = try web(Self.accountPools)
        assertSays(row, "<div className=\"pool-note\"> \(CodexLoginPool.noAccount) </div>", in: Self.accountPools)
        assertSays(row, "<span className=\"re-summary\">\(CodexPoolPage.justMe) · {availabilityOf(pool, refusals)}</span>",
                   in: Self.accountPools)
        XCTAssertEqual(ProvidersOverview.codexPoolLine(pool("P", accounts: 2)), "Just me · 2 of 2 accounts available")
        assertSays(row, "<span className=\"re-quota-none\">\(CodexLoginPool.noQuota)</span>", in: Self.accountPools)
        assertSays(row, "resets {formatResetTime(row.window.resetsAt)}", in: Self.accountPools)
        // Why it is out, and the way back — to the pool's owner, whose the sign-in is; one of the people
        // they added reads that only its owner can.
        assertSays(row, "<div className=\"pool-why\"> {onSignIn ? '\(CodexLoginPool.signedOutReason)' : '\(CodexLoginPool.signedOutReasonMember)'} </div>",
                   in: Self.accountPools)
        assertSays(row, "> \(CodexLoginPool.signInAgain) </Button>", in: Self.accountPools)
        let signingOut = account(email: "${member.label}")
        assertSays(row, "title={`\(CodexLoginPool.signOutTitle(signingOut))`}", in: Self.accountPools)
        assertSays(row, "aria-label={`\(CodexLoginPool.signOutLabel(signingOut))`}", in: Self.accountPools)
        assertSays(row, "okText=\"\(CodexLoginPool.signOut)\"", in: Self.accountPools)
        // Signing one out: the only account, and nothing runs on the pool; one of several, and it keeps
        // running on the others — "account" for one left, "accounts" for more.
        let one = CodexLoginPool.signOutNote(pool("${pool.label}", accounts: 1))
        assertSays(row, ": '\(one)'", in: Self.accountPools)
        XCTAssertTrue(CodexLoginPool.signOutNote(pool("${pool.label}", accounts: 2)).hasSuffix("its other account."))
        let several = CodexLoginPool.signOutNote(pool("${pool.label}", accounts: 3))
        assertSays(row, "? `" + asWeb(several, "accounts.", "account${others === 1 ? '' : 's'}.") + "`", in: Self.accountPools)
        // NEXT only where there is something to choose between.
        assertSays(row, "{member.next && pool.members.length > 1 && <span className=\"re-chip\">\(SharedPoolPage.nextChip)</span>}",
                   in: Self.accountPools)

        let lib = try web(Self.codexLogin)
        XCTAssertEqual(CodexLoginPool.line(account(email: "e")), "ChatGPT Plus · …AB12")
        assertSays(lib, "`${plan ? `ChatGPT ${plan}` : 'ChatGPT'} · ${login.fingerprint}`", in: Self.codexLogin)
        assertSays(lib, "login.email ?? '\(CodexLoginPool.name(account(email: nil)))'", in: Self.codexLogin)
        assertSays(lib, "unavailable: '\(CodexLoginPool.notSignedIn)'", in: Self.codexLogin)
        assertSays(lib, "members[0].state === 'SIGNED_OUT' ? '\(CodexLoginPool.signedOutWords)' : null", in: Self.codexLogin)

        let tags = try web(Self.providerPools)
        let out = PoolMember(id: "m", slug: "m", label: "m", state: .signedOut)
        XCTAssertEqual(ProviderPools.memberStatus(out), PoolStatus(label: "Signed out", tone: .danger))
        assertSays(tags, "return { label: '\(ProviderPools.memberStatus(out).label)', color: 'red' };", in: Self.providerPools)
    }

    /// The head names the account the next session starts on — just named while it is the pool's only
    /// account, "Next:" among several, "Next for you:" once other people use the pool — and reads its
    /// tightest window by its short name.
    func testTheHeadSaysWhatTheWebPoolGaugeSays() throws {
        let card = try web(Self.accountPools)
        assertSays(card, "{pool.shared && hasPeople(pool.shared) ? `Next for you: ${member.label}` : member.login && pool.members.length === 1 ? member.label : `Next: ${member.label}`}",
                   in: Self.accountPools)
        let usage = PlanUsageSnapshot(provider: "codex",
                                      primary: PlanUsageWindow(utilization: 6, windowDurationMins: 300),
                                      secondary: PlanUsageWindow(utilization: 97, windowDurationMins: 10080))
        let first = CodexLogin(email: "${member.label}", fingerprint: "…016a", usage: usage)
        XCTAssertEqual(ProviderPools.headline(codexPool("P", [first])), "${member.label}")
        let two = codexPool("P", [first, CodexLogin(email: "b", fingerprint: "…7QX4")])
        assertSays(card, "`\(ProviderPools.headline(two))`", in: Self.accountPools)
        // Its reading: the window's short name and its percent — "Weekly 97%" — in the gauge's own words.
        XCTAssertEqual(ProviderPools.headGauge(two)?.label, "Weekly 97%")
        assertSays(card, "{`${compactWindowLabel(quota.label)} ${quota.percent}%`}", in: Self.accountPools)
        let unread = codexPool("P", [CodexLogin(email: "e", fingerprint: "…016a")])
        XCTAssertEqual(ProviderPools.headGauge(unread)?.label, CodexLoginPool.noQuota)
        // A key with no cap has nothing to fill: it says so in the same place.
        assertSays(card, "<span className=\"pool-gauge-none\">{member.key ? '\(ProviderPools.noLimit)' : '\(CodexLoginPool.noQuota)'}</span>",
                   in: Self.accountPools)
    }
}
