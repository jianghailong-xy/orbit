import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import OrbitKit

/// Shared Codex pools as this client reads them — the GET /providers/shared-pools payload — and what
/// Settings → Providers and a shared pool's page make of it. The fixture is the pool effect mock 05
/// draws (Team Codex: four people, five keys), in the shape `SharedPoolsService.poolView` answers.
final class SharedPoolsTests: XCTestCase {
    private let decoder = JSONDecoder()

    private static func id(_ n: Int) -> String {
        PublicID.toPublic("0195c0de-0000-7000-8000-\(String(format: "%012d", n))")
    }

    private static let wikova = id(1), zhang = id(2), chen = id(3), lin = id(4)

    /// What the server answers Wikova, the pool's creator: base62 ids, as the public-id interceptor
    /// leaves them, and the fields this client doesn't read (timestamps). A pool made on the shared pools
    /// page holds no ChatGPT account, so `logins` is empty — which is also what a server from before
    /// scheme A leaves out entirely.
    private static let payload = """
    [{
      "id": "\(id(900))", "slug": "team-codex", "label": "Team Codex", "engine": "codex", "shared": true,
      "logins": [],
      "membersCanAdd": true, "ownKeyFirst": true, "viewerRole": "ADMIN",
      "window": {"start": "2026-09-01T00:00:00.000Z", "end": "2026-10-01T00:00:00.000Z"},
      "people": [
        {"userId": "\(wikova)", "name": "Wikova", "role": "ADMIN", "creator": true, "you": true, "keys": 2,
         "sessions": 23, "usage": {"inputTokens": 900, "outputTokens": 90, "costUsd": 34}},
        {"userId": "\(zhang)", "name": "Zhang Min", "role": "MEMBER", "creator": false, "you": false, "keys": 2,
         "sessions": 19, "usage": {"inputTokens": 800, "outputTokens": 80, "costUsd": 30}},
        {"userId": "\(chen)", "name": "Chen Yu", "role": "MEMBER", "creator": false, "you": false, "keys": 1,
         "sessions": 14, "usage": {"inputTokens": 700, "outputTokens": 70, "costUsd": 24}},
        {"userId": "\(lin)", "name": "Lin Wei", "role": "MEMBER", "creator": false, "you": false, "keys": 0,
         "sessions": 6, "usage": {"inputTokens": 300, "outputTokens": 30, "costUsd": 12}}
      ],
      "keys": [
        {"id": "\(id(11))", "label": "orbit-org-1", "fingerprint": "sk-…AB12", "state": "ACTIVE", "enabled": true,
         "shareCap": 50, "contributor": {"userId": "\(wikova)", "name": "Wikova", "you": true},
         "usage": {"inputTokens": 1, "outputTokens": 1, "costUsd": 20.5, "othersCostUsd": 12.4},
         "running": false, "next": true, "createdAt": "2026-09-02T00:00:00.000Z"},
        {"id": "\(id(12))", "label": "orbit-org-2", "fingerprint": "sk-…7K2P", "state": "ACTIVE", "enabled": true,
         "shareCap": 50, "contributor": {"userId": "\(zhang)", "name": "Zhang Min", "you": false},
         "usage": {"inputTokens": 1, "outputTokens": 1, "costUsd": 40, "othersCostUsd": 31},
         "running": true, "next": false, "createdAt": "2026-09-03T00:00:00.000Z"},
        {"id": "\(id(13))", "label": "ios-build", "fingerprint": "sk-…QZ03", "state": "ACTIVE", "enabled": true,
         "shareCap": 50, "contributor": {"userId": "\(chen)", "name": "Chen Yu", "you": false},
         "usage": {"inputTokens": 1, "outputTokens": 1, "costUsd": 55, "othersCostUsd": 50},
         "running": false, "next": false, "createdAt": "2026-09-04T00:00:00.000Z"},
        {"id": "\(id(14))", "label": "wikova-backup", "fingerprint": "sk-…M4T7", "state": "INVALID", "enabled": true,
         "shareCap": 50, "contributor": {"userId": "\(wikova)", "name": "Wikova", "you": true},
         "usage": {"inputTokens": 1, "outputTokens": 1, "costUsd": 6.2, "othersCostUsd": 6.2},
         "running": false, "next": false, "createdAt": "2026-09-05T00:00:00.000Z"},
        {"id": "\(id(15))", "label": "zhang-old", "fingerprint": "sk-…31FD", "state": "ACTIVE", "enabled": false,
         "shareCap": 50, "contributor": {"userId": "\(zhang)", "name": "Zhang Min", "you": false},
         "usage": {"inputTokens": 0, "outputTokens": 0, "costUsd": 0, "othersCostUsd": 0},
         "running": false, "next": false, "createdAt": "2026-09-06T00:00:00.000Z"}
      ],
      "createdAt": "2026-09-01T00:00:00.000Z", "updatedAt": "2026-09-27T00:00:00.000Z"
    }]
    """

    private func pools(_ json: String = SharedPoolsTests.payload) throws -> [SharedPool] {
        try decoder.decode([LossyDecodable<SharedPool>].self, from: Data(json.utf8)).compactMap(\.value)
    }

    private func team(_ json: String = SharedPoolsTests.payload) throws -> SharedPool {
        try XCTUnwrap(try pools(json).first)
    }

