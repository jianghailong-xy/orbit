import XCTest
@testable import OrbitKit

/// A Codex pool's page drawn for whoever reads it (scheme A, docs/mocks/account-pool-access/), worked out
/// on the boards' own pool (`PoolAccessBoards`): its owner's accounts and its keys drawn as one, what each
/// reader is told and offered, who can use it, sharing it and making it just the owner's again. The words
/// themselves are `PoolAccessCopyParityTests`'.
final class CodexPoolPageTests: XCTestCase {
    private typealias B = PoolAccessBoards

    // MARK: - one pool, read twice

    /// His accounts first, then the keys — his own first, as his sessions take them — and a key is the
    /// next session's only while none of his accounts can take it.
    func testHisAccountsComeFirstThenTheKeysAndAKeyIsNextOnlyWhenNoAccountCan() throws {
        let pool = SharedPools.ownPoolWithAccess(B.ownPool(), B.access(B.jiang))
        XCTAssertEqual(pool.members.map(\.label),
                       ["jianghailong.rd@gmail.com", "hl.work@gmail.com", "orbit-org-1", "zm-proj"])
        XCTAssertEqual(pool.members.map(\.next), [true, false, false, false])
        XCTAssertEqual(pool.engine, "codex")
        XCTAssertEqual(pool.shared?.id, B.poolID)
        XCTAssertTrue(CodexLoginPool.isLoginPool(pool), "still the pool his ChatGPT accounts are in")
        XCTAssertTrue(ProviderPools.runsCodex(pool))
        XCTAssertEqual(ProviderPools.availability(pool), "4 of 4 accounts available")
        XCTAssertNil(pool.unavailable)
        XCTAssertNil(pool.resetsAt)

        // Both accounts spent: the key the server picked for him is the next session's, and nothing waits.
        let spent = [B.account("a@x.io", plan: "plus", fingerprint: "…0001", fiveHour: 100, weekly: 10),
                     B.account("b@x.io", plan: "pro", fingerprint: "…0002", fiveHour: 10, weekly: 100)]
        let onKeys = SharedPools.ownPoolWithAccess(B.ownPool(spent), B.access(B.jiang))
        XCTAssertEqual(onKeys.members.map(\.state), [.spent, .spent, .available, .running])
        XCTAssertEqual(onKeys.members.map(\.next), [false, false, true, false])
        XCTAssertEqual(ProviderPools.headline(onKeys), "Next for you: orbit-org-1")
        XCTAssertNil(onKeys.resetsAt, "a key still runs: nothing to wait for")
        // ...and with no key to fall back on, the pool waits for the first account back.
        let waiting = SharedPools.ownPoolWithAccess(B.ownPool(spent), B.access(B.jiang, keys: []))
        XCTAssertEqual(waiting.resetsAt, B.inAnHour)
        XCTAssertNil(waiting.unavailable)
        XCTAssertTrue(ProviderPools.headline(waiting).hasPrefix("All spent · resets "),
                      "a pool with a ChatGPT account in it is spent, not capped")
    }

    /// Where nothing in it can run, and no reset will change that, it says why in the words its head has
    /// room for: its accounts signed out, its keys refused, or nothing in it at all.
    func testSaysWhyNothingCanRun() throws {
        let out = B.account("a@x.io", plan: "plus", fingerprint: "…0001", fiveHour: 0, weekly: 0)
        let signedOut = CodexLogin(state: "SIGNED_OUT", email: out.email, plan: out.plan, fingerprint: out.fingerprint)
        let refused = SharedPool(id: B.poolID, slug: "codex-pool", label: "Codex Pool", shared: false, keys: [
            SharedPoolKey(id: "k", label: "k", fingerprint: "sk-…0000", state: .invalid,
                          contributor: PoolKeyContributor(userId: B.jiang, name: "jianghailong", you: true)),
        ])
        XCTAssertEqual(SharedPools.ownPoolWithAccess(B.ownPool([signedOut]), refused).unavailable, "Signed out")
        XCTAssertEqual(SharedPools.ownPoolWithAccess(B.ownPool([]), refused).unavailable, "No key can run")
        XCTAssertEqual(SharedPools.ownPoolWithAccess(B.ownPool([]), B.access(B.jiang, keys: [])).unavailable,
                       "Not signed in")
        XCTAssertNil(SharedPools.ownPoolWithAccess(B.ownPool([signedOut]), B.access(B.jiang)).unavailable,
                     "its keys still run his sessions")
    }

    // MARK: - who reads it

