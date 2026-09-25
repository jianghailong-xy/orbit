import XCTest
@testable import OrbitKit

/// Account pools as this client reads them: the GET /providers/pools payload, and what the picker
/// and the composer make of it. Mirrors web's providerPools.test.ts where the two overlap.
final class ProviderPoolsTests: XCTestCase {
    private let decoder = JSONDecoder()

    /// What `ProvidersService.poolViews` answers, as the public-id interceptor leaves it: base62 ids,
    /// the pool's timestamps (which this client doesn't read), each member's own quota.
    private let payload = """
    [{
      "id": "34JNaNRk0VjYl3PgtCk2mM", "slug": "claude-accounts", "label": "Claude accounts",
      "createdAt": "2026-09-25T01:00:00.000Z", "updatedAt": "2026-09-25T01:00:00.000Z",
      "resetsAt": null,
      "members": [
        {"id": "34JNbOSl1WkZm4QhuDl3nN", "slug": "anthropic", "label": "Work", "presetSlug": "anthropic",
         "enabled": true, "state": "RUNNING", "resetsAt": null, "next": false,
         "planUsage": {"provider": "claude", "fiveHour": {"utilization": 70, "resetsAt": "2026-09-25T11:00:00.000Z"},
                       "sevenDay": {"utilization": 31}, "fetchedAt": "2026-09-25T09:00:00.000Z"}},
        {"id": "34JNcPTm2XlaN5RivEm4oO", "slug": "anthropic-2", "label": "Home", "presetSlug": "anthropic",
         "enabled": true, "state": "AVAILABLE", "resetsAt": null, "next": true,
         "planUsage": {"provider": "claude", "fiveHour": {"utilization": 20}}},
        {"id": "34JNdQUn3YmbO6SjwFn5pP", "slug": "anthropic-3", "label": "Spare", "presetSlug": "anthropic",
         "enabled": true, "state": "SPENT", "resetsAt": "2026-09-25T10:30:00.000Z", "next": false,
         "planUsage": {"provider": "claude", "fiveHour": {"utilization": 100, "resetsAt": "2026-09-25T10:30:00.000Z"}}}
      ]
    }]
    """

    private func pools(_ json: String) throws -> [ProviderPool] {
        try decoder.decode([LossyDecodable<ProviderPool>].self, from: Data(json.utf8)).compactMap(\.value)
    }

    private func member(_ n: Int, _ state: PoolMemberState, next: Bool = false, label: String? = nil,
                        resetsAt: String? = nil, fiveHour: Double? = nil) -> PoolMember {
        PoolMember(id: PublicID.toPublic("0195c0de-0000-7000-8000-\(String(format: "%012d", n))"),
                   slug: "anthropic-\(n)", label: label ?? "Account \(n)", presetSlug: "anthropic",
                   planUsage: fiveHour.map { PlanUsageSnapshot(provider: "claude",
                                                               fiveHour: PlanUsageWindow(utilization: $0)) },
                   state: state, resetsAt: resetsAt, next: next)
    }

    private func pool(_ members: [PoolMember], resetsAt: String? = nil,
                      unavailable: String? = nil) -> ProviderPool {
        ProviderPool(id: PublicID.toPublic("0195c0de-0000-7000-8000-000000000900"),
                     slug: "claude-accounts", label: "Claude accounts", resetsAt: resetsAt,
                     unavailable: unavailable, members: members)
    }

    // MARK: - decoding

    func testDecodesThePoolListTheServerSends() throws {
        let list = try pools(payload)
        XCTAssertEqual(list.count, 1)
        let claude = try XCTUnwrap(list.first)
        XCTAssertEqual(claude.slug, "claude-accounts")
        XCTAssertEqual(claude.label, "Claude accounts")
        XCTAssertNil(claude.resetsAt)
        XCTAssertNil(claude.unavailable)
        XCTAssertEqual(claude.members.map(\.label), ["Work", "Home", "Spare"])
        XCTAssertEqual(claude.members.map(\.state), [.running, .available, .spent])
        XCTAssertEqual(claude.members.map(\.next), [false, true, false])
        XCTAssertEqual(claude.members[2].resetsAt, "2026-09-25T10:30:00.000Z")
        // Each member's own quota, read with its own credential.
        XCTAssertEqual(claude.members[0].planUsage?.primaryPercent, 70)
        XCTAssertEqual(claude.members[1].planUsage?.primaryPercent, 20)
    }

