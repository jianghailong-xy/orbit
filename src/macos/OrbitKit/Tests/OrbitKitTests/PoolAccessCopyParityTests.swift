import Foundation
import XCTest
@testable import OrbitKit

/// What scheme A (docs/mocks/account-pool-access/01–03) put on a Codex pool's page says on iOS what it says
/// on the web: the page drawn for whoever reads it (`CodexPoolPage` ↔ `CodexPoolPage` in
/// pages/ProviderPoolPage.tsx); whose sessions each account runs — "Only you", "Everyone here" — and the one
/// locked line somebody the owner added sees (components/AccountPools.tsx); "Who can use it", Share and
/// "Make it just mine" (`WhoCanUseIt`, `SharePool`, `JustMine` ↔ components/SharedPool.tsx), with the
/// warning a pool shared before it has an API key gives; "Add account"'s choice; the Providers card's head;
/// and the picker's "No key you can run on" (lib/sessionProviderChoices.ts). Neither build compiles the
/// other, so each word is looked up in the web source it came from, rendered with the web's own expression
/// wherever a sentence names the pool, a person or a count — and every sentence this client composes from
/// the boards' own pool (`PoolAccessBoards`) is looked up, whole, among the sentences the web's own specs
/// expect of the same pool. A missing counterpart is a FAILURE, never an `XCTSkip`.
///
/// Deliberately not compared: the dialogs' Cancel, which on a phone is a sheet's × or the system's
/// confirmation Cancel (`AddPoolKey.cancel`, compared in SharedPoolCopyParityTests); the tooltip on the
/// web head's gauge, which a phone has no hover for; "Pool deleted" and "You left …", which the web says
/// after the page has gone, where a phone just closes it; and the layout, where the web's one line under
/// the pool's name is the phone's head plus the Accounts section's footer (`howSentence`, compared as the
/// web's `how`).
final class PoolAccessCopyParityTests: XCTestCase {

    private static let poolPage = "src/web/src/pages/ProviderPoolPage.tsx"
    private static let accountPools = "src/web/src/components/AccountPools.tsx"
    private static let sharedPool = "src/web/src/components/SharedPool.tsx"
    private static let choices = "src/web/src/lib/sessionProviderChoices.ts"
    private static let sharedPools = "src/web/src/lib/sharedPools.ts"
    /// The web's specs of the same page, mounted on the boards' own pool: what they expect it to say.
    private static let whoSpec = "src/web/src/pages/ProviderPoolPage.whoCanUseIt.test.tsx"
    private static let accessSpec = "src/web/src/pages/ProviderPoolPage.access.test.tsx"
    private static let choicesSpec = "src/web/src/lib/sessionProviderChoices.test.ts"

    private enum ParityError: Error, CustomStringConvertible {
        case missing(String)
        var description: String {
            switch self {
            case .missing(let file):
                return "\(file) was not found above this test file. A Codex pool's page on iOS is one half of a pair; "
                    + "if the web half moved, move this check with it rather than deleting it."
            }
        }
    }

    /// The web file, with its string concatenations joined, JSX's `{' '}` read as the space it is, and
    /// every run of whitespace made one space: where a long sentence or a JSX text node breaks its line is
    /// layout, the words are the contract.
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

    /// A sentence this client drew from the boards' pool, among those the web's spec expects of it.
    private func assertExpects(_ spec: String, _ sentence: String, in file: String,
                               file testFile: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(spec.contains("'\(sentence)'"), "\(file) expects no '\(sentence)'", file: testFile, line: line)
    }

    /// A sentence rendered for `rendered`, with that text swapped for the web's expression in its place.
    private func asWeb(_ sentence: String, _ rendered: String, _ expression: String,
                       file: StaticString = #filePath, line: UInt = #line) -> String {
        XCTAssertTrue(sentence.contains(rendered), "\(sentence) does not say \(rendered)", file: file, line: line)
        return sentence.replacingOccurrences(of: rendered, with: expression)
    }

