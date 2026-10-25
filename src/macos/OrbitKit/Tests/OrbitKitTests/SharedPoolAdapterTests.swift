import XCTest
@testable import OrbitKit

/// A shared pool drawn as an account pool — web's `sharedPoolAsProviderPool` (`lib/sharedPools.ts`),
/// which is what lets the new-session picker and the composer take a pool of OpenAI keys as they take
/// one of the viewer's own Claude pools. Everything it reads is the server's answer (Models/SharedPools.swift);
/// what is checked here is the drawing: which member state a key's own state becomes, what the gauge
/// counts, and the words a pool nothing can run on is headed with.
final class SharedPoolAdapterTests: XCTestCase {

    // MARK: - fixtures

    private let window = SharedPoolWindow(start: "2026-09-01T00:00:00.000Z",
                                          end: "2026-10-01T00:00:00.000Z")
    private let wikova = PoolKeyContributor(userId: "u-wikova", name: "Wikova")
    private let me = PoolKeyContributor(userId: "u-me", name: "Me", you: true)

    private func key(_ label: String, state: PoolKeyState = .active, enabled: Bool = true,
                     cap: Int? = nil, contributor: PoolKeyContributor? = nil, others: Double = 0,
                     running: Bool = false, next: Bool = false,
                     spentUntil: String? = nil) -> SharedPoolKey {
        SharedPoolKey(id: "k-\(label)", label: label, fingerprint: "sk-…0000", state: state,
                      enabled: enabled, shareCap: cap, spentUntil: spentUntil,
                      contributor: contributor ?? wikova,
                      usage: PoolSpend(costUsd: others, othersCostUsd: others),
                      running: running, next: next)
    }

    private func pool(_ keys: [SharedPoolKey], people: [SharedPoolPerson] = []) -> SharedPool {
        SharedPool(id: "p-1", slug: "team-codex", label: "Team Codex", engine: "codex",
                   window: window,
                   people: people.isEmpty
                       ? [SharedPoolPerson(userId: "u-wikova", name: "Wikova", role: .admin, creator: true),
                          SharedPoolPerson(userId: "u-me", name: "Me", you: true)]
                       : people,
                   keys: keys)
    }

    // MARK: - a key as a member

    /// Where each key stands, in this client's member vocabulary, with the pool's own answers carried
    /// across: which key is next, whether it is switched on, and the key itself.
    func testAKeyBecomesAMemberThatCarriesTheServersAnswers() {
        let pool = self.pool([key("orbit-org-1", next: true),
                              key("orbit-org-2", running: true),
                              key("orbit-org-3", enabled: false),
                              key("orbit-org-4", state: .invalid),
                              key("orbit-org-5", state: .disabled)])
        let members = SharedPools.asProviderPool(pool).members
        XCTAssertEqual(members.map(\.label),
                       ["orbit-org-1", "orbit-org-2", "orbit-org-3", "orbit-org-4", "orbit-org-5"])
        // A key's own slug is its id: it is not a provider row and is never picked on its own.
        XCTAssertEqual(members.map(\.slug), members.map(\.id))
        XCTAssertTrue(members.allSatisfy { $0.presetSlug == "openai" })
        XCTAssertEqual(members.map(\.state), [.available, .running, .disabled, .refused, .disabled])
        XCTAssertEqual(members.map(\.next), [true, false, false, false, false])
        XCTAssertEqual(members[2].enabled, false)
        XCTAssertEqual(members[0].key?.id, "k-orbit-org-1", "the key itself rides along, as web's `member.key`")
    }

    /// A key the others have spent their share of this month is spent, and comes back when the month
    /// turns — a date the pool carries, not a window's clock.
    func testAKeyTheOthersCappedIsSpentUntilTheMonthTurns() {
        let pool = self.pool([key("orbit-org-1", cap: 50, others: 50)])
        let member = SharedPools.asProviderPool(pool).members[0]
        XCTAssertEqual(member.state, .spent)
        XCTAssertEqual(member.resetsAt, window.end)
        XCTAssertEqual(member.planUsage?.rows.first?.percent, 100)
        XCTAssertEqual(member.planUsage?.rows.first?.label, "Monthly limit")
        XCTAssertEqual(member.planUsage?.rows.first?.window.resetsAt, window.end)
    }

    /// Its contributor's own use is never capped, and a key with no cap has no gauge at all.
    func testYourOwnKeyIsNeverCappedAndAnUncappedOneHasNoGauge() {
        let mine = self.pool([key("mine", cap: 1, contributor: me, others: 99)])
        XCTAssertEqual(SharedPools.asProviderPool(mine).members[0].state, .available)
        let uncapped = self.pool([key("orbit-org-1", others: 12)])
        let member = SharedPools.asProviderPool(uncapped).members[0]
        XCTAssertNil(member.planUsage)
        XCTAssertNil(member.resetsAt)
    }

