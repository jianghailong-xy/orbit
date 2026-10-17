import Foundation
import XCTest
@testable import OrbitKit

/// A pool's page on iOS says what the web's pool page says. `SharedPoolPage`, `AddPoolKey` and the
/// account pool's words in `ProviderPools` carry the web page's words for a pool's keys and people over to
/// the phone — what scheme A added to the page (who can use it, sharing, the locked line) is
/// `PoolAccessCopyParityTests`' — and nothing in either build notices a word changed at one end only — so
/// each one is looked up in the web source it came from. A sentence that names the pool, a key or a person is rendered with the web's own
/// expression in that place (`{pool.label}`, `${key.label}`), so the comparison is of the whole
/// sentence. A missing counterpart is a FAILURE, never an `XCTSkip`.
///
/// Deliberately not compared, because a sheet is not a dialog: "Add a key"'s title and lead, where the
/// web dialog's title carries the pool's name ("Add a key to Team Codex") and its lead says "this pool",
/// and the sheet's bar says "Add a key" and its lead names the pool; and the third thing putting a key
/// in means, whose usage the web says "shows on this page for everyone in the pool" and the sheet says
/// "shows on the pool’s page for everyone in it" — both as effect mock 05 draws them. The words only a
/// phone has to say are not compared either: the swipe's own labels.
final class SharedPoolCopyParityTests: XCTestCase {

    private static let sharedPool = "src/web/src/components/SharedPool.tsx"
    private static let accountPools = "src/web/src/components/AccountPools.tsx"
    private static let poolPage = "src/web/src/pages/ProviderPoolPage.tsx"
    private static let sharedPools = "src/web/src/lib/sharedPools.ts"
    private static let providerPools = "src/web/src/lib/providerPools.ts"
    private static let sessionProviderChoices = "src/web/src/lib/sessionProviderChoices.ts"