    /// A pool whose name, and whose owner's, are the web's own expressions for them.
    private func pool(_ label: String, owner: String = "Owner", keys: [SharedPoolKey] = [],
                      people: Int = 1) -> SharedPool {
        let everyone = [SharedPoolPerson(userId: "o", name: owner, role: .admin, creator: true, you: true)]
            + (1..<max(people, 1)).map { SharedPoolPerson(userId: "p\($0)", name: "P\($0)") }
        return SharedPool(id: "p", slug: "p", label: label, shared: false, ownerHasChatGPT: true,
                          people: everyone, keys: keys)
    }

    // MARK: - the page

    /// The line under the pool's name — who can use it, how many people (to anybody but its owner), how many
    /// of its accounts or keys can run, and what the reader's sessions run on — SHARED, and the head's press.
    func testThePageHeadSaysWhatTheWebPageSays() throws {
        let page = try web(Self.poolPage)
        assertSays(page, "<div className=\"pool-sub\"> \(CodexPoolPage.title) · <b>{who}</b> · {!mine && `${plural(access!.people.length, 'person', 'people')} · `} {availabilityOf(pool, NO_REFUSALS)} · {how} </div>",
                   in: Self.poolPage)
        let meAnd = asWeb(CodexPoolPage.meAnd(2), "2 people", "${plural(access!.people.length - 1, 'person', 'people')}")
        XCTAssertEqual(CodexPoolPage.meAnd(1), "Me and 1 person")
        assertSays(page, "const who = !mine ? `\(CodexPoolPage.whose("${owner?.name}"))` : people ? `\(meAnd)` : '\(CodexPoolPage.justMe)';",
                   in: Self.poolPage)
        assertSays(page, "const how = !mine ? `\(CodexPoolPage.memberHow)${access!.ownKeyFirst ? '\(CodexPoolPage.ownFirst)' : ''}.` : !own ? '\(CodexPoolPage.keysHow)' : people ? '\(CodexPoolPage.sharedHow)' : '\(CodexPoolPage.justMeHow)';",
                   in: Self.poolPage)
        assertSays(page, "{people && <span className=\"re-chip pool-shared-chip\">\(CodexPoolPage.sharedChip)</span>}",
                   in: Self.poolPage)
        // Its owner always has the press — "Add account" on a pool of their own, asking first once its people
        // and keys are read — and anybody else "Add a key" while the pool lets them.
        assertSays(page, "setDialog(!own ? { kind: 'addKey' } : access ? { kind: 'choose' } : { kind: 'signIn', login: null })",
                   in: Self.poolPage)
        assertSays(page, "{own ? '\(CodexPoolPage.addAccount)' : '\(CodexPoolPage.addKey)'}", in: Self.poolPage)
        assertSays(page, "canAddKey(access!) && ( <Button type=\"primary\" icon={<PlusOutlined />} onClick={() => setDialog({ kind: 'addKey' })}> \(CodexPoolPage.addKey) </Button>",
                   in: Self.poolPage)
        assertSays(page, "\(CodexPoolPage.accountsHeader){mine && <span className=\"pool-head-count\">{pool.members.length}</span>}",
                   in: Self.poolPage)

        // The boards' pool, read three ways, says what the web's spec expects of it.
        let spec = try web(Self.whoSpec)
        let alone = PoolAccessBoards.ownersPage(people: [], keys: [])
        let shared = PoolAccessBoards.ownersPage()
        let zhang = PoolAccessBoards.zhangsPage()
        assertExpects(spec, PoolAccessBoards.line(alone), in: Self.whoSpec)
        assertExpects(spec, PoolAccessBoards.line(shared), in: Self.whoSpec)
        assertExpects(spec, PoolAccessBoards.line(zhang), in: Self.whoSpec)
        XCTAssertEqual(PoolAccessBoards.line(zhang),
                       "Codex pool · jianghailong’s · 3 people · 2 of 2 keys you can run on available · your sessions run on the API keys, your own first.")
        XCTAssertEqual([alone.addLabel, shared.addLabel, zhang.addLabel], ["Add account", "Add account", "Add a key"])
        XCTAssertEqual([alone.accountsCount, shared.accountsCount, zhang.accountsCount], [2, 4, nil])
    }