    /// His alone: Just me, his accounts, nothing about anybody else — and "Add account" signs one in or
    /// asks first what kind goes in, once the pool's people and keys are read.
    func testHisOwnPoolKeptToHimself() throws {
        let page = B.ownersPage(people: [], keys: [])
        XCTAssertTrue(page.mine)
        XCTAssertFalse(page.people)
        XCTAssertFalse(page.tagged)
        XCTAssertNil(page.lockedOwner)
        XCTAssertEqual(page.who, "Just me")
        XCTAssertEqual(page.howSentence,
                       "Each session starts on the account whose quota resets soonest, and stays on it until that one runs out.")
        XCTAssertEqual(page.adding, .choose)
        XCTAssertEqual(page.accounts, 2)
        XCTAssertEqual(page.exitLabel, "Delete pool")
        XCTAssertEqual(page.exitTitle, "Delete Codex Pool?")
        let unread = try XCTUnwrap(CodexPoolPage(own: B.ownPool(), access: nil))
        XCTAssertEqual(unread.adding, .signIn, "with its people and keys not read, straight to signing one in")
        XCTAssertEqual(unread.who, "Just me")
        XCTAssertEqual(CodexPoolPage(own: B.ownPool([]), access: nil)?.emptyNote, CodexLoginPool.noAccount)
        XCTAssertNil(CodexPoolPage(own: nil, access: nil))
    }

    /// Somebody he added runs on its keys alone: his accounts are one locked line — never an email, a plan,
    /// a fingerprint or a quota — the keys are theirs to run on, their own first, and the way out is leaving.
    func testTheSamePoolForSomebodyHeAdded() throws {
        let page = B.zhangsPage()
        XCTAssertFalse(page.mine)
        XCTAssertTrue(page.people)
        XCTAssertFalse(page.tagged)
        XCTAssertEqual(page.lockedOwner, "jianghailong")
        XCTAssertEqual(page.pool.members.map(\.label), ["zm-proj", "orbit-org-1"])
        XCTAssertEqual(page.pool.members.map(\.next), [true, false])
        XCTAssertTrue(page.pool.members.allSatisfy { $0.login == nil && $0.key != nil })
        XCTAssertNil(page.accounts)
        XCTAssertNil(page.accountsCount)
        XCTAssertEqual(page.adding, .key)
        XCTAssertEqual(page.addLabel, "Add a key")
        XCTAssertEqual(page.exitLabel, "Leave pool")
        XCTAssertEqual(page.exitConfirm, "Leave")
        XCTAssertEqual(page.exitTitle, "Leave Codex Pool?")
        // Nothing of his accounts is anywhere on it: whose subscription they are is all it says.
        let said = [B.line(page), ProviderPools.headline(page.pool), CodexPoolPage.lockedTitle("jianghailong"),
                    CodexPoolPage.lockedLine("jianghailong")] + page.pool.members.map(\.label)
        for secret in ["jianghailong.rd@gmail.com", "hl.work@gmail.com", "ChatGPT Plus", "…016a", "Weekly"] {
            XCTAssertFalse(said.contains { $0.contains(secret) }, "\(secret) reached somebody he added")
        }
        // Nor do they get an "Add a key" the pool doesn't let them have.
        let theirs = B.access(B.zhang)
        let closed = SharedPool(id: theirs.id, slug: theirs.slug, label: theirs.label, shared: false,
                                ownerHasChatGPT: true, membersCanAdd: false, viewerRole: .member,
                                people: theirs.people, keys: theirs.keys)
        XCTAssertNil(CodexPoolPage(own: nil, access: closed)?.adding)
        // A pool of somebody's own without ChatGPT accounts in it has no locked line to draw.
        let none = SharedPool(id: theirs.id, slug: theirs.slug, label: theirs.label, shared: false,
                              ownerHasChatGPT: false, people: theirs.people, keys: theirs.keys)
        XCTAssertNil(CodexPoolPage(own: nil, access: none)?.lockedOwner)
    }

    // MARK: - who can use it

    func testWhoCanUseItForHimAndForSomebodyHeAdded() throws {
        let his = WhoCanUseIt(pool: B.access(B.jiang), accounts: 2)
        XCTAssertEqual(his.count, 3)
        XCTAssertEqual(his.mode, .withPeople)
        XCTAssertTrue(his.showsMode)
        XCTAssertTrue(his.addsPeople)
        XCTAssertTrue(his.showsRule)
        XCTAssertTrue(his.showsFoot)
        XCTAssertNil(his.warning, "the pool has keys")
        XCTAssertFalse(his.offersRoles, "a pool of his own has one admin, him")
        XCTAssertTrue(his.ran)
        XCTAssertEqual(his.rows.map { SharedPoolPage.share($0, in: his.pool) }, [20, 55, 25])
        XCTAssertEqual(his.rows.map(his.manages), [false, true, true])
        XCTAssertEqual(his.line(his.rows[0]), WhoCanUseIt.PersonLine(runs: WhoCanUseIt.runsOnEverything, everything: true,
                                                                    rest: "23 sessions"))
        // A pool made on the shared pools page holds no ChatGPT account: its maker runs on its keys too, and
        // there is no lock to speak of.
        let keysAlone = WhoCanUseIt(pool: B.access(B.jiang), accounts: nil)
        XCTAssertEqual(keysAlone.line(keysAlone.rows[0]).runs, WhoCanUseIt.runsOnKeys)
        XCTAssertFalse(keysAlone.showsFoot)

        let alone = WhoCanUseIt(pool: B.access(B.jiang, people: [], keys: []), accounts: 2)
        XCTAssertNil(alone.count)
        XCTAssertNil(alone.note)
        XCTAssertEqual(alone.mode, .justMe)
        XCTAssertTrue(alone.rows.isEmpty)
        XCTAssertFalse(alone.addsPeople)
        XCTAssertFalse(alone.showsRule)
        XCTAssertNil(alone.warning, "nobody else uses it")
        XCTAssertFalse(alone.ran)

        let zhang = WhoCanUseIt(pool: B.access(B.zhang), accounts: nil)
        XCTAssertFalse(zhang.showsMode)
        XCTAssertFalse(zhang.addsPeople)
        XCTAssertFalse(zhang.showsRule)
        XCTAssertFalse(zhang.showsFoot)
        XCTAssertEqual(zhang.rows.map(zhang.manages), [false, false, false])
        XCTAssertEqual(zhang.line(zhang.rows[2]), WhoCanUseIt.PersonLine(runs: nil, everything: false, rest: "No key · 6 sessions"))
    }

