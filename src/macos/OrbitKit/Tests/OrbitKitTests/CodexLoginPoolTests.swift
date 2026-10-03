import XCTest
@testable import OrbitKit

/// A Codex pool of one's own ChatGPT accounts (migration 0323) as this client reads it: GET
/// /providers/pools draws each account it holds as one of the pool's members, the Providers row and the
/// pool page say where they stand, the pickers offer the pool as Codex, and "Sign in with ChatGPT" reads
/// the server's answers into its steps. Mirrors web's codexLogin.test.ts and
/// ProvidersPage.codexLogin.test.tsx where the two overlap.
final class CodexLoginPoolTests: XCTestCase {
    private let decoder = JSONDecoder()
    private let utc = TimeZone(identifier: "UTC")!
    private let now = RelativeTime.parse("2026-09-28T12:00:00.000Z")!

    /// What `ProvidersService.poolViews` answers for a Codex pool of one's own: no member providers, every
    /// account it holds (`logins`, oldest first) and the first of them as `login`. The server's own
    /// `unavailable` is a sentence a door refuses with; the pool head reads it off the accounts instead.
    /// `logins: nil` is an older server's answer, which names the one account only.
    private func payload(logins: [String], legacy: Bool = false) -> String {
        """
        [{
          "id": "2zQeDGWFFAgN2112jNFD6", "slug": "my-codex", "label": "My Codex", "engine": "codex",
          "createdAt": "2026-09-28T09:10:00.000Z", "updatedAt": "2026-09-28T09:12:00.000Z",
          "login": \(logins.first ?? "null"),\(legacy ? "" : " \"logins\": [\(logins.joined(separator: ", "))],")
          "resetsAt": null, "members": [],
          "unavailable": "the pool \\"My Codex\\" has no ChatGPT account signed in — sign in on its page, or pick another provider"
        }]
        """
    }

    private func account(state: String = "ACTIVE", email: String = "wikova@orbitd.io", fingerprint: String = "…7QX4",
                         primary: Double = 23, secondary: Double = 41,
                         primaryReset: String = "2099-09-28T14:05:00.000Z",
                         secondaryReset: String = "2099-10-02T09:00:00.000Z") -> String {
        """
        {"state": "\(state)", "email": "\(email)", "plan": "pro", "fingerprint": "\(fingerprint)",
         "lastError": null, "expiresAt": "2099-10-07T09:12:00.000Z", "linkedAt": "2026-09-28T09:12:00.000Z",
         "usage": {"provider": "codex",
                   "primary": {"utilization": \(primary), "resetsAt": "\(primaryReset)", "windowDurationMins": 300},
                   "secondary": {"utilization": \(secondary), "resetsAt": "\(secondaryReset)", "windowDurationMins": 10080}},
         "usageUnavailable": null}
        """
    }

    /// The pool, holding `logins` — none, before anyone signed in.
    private func pool(_ logins: String...) throws -> ProviderPool {
        try decode(payload(logins: logins))
    }