    /// Whose sessions each account runs, once its owner shares the pool; the locked line anybody else sees in
    /// place of his ChatGPT accounts; and what the head says of the next one — the reader's, once shared.
    func testTheAccountsCardSaysWhoseSessionsEachAccountRuns() throws {
        let card = try web(Self.accountPools)
        assertSays(card, "<span className=\"pool-runs-for all\"> <TeamOutlined /> \(CodexPoolPage.everyoneHere) </span>",
                   in: Self.accountPools)
        assertSays(card, "<span className=\"pool-runs-for\"> <LockOutlined /> \(CodexPoolPage.onlyYou) </span>",
                   in: Self.accountPools)
        assertSays(card, "const tagged = !!shared && ownsPool(shared) && hasPeople(shared);", in: Self.accountPools)
        assertSays(card, "{key.contributor.name} · {key.fingerprint} {tagged && ( <> {' · '} <RunsFor everyone /> </> )}",
                   in: Self.accountPools)
        assertSays(card, "{loginLine(login)} {tagged && ( <> {' · '} <RunsFor everyone={false} /> </> )}",
                   in: Self.accountPools)
        assertSays(card, "const locked = shared && !ownsPool(shared) && shared.ownerHasChatGPT ? poolOwner(shared) : undefined;",
                   in: Self.accountPools)
        assertSays(card, "<span className=\"pool-member-label\">\(CodexPoolPage.lockedTitle("{owner}"))</span>",
                   in: Self.accountPools)
        assertSays(card, "<div className=\"pool-key-mask\"> \(CodexPoolPage.lockedLine("{owner}")) </div>",
                   in: Self.accountPools)
        // How many of them a session could start on: keys, to the people the owner added.
        assertSays(card, "const readByMember = (pool: ProviderPool): boolean => !!pool.shared && !ownsPool(pool.shared);",
                   in: Self.accountPools)
        assertSays(card, "readByMember(pool) ? `key${n === 1 ? '' : 's'} you can run on` : `account${n === 1 ? '' : 's'}`;",
                   in: Self.accountPools)
        assertSays(card, "{pool.shared && hasPeople(pool.shared) ? `Next for you: ${member.label}` :", in: Self.accountPools)
        assertSays(card, "<span className=\"pool-gauge-none\">{member.key ? '\(ProviderPools.noLimit)' : '\(CodexLoginPool.noQuota)'}</span>",
                   in: Self.accountPools)

        let spec = try web(Self.whoSpec)
        let shared = PoolAccessBoards.ownersPage()
        XCTAssertTrue(shared.tagged)
        let lines = shared.pool.members.map { member -> String in
            if let login = member.login { return "\(CodexLoginPool.line(login)) · \(CodexPoolPage.onlyYou)" }
            return "\(SharedPoolPage.keyLine(member.key!)) · \(CodexPoolPage.everyoneHere)"
        }
        XCTAssertEqual(lines, ["ChatGPT Plus · …016a · Only you", "ChatGPT Pro · …7QX4 · Only you",
                               "jianghailong · sk-…AB12 · Everyone here", "Zhang Min · sk-…7K2P · Everyone here"])
        for line in lines { assertExpects(spec, line, in: Self.whoSpec) }
        assertExpects(spec, ProviderPools.headline(shared.pool), in: Self.whoSpec)
        assertExpects(spec, try XCTUnwrap(ProviderPools.headGauge(shared.pool)?.label), in: Self.whoSpec)

        let zhang = PoolAccessBoards.zhangsPage()
        XCTAssertFalse(zhang.tagged)
        let owner = try XCTUnwrap(zhang.lockedOwner)
        assertExpects(spec, CodexPoolPage.lockedTitle(owner), in: Self.whoSpec)
        assertExpects(spec, CodexPoolPage.lockedLine(owner), in: Self.whoSpec)
        XCTAssertEqual(ProviderPools.headline(zhang.pool), "Next for you: zm-proj")
        assertExpects(spec, ProviderPools.headline(zhang.pool), in: Self.whoSpec)
        assertExpects(spec, try XCTUnwrap(ProviderPools.headGauge(zhang.pool)?.label), in: Self.whoSpec)
    }