    /// The pool as another person in it reads it: their role, and whose keys are "you". Which key is next
    /// is the server's answer for each reader; a test that needs it says so.
    private func asMember(_ pool: SharedPool, userId: String, role: SharedPoolRole = .member) -> SharedPool {
        func mark(_ person: SharedPoolPerson) -> SharedPoolPerson {
            SharedPoolPerson(userId: person.userId, name: person.name, role: person.role, creator: person.creator,
                             you: person.userId == userId, keys: person.keys, sessions: person.sessions,
                             usage: person.usage)
        }
        func mark(_ key: SharedPoolKey) -> SharedPoolKey {
            let c = key.contributor
            return SharedPoolKey(id: key.id, label: key.label, fingerprint: key.fingerprint, state: key.state,
                                 enabled: key.enabled, shareCap: key.shareCap, spentUntil: key.spentUntil,
                                 contributor: PoolKeyContributor(userId: c.userId, name: c.name, you: c.userId == userId),
                                 usage: key.usage, running: key.running)
        }
        return SharedPool(id: pool.id, slug: pool.slug, label: pool.label, engine: pool.engine, shared: pool.shared,
                          logins: pool.logins,
                          membersCanAdd: pool.membersCanAdd, ownKeyFirst: pool.ownKeyFirst, viewerRole: role,
                          window: pool.window, people: pool.people.map(mark), keys: pool.keys.map(mark))
    }

    private func key(_ pool: SharedPool, _ label: String) throws -> SharedPoolKey {
        try XCTUnwrap(pool.keys.first { $0.label == label })
    }

    /// 2026-09-28 10:00 in Berlin: the month's caps come back on Thursday at 02:00 there.
    private let now = ISO8601DateFormatter().date(from: "2026-09-28T08:00:00Z")!
    private let berlin = TimeZone(identifier: "Europe/Berlin")!

    // MARK: - decoding

    func testDecodesThePoolTheServerSends() throws {
        let pool = try team()
        XCTAssertEqual(pool.slug, "team-codex")
        XCTAssertEqual(pool.label, "Team Codex")
        XCTAssertEqual(pool.engine, "codex")
        XCTAssertTrue(pool.shared, "made on the shared pools page")
        XCTAssertTrue(pool.logins.isEmpty, "a shared pool holds no ChatGPT account")
        XCTAssertEqual(pool.viewerRole, .admin)
        XCTAssertTrue(pool.membersCanAdd)
        XCTAssertTrue(pool.ownKeyFirst)
        XCTAssertEqual(pool.window?.end, "2026-10-01T00:00:00.000Z")
        XCTAssertEqual(pool.people.map(\.name), ["Wikova", "Zhang Min", "Chen Yu", "Lin Wei"])
        XCTAssertEqual(pool.people.map(\.role), [.admin, .member, .member, .member])
        XCTAssertEqual(pool.people.map(\.keys), [2, 2, 1, 0])
        XCTAssertEqual(pool.people.map(\.sessions), [23, 19, 14, 6])
        XCTAssertEqual(pool.people.first?.creator, true)
        XCTAssertEqual(pool.people.first?.you, true)
        XCTAssertEqual(pool.keys.map(\.label), ["orbit-org-1", "orbit-org-2", "ios-build", "wikova-backup", "zhang-old"])
        XCTAssertEqual(pool.keys.map(\.state), [.active, .active, .active, .invalid, .active])
        XCTAssertEqual(pool.keys.map(\.enabled), [true, true, true, true, false])
        XCTAssertEqual(pool.keys.map(\.next), [true, false, false, false, false])
        XCTAssertEqual(pool.keys.map(\.running), [false, true, false, false, false])
        XCTAssertEqual(pool.keys.first?.fingerprint, "sk-…AB12")
        XCTAssertEqual(pool.keys.first?.shareCap, 50)
        XCTAssertEqual(pool.keys.first?.usage.othersCostUsd, 12.4)
        XCTAssertEqual(pool.keys.first?.contributor, PoolKeyContributor(userId: Self.wikova, name: "Wikova", you: true))
    }

    /// A state or role added on the server is one this build can't name — the pool survives it, and an
    /// unknown state is not read as a refused key.
    func testAStateOrRoleThisBuildDoesNotKnowReadsAsUnknown() throws {
        let json = Self.payload
            .replacingOccurrences(of: "\"state\": \"INVALID\"", with: "\"state\": \"PAUSED\"")
            .replacingOccurrences(of: "\"viewerRole\": \"ADMIN\"", with: "\"viewerRole\": \"OWNER\"")
        let pool = try team(json)
        XCTAssertEqual(pool.keys.count, 5)
        XCTAssertEqual(try key(pool, "wikova-backup").state, .unknown)
        XCTAssertNil(SharedPoolPage.invalidReason(try key(pool, "wikova-backup"), in: pool))
        XCTAssertEqual(pool.viewerRole, .unknown)
        XCTAssertFalse(SharedPoolPage.isAdmin(pool))
    }

    /// A key or person missing what identifies it is left out; the pool and everything else stays.
    func testAKeyOrPersonThisBuildCannotReadIsLeftOut() throws {
        let json = Self.payload
            .replacingOccurrences(of: "\"id\": \"\(Self.id(13))\", ", with: "")
            .replacingOccurrences(of: "{\"userId\": \"\(Self.lin)\", ", with: "{")
        let pool = try team(json)
        XCTAssertEqual(pool.keys.map(\.label), ["orbit-org-1", "orbit-org-2", "wikova-backup", "zhang-old"])
        XCTAssertEqual(pool.people.map(\.name), ["Wikova", "Zhang Min", "Chen Yu"])
    }