    /// A capped key's gauge is the share of its cap the others spent, in whole percent.
    func testACappedKeysGaugeIsWhatTheOthersSpentOfIt() {
        let pool = self.pool([key("orbit-org-1", cap: 100, others: 12.345)])
        XCTAssertEqual(SharedPools.asProviderPool(pool).members[0].planUsage?.rows.first?.percent, 12)
    }

    // MARK: - can this pool run at all

    /// Nothing to run on: no keys at all, or none of them a claim would take. Said in the words the
    /// pool's own page heads it with, which are web's.
    func testThePoolSaysWhyWhenNothingCanRun() {
        XCTAssertEqual(SharedPools.asProviderPool(self.pool([])).unavailable, "No keys")
        XCTAssertEqual(SharedPools.asProviderPool(
            self.pool([key("a", state: .invalid), key("b", enabled: false)])).unavailable, "No key can run")
        // One key a claim would take is enough — the pool is not greyed at all.
        XCTAssertNil(SharedPools.asProviderPool(self.pool([key("a", state: .invalid), key("b")])).unavailable)
        // Spent is not unable: the month turning brings its keys back.
        XCTAssertNil(SharedPools.asProviderPool(self.pool([key("a", cap: 5, others: 5)])).unavailable)
    }

    /// A member who put no key in still starts on the pool: the keys are the pool's, not theirs.
    func testAMemberWithNoKeyOfTheirOwnStillHasAPoolToStartOn() {
        let pool = self.pool([key("orbit-org-1", next: true), key("orbit-org-2")])
        let drawn = SharedPools.asProviderPool(pool)
        XCTAssertNil(drawn.unavailable)
        XCTAssertEqual(drawn.members.filter(\.next).map(\.label), ["orbit-org-1"])
        XCTAssertTrue(drawn.members.allSatisfy { !$0.key!.contributor.you })
    }

    // MARK: - the pool as a provider the picker and the composer run

    private let codexCatalog = RunnerModelCatalog(
        codex: [RunnerModelInfo(value: "gpt-5.6-sol", label: "GPT-5.6 Sol")])

    /// A shared pool runs Codex on OpenAI's own endpoint, so its models are the Codex CLI's — not the
    /// Claude CLI's, which is what the account pool beside it uses.
    func testASharedPoolRunsOnCodexWithTheCodexCLIsOwnModels() {
        let providers = ProviderPools.asProviders(SharedPools.asProviderPools([self.pool([key("a")])]))
        XCTAssertEqual(AgentDefaults.runtime(for: "team-codex", configured: providers), "codex")
        XCTAssertEqual(ProviderEngines.engines(ofProvider: "team-codex", configured: providers), ["codex"])
        XCTAssertEqual(AgentDefaults.models(engine: "codex", provider: "team-codex", catalog: codexCatalog,
                                            configured: providers).map(\.id), ["gpt-5.6-sol"])
        XCTAssertEqual(AgentDefaults.defaultModel(engine: "codex", provider: "team-codex", catalog: codexCatalog,
                                                  configured: providers), "gpt-5.6-sol")
        XCTAssertEqual(providers.first?.presetSlug, "openai")
        XCTAssertEqual(AgentDefaults.providerName("team-codex", configured: providers), "Team Codex")
    }