    private enum ParityError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let file):
                return "\(file) was not found above this test file. A pool's page on iOS is one half of a pair; "
                    + "if the web half moved, move this check with it rather than deleting it."
            }
        }
    }

    /// The web file, with its string concatenations joined and every run of whitespace made one space:
    /// where a long sentence or a JSX text node breaks its line is layout, the words are the contract.
    private func web(_ relative: String) throws -> String {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try String(contentsOf: candidate, encoding: .utf8)
                    .replacingOccurrences(of: "'\\s*\\+\\s*'", with: "", options: .regularExpression)
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

    /// A pool whose name, people and keys are the web's own expressions for them.
    private func pool(_ label: String) -> SharedPool {
        SharedPool(id: "p", slug: "p", label: label)
    }

    private func key(label: String, fingerprint: String = "sk-…0000", contributor: String = "Wikova",
                     you: Bool = false) -> SharedPoolKey {
        SharedPoolKey(id: "k", label: label, fingerprint: fingerprint, state: .invalid,
                      contributor: PoolKeyContributor(userId: "u", name: contributor, you: you))
    }

    /// What the pool page says of a key it took out, and of a pool that is gone.
    func testThePoolPageSaysWhatTheWebPageSays() throws {
        let page = try web(Self.poolPage)
        assertSays(page, "message.success(`\(SharedPoolPage.removedKey(key(label: "${key.label}")))`)", in: Self.poolPage)
        assertSays(page, "\(ProvidersOverview.poolGone)", in: Self.poolPage)
    }

    /// A key's row: its chips, its status words, why a refused one is out, and what can be done to it.
    func testAKeysRowSaysWhatTheWebRowSays() throws {
        let row = try web(Self.accountPools)
        assertSays(row, "<span className=\"pool-you\">\(SharedPoolPage.you)</span>", in: Self.accountPools)
        assertSays(row, "<span className=\"re-chip\">\(SharedPoolPage.nextChip)</span>", in: Self.accountPools)
        assertSays(row, "{key.contributor.name} · {key.fingerprint}", in: Self.accountPools)
        let mine = key(label: "${key.label}", you: true)
        let theirs = key(label: "${key.label}", contributor: "${key.contributor.name}")
        let asMember = pool("${pool.label}")
        assertSays(row, "'\(try XCTUnwrap(SharedPoolPage.invalidReason(mine, in: asMember)))'", in: Self.accountPools)
        assertSays(row, "`\(try XCTUnwrap(SharedPoolPage.invalidReason(theirs, in: asMember)))`", in: Self.accountPools)
        assertSays(row, "> \(SharedPoolPage.replaceKey) </Button>", in: Self.accountPools)
        assertSays(row, "key.enabled ? '\(SharedPoolPage.disableKey)' : '\(SharedPoolPage.enableKey)'", in: Self.accountPools)
        assertSays(row, "title={`\(SharedPoolPage.removeKeyTitle(key(label: "${key.label}")))`}", in: Self.accountPools)
        assertSays(row, "description=\"\(SharedPoolPage.removeKeyNote)\"", in: Self.accountPools)
        assertSays(row, "confirmText=\"\(SharedPoolPage.remove)\"", in: Self.accountPools)
        // "No keys yet — …", in the web's one sentence for both kinds of pool.
        assertSays(row, "No {shared ? 'keys' : 'accounts'}\(SharedPoolPage.noKeys.dropFirst("No keys".count))",
                   in: Self.accountPools)
        // The first run of a stopped pool of keys' head: "All at cap", or "All out of budget" when that
        // is what stopped them (`ProviderPools.spentHead` says the same).
        assertSays(row, "!keysOnly ? 'All spent' : allOutOfBudget(pool.shared!) ? '\(SharedPoolPage.allOutOfBudgetWords)' : '\(SharedPoolPage.allAtCapWords)'",
                   in: Self.accountPools)
    }

    /// Each key's status tag, and what the Keys header says when no key is next.
    func testAKeysStatusIsTheWebsTag() throws {
        let tags = try web(Self.providerPools)
        let pool = SharedPool(id: "p", slug: "p", label: "P",
                              window: SharedPoolWindow(start: "2026-09-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z"))
        func status(_ key: SharedPoolKey) -> String { SharedPoolPage.status(key, in: pool).label }
        let who = PoolKeyContributor(userId: "u", name: "U")
        let available = SharedPoolKey(id: "k", label: "k", fingerprint: "f", contributor: who)
        let running = SharedPoolKey(id: "k", label: "k", fingerprint: "f", contributor: who, running: true)
        let invalid = SharedPoolKey(id: "k", label: "k", fingerprint: "f", state: .invalid, contributor: who)
        let off = SharedPoolKey(id: "k", label: "k", fingerprint: "f", enabled: false, contributor: who)
        assertSays(tags, "label: '\(status(available))', color: 'green'", in: Self.providerPools)
        assertSays(tags, "label: '\(status(running))', color: 'processing'", in: Self.providerPools)
        assertSays(tags, "label: '\(status(invalid))', color: 'red'", in: Self.providerPools)
        assertSays(tags, "label: '\(status(off))', color: 'default'", in: Self.providerPools)
        assertSays(tags, "`At cap · resets ${formatCapReset(member.resetsAt)}` : 'At cap'", in: Self.providerPools)
        assertSays(tags, "keysOnly ? 'No key can run' : 'No account can run'", in: Self.providerPools)

        // A key OpenAI put out of budget (P2's `spentUntil`) says so, with the date its mark runs to, in
        // the web's own sentence and colour — and out of budget outranks the cap.
        let outOfBudget = SharedPoolKey(id: "k", label: "k", fingerprint: "f",
                                        spentUntil: "2026-09-30T06:00:00.000Z", contributor: who)
        XCTAssertEqual(status(outOfBudget), "Out of budget · resets Sep 30")
        assertSays(tags, "label: `Out of budget · resets ${formatCapReset(member.key.spentUntil)}`, color: 'orange'",
                   in: Self.providerPools)
        // ...and the Accounts header, when none of them can run, says which of the two stopped them, in the
        // two words the web's pool head chooses between.
        let gauge = try web(Self.accountPools)
        assertSays(gauge, "allOutOfBudget(pool.shared!) ? '\(SharedPoolPage.allOutOfBudgetWords)' : '\(SharedPoolPage.allAtCapWords)'",
                   in: Self.accountPools)

        let lib = try web(Self.sharedPools)
        assertSays(lib, "pool.keys.length === 0 ? pool.shared ? 'No keys' : 'Not signed in' : 'No key can run',",
                   in: Self.sharedPools)
        assertSays(lib, "{ month: 'short', day: 'numeric', timeZone: 'UTC' }", in: Self.sharedPools)
        assertSays(lib, "`sk-…${key.trim().slice(-4)}`", in: Self.sharedPools)
        // The colours people wear, in the web's order.
        let palette = SharedPoolPage.avatarPalette.map { "'\($0.lowercased())'" }.joined(separator: ", ")
        assertSays(lib, "[\(palette)]", in: Self.sharedPools)
    }

    /// A person's row as anybody but the pool's owner reads it, and what its owner does to one.
    func testPeopleSayWhatTheWebCardSays() throws {
        let card = try web(Self.sharedPool)
        assertSays(card, "<span className=\"re-chip\">\(SharedPoolPage.adminChip)</span>", in: Self.sharedPool)
        let person = SharedPoolPerson(userId: "u", name: "N", keys: 2, sessions: 1)
        XCTAssertEqual(SharedPoolPage.personLine(person), "2 keys · 1 session")
        assertSays(card, "`${person.keys ? plural(person.keys, 'key') : 'No key'} · ${sessions}`", in: Self.sharedPool)
        assertSays(card, "person.role === 'ADMIN' ? '\(SharedPoolPage.makeMember)' : '\(SharedPoolPage.makeAdmin)'",
                   in: Self.sharedPool)
        assertSays(card, "label: '\(SharedPoolPage.removeFromPool)', danger: true", in: Self.sharedPool)
        let someone = SharedPoolPerson(userId: "u", name: "${person.name}")
        assertSays(card, "title: `\(SharedPoolPage.removePersonTitle(someone, in: pool("${pool.label}")))`", in: Self.sharedPool)
        assertSays(card, "description: '\(SharedPoolPage.removePersonNote)',", in: Self.sharedPool)
    }

    /// "Add a key", step by step, and "Replace key".
    func testAddingAKeySaysWhatTheWebDialogSays() throws {
        let dialog = try web(Self.sharedPool)
        let named = pool("{pool.label}")
        let facts = AddPoolKey.facts(named)
        assertSays(dialog, "<b>\(facts[0].lead)</b>", in: Self.sharedPool)
        assertSays(dialog, "{plural(pool.people.length, 'person', 'people')}. Their sessions spend this key’s budget.",
                   in: Self.sharedPool)
        assertSays(dialog, "<b>\(facts[1].lead)</b>\(facts[1].rest)", in: Self.sharedPool)
        assertSays(dialog, "<b>\(facts[2].lead)</b>", in: Self.sharedPool)
        assertSays(dialog, "<b>\(AddPoolKey.risk.lead)</b>\(AddPoolKey.risk.rest)", in: Self.sharedPool)
        assertSays(dialog, "> \(AddPoolKey.continueLabel) </Button>", in: Self.sharedPool)
        assertSays(dialog, ">\(AddPoolKey.cancel)</Button>", in: Self.sharedPool)
        assertSays(dialog, "> \(AddPoolKey.submit) </Button>", in: Self.sharedPool)
        assertSays(dialog, ">\(AddPoolKey.close)</Button>", in: Self.sharedPool)
        assertSays(dialog, "> \(AddPoolKey.addAnother) </Button>", in: Self.sharedPool)
        assertSays(dialog, "> \(AddPoolKey.done) </Button>", in: Self.sharedPool)
        assertSays(dialog, "<div className=\"pa-lead\">\(AddPoolKey.formLead)</div>", in: Self.sharedPool)
        assertSays(dialog, "<span className=\"np-field-l\">\(AddPoolKey.name)</span>", in: Self.sharedPool)
        assertSays(dialog, "<span className=\"np-field-l\">\(AddPoolKey.key)</span>", in: Self.sharedPool)
        assertSays(dialog, "placeholder=\"\(AddPoolKey.keyPlaceholder)\"", in: Self.sharedPool)
        assertSays(dialog, "\(AddPoolKey.keyHintPrefix)<b>{maskTyped(value)}</b>\(AddPoolKey.keyHintSuffix)", in: Self.sharedPool)
        assertSays(dialog, "<span className=\"np-field-l\">\(AddPoolKey.limit)</span>", in: Self.sharedPool)
        assertSays(dialog, "prefix=\"\(AddPoolKey.limitPrefix)\" suffix=\"\(AddPoolKey.limitSuffix)\"", in: Self.sharedPool)
        assertSays(dialog, "placeholder=\"\(AddPoolKey.noLimit)\"", in: Self.sharedPool)
        assertSays(dialog, "> \(AddPoolKey.limitHint(named)) </div>", in: Self.sharedPool)
        assertSays(dialog, AddPoolKey.doneTitle(label: "{added.label}", pool: named), in: Self.sharedPool)
        assertSays(dialog, "<b>{added.fingerprint}</b>\(AddPoolKey.doneDetail)", in: Self.sharedPool)
        assertSays(dialog, AddPoolKey.doneRow(me: "{me.name}", fingerprint: "{added.fingerprint}"), in: Self.sharedPool)
        assertSays(dialog, AddPoolKey.duplicateTitle(named), in: Self.sharedPool)
        let duplicate = AddPoolKey.duplicateDetail(AddPoolKey.AddedBy(name: nil))
        assertSays(dialog, "{addedBy?.you ? 'You' : (addedBy?.name ?? 'Someone')}\(duplicate.dropFirst("Someone".count))",
                   in: Self.sharedPool)

        let refused = key(label: "${poolKey.label}")
        assertSays(dialog, "title={`\(AddPoolKey.replaceTitle(refused))`}", in: Self.sharedPool)
        assertSays(dialog, "> \(SharedPoolPage.replaceKey) </Button>", in: Self.sharedPool)
        let lead = AddPoolKey.replaceLead(key(label: "{poolKey.label}", fingerprint: "{poolKey.fingerprint}"))
        assertSays(dialog, "> \(lead) </div>", in: Self.sharedPool)
        assertSays(dialog, "message.success(`\(AddPoolKey.replaced(refused, in: pool("${pool.label}")))`)", in: Self.sharedPool)
        assertSays(dialog, "`This key is already in ${pool.label} — ${by.you ? 'you' : by.name} added it.`",
                   in: Self.sharedPool)
        XCTAssertEqual(AddPoolKey.replaceDuplicate(AddPoolKey.AddedBy(name: "Chen Yu"), pool: pool("Team Codex")),
                       "This key is already in Team Codex — Chen Yu added it.")
    }

    /// The new-session picker and the composer take a shared pool as web takes it: drawn as an account
    /// pool whose members are its keys (`sharedPoolAsProviderPool`), running Codex rather than Claude,
    /// wearing its keys' count and the key's own words. Each line below is the web's own expression for
    /// it, so a field or a sentence that moved at one end only fails here.
    func testThePickerAndTheComposerDrawASharedPoolAsTheWebDoes() throws {
        let lib = try web(Self.sharedPools)
        let window = SharedPoolWindow(start: "2026-09-01T00:00:00.000Z",
                                      end: "2026-10-01T00:00:00.000Z")
        let capped = SharedPoolKey(id: "k", label: "orbit-org-1", fingerprint: "sk-…0000", shareCap: 50,
                                   contributor: PoolKeyContributor(userId: "u", name: "Wikova"),
                                   usage: PoolSpend(costUsd: 50, othersCostUsd: 50))
        let mine = SharedPoolKey(id: "k2", label: "ios-build", fingerprint: "sk-…0000",
                                 contributor: PoolKeyContributor(userId: "me", name: "Me", you: true))
        func pool(_ keys: [SharedPoolKey]) -> SharedPool {
            SharedPool(id: "p", slug: "team-codex", label: "Team Codex", window: window, keys: keys)
        }
        let drawn = SharedPools.asProviderPool(pool([capped]))

        // The adapter, line for line: a key is the member, its state keyState's, its cap's gauge — and a
        // pool of somebody's own gets its ChatGPT accounts as members first (2026-10-03).
        assertSays(lib, "presetSlug: 'openai',", in: Self.sharedPools)
        assertSays(lib, "planUsage: keyWindow(key, pool),", in: Self.sharedPools)
        assertSays(lib, "...(pool.logins ?? []).map((login) => loginMember(pool, login)), ...keyMembers(pool)",
                   in: Self.sharedPools)
        assertSays(lib, "next: login.next && !accountIsPaused(login.pausedUntil),", in: Self.sharedPools)
        // A stopped key's reset is its own mark when OpenAI set one, else the month's end; the pool's is
        // the EARLIEST of those, both as this client reads them (`SharedPoolPage.earliest`).
        assertSays(lib, "resetsAt: state === 'SPENT' ? (key.spentUntil ?? pool.window.end) : null,",
                   in: Self.sharedPools)
        assertSays(lib, "next: key.next && !accountIsPaused(key.pausedUntil),", in: Self.sharedPools)
        assertSays(lib, "resetsAt: !free && stops.length > 0 ? earliest(stops) : null,", in: Self.sharedPools)
        assertSays(lib, "const earliest = (stops: string[]): string => stops.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));",
                   in: Self.sharedPools)
        assertSays(lib, "unavailable: revives ? null : accounts.length > 0 ? 'Signed out' : pool.keys.length === 0 ? pool.shared ? 'No keys' : 'Not signed in' : 'No key can run',",
                   in: Self.sharedPools)
        assertSays(lib, "shared: pool,", in: Self.sharedPools)
        XCTAssertEqual(drawn.members[0].presetSlug, "openai")
        XCTAssertEqual(drawn.members[0].state, .spent)
        XCTAssertEqual(drawn.members[0].resetsAt, window.end)
        XCTAssertEqual(drawn.resetsAt, window.end)
        XCTAssertEqual(SharedPools.asProviderPool(pool([])).unavailable, "No keys")
        let refused = SharedPoolKey(id: "k3", label: "orbit-org-3", fingerprint: "sk-…0000", state: .invalid,
                                    contributor: PoolKeyContributor(userId: "u", name: "Wikova"))
        XCTAssertEqual(SharedPools.asProviderPool(pool([refused])).unavailable, "No key can run")
        // A key the others have capped is not a pool that cannot run: the month brings it back, so
        // the pool takes a session and waits (`spentNote`), exactly as web's `runnable` reads it.
        XCTAssertNil(drawn.unavailable)
        XCTAssertEqual(drawn.shared?.slug, "team-codex", "the whole view rides along, as web's `shared`")

        // This pool's CLI is Codex, with Codex's own models and mark — the account pool's is Claude (and
        // a pool of one's own ChatGPT account's is Codex too: CodexSignInCopyParityTests).
        let providers = ProviderPools.asProviders([drawn])
        let poolsLib = try web(Self.providerPools)
        assertSays(poolsLib, "runtime: poolRunsCodex(pool) ? AgentProvider.CODEX : AgentProvider.CLAUDE,",
                   in: Self.providerPools)
        assertSays(poolsLib, "!!pool.shared || pool.engine === AgentProvider.CODEX;", in: Self.providerPools)
        XCTAssertEqual(AgentDefaults.runtime(for: "team-codex", configured: providers), "codex")
        XCTAssertEqual(providers.first?.presetSlug, "openai")
        XCTAssertEqual(ProviderPools.asProviders([drawn]).first?.runtime, "codex")

        // The picker's row: a choice on that CLI, wearing how many keys it holds.
        let choices = SessionProviderChoices.providers(for: "codex", sources: ChoiceSources(configured: providers, pools: [drawn]))
        let tile = try XCTUnwrap(choices.first { $0.slug == "team-codex" })
        let choicesSource = try web(Self.sessionProviderChoices)
        assertSays(choicesSource, "const poolEngine = (pool: PoolChoiceSource): AgentProvider =>",
                   in: Self.sessionProviderChoices)
        assertSays(choicesSource,
                   "pool.shared || pool.engine === AgentProvider.CODEX ? AgentProvider.CODEX : AgentProvider.CLAUDE;",
                   in: Self.sessionProviderChoices)
        assertSays(choicesSource, "poolUnit: 'key' as const", in: Self.sessionProviderChoices)
        assertSays(choicesSource, "poolUnit?: 'key';", in: Self.sessionProviderChoices)
        XCTAssertEqual(tile.brandKey, "openai")
        XCTAssertEqual(tile.poolUnit, "key")
        XCTAssertEqual(tile.poolSize, 1)

        // The composer: the key beside the quota is the one the pool picks for the viewer.
        let account = PoolAccount(member: drawn.members[0], current: false)
        XCTAssertEqual(ProviderPools.accountHelp(pool: drawn, account: account),
                       "A session on Team Codex starts on orbit-org-1 — the key it picks for you right now")
        // A key with no cap has no gauge, and the others' cap is a month, not a window.
        let uncapped = SharedPools.asProviderPool(pool([mine]))
        XCTAssertNil(uncapped.members[0].planUsage)
        XCTAssertEqual(drawn.members[0].planUsage?.rows.first?.window.windowDurationMins, 30 * 24 * 60)
    }

    /// An account pool's page, read-only on a phone: its head, its accounts and their status tags.
    func testAnAccountPoolsPageSaysWhatTheWebPageSays() throws {
        let page = try web(Self.poolPage)
        let footer = ProviderPools.accountsFooter.prefix(1).lowercased() + ProviderPools.accountsFooter.dropFirst()
        assertSays(page, "\(ProviderPools.pageTitle) · {availabilityOf(pool, refusals)} · \(footer)", in: Self.poolPage)
        assertSays(page, "<span className=\"re-runner\">\(ProviderPools.accountsHeader)</span>", in: Self.poolPage)

        let tags = try web(Self.providerPools)
        func member(_ state: PoolMemberState) -> PoolMember { PoolMember(id: "m", slug: "m", label: "M", state: state) }
        assertSays(tags, "label: '\(ProviderPools.memberStatus(member(.running)).label)', color: 'processing'", in: Self.providerPools)
        assertSays(tags, "label: '\(ProviderPools.memberStatus(member(.refused)).label)', color: 'red'", in: Self.providerPools)
        // The two ways the endpoint turns a credential away are two labels, word for word with the web's.
        assertSays(tags, "label: '\(ProviderPools.memberStatus(member(.usageUnknown)).label)', color: 'default'",
                   in: Self.providerPools)
        XCTAssertEqual(ProviderPools.memberStatus(member(.usageUnknown)).label, "Unavailable · usage unreadable")
        assertSays(tags, "label: '\(ProviderPools.memberStatus(member(.noQuota)).label)', color: 'default'", in: Self.providerPools)
        assertSays(tags, "`Spent · resets ${formatResetTime(member.resetsAt, now)}` : 'Spent'", in: Self.providerPools)

        let card = try web(Self.accountPools)
        // "Next: …" — but a pool of one's own ChatGPT account names its one account instead.
        assertSays(card, "`Next: ${member.label}`", in: Self.accountPools)
        let three = ProviderPool(id: "p", slug: "p", label: "P",
                                 members: [member(.available), member(.spent), member(.disabled)])
        XCTAssertEqual(ProviderPools.availability(three), "1 of 3 accounts available")
        assertSays(card, "${pool.members.length} ${memberNoun(pool, pool.members.length)} available", in: Self.accountPools)
    }
}
