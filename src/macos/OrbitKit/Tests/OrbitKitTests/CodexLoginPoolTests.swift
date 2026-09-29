import XCTest
@testable import OrbitKit

/// A Codex pool of one's own ChatGPT account (migration 0323) as this client reads it: GET
/// /providers/pools draws its account as the pool's one member, the Providers row and the pool page say
/// where it stands, the pickers offer the pool as Codex, and "Sign in with ChatGPT" reads the server's
/// answers into its steps. Mirrors web's codexLogin.test.ts and ProvidersPage.codexLogin.test.tsx where
/// the two overlap.
final class CodexLoginPoolTests: XCTestCase {
    private let decoder = JSONDecoder()
    private let utc = TimeZone(identifier: "UTC")!
    private let now = RelativeTime.parse("2026-09-28T12:00:00.000Z")!

    /// What `ProvidersService.poolViews` answers for a Codex pool of one's own: no members, and the
    /// account (or none) beside them. The server's own `unavailable` is a sentence a door refuses with;
    /// the pool head reads it off the account instead.
    private func payload(login: String) -> String {
        """
        [{
          "id": "2zQeDGWFFAgN2112jNFD6", "slug": "my-codex", "label": "My Codex", "engine": "codex",
          "createdAt": "2026-09-28T09:10:00.000Z", "updatedAt": "2026-09-28T09:12:00.000Z",
          "login": \(login), "resetsAt": null, "members": [],
          "unavailable": "the pool \\"My Codex\\" has no ChatGPT account signed in — sign in on its page, or pick another provider"
        }]
        """
    }

    private func account(state: String = "ACTIVE", primary: Double = 23, secondary: Double = 41,
                         primaryReset: String = "2099-09-28T14:05:00.000Z") -> String {
        """
        {"state": "\(state)", "email": "wikova@orbitd.io", "plan": "pro", "fingerprint": "…7QX4",
         "lastError": null, "expiresAt": "2099-10-07T09:12:00.000Z", "linkedAt": "2026-09-28T09:12:00.000Z",
         "usage": {"provider": "codex",
                   "primary": {"utilization": \(primary), "resetsAt": "\(primaryReset)", "windowDurationMins": 300},
                   "secondary": {"utilization": \(secondary), "resetsAt": "2099-10-02T09:00:00.000Z", "windowDurationMins": 10080}},
         "usageUnavailable": null}
        """
    }

    private func pool(_ login: String) throws -> ProviderPool {
        let list = try decoder.decode([LossyDecodable<ProviderPool>].self, from: Data(payload(login: login).utf8))
        return try XCTUnwrap(list.compactMap(\.value).first)
    }

    private func login(state: String = "ACTIVE", email: String? = "wikova@orbitd.io", plan: String? = "pro",
                       usage: PlanUsageSnapshot? = nil) -> CodexLogin {
        CodexLogin(state: state, email: email, plan: plan, fingerprint: "…7QX4", usage: usage)
    }

    private func windows(_ primary: Double, _ secondary: Double,
                         primaryReset: String = "2026-09-28T15:00:00.000Z") -> PlanUsageSnapshot {
        PlanUsageSnapshot(provider: "codex",
                          primary: PlanUsageWindow(utilization: primary, resetsAt: primaryReset, windowDurationMins: 300),
                          secondary: PlanUsageWindow(utilization: secondary, resetsAt: "2026-10-03T09:00:00.000Z",
                                                     windowDurationMins: 10080))
    }

    // MARK: - decoding

    func testDrawsTheAccountAsThePoolsOneMember() throws {
        let codex = try pool(account())
        XCTAssertEqual(codex.engine, "codex")
        XCTAssertTrue(CodexLoginPool.isLoginPool(codex))
        XCTAssertNil(codex.unavailable, "a signed-in account runs: the server's sentence is not the head's")
        XCTAssertEqual(codex.members.count, 1)
        let member = try XCTUnwrap(codex.members.first)
        XCTAssertEqual(member.label, "wikova@orbitd.io")
        XCTAssertEqual(member.state, .available)
        XCTAssertTrue(member.next)
        XCTAssertEqual(member.presetSlug, "openai")
        XCTAssertEqual(member.login?.fingerprint, "…7QX4")
        XCTAssertEqual(CodexLoginPool.line(try XCTUnwrap(member.login)), "ChatGPT Pro · …7QX4")
        XCTAssertEqual(CodexLoginPool.windows(try XCTUnwrap(member.login)).map(\.label), ["5h limit", "Weekly limit"])
    }

    func testSaysWhyNothingCanRunInWordsAPoolHeadHasRoomFor() throws {
        let none = try pool("null")
        XCTAssertEqual(none.members, [])
        XCTAssertEqual(none.unavailable, "Not signed in")
        let out = try pool(account(state: "SIGNED_OUT"))
        XCTAssertEqual(out.unavailable, "Signed out")
        XCTAssertEqual(out.members.first?.state, .signedOut)
        XCTAssertEqual(out.members.first?.next, false)
        XCTAssertEqual(ProviderPools.memberStatus(try XCTUnwrap(out.members.first)),
                       PoolStatus(label: "Signed out", tone: .danger))
    }