    /// Deleting the pool — its ChatGPT sign-ins, its API keys, or both, said as it is — and leaving it.
    func testGoingOutSaysWhatTheWebPageSays() throws {
        let page = try web(Self.poolPage)
        assertSays(page, "const gone = [ ...(own && (logins.length > 0 || keys.length === 0) ? [logins.length === 1 ? '\(CodexPoolPage.signIn)' : '\(CodexPoolPage.signIns)'] : []), ...(!own || keys.length > 0 ? ['\(CodexPoolPage.apiKeys)'] : []), ];",
                   in: Self.poolPage)
        assertSays(page, "const deleted = `Its ${gone.join(' and ')} ${gone.join() === '\(CodexPoolPage.signIn)' ? 'is' : 'are'} deleted from the Orbit server`;",
                   in: Self.poolPage)
        assertSays(page, "const outNote = !mine ? '\(CodexPoolPage.leaveNote)' : people ? `${deleted}\(CodexPoolPage.deletedShared)` : `${deleted}\(CodexPoolPage.deletedAlone)`;",
                   in: Self.poolPage)
        assertSays(page, "title={mine ? `\(CodexPoolPage.deleteTitle("${pool.label}"))` : `\(CodexPoolPage.leaveTitle("${pool.label}"))`}",
                   in: Self.poolPage)
        assertSays(page, "okText={mine ? '\(CodexPoolPage.delete)' : '\(CodexPoolPage.leave)'}", in: Self.poolPage)
        assertSays(page, "{mine ? '\(CodexPoolPage.deletePool)' : '\(CodexPoolPage.leavePool)'}", in: Self.poolPage)

        let spec = try web(Self.whoSpec)
        for page in [PoolAccessBoards.ownersPage(people: [], keys: []), PoolAccessBoards.ownersPage(),
                     PoolAccessBoards.zhangsPage()] {
            assertExpects(spec, page.outNote, in: Self.whoSpec)
        }
        XCTAssertEqual(PoolAccessBoards.ownersPage().outNote,
                       "Its ChatGPT sign-ins and API keys are deleted from the Orbit server, and nobody can run on it.")
        let one = CodexPoolPage(own: PoolAccessBoards.ownPool([PoolAccessBoards.accounts[0]]), access: nil)!
        XCTAssertEqual(one.outNote, "Its ChatGPT sign-in is deleted from the Orbit server with it.")
    }

    /// "Add account" asks first what kind goes in, and says on the choice whose sessions each runs.
    func testAddAccountAsksWhatTheWebDialogAsks() throws {
        let page = try web(Self.poolPage)
        assertSays(page, "title={`\(CodexPoolPage.addAccountTitle("${pool.label}"))`}", in: Self.poolPage)
        let first = try XCTUnwrap(CodexPoolPage.kinds(accounts: 0).first)
        let another = try XCTUnwrap(CodexPoolPage.kinds(accounts: 1).first)
        assertSays(page, "<span className=\"add-kind-t\">\(another.title)</span> <span className=\"add-kind-s\"> {accounts > 0 ? '\(another.lead)' : '\(first.lead)'} <b>\(another.bold)</b>\(another.rest) </span>",
                   in: Self.poolPage)
        let key = try XCTUnwrap(CodexPoolPage.kinds(accounts: 1).last)
        assertSays(page, "<span className=\"add-kind-t\">\(key.title)</span> <span className=\"add-kind-s\"> \(key.lead) <b>\(key.bold)</b>\(key.rest) </span>",
                   in: Self.poolPage)
        assertSays(page, "onClick={() => onContinue(kind)}> \(AddPoolKey.continueLabel) </Button>", in: Self.poolPage)
        assertSays(page, "setDialog(kind === 'key' ? { kind: 'addKey' } : { kind: 'signIn', login: null })", in: Self.poolPage)

        let spec = try web(Self.whoSpec)
        assertExpects(spec, CodexPoolPage.addAccountTitle("Codex Pool"), in: Self.whoSpec)
        for kind in CodexPoolPage.kinds(accounts: 2) {
            assertExpects(spec, "\(kind.title)\(kind.lead) \(kind.bold)\(kind.rest)", in: Self.whoSpec)
        }
    }

    // MARK: - who can use it