    func testAPoolThisBuildCannotReadIsLeftOutAndTheOthersStay() throws {
        let broken = #"{"slug": "no-id", "label": "Broken", "people": [], "keys": []}"#
        XCTAssertEqual(try pools("[\(broken), \(Self.payload.dropFirst().dropLast())]").map(\.slug), ["team-codex"])
    }

    /// A Codex pool of somebody's own, as one of the people they added reads it (migration 0358): not made
    /// on the shared pools page, and its owner's ChatGPT accounts in it — which they read since 2026-10-03
    /// like the owner does, the accounts running their sessions too.
    func testDecodesAPoolOfSomebodysOwnTheyWereAddedTo() throws {
        let json = Self.payload.replacingOccurrences(
            of: "\"shared\": true,",
            with: "\"shared\": false, \"logins\": [{\"state\": \"ACTIVE\", \"email\": \"owner@codex-login.invalid\","
                + " \"plan\": \"pro\", \"fingerprint\": \"…AB12\", \"next\": true}],")
        let pool = asMember(try team(json), userId: Self.zhang)
        XCTAssertFalse(pool.shared)
        XCTAssertEqual(pool.logins.map(\.email), ["owner@codex-login.invalid"])
        XCTAssertEqual(pool.logins.first?.plan, "pro")
        XCTAssertEqual(pool.logins.first?.next, true)
        XCTAssertEqual(CodexPoolPage(own: nil, access: pool)?.accounts, 1)
        XCTAssertEqual(CodexPoolPage(own: nil, access: pool)?.logins.map(\.email), ["owner@codex-login.invalid"])
        XCTAssertEqual(CodexPoolPage(own: nil, access: try team(json))?.accounts, 1,
                       "its owner reads the same accounts from their own page")
    }