    // MARK: - sharing it, and taking it back

    func testShareSaysWhatTheyGetAndReadsTheAddressesTyped() {
        XCTAssertEqual(SharePool.emails(" a@x.io,b@x.io\n\nc@x.io , a@x.io"), ["a@x.io", "b@x.io", "c@x.io"])
        XCTAssertEqual(SharePool.emails(" ,, "), [])
        let two = B.access(B.jiang, people: [])
        XCTAssertFalse(SharePool.noKey(two))
        XCTAssertEqual(SharePool.facts(two, accounts: nil)[1].rest, ", which are orbit-org-1 and zm-proj now.")
        XCTAssertEqual(SharePool.facts(two, accounts: 1)[1].rest, ", which are orbit-org-1 and zm-proj now. "
            + "Your ChatGPT account stays yours alone: they can’t run on it or see which account it is.")
        let none = B.access(B.jiang, people: [], keys: [])
        XCTAssertTrue(SharePool.noKey(none))
        XCTAssertEqual(SharePool.risk(none, accounts: nil).rest, " They’ll see it but can’t start a session until it has one.")
        XCTAssertEqual(SharePool.outcome(none, missed: [SharePool.missed("x@y.io", reason: "No Orbit account has that email")]),
                       "Not added: x@y.io (No Orbit account has that email)")
    }

    func testMakingItJustHisSaysWhoLosesItWhichKeysGoAndWhatStays() {
        // Lin Wei alone, with no key: nothing goes with her, and his one account stays.
        let lin = B.access(B.jiang, people: [B.lin], keys: [])
        XCTAssertEqual(JustMine.cost(lin, accounts: 1),
                       "Lin Wei loses it at once, and their sessions on it stop. Your ChatGPT account stays.")
        // Both of them, each with a key: each key goes with whoever added it.
        let both = SharedPool(id: "p", slug: "p", label: "P", shared: false, people: lin.people + [
            SharedPoolPerson(userId: B.zhang, name: "Zhang Min"),
        ], keys: [
            SharedPoolKey(id: "1", label: "lin-1", fingerprint: "f", contributor: PoolKeyContributor(userId: B.lin, name: "Lin Wei")),
            SharedPoolKey(id: "2", label: "lin-2", fingerprint: "f", contributor: PoolKeyContributor(userId: B.lin, name: "Lin Wei")),
            SharedPoolKey(id: "3", label: "zm", fingerprint: "f", contributor: PoolKeyContributor(userId: B.zhang, name: "Zhang Min")),
        ])
        XCTAssertEqual(JustMine.cost(both, accounts: nil),
                       "Lin Wei and Zhang Min lose it at once, and their sessions on it stop. lin-1 and lin-2 leave with "
                        + "Lin Wei and zm leaves with Zhang Min, because a key goes with whoever added it.")
        XCTAssertEqual(JustMine.title(both), "Make P just yours?")
    }

    // MARK: - its words for the whole of it

    func testItsWayOutSaysWhatGoesWithIt() {
        XCTAssertEqual(B.ownersPage(people: [], keys: ["orbit-org-1"]).outNote,
                       "Its ChatGPT sign-ins and API keys are deleted from the Orbit server with it.")
        let keysAlone = CodexPoolPage(own: nil, access: B.access(B.jiang, people: [], shared: true))!
        XCTAssertEqual(keysAlone.outNote, "Its API keys are deleted from the Orbit server with it.")
        XCTAssertEqual(keysAlone.exitLabel, "Delete pool")
        let none = CodexPoolPage(own: B.ownPool([]), access: B.access(B.jiang, people: [], keys: []))!
        XCTAssertEqual(none.outNote, "Its ChatGPT sign-ins are deleted from the Orbit server with it.")
    }
}