    /// The card's head, its owner's switch and what it means, each person's row, the rule and the lock.
    func testWhoCanUseItSaysWhatTheWebCardSays() throws {
        let card = try web(Self.sharedPool)
        assertSays(card, "<span className=\"re-runner\"> \(WhoCanUseIt.header){people && <span className=\"pool-head-count\">{pool.people.length}</span>} </span>",
                   in: Self.sharedPool)
        assertSays(card, "{mine ? '\(WhoCanUseIt.shareNote)' : `\(WhoCanUseIt.setBy("${poolOwner(pool)?.name}"))`}",
                   in: Self.sharedPool)
        assertSays(card, "onClick={() => setSharing(true)}> \(WhoCanUseIt.addPeople) </Button>", in: Self.sharedPool)
        assertSays(card, "{ value: 'me', label: '\(WhoCanUseIt.Mode.justMe.label)' }, { value: 'people', label: '\(WhoCanUseIt.Mode.withPeople.label)' },",
                   in: Self.sharedPool)
        assertSays(card, "{people ? `\(WhoCanUseIt.theySee("${pool.label}"))` : '\(WhoCanUseIt.nobodyElse)'}", in: Self.sharedPool)
        assertSays(card, "{person.creator ? ( <span className=\"re-chip\">\(WhoCanUseIt.ownerChip)</span> ) : ( person.role === 'ADMIN' && <span className=\"re-chip\">\(SharedPoolPage.adminChip)</span> )}",
                   in: Self.sharedPool)
        assertSays(card, "const everything = person.creator && accounts !== null;", in: Self.sharedPool)
        assertSays(card, "const sessions = plural(person.sessions, 'session');", in: Self.sharedPool)
        assertSays(card, "<span className=\"pool-runs all\">\(WhoCanUseIt.runsOnEverything)</span> · {sessions}", in: Self.sharedPool)
        assertSays(card, "<span className=\"pool-runs\">\(WhoCanUseIt.runsOnKeys)</span> · {person.keys ? plural(person.keys, 'key') : 'no key'} · {sessions}",
                   in: Self.sharedPool)
        assertSays(card, "const ran = pool.people.some((row) => row.usage.costUsd > 0);", in: Self.sharedPool)
        assertSays(card, "{mine && !person.creator && <PersonMenu pool={pool} person={person} />}", in: Self.sharedPool)
        assertSays(card, "...(pool.shared ? [{ key: 'role', label: person.role === 'ADMIN' ? '\(SharedPoolPage.makeMember)' : '\(SharedPoolPage.makeAdmin)' }] : []),",
                   in: Self.sharedPool)
        assertSays(card, "{mine && people && ( <div className=\"pool-rule\"> <div> <div className=\"pool-rule-t\">\(WhoCanUseIt.ruleTitle)</div> <div className=\"pool-rule-h\"> \(WhoCanUseIt.ruleHint) </div>",
                   in: Self.sharedPool)
        assertSays(card, "{mine && people && accounts !== null && ( <div className=\"who-foot\"> <LockOutlined /> <span> <b>\(WhoCanUseIt.footLead)</b>\(WhoCanUseIt.footRest) </span>",
                   in: Self.sharedPool)
        assertSays(card, "const listOf = (items: string[]): string => items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;",
                   in: Self.sharedPool)
        XCTAssertEqual(SharedPoolPage.listOf(["a", "b", "c"]), "a, b and c")

        let spec = try web(Self.whoSpec)
        let shared = try XCTUnwrap(PoolAccessBoards.ownersPage().access).whoCanUseIt(accounts: 2)
        let zhang = try XCTUnwrap(PoolAccessBoards.zhangsPage().access).whoCanUseIt(accounts: nil)
        for card in [shared, zhang] {
            assertExpects(spec, try XCTUnwrap(card.note), in: Self.whoSpec)
            for person in card.rows {
                let line = card.line(person)
                assertExpects(spec, line.runs.map { "\($0) · \(line.rest)" } ?? line.rest, in: Self.whoSpec)
            }
        }
        assertExpects(spec, shared.modeHint, in: Self.whoSpec)
        assertExpects(spec, PoolAccessBoards.ownersPage(people: [], keys: []).access!.whoCanUseIt(accounts: 2).modeHint,
                      in: Self.whoSpec)
        assertExpects(spec, WhoCanUseIt.footLead + WhoCanUseIt.footRest, in: Self.whoSpec)
    }