    /// A state added on the server is one this build can't name — it must not cost the user every
    /// pool they have, and it must not read as a spent account either.
    func testAStateThisBuildDoesNotKnowReadsAsUnknownAndTheListSurvives() throws {
        let json = payload.replacingOccurrences(of: "\"AVAILABLE\"", with: "\"RESTING\"")
        let list = try pools(json)
        XCTAssertEqual(list.first?.members.count, 3)
        XCTAssertEqual(list.first?.members[1].state, .unknown)
        XCTAssertNil(ProviderPools.spentNote(pool([member(1, .unknown)])))
    }

    /// Why nothing in a pool can run, when the server says so — and only a readable reason counts.
    func testThePoolCarriesTheServersReasonWhenNothingInItCanRun() throws {
        let stuck = payload.replacingOccurrences(of: "\"resetsAt\": null,\n  \"members\"",
                                                 with: "\"resetsAt\": null, \"unavailable\": \"No account can run\",\n  \"members\"")
        XCTAssertEqual(try pools(stuck).first?.unavailable, "No account can run")
        for odd in ["null", "\"\"", "{\"code\": \"NONE\"}", "3"] {
            let json = payload.replacingOccurrences(of: "\"resetsAt\": null,\n  \"members\"",
                                                    with: "\"resetsAt\": null, \"unavailable\": \(odd),\n  \"members\"")
            let list = try pools(json)
            XCTAssertEqual(list.map(\.slug), ["claude-accounts"], odd)
            XCTAssertNil(list.first?.unavailable, odd)
        }
    }

    func testFieldsThisBuildDoesNotKnowAreIgnored() throws {
        let json = payload
            .replacingOccurrences(of: "\"next\": true,", with: "\"next\": true, \"weight\": 3, \"tier\": {\"name\": \"max\"},")
            .replacingOccurrences(of: "\"resetsAt\": null,\n  \"members\"", with: "\"resetsAt\": null, \"strategy\": \"LEAST_USED\",\n  \"members\"")
        XCTAssertEqual(try pools(json).first?.members.map(\.label), ["Work", "Home", "Spare"])
    }

    /// A quota snapshot in a shape this build can't read is no quota — not a lost member.
    func testAnUnreadableQuotaIsNoQuotaAndKeepsTheMember() throws {
        let json = payload.replacingOccurrences(
            of: "\"planUsage\": {\"provider\": \"claude\", \"fiveHour\": {\"utilization\": 20}}",
            with: "\"planUsage\": {\"fiveHour\": {\"utilization\": \"twenty\"}}")
        let home = try XCTUnwrap(try pools(json).first?.members[1])
        XCTAssertEqual(home.label, "Home")
        XCTAssertNil(home.planUsage)
    }

    /// A member missing what identifies it is left out; its pool and the other members are not.
    func testAMemberThisBuildCannotReadIsLeftOutAndTheRestStay() throws {
        let json = payload.replacingOccurrences(of: "\"id\": \"34JNcPTm2XlaN5RivEm4oO\", ", with: "")
        XCTAssertEqual(try pools(json).first?.members.map(\.label), ["Work", "Spare"])
    }

    func testAPoolThisBuildCannotReadIsLeftOutAndTheOthersStay() throws {
        let broken = #"{"slug": "no-id", "label": "Broken", "members": []}"#
        let list = try pools("[\(broken), \(payload.dropFirst().dropLast())]")
        XCTAssertEqual(list.map(\.slug), ["claude-accounts"])
    }

    func testOptionalFieldsFallBackWhenAnOlderOrNewerServerOmitsThem() throws {
        let json = #"[{"id": "p1", "slug": "pool-a", "members": [{"id": "m1", "slug": "key-a"}]}]"#
        let only = try XCTUnwrap(try pools(json).first)
        XCTAssertEqual(only.label, "pool-a")
        XCTAssertNil(only.resetsAt)
        XCTAssertNil(only.unavailable)
        let m = try XCTUnwrap(only.members.first)
        XCTAssertEqual(m.label, "key-a")
        XCTAssertEqual(m.state, .unknown)
        XCTAssertTrue(m.enabled)
        XCTAssertFalse(m.next)
        XCTAssertNil(m.planUsage)
    }

    /// Session detail carries the member its last claim chose; the list and an older server don't.
    func testTheSessionDetailCarriesTheRecordedMember() throws {
        let detail = #"{"id": "s1", "status": "RUNNING", "provider": "claude-accounts", "poolMemberProviderId": "34JNbOSl1WkZm4QhuDl3nN"}"#
        XCTAssertEqual(try decoder.decode(Session.self, from: Data(detail.utf8)).poolMemberProviderId,
                       "34JNbOSl1WkZm4QhuDl3nN")
        let listRow = #"{"id": "s1", "status": "RUNNING", "provider": "claude-accounts"}"#
        XCTAssertNil(try decoder.decode(Session.self, from: Data(listRow.utf8)).poolMemberProviderId)
    }