    func testWaitsOutAUsedUpWindowUntilItsReset() throws {
        let spent = try pool(account(primary: 100, primaryReset: "2099-09-28T14:05:00.000Z"))
        XCTAssertEqual(spent.members.first?.state, .spent)
        XCTAssertEqual(spent.members.first?.resetsAt, "2099-09-28T14:05:00.000Z")
        XCTAssertEqual(spent.resetsAt, "2099-09-28T14:05:00.000Z")
        XCTAssertNil(spent.unavailable)

        // Both used up: the later reset is when it runs again; a reading from before its window turned
        // over is no reason to wait.
        XCTAssertEqual(CodexLoginPool.spentUntil(login(usage: windows(100, 100)), now: now), .some("2026-10-03T09:00:00.000Z"))
        XCTAssertEqual(CodexLoginPool.state(login(usage: windows(100, 40)), now: now), .spent)
        let later = RelativeTime.parse("2026-09-28T15:00:01.000Z")!
        XCTAssertEqual(CodexLoginPool.state(login(usage: windows(100, 40)), now: later), .available)
        XCTAssertEqual(CodexLoginPool.state(login(usage: windows(23, 41)), now: now), .available)
        XCTAssertEqual(CodexLoginPool.state(login(), now: now), .available, "no quota read yet: it runs")
    }

    func testLeavesEveryOtherPoolAsItWas() throws {
        let json = """
        [{"id": "34JNaNRk0VjYl3PgtCk2mM", "slug": "claude-accounts", "label": "Claude accounts", "engine": "claude",
          "login": null, "resetsAt": null, "unavailable": "No accounts", "members": []}]
        """
        let claude = try XCTUnwrap(try decoder.decode([LossyDecodable<ProviderPool>].self, from: Data(json.utf8))
            .compactMap(\.value).first)
        XCTAssertEqual(claude.engine, "claude")
        XCTAssertFalse(CodexLoginPool.isLoginPool(claude))
        XCTAssertEqual(claude.unavailable, "No accounts")
        // An older server names no engine: a Claude pool.
        let old = """
        [{"id": "34JNaNRk0VjYl3PgtCk2mM", "slug": "claude-accounts", "label": "Claude accounts", "resetsAt": null, "members": []}]
        """
        let legacy = try XCTUnwrap(try decoder.decode([LossyDecodable<ProviderPool>].self, from: Data(old.utf8))
            .compactMap(\.value).first)
        XCTAssertEqual(legacy.engine, "claude")
    }

    // MARK: - where it is shown

    func testOffersThePoolAsCodexInThePickers() throws {
        let codex = try pool(account())
        let provider = try XCTUnwrap(ProviderPools.asProviders([codex]).first)
        XCTAssertEqual(provider.runtime, "codex")
        XCTAssertEqual(provider.presetSlug, "openai")
        XCTAssertTrue(ProviderPools.runsCodex(codex))
    }

    func testTheProvidersRowAndThePageSayWhereTheAccountStands() throws {
        let codex = try pool(account())
        XCTAssertEqual(CodexLoginPool.overviewLine(codex), "Just me · wikova@orbitd.io")
        XCTAssertEqual(ProvidersOverview.poolSummary(codex), "Available")
        XCTAssertEqual(CodexLoginPool.headline(codex), "wikova@orbitd.io", "one account is named, not \"next\"")
        let none = try pool("null")
        XCTAssertEqual(CodexLoginPool.overviewLine(none), "Just me")
        XCTAssertEqual(ProvidersOverview.poolSummary(none), "Not signed in")
        XCTAssertEqual(CodexLoginPool.headline(none), "Not signed in")
        XCTAssertEqual(ProvidersOverview.poolSummary(try pool(account(state: "SIGNED_OUT"))), "Signed out")
        let spent = try pool(account(primary: 100, primaryReset: "2099-09-28T14:05:00.000Z"))
        XCTAssertTrue(ProvidersOverview.poolSummary(spent).hasPrefix("Spent · resets "))
        XCTAssertTrue(CodexLoginPool.headline(spent).hasPrefix("All spent · resets "))

        let row = try XCTUnwrap(CodexLoginPool.windows(login(usage: windows(23, 41))).first)
        XCTAssertEqual(CodexLoginPool.resets(row, now: now, timeZone: utc), "resets 15:00")
        let week = try XCTUnwrap(CodexLoginPool.windows(login(usage: windows(23, 41))).last)
        XCTAssertEqual(CodexLoginPool.resets(week, now: now, timeZone: utc), "resets Sat 09:00")
        XCTAssertEqual(CodexLoginPool.line(login(plan: nil)), "ChatGPT · …7QX4")
        XCTAssertEqual(CodexLoginPool.name(login(email: nil)), "ChatGPT account")
        XCTAssertEqual(CodexLoginPool.signOutTitle(login()), "Sign out wikova@orbitd.io?")
        XCTAssertEqual(CodexLoginPool.signedOut(nil), "The account is signed out")
    }