    private func decode(_ json: String) throws -> ProviderPool {
        let list = try decoder.decode([LossyDecodable<ProviderPool>].self, from: Data(json.utf8))
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

    /// The two accounts of 01-review-and-accounts: the oldest at 5h 6% and weekly 97%, the other at 18% / 40%.
    private var lin: String {
        account(email: "jianghailong.rd@gmail.com", fingerprint: "…016a", primary: 6, secondary: 97)
    }
    private var work: String {
        account(email: "hl.work@gmail.com", fingerprint: "…7QX4", primary: 18, secondary: 40)
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
        XCTAssertFalse(CodexLoginPool.showsNext(member, in: codex), "one account has nothing to choose between")
        XCTAssertEqual(member.presetSlug, "openai")
        XCTAssertEqual(member.login?.fingerprint, "…7QX4")
        XCTAssertEqual(CodexLoginPool.line(try XCTUnwrap(member.login)), "ChatGPT Pro · …7QX4")
        XCTAssertEqual(CodexLoginPool.windows(try XCTUnwrap(member.login)).map(\.label), ["5h limit", "Weekly limit"])
    }

    /// Several accounts: each one a member, oldest first, and the first — the account the pool's sessions
    /// run on — the one a session starting now uses, wearing NEXT now that there is a choice.
    func testDrawsEachAccountAsAMemberAndTheFirstIsNext() throws {
        let codex = try pool(lin, work)
        XCTAssertEqual(CodexLoginPool.logins(codex).map(\.fingerprint), ["…016a", "…7QX4"])
        XCTAssertEqual(codex.login?.fingerprint, "…016a", "`login` is the first of `logins`")
        XCTAssertEqual(codex.members.map(\.id), ["login:…016a", "login:…7QX4"])
        XCTAssertEqual(codex.members.map(\.label), ["jianghailong.rd@gmail.com", "hl.work@gmail.com"])
        XCTAssertEqual(codex.members.map(\.state), [.available, .available])
        XCTAssertEqual(codex.members.map(\.next), [true, false])
        XCTAssertEqual(codex.members.map { CodexLoginPool.showsNext($0, in: codex) }, [true, false])
        XCTAssertNil(codex.unavailable)
        XCTAssertNil(codex.resetsAt)
        // How the pickers count it: two accounts.
        XCTAssertEqual(ProviderPools.readyCount(codex), 2)
        XCTAssertEqual(CodexLoginPool.summary(codex), "Just me · 2 of 2 accounts available")
    }

    /// An older server names only `login`: the pool runs on that one account, as before.
    func testAnOlderServerNamesTheOneAccount() throws {
        let codex = try decode(payload(logins: [account()], legacy: true))
        XCTAssertNil(codex.logins)
        XCTAssertEqual(CodexLoginPool.logins(codex).map(\.fingerprint), ["…7QX4"])
        XCTAssertEqual(codex.members.map(\.label), ["wikova@orbitd.io"])
        XCTAssertEqual(codex.members.first?.next, true)
    }

    /// An account in a shape this build cannot read is left out; the pool and its other accounts stay.
    func testAnAccountThisBuildCannotReadIsLeftOutAndTheRestStay() throws {
        let codex = try pool("42", work)
        XCTAssertEqual(codex.members.map(\.label), ["hl.work@gmail.com"])
    }

    func testSaysWhyNothingCanRunInWordsAPoolHeadHasRoomFor() throws {
        let none = try pool()
        XCTAssertEqual(none.members, [])
        XCTAssertEqual(none.unavailable, "Not signed in")
        let out = try pool(account(state: "SIGNED_OUT"))
        XCTAssertEqual(out.unavailable, "Signed out")
        XCTAssertEqual(out.members.first?.state, .signedOut)
        XCTAssertEqual(out.members.first?.next, false)
        XCTAssertEqual(ProviderPools.memberStatus(try XCTUnwrap(out.members.first)),
                       PoolStatus(label: "Signed out", tone: .danger))
        // As web's `withLogin` reads it: the pool says so when the account its sessions run on — the
        // first — is the one OpenAI signed out; its other accounts are where they stand.
        let firstOut = try pool(account(state: "SIGNED_OUT", fingerprint: "…016a"), work)
        XCTAssertEqual(firstOut.unavailable, "Signed out")
        XCTAssertEqual(firstOut.members.map(\.state), [.signedOut, .available])
        XCTAssertNil(try pool(lin, account(state: "SIGNED_OUT")).unavailable)
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

    /// Every account spent: the pool frees up when the first of them does — the earliest reset, not the
    /// latest — one account freeing up being enough for work to continue.
    func testAPoolOfSpentAccountsFreesUpAtTheEarliestOfTheirResets() throws {
        let codex = try pool(account(fingerprint: "…016a", secondary: 100, secondaryReset: "2099-10-02T09:00:00.000Z"),
                             account(fingerprint: "…7QX4", primary: 100, primaryReset: "2099-09-28T14:05:00.000Z"))
        XCTAssertEqual(codex.members.map(\.state), [.spent, .spent])
        XCTAssertEqual(codex.members.map(\.resetsAt), ["2099-10-02T09:00:00.000Z", "2099-09-28T14:05:00.000Z"])
        XCTAssertEqual(codex.resetsAt, "2099-09-28T14:05:00.000Z")
        XCTAssertFalse(codex.members.contains(where: \.next))
        XCTAssertNil(codex.unavailable)
        XCTAssertEqual(CodexLoginPool.summary(codex), "Just me · 0 of 2 accounts available")
        XCTAssertTrue(ProviderPools.headline(codex).hasPrefix("All spent · resets "))
    }

    func testLeavesEveryOtherPoolAsItWas() throws {
        let json = """
        [{"id": "34JNaNRk0VjYl3PgtCk2mM", "slug": "claude-accounts", "label": "Claude accounts", "engine": "claude",
          "login": null, "logins": [], "resetsAt": null, "unavailable": "No accounts", "members": []}]
        """
        let claude = try decode(json)
        XCTAssertEqual(claude.engine, "claude")
        XCTAssertFalse(CodexLoginPool.isLoginPool(claude))
        XCTAssertEqual(claude.unavailable, "No accounts")
        // An older server names no engine: a Claude pool.
        let old = """
        [{"id": "34JNaNRk0VjYl3PgtCk2mM", "slug": "claude-accounts", "label": "Claude accounts", "resetsAt": null, "members": []}]
        """
        XCTAssertEqual(try decode(old).engine, "claude")
    }

    // MARK: - where it is shown

    func testOffersThePoolAsCodexInThePickers() throws {
        let codex = try pool(account())
        let provider = try XCTUnwrap(ProviderPools.asProviders([codex]).first)
        XCTAssertEqual(provider.runtime, "codex")
        XCTAssertEqual(provider.presetSlug, "openai")
        XCTAssertTrue(ProviderPools.runsCodex(codex))
    }

    func testTheProvidersRowAndThePageSayWhereTheAccountsStand() throws {
        let codex = try pool(account())
        XCTAssertEqual(CodexLoginPool.summary(codex), "Just me · 1 of 1 account available")
        // The row's value is the head's gauge: the tightest window of the account the next session starts
        // on — here its weekly one, at 41% beside 23% for its 5 hours.
        XCTAssertEqual(ProvidersOverview.poolSummary(codex), "Weekly 41%")
        XCTAssertEqual(ProviderPools.headline(codex), "wikova@orbitd.io", "one account is named, not \"next\"")
        let two = try pool(lin, work)
        XCTAssertEqual(ProviderPools.headline(two), "Next: jianghailong.rd@gmail.com")
        XCTAssertEqual(ProvidersOverview.poolSummary(two), "Weekly 97%")
        let none = try pool()
        XCTAssertEqual(CodexLoginPool.summary(none), "Just me · 0 of 0 accounts available")
        XCTAssertEqual(ProvidersOverview.poolSummary(none), "Not signed in")
        XCTAssertEqual(ProviderPools.headline(none), "Not signed in")
        XCTAssertEqual(ProvidersOverview.poolSummary(try pool(account(state: "SIGNED_OUT"))), "Signed out")
        let spent = try pool(account(primary: 100, primaryReset: "2099-09-28T14:05:00.000Z"))
        XCTAssertTrue(ProvidersOverview.poolSummary(spent).hasPrefix("All spent · resets "))
        XCTAssertTrue(ProviderPools.headline(spent).hasPrefix("All spent · resets "))

        let row = try XCTUnwrap(CodexLoginPool.windows(login(usage: windows(23, 41))).first)
        XCTAssertEqual(CodexLoginPool.resets(row, now: now, timeZone: utc), "resets 15:00")
        let week = try XCTUnwrap(CodexLoginPool.windows(login(usage: windows(23, 41))).last)
        XCTAssertEqual(CodexLoginPool.resets(week, now: now, timeZone: utc), "resets Sat 09:00")
        XCTAssertEqual(CodexLoginPool.line(login(plan: nil)), "ChatGPT · …7QX4")
        XCTAssertEqual(CodexLoginPool.name(login(email: nil)), "ChatGPT account")
    }

    /// Signing one account out names it, and says what it leaves running: nothing, from the pool's only
    /// account; the pool's other account — or accounts — from one of several. Deleting the pool takes
    /// every sign-in with it.
    func testSigningAnAccountOutSaysWhatItLeavesRunning() throws {
        XCTAssertEqual(CodexLoginPool.signOutTitle(login()), "Sign out wikova@orbitd.io?")
        XCTAssertEqual(CodexLoginPool.signedOut(login()), "wikova@orbitd.io is signed out")
        XCTAssertEqual(CodexLoginPool.signOutNote(try pool(account())),
                       "Its sign-in is deleted from the Orbit server, and no session runs on this pool until you sign in again.")
        XCTAssertEqual(CodexLoginPool.signOutNote(try pool(lin, work)),
                       "Its sign-in is deleted from the Orbit server, and no session runs on it until you sign in again — My Codex keeps running on its other account.")
        let three = try pool(lin, work, account(email: "third@example.com", fingerprint: "…9ZZ9"))
        XCTAssertTrue(CodexLoginPool.signOutNote(three).hasSuffix("— My Codex keeps running on its other accounts."))
        XCTAssertEqual(CodexLoginPool.deleteNote(try pool(account())), "Its ChatGPT sign-in is deleted from the Orbit server with it.")
        XCTAssertEqual(CodexLoginPool.deleteNote(try pool(lin, work)), "Its ChatGPT sign-ins are deleted from the Orbit server with it.")
    }

    // MARK: - signing in

    func testReadsEachPollIntoTheStepItEndsOn() {
        let pending = CodexLoginPoll(status: "PENDING", verificationUrl: "https://auth.openai.com/codex/device",
                                     userCode: "QX7M-4TZPK", expiresAt: "2026-09-28T12:15:00.000Z")
        XCTAssertNil(CodexSignIn.step(after: pending))
        let signedIn = login()
        let other = CodexLogin(email: "jianghailong.rd@gmail.com", fingerprint: "…016a")
        // CONFIRMED names the account this sign-in stored, and every account the pool holds now.
        XCTAssertEqual(CodexSignIn.step(after: CodexLoginPoll(status: "CONFIRMED", account: signedIn, logins: [other, signedIn])),
                       .done(signedIn, logins: [other, signedIn]))
        // An older server names only the account.
        XCTAssertEqual(CodexSignIn.step(after: CodexLoginPoll(status: "CONFIRMED", account: signedIn)), .done(signedIn, logins: [signedIn]))
        XCTAssertEqual(CodexSignIn.step(after: CodexLoginPoll(status: "EXPIRED")), .expired)
        XCTAssertEqual(CodexSignIn.step(after: CodexLoginPoll(status: "CANCELLED")), .failed("it was cancelled"))
        XCTAssertEqual(CodexSignIn.step(after: CodexLoginPoll(status: "FAILED", error: "the codex CLI gave up (exit 1)")),
                       .failed("the codex CLI gave up (exit 1)"))
        // Nothing in flight any more: an account in and running is the sign-in done.
        XCTAssertEqual(CodexSignIn.step(after: CodexLoginPoll(status: "NONE", account: signedIn, logins: [signedIn, other])),
                       .done(signedIn, logins: [signedIn, other]))
        XCTAssertEqual(CodexSignIn.step(after: CodexLoginPoll(status: "NONE", account: signedIn)), .done(signedIn, logins: [signedIn]))
        XCTAssertEqual(CodexSignIn.step(after: CodexLoginPoll(status: "NONE")),
                       .failed("the Orbit server has no sign-in in progress for this pool"))
        XCTAssertEqual(CodexSignIn.sentence("the codex CLI gave up (exit 1)"), "The codex CLI gave up (exit 1).")
        XCTAssertEqual(CodexSignIn.sentence("Done."), "Done.")
    }

    /// The poll's own answer, as the server sends it: the pool's accounts ride along.
    func testDecodesThePollWithThePoolsAccounts() throws {
        let json = """
        {"status": "CONFIRMED", "account": \(work), "logins": [\(lin), \(work)]}
        """
        let poll = try decoder.decode(CodexLoginPoll.self, from: Data(json.utf8))
        guard case .done(let account, let logins) = try XCTUnwrap(CodexSignIn.step(after: poll)) else {
            return XCTFail("a confirmed sign-in did not end the sheet")
        }
        XCTAssertEqual(account?.email, "hl.work@gmail.com")
        XCTAssertEqual(logins.map(\.fingerprint), ["…016a", "…7QX4"])
        let codex = try pool(lin)
        XCTAssertEqual(CodexSignIn.doneTitle(account, pool: codex), "hl.work@gmail.com is in My Codex")
        XCTAssertEqual(CodexSignIn.doneDetail(codex, logins: logins),
                       "My Codex has 2 accounts now. A session moves to this one when the account it’s on runs out.")
    }

    func testReadsTheDuplicateRefusalAndAsksAgainAfterADroppedRequest() {
        let dup = APIError.http(status: 409, body: #"{"statusCode":409,"code":"POOL_CODEX_ACCOUNT_DUPLICATE","message":"This ChatGPT account is already in \"My Codex\"","email":"jianghailong.rd@gmail.com"}"#)
        XCTAssertEqual(CodexSignIn.step(afterPollFailure: dup), .duplicate(email: "jianghailong.rd@gmail.com"))
        // An older server names only the pool.
        let bare = APIError.http(status: 409, body: #"{"statusCode":409,"code":"POOL_CODEX_ACCOUNT_DUPLICATE","message":"This ChatGPT account is already in \"My Codex\""}"#)
        XCTAssertEqual(CodexSignIn.step(afterPollFailure: bare), .duplicate(email: nil))
        XCTAssertEqual(CodexSignIn.duplicateDetail("jianghailong.rd@gmail.com"),
                       "jianghailong.rd@gmail.com is one of its accounts, and signing it in twice adds no quota. Sign in with a different account.")
        XCTAssertEqual(CodexSignIn.duplicateDetail(nil),
                       "It’s one of its accounts, and signing it in twice adds no quota. Sign in with a different account.")
        XCTAssertEqual(CodexSignIn.step(afterPollFailure: APIError.http(status: 404, body: nil)),
                       .failed("this pool no longer exists"))
        XCTAssertNil(CodexSignIn.step(afterPollFailure: URLError(.networkConnectionLost)))
        let noCode = APIError.http(status: 503, body: #"{"statusCode":503,"code":"CODEX_LOGIN_NO_CHALLENGE","message":"the codex CLI offered no device code"}"#)
        XCTAssertEqual(CodexSignIn.step(afterStartFailure: noCode), .failed("the codex CLI offered no device code"))
    }

    /// The notice the sheet opens on: the pool's first account, one more beside those it runs on, or one
    /// OpenAI signed out going back in — signed in as that account.
    func testOpensOnTheNoticeForTheAccountItIsFor() throws {
        let empty = try pool()
        XCTAssertFalse(CodexSignIn.addsAnother(empty, again: nil))
        XCTAssertEqual(CodexSignIn.leadPrefix + empty.label + CodexSignIn.leadSuffix,
                       "Sign in with your own ChatGPT account to run My Codex on it.")

        let one = try pool(lin)
        XCTAssertTrue(CodexSignIn.addsAnother(one, again: nil))
        XCTAssertEqual(CodexSignIn.anotherLeadPrefix + one.label + CodexSignIn.anotherLeadSuffix(one),
                       "Sign in with another ChatGPT account of yours to add it to My Codex. It runs on 1 account now.")
        XCTAssertEqual(CodexSignIn.anotherLeadSuffix(try pool(lin, work)), ". It runs on 2 accounts now.")
        XCTAssertEqual(CodexSignIn.anotherFacts(one).map(\.lead),
                       ["Only you can use it.", "The sign-in stays on the Orbit server.", "Sign out any time."])
        XCTAssertEqual(CodexSignIn.anotherFacts(one).last?.rest, " My Codex keeps running on its other accounts.")

        let out = try pool(lin, account(state: "SIGNED_OUT"))
        let held = try XCTUnwrap(out.members.last?.login)
        XCTAssertFalse(CodexSignIn.addsAnother(out, again: held), "an account going back in is not one more")
        XCTAssertEqual(CodexSignIn.againLeadPrefix(held) + out.label + CodexSignIn.againLeadSuffix,
                       "OpenAI signed wikova@orbitd.io out. Sign in with it again to put it back in My Codex.")
        XCTAssertEqual(CodexSignIn.expiry("2026-09-28T12:15:00.000Z", now: now, timeZone: utc), "The code works until 12:15.")
        XCTAssertEqual(CodexSignIn.doneTitle(held, pool: out), "wikova@orbitd.io is in My Codex")
        XCTAssertEqual(CodexSignIn.doneTitle(nil, pool: out), "Your ChatGPT account is in My Codex")
        XCTAssertEqual(CodexSignIn.doneRow(held), "ChatGPT Pro · …7QX4 · its sign-in stays on the Orbit server")
    }
}