    // MARK: - the account a session is on

    private lazy var work = member(1, .running, label: "Work", fiveHour: 70)
    private lazy var home = member(2, .available, next: true, label: "Home", fiveHour: 20)
    private lazy var claude = pool([work, home])

    func testASessionIsOnTheMemberItsLastClaimRecordedNotThePoolAndNotItsNextPick() {
        let account = ProviderPools.sessionAccount(in: claude, memberID: work.id)
        XCTAssertEqual(account, PoolAccount(member: work, current: true))
        XCTAssertNotEqual(account?.member.label, claude.label)
        // Its own quota, not the pool's next pick's.
        XCTAssertEqual(account?.member.planUsage?.primaryPercent, 70)
    }

    /// The detail spells ids base62 and a push or an older payload may spell them as UUIDs: the same
    /// member either way.
    func testTheRecordedMemberMatchesWhicheverSpellingItArrivesIn() throws {
        let uuid = try XCTUnwrap(PublicID.toUUID(work.id))
        XCTAssertEqual(ProviderPools.sessionAccount(in: claude, memberID: uuid)?.member, work)
        let upper = uuid.uppercased()
        XCTAssertEqual(ProviderPools.sessionAccount(in: claude, memberID: upper)?.member, work)
        let spelledAsUUID = pool([member(1, .running, label: "Work"), home].map { m in
            PoolMember(id: PublicID.toUUID(m.id) ?? m.id, slug: m.slug, label: m.label, state: m.state, next: m.next)
        })
        XCTAssertEqual(ProviderPools.sessionAccount(in: spelledAsUUID, memberID: work.id)?.member.label, "Work")
    }

    func testBeforeAnyClaimItIsTheMemberTheNextClaimPicks() {
        XCTAssertEqual(ProviderPools.sessionAccount(in: claude, memberID: nil),
                       PoolAccount(member: home, current: false))
        XCTAssertEqual(ProviderPools.sessionAccount(in: claude, memberID: ""),
                       PoolAccount(member: home, current: false))
    }

    func testItIsNobodyOnceTheRecordedMemberHasLeftThePool() {
        let gone = PublicID.toPublic("0195c0de-0000-7000-8000-000000000077")
        XCTAssertNil(ProviderPools.sessionAccount(in: claude, memberID: gone))
    }

    func testItIsNobodyBeforeAClaimWhenNoMemberCanRun() {
        XCTAssertNil(ProviderPools.sessionAccount(in: pool([member(1, .refused), member(2, .spent)]),
                                                  memberID: nil))
    }

    func testTheAccountSaysWhoseItIsInWebsWords() {
        XCTAssertEqual(ProviderPools.accountHelp(pool: claude, account: PoolAccount(member: work, current: true)),
                       "Claude accounts is running this session on Work")
        XCTAssertEqual(ProviderPools.accountHelp(pool: claude, account: PoolAccount(member: home, current: false)),
                       "A session on Claude accounts starts on Home — the account with the most room right now")
    }

    // MARK: - when the picker greys a pool out, and when it only says it is spent

    private let utc = TimeZone(identifier: "UTC")!
    private let now = RelativeTime.parse("2026-09-25T09:00:00.000Z")!

    /// Greyed on the server's word alone: only it knows which accounts its admission still takes, and
    /// every door that takes a provider refuses such a pool.
    func testAPoolIsGreyedOnlyWithTheServersReason() {
        XCTAssertEqual(ProviderPools.unavailableReason(pool([member(1, .noQuota)], unavailable: "No account can run")),
                       "No account can run")
        XCTAssertEqual(ProviderPools.unavailableReason(pool([], unavailable: "No accounts")), "No accounts")
        // Not without it, whatever its accounts read as — spent ones included.
        for states: [PoolMemberState] in [[.spent, .spent], [.spent, .available], [.refused, .disabled], [.unknown], []] {
            let members = states.enumerated().map { member($0.offset + 1, $0.element) }
            XCTAssertNil(ProviderPools.unavailableReason(pool(members, resetsAt: "2026-09-25T10:30:00.000Z")),
                         "\(states)")
        }
    }