    // MARK: - signing in

    func testReadsEachPollIntoTheStepItEndsOn() {
        let pending = CodexLoginPoll(status: "PENDING", verificationUrl: "https://auth.openai.com/codex/device",
                                     userCode: "QX7M-4TZPK", expiresAt: "2026-09-28T12:15:00.000Z")
        XCTAssertNil(CodexSignIn.step(after: pending))
        let signedIn = login()
        XCTAssertEqual(CodexSignIn.step(after: CodexLoginPoll(status: "CONFIRMED", account: signedIn)), .done(signedIn))
        XCTAssertEqual(CodexSignIn.step(after: CodexLoginPoll(status: "EXPIRED")), .expired)
        XCTAssertEqual(CodexSignIn.step(after: CodexLoginPoll(status: "CANCELLED")), .failed("it was cancelled"))
        XCTAssertEqual(CodexSignIn.step(after: CodexLoginPoll(status: "FAILED", error: "the codex CLI gave up (exit 1)")),
                       .failed("the codex CLI gave up (exit 1)"))
        // Nothing in flight any more: an account in and running is the sign-in done.
        XCTAssertEqual(CodexSignIn.step(after: CodexLoginPoll(status: "NONE", account: signedIn)), .done(signedIn))
        XCTAssertEqual(CodexSignIn.step(after: CodexLoginPoll(status: "NONE")),
                       .failed("the Orbit server has no sign-in in progress for this pool"))
        XCTAssertEqual(CodexSignIn.sentence("the codex CLI gave up (exit 1)"), "The codex CLI gave up (exit 1).")
        XCTAssertEqual(CodexSignIn.sentence("Done."), "Done.")
    }

    func testReadsTheTwoRefusalsAndAsksAgainAfterADroppedRequest() {
        let dup = APIError.http(status: 409, body: #"{"statusCode":409,"code":"POOL_CODEX_ACCOUNT_DUPLICATE","message":"This ChatGPT account is already in \"My Codex\""}"#)
        let taken = APIError.http(status: 409, body: #"{"statusCode":409,"code":"POOL_CODEX_ACCOUNT_TAKEN","message":"\"My Codex\" already runs on wikova@orbitd.io — sign it out first"}"#)
        XCTAssertEqual(CodexSignIn.step(afterPollFailure: dup), .duplicate)
        XCTAssertEqual(CodexSignIn.step(afterPollFailure: taken), .taken)
        XCTAssertEqual(CodexSignIn.step(afterPollFailure: APIError.http(status: 404, body: nil)),
                       .failed("this pool no longer exists"))
        XCTAssertNil(CodexSignIn.step(afterPollFailure: URLError(.networkConnectionLost)))
        let noCode = APIError.http(status: 503, body: #"{"statusCode":503,"code":"CODEX_LOGIN_NO_CHALLENGE","message":"the codex CLI offered no device code"}"#)
        XCTAssertEqual(CodexSignIn.step(afterStartFailure: noCode), .failed("the codex CLI offered no device code"))
    }

    func testSignsAnAccountOpenAISignedOutInAgainAsThatAccount() throws {
        let out = try pool(account(state: "SIGNED_OUT"))
        XCTAssertTrue(CodexSignIn.isAgain(out))
        XCTAssertFalse(CodexSignIn.isAgain(try pool(account())))
        XCTAssertFalse(CodexSignIn.isAgain(try pool("null")))
        XCTAssertEqual(CodexSignIn.againLeadPrefix(out.login) + out.label + CodexSignIn.againLeadSuffix,
                       "OpenAI signed wikova@orbitd.io out. Sign in with it again to put it back in My Codex.")
        XCTAssertEqual(CodexSignIn.takenDetail(out.login),
                       "Sign in as wikova@orbitd.io instead — or sign it out first to switch accounts.")
        XCTAssertEqual(CodexSignIn.expiry("2026-09-28T12:15:00.000Z", now: now, timeZone: utc), "The code works until 12:15.")
        XCTAssertEqual(CodexSignIn.doneTitle(out.login, pool: out), "wikova@orbitd.io is in My Codex")
        XCTAssertEqual(CodexSignIn.doneTitle(nil, pool: out), "Your ChatGPT account is in My Codex")
        XCTAssertEqual(CodexSignIn.doneRow(try XCTUnwrap(out.login)), "ChatGPT Pro · …7QX4 · its sign-in stays on the Orbit server")
    }
}