    /// Shared with people before it has an API key: who can't start a session on it yet, and what fixes it.
    func testTheWarningOfAPoolWithNoKeySaysWhatTheWebCardSays() throws {
        let card = try web(Self.sharedPool)
        let one = SharedPoolPerson(userId: "u", name: "{listOf(added.map((person) => person.name))}")
        let named = SharedPool(id: "p", slug: "p", label: "{pool.label}",
                               people: [SharedPoolPerson(userId: "o", name: "O", creator: true, you: true), one])
        let plain = try XCTUnwrap(WhoCanUseIt(pool: named, accounts: nil).warning)
        let withAccounts = try XCTUnwrap(WhoCanUseIt(pool: named, accounts: 2).warning)
        let clause = String(withAccounts.rest.dropFirst(plain.rest.count - 1).dropLast())
        assertSays(card, "{mine && people && pool.keys.length === 0 && ( <div className=\"who-warn\"> <WarningFilled /> <span> <b>\(plain.lead)</b>\(plain.rest.dropLast()){accounts !== null ? '\(clause)' : ''}. </span>",
                   in: Self.sharedPool)
        assertSays(card, "onClick={onAddKey}> \(WhoCanUseIt.addAPIKey) </Button>", in: Self.sharedPool)

        let spec = try web(Self.accessSpec)
        let shared = PoolAccessBoards.access(PoolAccessBoards.jiang, keys: [])
        let lin = PoolAccessBoards.access(PoolAccessBoards.jiang, people: [PoolAccessBoards.lin], keys: [], label: "Orbit Codex")
        let team = PoolAccessBoards.access(PoolAccessBoards.jiang, keys: [], label: "Team Codex", shared: true)
        for (pool, accounts) in [(shared, 1), (lin, 1), (team, nil)] as [(SharedPool, Int?)] {
            let warning = try XCTUnwrap(pool.whoCanUseIt(accounts: accounts).warning)
            assertExpects(spec, warning.lead + warning.rest, in: Self.accessSpec)
        }
        XCTAssertNil(PoolAccessBoards.access(PoolAccessBoards.jiang).whoCanUseIt(accounts: 2).warning, "the pool has a key")
        XCTAssertNil(PoolAccessBoards.access(PoolAccessBoards.zhang, keys: []).whoCanUseIt(accounts: nil).warning,
                     "said to its owner alone")
    }