    /// Every account that can run is spent: not greyed — the server takes the pool, and a session on
    /// it waits — but it says when the FIRST of them frees up, the reset the server put on the pool.
    func testAFullySpentPoolSaysWhenTheFirstAccountFreesUp() {
        let spent = pool([member(1, .spent, resetsAt: "2026-09-25T13:00:00.000Z"),
                          member(2, .spent, resetsAt: "2026-09-25T10:30:00.000Z")],
                         resetsAt: "2026-09-25T10:30:00.000Z")
        XCTAssertNil(ProviderPools.unavailableReason(spent))
        XCTAssertEqual(ProviderPools.spentNote(spent, now: now, timeZone: utc), "All spent · resets 10:30")
    }

    func testAResetMoreThanADayOutNamesItsDay() {
        let weekly = pool([member(1, .spent)], resetsAt: "2026-09-28T14:05:00.000Z")
        XCTAssertEqual(ProviderPools.spentNote(weekly, now: now, timeZone: utc), "All spent · resets Mon 14:05")
    }

    func testAFullySpentPoolWithNoResetSaysOnlyThatItIsSpent() {
        XCTAssertEqual(ProviderPools.spentNote(pool([member(1, .spent), member(2, .refused)]), now: now), "All spent")
    }

    /// An account the pool no longer admits reads as reporting no quota, yet no claim picks it: beside
    /// a spent one there is no account for the next session, and the pool is spent, not idle.
    func testAPoolWhoseOtherAccountItNoLongerAdmitsIsStillSpent() {
        let spent = pool([member(1, .noQuota), member(2, .spent)], resetsAt: "2026-09-25T10:30:00.000Z")
        XCTAssertEqual(ProviderPools.spentNote(spent, now: now, timeZone: utc), "All spent · resets 10:30")
    }

    func testAPoolWithAnAccountForTheNextSessionSaysNothingOfBeingSpent() {
        XCTAssertNil(ProviderPools.spentNote(pool([member(1, .spent), member(2, .available, next: true)]), now: now))
    }

    /// No reset brings back a pool the server says cannot run, not even the spent window of an account
    /// it no longer admits: its reason speaks instead.
    func testAPoolThatCannotRunSaysNothingOfAReset() {
        let stuck = pool([member(1, .spent)], resetsAt: "2026-09-25T10:30:00.000Z", unavailable: "No account can run")
        XCTAssertNil(ProviderPools.spentNote(stuck, now: now))
    }

    func testAResetTimeIsHoursAndMinutesWithinADayAndGetsItsDayBeyond() {
        XCTAssertEqual(ProviderPools.formatResetTime("2026-09-25T10:30:00.000Z", now: now, timeZone: utc), "10:30")
        XCTAssertEqual(ProviderPools.formatResetTime("2026-09-26T08:59:00Z", now: now, timeZone: utc), "08:59")
        XCTAssertEqual(ProviderPools.formatResetTime("2026-09-26T09:00:00.000Z", now: now, timeZone: utc), "Sat 09:00")
        XCTAssertNil(ProviderPools.formatResetTime("soon", now: now, timeZone: utc))
    }

    // MARK: - a pool as a provider the composer can run

    private let catalog = RunnerModelCatalog(claude: [RunnerModelInfo(value: "claude-opus-5", label: "Opus 5"),
                                                      RunnerModelInfo(value: "claude-sonnet-5", label: "Sonnet 5")])

    func testAPoolRunsOnClaudeWithTheClaudeCLIsOwnModels() {
        let providers = ProviderPools.asProviders([claude])
        XCTAssertEqual(AgentDefaults.runtime(for: "claude-accounts", configured: providers), "claude")
        XCTAssertEqual(AgentDefaults.models(for: "claude-accounts", catalog: catalog, configured: providers).map(\.id),
                       ["claude-opus-5", "claude-sonnet-5"])
        XCTAssertEqual(AgentDefaults.defaultModel(for: "claude-accounts", catalog: catalog, configured: providers),
                       "claude-opus-5")
        XCTAssertEqual(AgentDefaults.providerName("claude-accounts", configured: providers), "Claude accounts")
    }

    /// A pool has no quota of its own — each member has one — so nothing may read one off it.
    func testAPoolCarriesNoQuotaOfItsOwn() {
        let providers = ProviderPools.asProviders([claude])
        XCTAssertNil(providers.first?.planUsage)
        XCTAssertNil(AgentDefaults.planUsage(for: "claude-accounts",
                                             runner: PlanUsage(claude: PlanUsageSnapshot(fiveHour: PlanUsageWindow(utilization: 55))),
                                             configured: providers))
    }
}