    func testOptionalFieldsFallBackWhenAServerOmitsThem() throws {
        let pool = try team(#"[{"id": "p1", "slug": "pool-a", "keys": [{"id": "k1", "contributor": {"userId": "u1"}}]}]"#)
        XCTAssertEqual(pool.label, "pool-a")
        XCTAssertTrue(pool.shared, "an older server lists only pools made on the shared pools page")
        XCTAssertTrue(pool.logins.isEmpty, "a server that says nothing of accounts is read as holding none")
        XCTAssertEqual(pool.viewerRole, .unknown)
        XCTAssertTrue(pool.people.isEmpty)
        XCTAssertNil(pool.window)
        let only = try XCTUnwrap(pool.keys.first)
        XCTAssertEqual(only.state, .unknown)
        XCTAssertTrue(only.enabled)
        XCTAssertNil(only.shareCap)
        XCTAssertEqual(only.usage, PoolSpend())
        XCTAssertFalse(only.next)
        XCTAssertFalse(only.running)
    }

    /// The only place a key is sent: the add and the replace. The limit is left out when there is none.
    func testTheRequestsCarryWhatTheServerTakes() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        func json<T: Encodable>(_ value: T) throws -> String { String(decoding: try encoder.encode(value), as: UTF8.self) }
        XCTAssertEqual(try json(AddPoolKeyRequest(label: "a", apiKey: "sk-x", shareCap: 50)),
                       #"{"apiKey":"sk-x","label":"a","shareCap":50}"#)
        XCTAssertEqual(try json(AddPoolKeyRequest(label: "a", apiKey: "sk-x")), #"{"apiKey":"sk-x","label":"a"}"#)
        XCTAssertEqual(try json(ReplacePoolKeyRequest(apiKey: "sk-y")), #"{"apiKey":"sk-y"}"#)
        XCTAssertEqual(try json(UpdatePoolKeyRequest(enabled: false)), #"{"enabled":false}"#)
        XCTAssertEqual(try json(UpdateSharedPoolRequest(ownKeyFirst: false)), #"{"ownKeyFirst":false}"#)
        XCTAssertEqual(try json(AddSharedPoolPersonRequest(email: "a@b.c")), #"{"email":"a@b.c"}"#)
        XCTAssertEqual(try json(UpdateSharedPoolPersonRequest(role: .admin)), #"{"role":"ADMIN"}"#)
    }

    // MARK: - Settings → Providers

    /// Its maker reads how many of its keys a session could start on, beside SHARED; anybody else whose it
    /// is and how many keys they can run on; and its maker alone in it, "Just me".
    func testTheProvidersRowSaysWhoseItIsAndHowManyCanRun() throws {
        let pool = SharedPools.asProviderPool(try team())
        XCTAssertTrue(ProvidersOverview.isShared(pool))
        XCTAssertEqual(ProvidersOverview.codexPoolLine(pool), "2 of 5 accounts available")
        let zhang = SharedPools.asProviderPool(asMember(try team(), userId: Self.zhang))
        XCTAssertEqual(ProvidersOverview.codexPoolLine(zhang), "Wikova’s · 5 keys you can run on")
        XCTAssertNil(ProvidersOverview.codexPoolValue(zhang))
        let alone = SharedPools.asProviderPool(SharedPool(id: "p", slug: "p", label: "P", people: [
            SharedPoolPerson(userId: "u", name: "U", role: .admin, creator: true, you: true),
        ]))
        XCTAssertFalse(ProvidersOverview.isShared(alone))
        XCTAssertEqual(ProvidersOverview.codexPoolLine(alone), "Just me · 0 of 0 accounts available")
        XCTAssertEqual(ProvidersOverview.codexPoolValue(alone)?.label, "No keys")
    }

    // MARK: - the head

    /// Its maker reads who else can use it and how many of its keys a session could start on; a pool made
    /// on the shared pools page holds no account yet but may hold one (migration 0371), so its press asks
    /// what kind goes in and its line reads its keys while none is in.
    func testTheHeadSaysWhoCanUseItAndHowManyKeysCanRun() throws {
        let page = try XCTUnwrap(CodexPoolPage(own: nil, access: try team()))
        XCTAssertEqual(page.who, "Me and 3 people")
        XCTAssertEqual(page.subtitleRest, " · 2 of 5 accounts available")
        XCTAssertEqual(page.howSentence, "Each session starts on the key with the most room, and stays on it until that one runs out.")
        XCTAssertEqual(page.adding, .choose)
        let chen = try XCTUnwrap(CodexPoolPage(own: nil, access: asMember(try team(), userId: Self.chen)))
        XCTAssertEqual(chen.who, "Wikova’s")
        XCTAssertEqual(chen.subtitleRest, " · 4 people · 3 of 5 keys you can run on available")
        XCTAssertEqual(chen.howSentence, "Your sessions run on the API keys, your own first.")
        XCTAssertEqual(chen.accounts, 0, "a pool made on the shared pools page holds no ChatGPT account yet")
        XCTAssertEqual(chen.adding, .choose, "a member the pool's rule lets signs one of their own in")
    }

    // MARK: - keys

    /// Each key's status, in the words and colours of the web's tags (`keyState` → `memberStatus`).
    func testEachKeysStatusIsTheWebsWordsAndColour() throws {
        let pool = try team()
        func status(_ label: String) throws -> PoolStatus { SharedPoolPage.status(try key(pool, label), in: pool) }
        XCTAssertEqual(try status("orbit-org-1"), PoolStatus(label: "Available", tone: .success))
        XCTAssertEqual(try status("orbit-org-2"), PoolStatus(label: "Running now", tone: .brand))
        XCTAssertEqual(try status("ios-build"), PoolStatus(label: "At cap · resets Oct 1", tone: .warning))
        XCTAssertEqual(try status("wikova-backup"), PoolStatus(label: "Invalid", tone: .danger))
        XCTAssertEqual(try status("zhang-old"), PoolStatus(label: "Disabled", tone: .neutral))
        // OpenAI switched its organization off: out, however its contributor has it.
        let refused = SharedPoolKey(id: "k", label: "k", fingerprint: "sk-…0000", state: .disabled,
                                    contributor: PoolKeyContributor(userId: Self.lin, name: "Lin Wei"))
        XCTAssertEqual(SharedPoolPage.status(refused, in: pool), PoolStatus(label: "Disabled", tone: .neutral))
        // Refused by OpenAI outranks switched off: it is the one somebody has to act on.
        let both = SharedPoolKey(id: "k", label: "k", fingerprint: "sk-…0000", state: .invalid, enabled: false,
                                 contributor: PoolKeyContributor(userId: Self.lin, name: "Lin Wei"))
        XCTAssertEqual(SharedPoolPage.status(both, in: pool).label, "Invalid")
        // A pool read with no month to name says the cap without its reset.
        let noWindow = SharedPool(id: pool.id, slug: pool.slug, label: pool.label, keys: pool.keys)
        XCTAssertEqual(SharedPoolPage.status(try key(pool, "ios-build"), in: noWindow),
                       PoolStatus(label: "At cap", tone: .warning))
    }

    /// A key OpenAI has put out of budget (`spentUntil`, the gateway's mark on an upstream
    /// `insufficient_quota`): read off the payload, out until its own mark, and no session of anybody's
    /// starts on it — its contributor's included, where a cap stops only the others.
    func testAKeyOpenAIPutOutOfBudgetIsOutUntilItsMark() throws {
        let pool = try team()
        let json = """
        {"id": "\(Self.id(16))", "label": "chen-org-2", "fingerprint": "sk-…5V8N", "state": "ACTIVE",
         "enabled": true, "shareCap": 50, "spentUntil": "2026-09-30T06:00:00.000Z",
         "contributor": {"userId": "\(Self.chen)", "name": "Chen Yu", "you": false},
         "usage": {"inputTokens": 1, "outputTokens": 1, "costUsd": 18, "othersCostUsd": 18},
         "running": false, "next": false}
        """
        let spent = try decoder.decode(SharedPoolKey.self, from: Data(json.utf8))
        XCTAssertEqual(spent.spentUntil, "2026-09-30T06:00:00.000Z")
        XCTAssertEqual(SharedPoolPage.status(spent, in: pool),
                       PoolStatus(label: "Out of budget · resets Sep 30", tone: .warning))

        let withIt = SharedPool(id: pool.id, slug: pool.slug, label: pool.label, engine: pool.engine,
                                viewerRole: pool.viewerRole, window: pool.window,
                                people: pool.people, keys: pool.keys + [spent])
        // No session starts on it: what can run is what the other keys made of the pool.
        XCTAssertEqual(SharedPoolPage.keyState(spent), .spent)
        XCTAssertEqual(ProviderPools.readyCount(SharedPools.asProviderPool(withIt)), 2)
        XCTAssertEqual(ProviderPools.availability(SharedPools.asProviderPool(withIt)), "2 of 6 accounts available")
        XCTAssertEqual(ProviderPools.headline(SharedPools.asProviderPool(withIt)), "Next for you: orbit-org-1")
        // Nothing that can run: the head names OpenAI's mark — the soonest key back — rather than the month.
        let only = SharedPool(id: "p", slug: "p", label: "P", window: pool.window, keys: [spent])
        XCTAssertEqual(ProviderPools.headline(SharedPools.asProviderPool(only)), "All out of budget · resets Sep 30")
        // A cap among the stops keeps the cap's words, with the reset the first of them comes back at.
        let mixed = SharedPool(id: "p", slug: "p", label: "P", window: pool.window,
                               keys: [try key(pool, "ios-build"), spent])
        XCTAssertEqual(ProviderPools.headline(SharedPools.asProviderPool(mixed)), "All at cap · resets Sep 30")

        // Its own contributor is stopped too, and out of budget outranks a cap the others have spent.
        let mine = SharedPoolKey(id: "k", label: "k", fingerprint: "sk-…0000",
                                 spentUntil: "2026-09-30T06:00:00.000Z",
                                 contributor: PoolKeyContributor(userId: Self.wikova, name: "Wikova", you: true))
        XCTAssertEqual(SharedPoolPage.status(mine, in: pool).label, "Out of budget · resets Sep 30")
        let capped = try key(pool, "ios-build")
        XCTAssertTrue(SharedPoolPage.atCap(capped))
        let cappedAndSpent = SharedPoolKey(id: capped.id, label: capped.label, fingerprint: capped.fingerprint,
                                           shareCap: capped.shareCap, spentUntil: "2026-09-30T06:00:00.000Z",
                                           contributor: capped.contributor, usage: capped.usage)
        XCTAssertEqual(SharedPoolPage.status(cappedAndSpent, in: pool).label, "Out of budget · resets Sep 30")
        XCTAssertFalse(SharedPoolPage.allOutOfBudget(withIt))
        XCTAssertTrue(SharedPoolPage.allOutOfBudget(only))
    }

    /// A cap stops everyone's sessions on the key but its contributor's.
    func testAKeyAtItsCapIsAvailableToItsContributor() throws {
        let chen = asMember(try team(), userId: Self.chen)
        XCTAssertEqual(SharedPoolPage.status(try key(chen, "ios-build"), in: chen).label, "Available")
        XCTAssertEqual(ProviderPools.availability(SharedPools.asProviderPool(chen)), "3 of 5 keys you can run on available")
    }

    /// Its contributor, or an admin, is told to replace a refused key; anyone else is told who can.
    func testARefusedKeySaysWhoCanPutItBack() throws {
        let pool = try team()
        let mine = try key(pool, "wikova-backup")
        XCTAssertEqual(SharedPoolPage.invalidReason(mine, in: pool),
                       "Rejected by OpenAI — replace it with a working key to put it back in the pool.")
        XCTAssertTrue(SharedPoolPage.canReplace(mine, in: pool))
        let zhang = asMember(pool, userId: Self.zhang)
        let theirs = try key(zhang, "wikova-backup")
        XCTAssertEqual(SharedPoolPage.invalidReason(theirs, in: zhang),
                       "Rejected by OpenAI — only Wikova or the pool’s admins can replace it.")
        XCTAssertFalse(SharedPoolPage.canReplace(theirs, in: zhang))
        // An admin who didn't put it in may replace it too.
        let admin = asMember(pool, userId: Self.chen, role: .admin)
        XCTAssertTrue(SharedPoolPage.canReplace(try key(admin, "wikova-backup"), in: admin))
        XCTAssertNil(SharedPoolPage.invalidReason(try key(pool, "orbit-org-1"), in: pool))
    }

    func testTheMoneyIsWhatTheOthersSpentAgainstTheCap() throws {
        let pool = try team()
        XCTAssertEqual(SharedPoolPage.money(try key(pool, "orbit-org-1")), "$12.40 of $50")
        XCTAssertEqual(SharedPoolPage.capPercent(try key(pool, "orbit-org-1")), 25)
        XCTAssertEqual(SharedPoolPage.money(try key(pool, "ios-build")), "$50.00 of $50")
        XCTAssertEqual(SharedPoolPage.capPercent(try key(pool, "ios-build")), 100)
        XCTAssertEqual(SharedPoolPage.money(try key(pool, "zhang-old")), "$0.00 of $50")
        XCTAssertEqual(SharedPoolPage.capPercent(try key(pool, "zhang-old")), 0)
        let uncapped = SharedPoolKey(id: "k", label: "k", fingerprint: "sk-…0000",
                                     contributor: PoolKeyContributor(userId: Self.lin, name: "Lin Wei"),
                                     usage: PoolSpend(costUsd: 9, othersCostUsd: 3.1))
        XCTAssertEqual(SharedPoolPage.money(uncapped), "$3.10")
        XCTAssertNil(SharedPoolPage.capPercent(uncapped))
        XCTAssertFalse(SharedPoolPage.atCap(uncapped))
        // Nothing for the others at all: capped before anyone starts.
        let closed = SharedPoolKey(id: "k", label: "k", fingerprint: "sk-…0000", shareCap: 0,
                                   contributor: PoolKeyContributor(userId: Self.lin, name: "Lin Wei"))
        XCTAssertEqual(SharedPoolPage.capPercent(closed), 100)
        XCTAssertTrue(SharedPoolPage.atCap(closed))
    }

    func testTheKeyLineIsWhoseItIsAndItsFingerprint() throws {
        XCTAssertEqual(SharedPoolPage.keyLine(try key(try team(), "orbit-org-2")), "Zhang Min · sk-…7K2P")
    }

    /// The Accounts header: the key the server says a session of the reader's starts on now — theirs, once
    /// other people use the pool — or why there is none.
    func testTheAccountsHeaderNamesTheNextKeyOrWhyThereIsNone() throws {
        let pool = try team()
        func headline(_ pool: SharedPool) -> String { ProviderPools.headline(SharedPools.asProviderPool(pool)) }
        XCTAssertEqual(headline(pool), "Next for you: orbit-org-1")
        XCTAssertEqual(headline(SharedPool(id: "p", slug: "p", label: "P", keys: [try key(pool, "orbit-org-1")])),
                       "Next: orbit-org-1")
        XCTAssertEqual(headline(SharedPool(id: "p", slug: "p", label: "P")), "No keys")
        let dead = SharedPool(id: "p", slug: "p", label: "P",
                              keys: [try key(pool, "wikova-backup"), try key(pool, "zhang-old")])
        XCTAssertEqual(headline(dead), "No key can run")
        let capped = SharedPool(id: "p", slug: "p", label: "P", window: pool.window, keys: [try key(pool, "ios-build")])
        XCTAssertEqual(headline(capped), "All at cap · resets Oct 1")
    }

    // MARK: - people

    func testEachPersonsLineAndShareOfTheMonth() throws {
        let pool = try team()
        XCTAssertEqual(pool.people.map(SharedPoolPage.personLine),
                       ["2 keys · 23 sessions", "2 keys · 19 sessions", "1 key · 14 sessions", "No key · 6 sessions"])
        XCTAssertEqual(pool.people.map { SharedPoolPage.share($0, in: pool) }, [34, 30, 24, 12])
        let quiet = SharedPool(id: "p", slug: "p", label: "P",
                               people: [SharedPoolPerson(userId: "u", name: "U", keys: 1, sessions: 1)])
        XCTAssertEqual(SharedPoolPage.personLine(quiet.people[0]), "1 key · 1 session")
        XCTAssertEqual(SharedPoolPage.share(quiet.people[0], in: quiet), 0)
    }

    /// A person wears the same colour beside their keys as in Members: their place in the pool's list.
    func testAPersonsColourIsTheirPlaceInThePool() throws {
        let pool = try team()
        XCTAssertEqual([Self.wikova, Self.zhang, Self.chen, Self.lin].map { SharedPoolPage.avatarHex($0, in: pool) },
                       ["#3370FF", "#16A34A", "#DB2777", "#EA580C"])
        // Either spelling of the id names the same person.
        XCTAssertEqual(SharedPoolPage.avatarHex(try XCTUnwrap(PublicID.toUUID(Self.chen)), in: pool), "#DB2777")
        // Somebody not (or no longer) in the list takes the next place's.
        XCTAssertEqual(SharedPoolPage.avatarHex("nobody", in: pool), "#7C3AED")
        XCTAssertEqual(SharedPoolPage.initial(" zhang Min"), "Z")
        XCTAssertEqual(SharedPoolPage.initial(""), "?")
    }

    // MARK: - what the reader may do

    func testWhatAnAdminAndAMemberMayDo() throws {
        let pool = try team()
        XCTAssertTrue(SharedPoolPage.canAddKey(pool))
        XCTAssertTrue(SharedPoolPage.canRemove(try key(pool, "orbit-org-2"), in: pool), "an admin removes anyone's key")
        XCTAssertFalse(SharedPoolPage.canSwitch(try key(pool, "orbit-org-2")), "only its contributor switches it")
        XCTAssertTrue(SharedPoolPage.canSwitch(try key(pool, "orbit-org-1")))
        // Its maker manages everybody they added.
        let card = WhoCanUseIt(pool: pool, accounts: nil)
        XCTAssertEqual(pool.people.map(card.manages), [false, true, true, true])
        XCTAssertTrue(card.offersRoles, "a pool made on the shared pools page may have more admins than its maker")

        let zhang = asMember(pool, userId: Self.zhang)
        XCTAssertFalse(SharedPoolPage.isAdmin(zhang))
        XCTAssertTrue(SharedPoolPage.canAddKey(zhang), "members add keys while the rule is on")
        XCTAssertTrue(SharedPoolPage.canRemove(try key(zhang, "orbit-org-2"), in: zhang))
        XCTAssertFalse(SharedPoolPage.canRemove(try key(zhang, "orbit-org-1"), in: zhang))
        XCTAssertEqual(zhang.people.map(WhoCanUseIt(pool: zhang, accounts: nil).manages), [false, false, false, false])
        let closed = SharedPool(id: zhang.id, slug: zhang.slug, label: zhang.label, membersCanAdd: false,
                                viewerRole: .member, people: zhang.people, keys: zhang.keys)
        XCTAssertFalse(SharedPoolPage.canAddKey(closed))

        // Accounts go in on their own rule (migration 0371): an admin always, a member while it is on —
        // apart from the keys' rule, which says nothing about them.
        XCTAssertTrue(SharedPoolPage.canAddAccount(zhang), "members sign accounts of their own in while the rule is on")
        let accountsClosed = SharedPool(id: zhang.id, slug: zhang.slug, label: zhang.label,
                                        membersCanAddAccounts: false, viewerRole: .member,
                                        people: zhang.people, keys: zhang.keys)
        XCTAssertFalse(SharedPoolPage.canAddAccount(accountsClosed))
        XCTAssertTrue(SharedPoolPage.canAddAccount(SharedPool(id: accountsClosed.id, slug: accountsClosed.slug,
                                                               label: accountsClosed.label, membersCanAddAccounts: false,
                                                               viewerRole: .admin, people: zhang.people)))

        // Signing one in again, and taking it out: the person who signed it in's — its admins take anybody's
        // out, and only their own back in.
        XCTAssertEqual(SharedPoolPage.viewerId(zhang), Self.zhang)
        XCTAssertEqual(SharedPoolPage.viewerId(zhang), Self.zhang)
        XCTAssertEqual(SharedPoolPage.viewerId(pool), Self.wikova)
        let hers = CodexLogin(state: "SIGNED_OUT", email: "zhang@orbitd.io", fingerprint: "…AB12", userId: Self.zhang)
        let his = CodexLogin(state: "SIGNED_OUT", email: "wikova@orbitd.io", fingerprint: "…7K2P", userId: Self.wikova)
        // As Zhang (a member) reads them: hers is hers to bring back and to take out, Wikova's is neither.
        XCTAssertTrue(SharedPoolPage.canSignInAgain(hers, in: zhang))
        XCTAssertTrue(SharedPoolPage.canSignOut(hers, in: zhang))
        XCTAssertFalse(SharedPoolPage.canSignInAgain(his, in: zhang), "only the person who signed it in brings it back")
        XCTAssertFalse(SharedPoolPage.canSignOut(his, in: zhang))
        // As its admin reads them: her own to bring back, anybody's to take out — an admin has no
        // credential for somebody else's account.
        XCTAssertTrue(SharedPoolPage.canSignInAgain(his, in: pool))
        XCTAssertTrue(SharedPoolPage.canSignOut(his, in: pool), "an admin takes anybody's account out")
        XCTAssertFalse(SharedPoolPage.canSignInAgain(hers, in: pool))
        XCTAssertTrue(SharedPoolPage.canSignOut(hers, in: pool))
        // An account an older server sends without a `userId` is nobody's to bring back — an admin may still
        // take it out.
        XCTAssertFalse(SharedPoolPage.canSignInAgain(CodexLogin(email: "x@y.io", fingerprint: "…zzzz"), in: pool))
        XCTAssertTrue(SharedPoolPage.canSignOut(CodexLogin(email: "x@y.io", fingerprint: "…zzzz"), in: pool))
    }

    func testTheSentencesThatNameThePoolAKeyOrAPerson() throws {
        let pool = try team()
        let key = try key(pool, "orbit-org-2")
        XCTAssertEqual(SharedPoolPage.removeKeyTitle(key), "Remove orbit-org-2?")
        XCTAssertEqual(SharedPoolPage.removedKey(key), "orbit-org-2 is out of the pool")
        XCTAssertEqual(CodexPoolPage.deleteTitle(pool.label), "Delete Team Codex?")
        XCTAssertEqual(CodexPoolPage.leaveTitle(pool.label), "Leave Team Codex?")
        XCTAssertEqual(SharePool.title(pool), "Share Team Codex")
        XCTAssertEqual(SharePool.outcome(pool, missed: []), "Added to Team Codex")
        XCTAssertEqual(SharedPoolPage.removePersonTitle(pool.people[1], in: pool), "Remove Zhang Min from Team Codex?")
    }

    // MARK: - words

    func testACapComesBackOnADateInUTC() {
        XCTAssertEqual(SharedPoolPage.capReset("2026-10-01T00:00:00.000Z"), "Oct 1")
        XCTAssertEqual(SharedPoolPage.capReset("2027-01-01T00:00:00Z"), "Jan 1")
        XCTAssertNil(SharedPoolPage.capReset("soon"))
    }

    // MARK: - Add a key

    func testTheAddSheetSaysWhatPuttingAKeyInMeans() throws {
        let pool = try team()
        XCTAssertEqual(AddPoolKey.facts(pool).map { $0.lead + $0.rest }, [
            "Everyone in Team Codex can run sessions on it — 4 people. Their sessions spend this key’s budget.",
            "The key stays on the Orbit server. It never goes to a runner — runners get a session token, not the key — and nobody in the pool sees it or its full value.",
            "Take it out, or replace it, any time. Its usage shows on the pool’s page for everyone in it.",
        ])
        XCTAssertEqual(AddPoolKey.risk.lead + AddPoolKey.risk.rest,
                       "Keys can’t be resold. Everything run with this key is billed to its account, and the person who adds it is responsible for it.")
        XCTAssertEqual(AddPoolKey.limitHint(pool),
                       "Others in Team Codex can spend up to this on the key each month. Your own sessions aren’t limited by it.")
        XCTAssertEqual(AddPoolKey.doneTitle(label: "wikova-org-1", pool: pool), "wikova-org-1 is in Team Codex")
        XCTAssertEqual(AddPoolKey.doneRow(me: "Wikova", fingerprint: "sk-…9E4D"),
                       "Wikova · sk-…9E4D · only its fingerprint is ever shown")
        XCTAssertEqual(AddPoolKey.duplicateTitle(pool), "This key is already in Team Codex")
        XCTAssertEqual(AddPoolKey.duplicateDetail(AddPoolKey.AddedBy(name: "Wikova")),
                       "Wikova added it. The same key twice doesn’t add budget — add a different one.")
        XCTAssertEqual(AddPoolKey.duplicateDetail(AddPoolKey.AddedBy(name: "Wikova", you: true)),
                       "You added it. The same key twice doesn’t add budget — add a different one.")
        XCTAssertEqual(AddPoolKey.duplicateDetail(AddPoolKey.AddedBy(name: nil)),
                       "Someone added it. The same key twice doesn’t add budget — add a different one.")
        let one = SharedPool(id: "p", slug: "p", label: "Solo", people: [SharedPoolPerson(userId: "u", name: "U", you: true)])
        XCTAssertEqual(AddPoolKey.facts(one).first.map { $0.lead + $0.rest },
                       "Everyone in Solo can run sessions on it — 1 person. Their sessions spend this key’s budget.")
    }

    func testReplacingARefusedKeyNamesItAndItsFingerprint() throws {
        let pool = try team()
        let refused = try key(pool, "wikova-backup")
        XCTAssertEqual(AddPoolKey.replaceTitle(refused), "Replace wikova-backup")
        XCTAssertEqual(AddPoolKey.replaceLead(refused),
                       "OpenAI rejected sk-…M4T7. Paste a working key to put wikova-backup back in the pool.")
        XCTAssertEqual(AddPoolKey.replaced(refused, in: pool), "wikova-backup is back in Team Codex")
        XCTAssertEqual(AddPoolKey.replaceDuplicate(AddPoolKey.AddedBy(name: "Chen Yu"), pool: pool),
                       "This key is already in Team Codex — Chen Yu added it.")
        XCTAssertEqual(AddPoolKey.replaceDuplicate(AddPoolKey.AddedBy(name: "Wikova", you: true), pool: pool),
                       "This key is already in Team Codex — you added it.")
    }

    /// What the form shows of a key is what the pool will: `sk-…` and its last four characters.
    func testTheFormShowsOnlyTheFingerprintOfWhatIsTyped() {
        XCTAssertEqual(AddPoolKey.fingerprint(of: "sk-proj-9tRkQm2Zx8VbN4Lc7Hd39E4D"), "sk-…9E4D")
        XCTAssertEqual(AddPoolKey.fingerprint(of: "  sk-proj-9tRkQm2Zx8VbN4Lc7Hd39E4D\n"), "sk-…9E4D")
        XCTAssertEqual(AddPoolKey.fingerprint(of: "sk-12"), "sk-…k-12")
        XCTAssertEqual(AddPoolKey.fingerprint(of: ""), "sk-…")
    }

    func testTheFormTakesAWholeDollarLimitAndNeedsANameAndAKey() {
        XCTAssertEqual(AddPoolKey.limitDigits("$5a0 "), "50")
        XCTAssertEqual(AddPoolKey.limitDigits("12.5"), "125")
        XCTAssertEqual(AddPoolKey.shareCap("50"), 50)
        XCTAssertNil(AddPoolKey.shareCap(""))
        XCTAssertTrue(AddPoolKey.canSubmit(name: "a", key: "sk-x"))
        XCTAssertFalse(AddPoolKey.canSubmit(name: " ", key: "sk-x"))
        XCTAssertFalse(AddPoolKey.canSubmit(name: "a", key: " \n"))
    }

    /// A failed send, as the sheet reads it: the duplicate refusal names who put the key in (`addedBy`),
    /// and any other refusal is the server's own sentence.
    func testAFailedSendIsADuplicateOrTheServersReason() throws {
        let theirs = APIError.http(status: 409, body: #"{"code":"POOL_KEY_DUPLICATE","message":"This key is already in \"Team Codex\" — Chen Yu put it in","addedBy":{"name":"Chen Yu","you":false}}"#)
        XCTAssertEqual(AddPoolKey.outcome(of: theirs), .duplicate(AddPoolKey.AddedBy(name: "Chen Yu")))
        let mine = APIError.http(status: 409, body: #"{"code":"POOL_KEY_DUPLICATE","message":"…","addedBy":{"name":"Wikova","you":true}}"#)
        XCTAssertEqual(AddPoolKey.outcome(of: mine), .duplicate(AddPoolKey.AddedBy(name: "Wikova", you: true)))
        // An older server's refusal names nobody in a field: "Someone".
        let bare = APIError.http(status: 409, body: #"{"code":"POOL_KEY_DUPLICATE","message":"…"}"#)
        XCTAssertEqual(AddPoolKey.outcome(of: bare), .duplicate(AddPoolKey.AddedBy(name: nil)))
        let shape = APIError.http(status: 400, body: #"{"code":"POOL_KEY_FORMAT","message":"That isn't an OpenAI API key — paste an organization or project key (sk-…)"}"#)
        XCTAssertEqual(AddPoolKey.outcome(of: shape),
                       .refused("That isn't an OpenAI API key — paste an organization or project key (sk-…)"))
        XCTAssertEqual(AddPoolKey.outcome(of: URLError(.networkConnectionLost)), .refused("the connection dropped"))
    }

    func testTheAddedKeyIsTheOneThatWasntThereBefore() throws {
        let after = try team()
        let before = SharedPool(id: after.id, slug: after.slug, label: after.label, people: after.people,
                                keys: Array(after.keys.dropLast()))
        XCTAssertEqual(AddPoolKey.added(before: before, after: after)?.label, "zhang-old")
        XCTAssertNil(AddPoolKey.added(before: after, after: after))
    }
}