    /// "Share <pool>": what being added means — or, with no key yet, that it can't take their sessions — and
    /// the presses, then how it went.
    func testShareSaysWhatTheWebDialogSays() throws {
        let dialog = try web(Self.sharedPool)
        assertSays(dialog, "title={`\(SharePool.title(pool("${pool.label}")))`}", in: Self.sharedPool)
        assertSays(dialog, "<span className=\"np-field-l\">\(SharePool.emailsLabel)</span>", in: Self.sharedPool)
        // The addresses typed: a comma or a space ends one.
        assertSays(dialog, "tokenSeparators={[',', ' ']}", in: Self.sharedPool)
        XCTAssertEqual(SharePool.emails("zhang.min@orbitd.io, lin.wei@orbitd.io zhang.min@orbitd.io,"),
                       ["zhang.min@orbitd.io", "lin.wei@orbitd.io"])
        assertSays(dialog, "const noKey = pool.keys.length === 0;", in: Self.sharedPool)

        let named = pool("{pool.label}")
        let plain = SharePool.risk(named, accounts: nil)
        let clause = String(SharePool.risk(named, accounts: 2).rest.dropFirst(plain.rest.count - 1).dropLast())
        assertSays(dialog, "<b>\(plain.lead)</b>\(plain.rest.dropLast()) {accounts !== null ? '\(clause)' : ''}. </span>",
                   in: Self.sharedPool)

        let oneKey = SharedPoolKey(id: "k", label: "{listOf(pool.keys.map((key) => key.label))}", fingerprint: "f",
                                   contributor: PoolKeyContributor(userId: "o", name: "O"))
        let keyed = pool("{pool.label}", keys: [oneKey])
        let facts = SharePool.facts(keyed, accounts: nil)
        XCTAssertEqual(facts.count, 3)
        assertSays(dialog, "<b>\(facts[0].lead)</b>\(facts[0].rest) </li>", in: Self.sharedPool)
        assertSays(dialog, "<b>\(facts[1].lead)</b>\(asWeb(facts[1].rest, ", which is ", ", which {pool.keys.length === 1 ? 'is' : 'are'} "))",
                   in: Self.sharedPool)
        let account = String(SharePool.facts(keyed, accounts: 1)[1].rest.dropFirst(facts[1].rest.count))
        let accounts = asWeb(String(SharePool.facts(keyed, accounts: 2)[1].rest.dropFirst(facts[1].rest.count)), "2", "${accounts}")
        assertSays(dialog, "{accounts === 1 && '\(account)'} {(accounts ?? 0) > 1 && `\(accounts)`}", in: Self.sharedPool)
        assertSays(dialog, "<b>\(facts[2].lead)</b>\(facts[2].rest) </li>", in: Self.sharedPool)
        assertSays(dialog, "onChange={(e) => setCanAdd(e.target.checked)}> \(WhoCanUseIt.ruleTitle) </Checkbox>", in: Self.sharedPool)
        assertSays(dialog, "if (!noKey && canAdd !== pool.membersCanAdd) {", in: Self.sharedPool)
        assertSays(dialog, "onClick={() => share.mutate()}> \(SharePool.shareAnyway) </Button>", in: Self.sharedPool)
        assertSays(dialog, "> \(SharePool.addKeyFirst) </Button>", in: Self.sharedPool)
        assertSays(dialog, "onClick={() => share.mutate()}> \(SharePool.share) </Button>", in: Self.sharedPool)
        assertSays(dialog, "missed.push(`\(SharePool.missed("${email}", reason: "${e.message}"))`)", in: Self.sharedPool)
        assertSays(dialog, "message.warning(`\(SharePool.outcome(named, missed: ["${missed.join(', ')}"]))`)", in: Self.sharedPool)
        assertSays(dialog, "message.success(`\(SharePool.outcome(pool("${pool.label}"), missed: []))`)", in: Self.sharedPool)

        let spec = try web(Self.whoSpec)
        let oneKeyPool = PoolAccessBoards.access(PoolAccessBoards.jiang, people: [], keys: ["orbit-org-1"])
        assertExpects(spec, SharePool.title(oneKeyPool), in: Self.whoSpec)
        assertExpects(spec, SharePool.emailsLabel, in: Self.whoSpec)
        for fact in SharePool.facts(oneKeyPool, accounts: 2) {
            assertExpects(spec, fact.lead + fact.rest, in: Self.whoSpec)
        }
        let risk = SharePool.risk(PoolAccessBoards.access(PoolAccessBoards.jiang, people: [], keys: []), accounts: 2)
        assertExpects(spec, risk.lead + risk.rest, in: Self.whoSpec)
        assertExpects(spec, WhoCanUseIt.ruleTitle, in: Self.whoSpec)
        for press in [SharePool.shareAnyway, SharePool.addKeyFirst] {
            assertExpects(spec, press, in: Self.whoSpec)
        }
    }

    /// "Make <pool> just yours?": who loses it, which keys go with them, what stays — and its press.
    func testMakeItJustMineSaysWhatTheWebDialogSays() throws {
        let card = try web(Self.sharedPool)
        assertSays(card, "title: `\(JustMine.title(pool("${pool.label}")))`,", in: Self.sharedPool)
        assertSays(card, "okText: '\(JustMine.confirm)',", in: Self.sharedPool)
        assertSays(card, "{listOf(others.map((person) => person.name))} {others.length === 1 ? 'loses' : 'lose'} it at once, and their sessions on it stop.",
                   in: Self.sharedPool)
        assertSays(card, "{listOf(keys)} {keys.length === 1 ? 'leaves' : 'leave'} with {person.name}", in: Self.sharedPool)
        assertSays(card, "{at > 0 && (at === leaving.length - 1 ? ' and ' : ', ')}", in: Self.sharedPool)
        assertSays(card, "))} , because a key goes with whoever added it. </>", in: Self.sharedPool)
        assertSays(card, "...(accounts ? [accounts === 1 ? 'Your ChatGPT account' : 'Your ChatGPT accounts'] : []),",
                   in: Self.sharedPool)
        assertSays(card, "` ${listOf(staying)} ${staying.length > 1 || (accounts ?? 0) > 1 ? 'stay' : 'stays'}.`",
                   in: Self.sharedPool)

        let spec = try web(Self.whoSpec)
        let access = PoolAccessBoards.access(PoolAccessBoards.jiang)
        assertExpects(spec, JustMine.title(access), in: Self.whoSpec)
        assertExpects(spec, JustMine.confirm, in: Self.whoSpec)
        let cost = JustMine.cost(access, accounts: 2)
        XCTAssertEqual(cost, "Zhang Min and Lin Wei lose it at once, and their sessions on it stop. zm-proj leaves with "
            + "Zhang Min, because a key goes with whoever added it. Your ChatGPT accounts and orbit-org-1 stay.")
        assertExpects(spec, cost, in: Self.whoSpec)
    }