    /// The pick a member makes in the new-session picker is what a created session carries: the
    /// pool's own slug, as the web's selector sends it, with the model resolved in the Codex CLI's
    /// space rather than Claude's.
    func testThePickersPoolIsTheSlugASessionIsCreatedWith() throws {
        let pools = SharedPools.asProviderPools([self.pool([key("orbit-org-1", next: true)])])
        let providers = ProviderPools.asProviders(pools)
        let tile = try XCTUnwrap(SessionProviderChoices
            .providers(for: "codex", sources: ChoiceSources(configured: providers, catalog: codexCatalog, pools: pools))
            .first { $0.kind == .pool })
        XCTAssertEqual(tile.slug, "team-codex")
        XCTAssertEqual(tile.modelLabel, "GPT-5.6 Sol")
        let created = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(
            CreateSessionRequest(prompt: "do it", agentId: "ag1", engine: "codex", provider: tile.slug,
                                 model: AgentDefaults.defaultModel(engine: "codex", provider: tile.slug,
                                                                   catalog: codexCatalog,
                                                                   configured: providers)))) as? [String: Any])
        XCTAssertEqual(created["engine"] as? String, "codex")
        XCTAssertEqual(created["provider"] as? String, "team-codex")
        XCTAssertEqual(created["model"] as? String, "gpt-5.6-sol")
    }

    /// Every key capped, none next: the pool still takes the pick and says when the month turns — in
    /// the words the /providers card heads it with (`PoolGauge`'s "All at cap"), a date rather than a
    /// window's clock.
    func testAWholeSharedPoolSaysAllAtCapAndWhenTheMonthTurns() {
        let pool = SharedPools.asProviderPool(self.pool([key("a", cap: 5, others: 5),
                                                         key("b", cap: 5, others: 9)]))
        XCTAssertEqual(pool.resetsAt, window.end)
        XCTAssertEqual(ProviderPools.spentNote(pool), "All at cap · resets Oct 1")
        // A key the next session starts on — the viewer's own, which its cap never stops — says
        // nothing of being capped at all.
        let mine = SharedPools.asProviderPool(self.pool([key("a", cap: 5, others: 5),
                                                         key("mine", cap: 5, contributor: me,
                                                             others: 99, next: true)]))
        XCTAssertNil(ProviderPools.spentNote(mine))
    }

    /// A key OpenAI itself put out of budget comes back at its own mark rather than the month's end, and
    /// a pool left with nothing but such keys says that instead — the words the pool's own page heads
    /// its accounts with (`ProviderPools.headline`), at the earliest key back.
    func testAKeyOpenAIPutOutOfBudgetComesBackAtItsMark() {
        let spent = SharedPools.asProviderPool(self.pool([key("a", spentUntil: "2026-09-30T06:00:00.000Z")]))
        XCTAssertEqual(spent.members[0].state, .spent)
        XCTAssertEqual(spent.members[0].resetsAt, "2026-09-30T06:00:00.000Z")
        XCTAssertEqual(spent.resetsAt, "2026-09-30T06:00:00.000Z")
        XCTAssertEqual(ProviderPools.spentNote(spent), "All out of budget · resets Sep 30")
        // A cap among the stops keeps the cap's words, at the soonest of the two.
        let mixed = SharedPools.asProviderPool(self.pool([key("a", cap: 5, others: 5),
                                                         key("b", spentUntil: "2026-09-30T06:00:00.000Z")]))
        XCTAssertEqual(mixed.resetsAt, "2026-09-30T06:00:00.000Z")
        XCTAssertEqual(ProviderPools.spentNote(mixed), "All at cap · resets Sep 30")
    }

    /// What the composer says the key beside the gauge is: the one a session started now runs on,
    /// which for a shared pool is the key it picks for the viewer.
    func testTheComposerSaysAKeyIsWhatASharedPoolStartsOn() {
        let pool = SharedPools.asProviderPool(self.pool([key("orbit-org-1")]))
        let member = pool.members[0]
        XCTAssertEqual(ProviderPools.accountHelp(pool: pool, account: PoolAccount(member: member, current: false)),
                       "A session on Team Codex starts on orbit-org-1 — the key it picks for you right now")
        XCTAssertEqual(ProviderPools.accountHelp(pool: pool, account: PoolAccount(member: member, current: true)),
                       "Team Codex is running this session on orbit-org-1")
    }

    /// Which key a session is on travels in the shared pool's own field, and only on the detail —
    /// the list's summaries never carry it, and an event must not clear it.
    func testTheSessionDetailCarriesTheKeyItsClaimChose() throws {
        let decoder = JSONDecoder()
        let detail = #"{"id": "s1", "status": "RUNNING", "provider": "team-codex", "poolKeyId": "34JNbOSl1WkZm4QhuDl3nN"}"#
        XCTAssertEqual(try decoder.decode(Session.self, from: Data(detail.utf8)).poolKeyId,
                       "34JNbOSl1WkZm4QhuDl3nN")
        let listRow = #"{"id": "s1", "status": "RUNNING", "provider": "team-codex"}"#
        XCTAssertNil(try decoder.decode(Session.self, from: Data(listRow.utf8)).poolKeyId)
        let merged = try decoder.decode(Session.self, from: Data(detail.utf8))
            .settingTitle("Renamed")
        XCTAssertEqual(merged.poolKeyId, "34JNbOSl1WkZm4QhuDl3nN", "a rename keeps the key it is on")
    }

    /// A session on a shared pool is on the key its last claim recorded (`poolKeyId`) — the account
    /// pool's own read, in the shared pool's field.
    func testTheSessionIsOnTheKeyItsClaimRecorded() {
        let pool = SharedPools.asProviderPool(self.pool([key("orbit-org-1", next: true),
                                                         key("orbit-org-2")]))
        let recorded = ProviderPools.sessionAccount(in: pool, memberID: "k-orbit-org-2")
        XCTAssertEqual(recorded?.member.label, "orbit-org-2")
        XCTAssertEqual(recorded?.current, true)
        // Before the first claim it is the key the next one picks.
        XCTAssertEqual(ProviderPools.sessionAccount(in: pool, memberID: nil)?.member.label, "orbit-org-1")
        // A key that has left the pool names nobody: the next claim chooses again.
        XCTAssertNil(ProviderPools.sessionAccount(in: pool, memberID: "k-gone"))
    }
}
