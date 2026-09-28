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
    /// leaves them, and the fields this client doesn't read (timestamps, `shared`).
    private static let payload = """
    [{
      "id": "\(id(900))", "slug": "team-codex", "label": "Team Codex", "engine": "codex", "shared": true,
      "membersCanAdd": true, "ownKeyFirst": true, "viewerRole": "ADMIN",
      "window": {"start": "2026-09-01T00:00:00.000Z", "end": "2026-10-01T00:00:00.000Z"},
      "people": [
        {"userId": "\(wikova)", "name": "Wikova", "role": "ADMIN", "creator": true, "you": true, "keys": 2,
         "usage": {"inputTokens": 900, "outputTokens": 90, "costUsd": 34}},
        {"userId": "\(zhang)", "name": "Zhang Min", "role": "MEMBER", "creator": false, "you": false, "keys": 2,
         "usage": {"inputTokens": 800, "outputTokens": 80, "costUsd": 30}},
        {"userId": "\(chen)", "name": "Chen Yu", "role": "MEMBER", "creator": false, "you": false, "keys": 1,
         "usage": {"inputTokens": 700, "outputTokens": 70, "costUsd": 24}},
        {"userId": "\(lin)", "name": "Lin Wei", "role": "MEMBER", "creator": false, "you": false, "keys": 0,
         "usage": {"inputTokens": 300, "outputTokens": 30, "costUsd": 12}}
      ],
      "keys": [
        {"id": "\(id(11))", "label": "orbit-org-1", "fingerprint": "sk-…AB12", "state": "ACTIVE", "enabled": true,
         "shareCap": 50, "contributor": {"userId": "\(wikova)", "name": "Wikova", "you": true},
         "usage": {"inputTokens": 1, "outputTokens": 1, "costUsd": 20.5, "othersCostUsd": 12.4},
         "createdAt": "2026-09-02T00:00:00.000Z"},
        {"id": "\(id(12))", "label": "orbit-org-2", "fingerprint": "sk-…7K2P", "state": "ACTIVE", "enabled": true,
         "shareCap": 50, "contributor": {"userId": "\(zhang)", "name": "Zhang Min", "you": false},
         "usage": {"inputTokens": 1, "outputTokens": 1, "costUsd": 40, "othersCostUsd": 31},
         "createdAt": "2026-09-03T00:00:00.000Z"},
        {"id": "\(id(13))", "label": "ios-build", "fingerprint": "sk-…QZ03", "state": "ACTIVE", "enabled": true,
         "shareCap": 50, "contributor": {"userId": "\(chen)", "name": "Chen Yu", "you": false},
         "usage": {"inputTokens": 1, "outputTokens": 1, "costUsd": 55, "othersCostUsd": 50},
         "createdAt": "2026-09-04T00:00:00.000Z"},
        {"id": "\(id(14))", "label": "wikova-backup", "fingerprint": "sk-…M4T7", "state": "INVALID", "enabled": true,
         "shareCap": 50, "contributor": {"userId": "\(wikova)", "name": "Wikova", "you": true},
         "usage": {"inputTokens": 1, "outputTokens": 1, "costUsd": 6.2, "othersCostUsd": 6.2},
         "createdAt": "2026-09-05T00:00:00.000Z"},
        {"id": "\(id(15))", "label": "zhang-old", "fingerprint": "sk-…31FD", "state": "ACTIVE", "enabled": false,
         "shareCap": 50, "contributor": {"userId": "\(zhang)", "name": "Zhang Min", "you": false},
         "usage": {"inputTokens": 0, "outputTokens": 0, "costUsd": 0, "othersCostUsd": 0},
         "createdAt": "2026-09-06T00:00:00.000Z"}
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

    /// The pool as another person in it reads it: their role, and whose keys are "you".
    private func asMember(_ pool: SharedPool, userId: String, role: SharedPoolRole = .member) -> SharedPool {
        func mark(_ person: SharedPoolPerson) -> SharedPoolPerson {
            SharedPoolPerson(userId: person.userId, name: person.name, role: person.role, creator: person.creator,
                             you: person.userId == userId, keys: person.keys, usage: person.usage)
        }
        func mark(_ key: SharedPoolKey) -> SharedPoolKey {
            let c = key.contributor
            return SharedPoolKey(id: key.id, label: key.label, fingerprint: key.fingerprint, state: key.state,
                                 enabled: key.enabled, shareCap: key.shareCap,
                                 contributor: PoolKeyContributor(userId: c.userId, name: c.name, you: c.userId == userId),
                                 usage: key.usage)
        }
        return SharedPool(id: pool.id, slug: pool.slug, label: pool.label, engine: pool.engine,
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
        XCTAssertEqual(pool.viewerRole, .admin)
        XCTAssertTrue(pool.membersCanAdd)
        XCTAssertTrue(pool.ownKeyFirst)
        XCTAssertEqual(pool.window?.end, "2026-10-01T00:00:00.000Z")
        XCTAssertEqual(pool.people.map(\.name), ["Wikova", "Zhang Min", "Chen Yu", "Lin Wei"])
        XCTAssertEqual(pool.people.map(\.role), [.admin, .member, .member, .member])
        XCTAssertEqual(pool.people.map(\.keys), [2, 2, 1, 0])
        XCTAssertEqual(pool.people.first?.creator, true)
        XCTAssertEqual(pool.people.first?.you, true)
        XCTAssertEqual(pool.keys.map(\.label), ["orbit-org-1", "orbit-org-2", "ios-build", "wikova-backup", "zhang-old"])
        XCTAssertEqual(pool.keys.map(\.state), [.active, .active, .active, .invalid, .active])
        XCTAssertEqual(pool.keys.map(\.enabled), [true, true, true, true, false])
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

    func testOptionalFieldsFallBackWhenAServerOmitsThem() throws {
        let pool = try team(#"[{"id": "p1", "slug": "pool-a", "keys": [{"id": "k1", "contributor": {"userId": "u1"}}]}]"#)
        XCTAssertEqual(pool.label, "pool-a")
        XCTAssertEqual(pool.viewerRole, .unknown)
        XCTAssertTrue(pool.people.isEmpty)
        XCTAssertNil(pool.window)
        let only = try XCTUnwrap(pool.keys.first)
        XCTAssertEqual(only.state, .unknown)
        XCTAssertTrue(only.enabled)
        XCTAssertNil(only.shareCap)
        XCTAssertEqual(only.usage, PoolSpend())
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
    }

    // MARK: - Settings → Providers

    func testTheProvidersRowSaysSharedWithHowManyAndHowManyKeysCanRun() throws {
        let pool = try team()
        XCTAssertEqual(ProvidersOverview.sharedPoolLine(pool), "Shared · 4 members")
        XCTAssertEqual(ProvidersOverview.sharedPoolSummary(pool), "2 of 5 available")
        let alone = SharedPool(id: "p", slug: "p", label: "P", people: [SharedPoolPerson(userId: "u", name: "U")])
        XCTAssertEqual(ProvidersOverview.sharedPoolLine(alone), "Shared · 1 member")
        XCTAssertEqual(ProvidersOverview.sharedPoolSummary(alone), "0 of 0 available")
    }

    // MARK: - the head

    func testTheHeadCountsPeopleAndTheKeysASessionCouldStartOn() throws {
        XCTAssertEqual(SharedPoolPage.subtitle(try team()), "4 members · 2 of 5 keys available")
    }

    // MARK: - keys

    /// Each key's status, in the words and colours of the web's tags.
    func testEachKeysStatusIsTheWebsWordsAndColour() throws {
        let pool = try team()
        func status(_ label: String) throws -> PoolStatus {
            SharedPoolPage.status(try key(pool, label), in: pool, now: now, timeZone: berlin)
        }
        XCTAssertEqual(try status("orbit-org-1"), PoolStatus(label: "Available", tone: .success))
        XCTAssertEqual(try status("orbit-org-2"), PoolStatus(label: "Available", tone: .success))
        XCTAssertEqual(try status("ios-build"), PoolStatus(label: "At cap · resets Thu 02:00", tone: .warning))
        XCTAssertEqual(try status("wikova-backup"), PoolStatus(label: "Invalid", tone: .danger))
        XCTAssertEqual(try status("zhang-old"), PoolStatus(label: "Disabled", tone: .neutral))
        // OpenAI switched its organization off: out, however its contributor has it.
        let refused = SharedPoolKey(id: "k", label: "k", fingerprint: "sk-…0000", state: .disabled,
                                    contributor: PoolKeyContributor(userId: Self.lin, name: "Lin Wei"))
        XCTAssertEqual(SharedPoolPage.status(refused, in: pool, now: now), PoolStatus(label: "Disabled", tone: .neutral))
        // A pool read with no month to name says the cap without its reset.
        let noWindow = SharedPool(id: pool.id, slug: pool.slug, label: pool.label, keys: pool.keys)
        XCTAssertEqual(SharedPoolPage.status(try key(pool, "ios-build"), in: noWindow, now: now),
                       PoolStatus(label: "At cap", tone: .warning))
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
        XCTAssertEqual(SharedPoolPage.invalidReason(theirs, in: zhang), "Rejected by OpenAI — only Wikova can replace it.")
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
        // Nothing for the others at all: spent before anyone starts.
        let closed = SharedPoolKey(id: "k", label: "k", fingerprint: "sk-…0000", shareCap: 0,
                                   contributor: PoolKeyContributor(userId: Self.lin, name: "Lin Wei"))
        XCTAssertEqual(SharedPoolPage.capPercent(closed), 100)
        XCTAssertTrue(SharedPoolPage.atCap(closed))
    }

    func testTheKeyLineIsWhoseItIsAndItsFingerprint() throws {
        XCTAssertEqual(SharedPoolPage.keyLine(try key(try team(), "orbit-org-2")), "Zhang Min · sk-…7K2P")
    }

    /// The claim's own rule for the key a session starting now runs on, asked for whoever reads the page.
    func testTheNextKeyIsTheClaimsChoiceForTheReader() throws {
        let pool = try team()
        // Wikova, with "Own key first": the key of theirs that can run, however much room others have.
        XCTAssertEqual(SharedPoolPage.nextKey(pool)?.label, "orbit-org-1")
        XCTAssertEqual(SharedPoolPage.nextKey(pool).map(SharedPoolPage.nextLine), "Next: orbit-org-1")
        // Lin Wei has no key: the most room left, which orbit-org-1 has ($37.60 against $19).
        XCTAssertEqual(SharedPoolPage.nextKey(asMember(pool, userId: Self.lin))?.label, "orbit-org-1")
        // Chen Yu's own key is spent to its cap for the others — never for Chen Yu.
        XCTAssertEqual(SharedPoolPage.nextKey(asMember(pool, userId: Self.chen))?.label, "ios-build")
        // Without the rule, room decides: a key of one's own has all of it.
        let off = SharedPool(id: pool.id, slug: pool.slug, label: pool.label, ownKeyFirst: false,
                             viewerRole: .member, window: pool.window,
                             people: asMember(pool, userId: Self.zhang).people,
                             keys: asMember(pool, userId: Self.zhang).keys)
        XCTAssertEqual(SharedPoolPage.nextKey(off)?.label, "orbit-org-2")
        // Equal room goes to the lower id, compared as the ids the server orders by.
        let tie = SharedPool(id: "p", slug: "p", label: "P", people: [SharedPoolPerson(userId: Self.lin, name: "Lin Wei", you: true)],
                             keys: [SharedPoolKey(id: Self.id(22), label: "b", fingerprint: "sk-…0002",
                                                  contributor: PoolKeyContributor(userId: Self.chen, name: "Chen Yu")),
                                    SharedPoolKey(id: Self.id(21), label: "a", fingerprint: "sk-…0001",
                                                  contributor: PoolKeyContributor(userId: Self.zhang, name: "Zhang Min"))])
        XCTAssertEqual(SharedPoolPage.nextKey(tie)?.label, "a")
        // Nothing can run: no next key, and the header says nothing.
        let dead = SharedPool(id: "p", slug: "p", label: "P", keys: [try key(pool, "wikova-backup"), try key(pool, "zhang-old")])
        XCTAssertNil(SharedPoolPage.nextKey(dead))
    }

    // MARK: - people

    func testEachPersonsLineAndShareOfTheMonth() throws {
        let pool = try team()
        XCTAssertEqual(pool.people.map(SharedPoolPage.personLine), ["2 keys", "2 keys", "1 key", "No key"])
        XCTAssertEqual(pool.people.map { SharedPoolPage.share($0, in: pool) }, [34, 30, 24, 12])
        let quiet = SharedPool(id: "p", slug: "p", label: "P", people: [SharedPoolPerson(userId: "u", name: "U")])
        XCTAssertEqual(SharedPoolPage.share(quiet.people[0], in: quiet), 0)
    }

    /// A person wears the same colour beside their keys as in Members: their place in the pool's list.
    func testAPersonsColourIsTheirPlaceInThePool() throws {
        let pool = try team()
        XCTAssertEqual([Self.wikova, Self.zhang, Self.chen, Self.lin].map { SharedPoolPage.avatarHex($0, in: pool) },
                       ["#3370FF", "#16A34A", "#DB2777", "#EA580C"])
        // Either spelling of the id names the same person.
        XCTAssertEqual(SharedPoolPage.avatarHex(try XCTUnwrap(PublicID.toUUID(Self.chen)), in: pool), "#DB2777")
        XCTAssertEqual(SharedPoolPage.avatarHex("nobody", in: pool), "#8E8E93")
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

        let zhang = asMember(pool, userId: Self.zhang)
        XCTAssertFalse(SharedPoolPage.isAdmin(zhang))
        XCTAssertTrue(SharedPoolPage.canAddKey(zhang), "members add keys while the rule is on")
        XCTAssertTrue(SharedPoolPage.canRemove(try key(zhang, "orbit-org-2"), in: zhang))
        XCTAssertFalse(SharedPoolPage.canRemove(try key(zhang, "orbit-org-1"), in: zhang))
        let closed = SharedPool(id: zhang.id, slug: zhang.slug, label: zhang.label, membersCanAdd: false,
                                viewerRole: .member, people: zhang.people, keys: zhang.keys)
        XCTAssertFalse(SharedPoolPage.canAddKey(closed))
        XCTAssertEqual(SharedPoolPage.membersCanAddHint(pool),
                       "Anyone in Team Codex can put an OpenAI API key in. Off: only admins can.")
    }

    // MARK: - words

    func testTheResetIsATimeADayOrADate() {
        let at = { (iso: String) in SharedPoolPage.resetTime(iso, now: self.now, timeZone: self.berlin) }
        XCTAssertEqual(at("2026-09-28T20:30:00Z"), "22:30")
        XCTAssertEqual(at("2026-10-01T00:00:00.000Z"), "Thu 02:00")
        XCTAssertEqual(at("2026-11-01T00:00:00.000Z"), "Nov 1")
        XCTAssertNil(at("soon"))
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
        XCTAssertEqual(AddPoolKey.duplicateDetail(contributor: "Wikova"),
                       "Wikova added it. The same key twice doesn’t add budget — add a different one.")
        XCTAssertEqual(AddPoolKey.duplicateDetail(contributor: nil),
                       "The same key twice doesn’t add budget — add a different one.")
        let one = SharedPool(id: "p", slug: "p", label: "Solo", people: [SharedPoolPerson(userId: "u", name: "U", you: true)])
        XCTAssertEqual(AddPoolKey.facts(one).first.map { $0.lead + $0.rest },
                       "Everyone in Solo can run sessions on it — 1 person. Their sessions spend this key’s budget.")
    }

    /// What the form shows of a key is what the pool will: `sk-…` and its last four characters.
    func testTheFormShowsOnlyTheFingerprintOfWhatIsTyped() {
        XCTAssertEqual(AddPoolKey.fingerprint(of: "sk-proj-9tRkQm2Zx8VbN4Lc7Hd39E4D"), "sk-…9E4D")
        XCTAssertEqual(AddPoolKey.fingerprint(of: "  sk-proj-9tRkQm2Zx8VbN4Lc7Hd39E4D\n"), "sk-…9E4D")
        XCTAssertEqual(AddPoolKey.fingerprint(of: "sk-12"), "sk-…")
        XCTAssertEqual(AddPoolKey.fingerprint(of: ""), "sk-…")
    }

    func testTheFormSuggestsANameNoKeyHasAndReadsTheLimit() throws {
        let pool = try team()
        XCTAssertEqual(AddPoolKey.suggestedName(for: pool), "wikova-org-1")
        let taken = SharedPool(id: pool.id, slug: pool.slug, label: pool.label, people: pool.people,
                               keys: pool.keys + [SharedPoolKey(id: "k", label: "wikova-org-1", fingerprint: "sk-…0000",
                                                                contributor: PoolKeyContributor(userId: Self.wikova, name: "Wikova", you: true))])
        XCTAssertEqual(AddPoolKey.suggestedName(for: taken), "wikova-org-2")
        XCTAssertEqual(AddPoolKey.suggestedName(for: asMember(pool, userId: Self.zhang)), "zhang-org-1")
        XCTAssertEqual(AddPoolKey.shareCap("50"), 50)
        XCTAssertEqual(AddPoolKey.shareCap(" 7 "), 7)
        XCTAssertNil(AddPoolKey.shareCap(""))
        XCTAssertTrue(AddPoolKey.canSubmit(name: "a", key: "sk-x", limit: ""))
        XCTAssertTrue(AddPoolKey.canSubmit(name: "a", key: "sk-x", limit: "50"))
        XCTAssertFalse(AddPoolKey.canSubmit(name: " ", key: "sk-x", limit: ""))
        XCTAssertFalse(AddPoolKey.canSubmit(name: "a", key: "", limit: ""))
        XCTAssertFalse(AddPoolKey.canSubmit(name: "a", key: "sk-x", limit: "12.5"))
        XCTAssertFalse(AddPoolKey.canSubmit(name: "a", key: "sk-x", limit: "-3"))
    }

    /// Who put in the key the server turned away as a duplicate: read off the pool by the key's last four
    /// characters, else off the refusal itself.
    func testADuplicateNamesWhoPutTheKeyIn() throws {
        let pool = try team()
        XCTAssertEqual(AddPoolKey.duplicateContributor(typed: "sk-proj-aaaaaaaaaaaaaaaaaaaa7K2P", pool: pool, message: nil),
                       "Zhang Min")
        XCTAssertEqual(AddPoolKey.duplicateContributor(typed: "sk-proj-aaaaaaaaaaaaaaaaaaaaZZZZ", pool: pool,
                                                       message: "This key is already in \"Team Codex\" — Chen Yu put it in"),
                       "Chen Yu")
        XCTAssertNil(AddPoolKey.duplicateContributor(typed: "sk-proj-aaaaaaaaaaaaaaaaaaaaZZZZ", pool: pool,
                                                     message: "Conflict"))
    }

    /// A failed send, as the sheet reads it: the duplicate refusal names who put the key in, and any
    /// other refusal is the server's own sentence.
    func testAFailedSendIsADuplicateOrTheServersReason() throws {
        let pool = try team()
        let duplicate = APIError.http(status: 409, body: #"{"code":"POOL_KEY_DUPLICATE","message":"This key is already in \"Team Codex\" — Chen Yu put it in"}"#)
        XCTAssertEqual(AddPoolKey.outcome(of: duplicate, typed: "sk-proj-aaaaaaaaaaaaaaaaaaaaZZZZ", pool: pool),
                       .duplicate(contributor: "Chen Yu"))
        XCTAssertEqual(AddPoolKey.outcome(of: duplicate, typed: "sk-proj-aaaaaaaaaaaaaaaaaaaaAB12", pool: pool),
                       .duplicate(contributor: "Wikova"))
        let shape = APIError.http(status: 400, body: #"{"code":"POOL_KEY_FORMAT","message":"That isn't an OpenAI API key — paste an organization or project key (sk-…)"}"#)
        XCTAssertEqual(AddPoolKey.outcome(of: shape, typed: "abc", pool: pool),
                       .refused("That isn't an OpenAI API key — paste an organization or project key (sk-…)"))
        XCTAssertEqual(AddPoolKey.outcome(of: URLError(.networkConnectionLost), typed: "abc", pool: pool),
                       .refused("the connection dropped"))
    }

    func testTheAddedKeyIsTheCallersNewestOfThatName() throws {
        let pool = try team()
        XCTAssertEqual(AddPoolKey.added("orbit-org-1", in: pool)?.fingerprint, "sk-…AB12")
        XCTAssertNil(AddPoolKey.added("orbit-org-2", in: pool), "a key of that name that isn't the caller's")
    }
}