    // MARK: - elsewhere

    /// The Providers card's head, by who reads it: whose it is and how many keys, "Just me", or SHARED.
    func testTheProvidersCardSaysWhatTheWebCardSays() throws {
        let card = try web(Self.accountPools)
        let zhang = PoolAccessBoards.zhangsPage().pool
        let line = ProvidersOverview.codexPoolLine(zhang)
        XCTAssertEqual(line, "jianghailong’s · 2 keys you can run on")
        let named = asWeb(asWeb(line, "jianghailong", "{poolOwner(shared!)?.name}"), "2 keys you can run on",
                          "{pool.members.length} {memberNoun(pool, pool.members.length)}")
        assertSays(card, "<span className=\"re-summary\"> \(named) </span>", in: Self.accountPools)
        assertSays(card, "<span className=\"re-summary\">\(CodexPoolPage.justMe) · {availabilityOf(pool, refusals)}</span>",
                   in: Self.accountPools)
        assertSays(card, "{people && <span className=\"re-chip pool-shared-chip\">\(CodexPoolPage.sharedChip)</span>}",
                   in: Self.accountPools)
        assertSays(card, "{!member && <PoolGauge pool={pool} />}", in: Self.accountPools)

        let spec = try web(Self.whoSpec)
        let alone = PoolAccessBoards.ownersPage(people: [], keys: []).pool
        let shared = PoolAccessBoards.ownersPage().pool
        for pool in [alone, shared, zhang] {
            assertExpects(spec, ProvidersOverview.codexPoolLine(pool), in: Self.whoSpec)
        }
        XCTAssertEqual([alone, shared, zhang].map(ProvidersOverview.isShared), [false, true, true])
        XCTAssertNil(ProvidersOverview.codexPoolValue(zhang), "somebody the owner added reads its gauge on its page")
        assertExpects(spec, try XCTUnwrap(ProvidersOverview.codexPoolValue(shared)?.label), in: Self.whoSpec)
    }

    /// Somebody a pool's owner added runs on its API keys alone, so the picker greys the pool for them as
    /// having no key they can run on, whatever else it holds; its owner reads the server's own words.
    func testThePickerGreysAPoolInTheWebsWords() throws {
        let source = try web(Self.choices)
        assertSays(source, "unavailable: pool.shared && !ownsPool(pool.shared) ? '\(SessionProviderChoices.noKeyYouCanRunOn)' : pool.unavailable,",
                   in: Self.choices)
        assertSays(try web(Self.choicesSpec), "unavailable: '\(SessionProviderChoices.noKeyYouCanRunOn)',", in: Self.choicesSpec)
        let zhang = SharedPools.asProviderPool(PoolAccessBoards.access(PoolAccessBoards.zhang, keys: []))
        let tile = SessionProviderChoices.choices(configured: ProviderPools.asProviders([zhang]), pools: [zhang])
            .first { $0.slug == "codex-pool" }
        XCTAssertEqual(tile?.unavailable, SessionProviderChoices.noKeyYouCanRunOn)
    }
}

private extension SharedPool {
    /// "Who can use it" as its page draws it, with `accounts` ChatGPT accounts of its owner's beside.
    func whoCanUseIt(accounts: Int?) -> WhoCanUseIt { WhoCanUseIt(pool: self, accounts: accounts) }
}
