import Foundation
import XCTest
@testable import OrbitKit

/// This client reads account pools off the same payload the web does and prints the same words about
/// them. Neither end compiles the other, so a field the server renames or a sentence the web rewords
/// would otherwise just stop showing up here — decoded as absent, silently. This holds the Swift
/// declarations to the web's and the server's:
///
/// - the fields `PoolMember` / `ProviderPool` decode are the ones web's `lib/providerPools.ts`
///   declares (`unavailable` among them), and the session detail still declares
///   `poolMemberProviderId` (`api.ts`);
/// - the member states are the server's `PoolMemberState` union and the web's;
/// - what web declares beyond that is exactly its shared-pool adapter: `sharedPoolAsProviderPool`
///   (`lib/sharedPools.ts`) draws a shared pool as an account pool — each member carrying its `key`, the
///   pool the whole view as `shared`, a key OpenAI refused as `INVALID` — out of GET
///   /providers/shared-pools, which the server's account pools never carry. This client reads that
///   endpoint into `SharedPool` (Models/SharedPools.swift) instead, so the three stay web's own;
/// - a Codex pool's accounts (`logins`) and a sign-in's poll are web's `CodexLogin` / `CodexLoginPoll`
///   (`lib/codexLogin.ts`), and a member's gauge is the window web's `memberQuota` picks;
/// - a pool that cannot run is greyed in the server's own words, which the web's pool head says too;
/// - the picker's and the status bar's words are the web's, word for word.
///
/// A missing counterpart file is a FAILURE, never an `XCTSkip`: a check that quietly opts out
/// reports green on exactly the day the thing it watches moves. If one moved, point this at it.
final class ProviderPoolsParityTests: XCTestCase {
    private static let anchor = "src/web/src/lib/providerPools.ts"

    private struct Missing: Error, CustomStringConvertible {
        let what: String
        var description: String {
            "\(what) — the web/server counterpart this check reads. If it moved, point "
                + "ProviderPoolsParityTests at its new home rather than deleting the check."
        }
    }

    private func repoRoot() throws -> URL {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent(Self.anchor).path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        throw Missing(what: "\(Self.anchor) was not found above this test file")
    }

    private func source(_ path: String) throws -> String {
        let url = try repoRoot().appendingPathComponent(path)
        guard let text = try? String(contentsOf: url, encoding: .utf8) else {
            throw Missing(what: "\(path) is not readable")
        }
        return text
    }

    /// The body of `export interface <name> { … }`: from its opening brace to the brace that closes it
    /// at the start of a line.
    private func interfaceBody(_ name: String, in text: String, file: String) throws -> String {
        guard let open = text.range(of: "export interface \(name) {"),
              let close = text.range(of: "\n}", range: open.upperBound..<text.endIndex) else {
            throw Missing(what: "`export interface \(name)` in \(file)")
        }
        return String(text[open.upperBound..<close.lowerBound])
    }

    /// The field names an interface body declares (`name: …` / `name?: …`), comments stripped first so
    /// a field mentioned in a doc comment is not mistaken for a declared one.
    private func declaredFields(_ body: String) -> Set<String> {
        let code = body
            .replacingOccurrences(of: "/\\*[\\s\\S]*?\\*/", with: "", options: .regularExpression)
            .replacingOccurrences(of: "//[^\\n]*", with: "", options: .regularExpression)
        let regex = try! NSRegularExpression(pattern: "^\\s*([A-Za-z_][A-Za-z0-9_]*)\\??\\s*:", options: .anchorsMatchLines)
        let range = NSRange(code.startIndex..., in: code)
        return Set(regex.matches(in: code, range: range).compactMap { match in
            Range(match.range(at: 1), in: code).map { String(code[$0]) }
        })
    }

    /// The string literals of `export type <name> = 'A' | 'B' …;`.
    private func unionMembers(_ name: String, in text: String, file: String) throws -> Set<String> {
        guard let start = text.range(of: "export type \(name) ="),
              let end = text.range(of: ";", range: start.upperBound..<text.endIndex) else {
            throw Missing(what: "`export type \(name)` in \(file)")
        }
        let decl = String(text[start.upperBound..<end.lowerBound])
        let regex = try! NSRegularExpression(pattern: "'([A-Z_]+)'")
        return Set(regex.matches(in: decl, range: NSRange(decl.startIndex..., in: decl)).compactMap {
            Range($0.range(at: 1), in: decl).map { String(decl[$0]) }
        })
    }

    /// The keys a value's own Codable writes — the same CodingKeys its decoder reads — with every
    /// optional filled in so none is left out for being nil.
    private func encodedKeys<T: Encodable>(_ value: T) throws -> Set<String> {
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
        return Set((object as? [String: Any] ?? [:]).keys)
    }

    private let fullMember = PoolMember(
        id: "m", slug: "anthropic", label: "Work", presetSlug: "anthropic", enabled: true,
        planUsage: PlanUsageSnapshot(fiveHour: PlanUsageWindow(utilization: 1)), state: .available,
        resetsAt: "2026-09-25T10:00:00.000Z", next: true)

    // MARK: - the payload

    /// What web's pool types declare for its adapters alone (see the types' comments): a shared pool's
    /// key and a Codex pool's ChatGPT account on a member, the whole shared pool on a pool, and the two
    /// states only an adapter reads — a refused key's, and a signed-out account's.
    private static let webSharedMember: Set<String> = ["key", "login"]
    private static let webSharedPool: Set<String> = ["shared"]
    private static let webSharedState: Set<String> = ["INVALID"]
    /// The state the server never sends as a member's: a Codex pool's account carries its own (`login`),
    /// and the member drawn for it is read off that (`CodexLoginPool.drawn`, web's `withLogin`).
    private static let accountState: Set<String> = ["SIGNED_OUT"]

    func testTheMemberDecodesExactlyTheFieldsWebDeclares() throws {
        let web = try declaredFields(interfaceBody("PoolMember", in: source(Self.anchor), file: Self.anchor))
        XCTAssertEqual(try encodedKeys(fullMember), web.subtracting(Self.webSharedMember))
        XCTAssertTrue(Self.webSharedMember.isSubset(of: web),
                      "\(Self.anchor)'s PoolMember no longer carries a shared pool's key or a Codex pool's account — drop it from this check")
    }

    func testThePoolDecodesExactlyTheFieldsWebDeclares() throws {
        let web = try declaredFields(interfaceBody("ProviderPool", in: source(Self.anchor), file: Self.anchor))
        // Every field filled in — a Codex pool's accounts among them — so none is left out for being nil.
        let account = CodexLogin(email: "e", fingerprint: "…AB12")
        let pool = ProviderPool(id: "p", slug: "claude-accounts", label: "Claude accounts",
                                resetsAt: "2026-09-25T10:00:00.000Z", unavailable: "No account can run",
                                members: [fullMember], engine: "claude", login: account, logins: [account])
        XCTAssertEqual(try encodedKeys(pool), web.subtracting(Self.webSharedPool))
        XCTAssertTrue(Self.webSharedPool.isSubset(of: web),
                      "\(Self.anchor)'s ProviderPool no longer carries the shared pool — drop it from this check")
        XCTAssertTrue(web.contains("unavailable"), "\(Self.anchor) no longer declares `unavailable` on a pool")
    }

    /// A Codex pool's accounts are web's `CodexLogin` field for field, and so is a sign-in's poll — every
    /// account the pool holds riding along on it as `logins` (lib/codexLogin.ts).
    func testACodexPoolsAccountsDecodeTheShapeWebDeclares() throws {
        let lib = "src/web/src/lib/codexLogin.ts"
        let web = try source(lib)
        let account = CodexLogin(state: "ACTIVE", email: "e", plan: "plus", fingerprint: "…AB12", lastError: "x",
                                 expiresAt: "2026-10-07T09:12:00.000Z", linkedAt: "2026-09-28T09:12:00.000Z",
                                 usage: PlanUsageSnapshot(provider: "codex", primary: PlanUsageWindow(utilization: 1)),
                                 usageUnavailable: "y")
        XCTAssertEqual(try encodedKeys(account), declaredFields(try interfaceBody("CodexLogin", in: web, file: lib)))
        let poll = CodexLoginPoll(status: "CONFIRMED", verificationUrl: "u", userCode: "c", expiresAt: "t",
                                  account: account, logins: [account], error: "e")
        XCTAssertEqual(try encodedKeys(poll), declaredFields(try interfaceBody("CodexLoginPoll", in: web, file: lib)))
        // An older server names only the one account: both ends read `login` as that one.
        XCTAssertTrue(web.contains("pool.logins ?? (pool.login ? [pool.login] : [])"),
                      "\(lib) no longer reads an older server's one `login` as the pool's accounts")
    }

    /// A member's gauge is chosen the way web's `memberQuota` chooses it: the window that stopped a spent
    /// member, else the tightest — the first of two level ones — rather than always the 5-hour window.
    func testAMembersGaugeIsChosenAsTheWebChoosesIt() throws {
        let web = try source(Self.anchor).replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        XCTAssertTrue(web.contains("member.state === 'SPENT' ? rows.find((row) => row.window.utilization >= 100)"),
                      "\(Self.anchor)'s memberQuota no longer draws the window that stopped a spent member")
        XCTAssertTrue(web.contains("row.window.utilization > tightest.window.utilization ? row : tightest"),
                      "\(Self.anchor)'s memberQuota no longer draws the tightest window, the first of two level ones")
        let level = PoolMember(id: "m", slug: "m", label: "M",
                               planUsage: PlanUsageSnapshot(provider: "codex",
                                                            primary: PlanUsageWindow(utilization: 50, windowDurationMins: 300),
                                                            secondary: PlanUsageWindow(utilization: 50, windowDurationMins: 10080)),
                               state: .available)
        XCTAssertEqual(ProviderPools.memberQuota(level)?.label, "5h limit")
    }

    func testTheMemberStatesAreTheServersAndTheWebs() throws {
        let mine = Set(PoolMemberState.allCases.map(\.rawValue)).subtracting(["UNKNOWN"])
        let server = "src/apiserver/src/providers/providers.service.ts"
        XCTAssertEqual(try unionMembers("PoolMemberState", in: source(server), file: server),
                       mine.subtracting(Self.accountState))
        let web = try unionMembers("PoolMemberState", in: source(Self.anchor), file: Self.anchor)
        XCTAssertEqual(web.subtracting(Self.webSharedState), mine)
        XCTAssertTrue(Self.webSharedState.isSubset(of: web),
                      "\(Self.anchor) no longer has a refused key's state — drop it from this check")
        // Where this client says it instead: a shared pool's key.
        XCTAssertEqual(PoolKeyState.invalid.rawValue, "INVALID")
    }

    func testTheSessionDetailStillDeclaresTheRecordedMember() throws {
        let api = "src/web/src/api.ts"
        XCTAssertTrue(try source(api).contains("  poolMemberProviderId?: string | null;"),
                      "\(api) no longer declares poolMemberProviderId on the session detail")
        let session = Session(id: "s", title: nil, status: .running, agentId: nil, assignedRunnerId: nil,
                              pendingApprovals: nil, branch: nil, updatedAt: nil,
                              poolMemberProviderId: "m")
        XCTAssertTrue(try encodedKeys(session).contains("poolMemberProviderId"))
    }

    // MARK: - a shared pool's own model

    /// Web's `SharedPoolKey` / `SharedPoolPerson` / `SharedPool` are what this client decodes
    /// (Models/SharedPools.swift), field for field — a field added at one end and not the other would
    /// otherwise just stop showing up, silently. The differences are declared here rather than left to
    /// be discovered:
    ///
    /// - `PoolSpend.othersCostUsd` is spelled inline in web's key usage (`PoolSpend & { othersCostUsd }`),
    ///   so this client's one `PoolSpend` is the union of the two declarations;
    /// - the server's own `spentUntil` is not part of the view: it is a column the gateway writes and
    ///   the key selector reads, and neither web's types nor this client's carry it — a page's closest
    ///   thing is `shareCap` beside `usage.othersCostUsd`;
    /// - a key OpenAI refused is web's member state `INVALID`, and this client keeps that on the key
    ///   (`PoolKeyState.invalid`) rather than in its member states — see the member checks above.
    func testTheSharedPoolDecodesTheShapeWebDeclares() throws {
        let lib = "src/web/src/lib/sharedPools.ts"
        let web = try source(lib)

        let key = SharedPoolKey(id: "k", label: "orbit-org-1", fingerprint: "sk-…0000",
                                state: .active, enabled: true, shareCap: 50,
                                spentUntil: "2026-09-30T06:00:00.000Z",
                                contributor: PoolKeyContributor(userId: "u", name: "Wikova", you: false),
                                usage: PoolSpend(inputTokens: 10, outputTokens: 20, costUsd: 1.5,
                                                 othersCostUsd: 1.25),
                                running: true, next: true)
        // The mark a key is out of budget until is one of the fields web declares, mirrored here — the
        // tripwire this file used to carry ("web does not carry `spentUntil` yet") has fired, and the
        // mark in the fixture above is what makes the two sets of fields line up.
        XCTAssertEqual(try encodedKeys(key), declaredFields(try interfaceBody("SharedPoolKey", in: web, file: lib)))
        XCTAssertTrue(web.contains("spentUntil: string | null;"),
                      "\(lib) no longer declares the mark a key is out of budget until — drop it from this check")

        let person = SharedPoolPerson(userId: "u", name: "Wikova", role: .admin, creator: true, you: true,
                                      keys: 2, sessions: 3, usage: PoolSpend(costUsd: 4))
        XCTAssertEqual(try encodedKeys(person),
                       declaredFields(try interfaceBody("SharedPoolPerson", in: web, file: lib)))

        let spend = PoolSpend(inputTokens: 0, outputTokens: 0, costUsd: 0, othersCostUsd: 0)
        XCTAssertEqual(try encodedKeys(spend),
                       declaredFields(try interfaceBody("PoolSpend", in: web, file: lib)).union(["othersCostUsd"]))
        XCTAssertTrue(try source(lib).contains("othersCostUsd"),
                      "\(lib) no longer declares what a key's cap counts — drop `othersCostUsd` from this check")

        // The month is two fields spelled inline on the pool rather than an interface of its own.
        XCTAssertTrue(web.contains("window: { start: string; end: string };"),
                      "\(lib)'s pool no longer spells out its month — drop this check")
        let window = SharedPoolWindow(start: "2026-09-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z")
        XCTAssertEqual(try encodedKeys(window), ["start", "end"])
        let pool = SharedPool(id: "p", slug: "team-codex", label: "Team Codex", engine: "codex",
                              membersCanAdd: true, ownKeyFirst: true, viewerRole: .member,
                              window: window, people: [person], keys: [key])
        XCTAssertEqual(try encodedKeys(pool), declaredFields(try interfaceBody("SharedPool", in: web, file: lib)))
    }

    // MARK: - the words

    /// The status bar's account names whose it is in the web's own sentences (WorkspaceView's tooltip).
    /// Rendered with sentinel names, then the sentinels swapped for the web's interpolations, so the
    /// whole sentence has to match rather than the words either side of a name.
    ///
    /// The web's sentence for the member the next session starts on ends by saying how it was chosen,
    /// which differs for a shared pool's key; an account pool's words are the branch this client says.
    func testTheAccountSaysWhoseItIsInTheWebsSentences() throws {
        let web = try source("src/web/src/components/WorkspaceView.tsx")
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        let pool = ProviderPool(id: "p", slug: "s", label: "POOLNAME")
        let member = PoolMember(id: "m", slug: "k", label: "MEMBERNAME", state: .available)
        func theirs(_ current: Bool) -> String {
            ProviderPools.accountHelp(pool: pool, account: PoolAccount(member: member, current: current))
                .replacingOccurrences(of: "POOLNAME", with: "${shownPool.label}")
                .replacingOccurrences(of: "MEMBERNAME", with: "${shownPoolAccount.member.label}")
        }
        XCTAssertTrue(web.contains("`\(theirs(true))`"), "WorkspaceView.tsx has no `\(theirs(true))`")
        let next = theirs(false)
        let chosen = " — the account whose quota resets soonest"
        XCTAssertTrue(next.hasSuffix(chosen))
        let opening = next.dropLast(chosen.count)
        XCTAssertTrue(web.contains("`\(opening) — ${ shownPool.shared ? 'the key it picks for you right now' : 'the account whose quota resets soonest' }`"),
                      "WorkspaceView.tsx no longer says `\(next)` for an account pool")
        // A shared pool's key says the same sentence with the web's other branch, which the ternary
        // above already carries — so it has to be the same opening and the one word changed.
        let shared = ProviderPool(id: "p", slug: "s", label: "POOLNAME", members: [member],
                                  shared: SharedPool(id: "p", slug: "s", label: "POOLNAME"))
        let asKey = ProviderPools
            .accountHelp(pool: shared, account: PoolAccount(member: member, current: false))
            .replacingOccurrences(of: "POOLNAME", with: "${shownPool.label}")
            .replacingOccurrences(of: "MEMBERNAME", with: "${shownPoolAccount.member.label}")
        XCTAssertTrue(asKey.hasSuffix(" — the key it picks for you right now"), asKey)
        XCTAssertEqual(asKey.replacingOccurrences(of: "the key it picks for you right now",
                                                  with: "the account whose quota resets soonest"),
                       next, "a shared pool's sentence differs from an account pool's in one branch only")
        // Running — as opposed to starting — names the key the same way either kind does.
        XCTAssertEqual(ProviderPools
            .accountHelp(pool: shared, account: PoolAccount(member: member, current: true))
            .replacingOccurrences(of: "POOLNAME", with: "${shownPool.label}")
            .replacingOccurrences(of: "MEMBERNAME", with: "${shownPoolAccount.member.label}"),
                       theirs(true))
    }

    /// A pool that cannot run is greyed in the words the server puts on it (`poolViews`' `unavailable`),
    /// read off the payload rather than worked out here — each of them, as the server writes it — and
    /// the web's pool head says the same words, from the same field.
    func testAGreyedPoolSaysWhyInTheServersWords() throws {
        let server = "src/apiserver/src/providers/providers.service.ts"
        let text = try source(server)
        XCTAssertTrue(text.contains("unavailable:"), "\(server) no longer puts `unavailable` on a pool")
        for reason in ["No account can run", "No accounts"] {
            XCTAssertTrue(text.contains("'\(reason)'"), "\(server) no longer says “\(reason)”")
            let json = #"{"id": "p", "slug": "s", "label": "L", "unavailable": "\#(reason)", "members": []}"#
            let pool = try JSONDecoder().decode(ProviderPool.self, from: Data(json.utf8))
            XCTAssertEqual(ProviderPools.unavailableReason(pool), reason)
        }
        XCTAssertTrue(try source(Self.anchor).contains("reason: pool.unavailable"),
                      "\(Self.anchor)'s pool head no longer says the server's `unavailable`")
    }

    /// A spent pool says when it frees up in the words the pool's head says it on /providers
    /// (AccountPools' `PoolGauge`), where "All spent · " and "resets …" are two runs of one line.
    func testASpentPoolSaysWhenInThePoolHeadsWords() throws {
        let web = try source("src/web/src/components/AccountPools.tsx")
        let now = RelativeTime.parse("2026-09-25T09:00:00.000Z")!
        let spent = ProviderPool(id: "p", slug: "s", label: "L", resetsAt: "2026-09-25T10:30:00.000Z",
                                 members: [PoolMember(id: "m", slug: "k", label: "K", state: .spent)])
        let withReset = try XCTUnwrap(ProviderPools.spentNote(spent, now: now))
        let head = try XCTUnwrap(withReset.components(separatedBy: " · resets ").first)
        // The head's first run is chosen by the pool's kind — a shared pool's keys are capped, not spent,
        // unless what stopped them is OpenAI's own out-of-budget mark (`allOutOfBudget`) — and an account
        // pool's reset is `formatResetTime`, the same clock this client reads.
        let prose = web.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        XCTAssertTrue(prose.contains("const spent = !pool.shared ? '\(head)' : allOutOfBudget(pool.shared) ? '\(SharedPoolPage.allOutOfBudgetWords)' : '\(SharedPoolPage.allAtCapWords)';"),
                      "AccountPools.tsx no longer heads a spent account pool with `\(head)`")
        XCTAssertTrue(prose.contains("{spent} · </span>resets{' '} {pool.shared ? formatCapReset(head.resetsAt) : formatResetTime(head.resetsAt)}"),
                      "AccountPools.tsx no longer says `\(head) · resets <time>`")

        let noReset = ProviderPool(id: "p", slug: "s", label: "L", members: spent.members)
        XCTAssertEqual(ProviderPools.spentNote(noReset, now: now), head)
    }

    func testThePickersWordsAreTheWebs() throws {
        let hero = try source("src/web/src/components/NewSessionProviderHero.tsx")
        XCTAssertTrue(hero.contains(">\(ProviderPools.pinAccountLabel)<"))

        // The /providers page wraps its sentence over two source lines: compare it as prose.
        let pools = try source("src/web/src/components/AccountPools.tsx")
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        XCTAssertTrue(pools.contains("<h3>\(ProviderPools.sectionTitle)</h3>"))
        XCTAssertTrue(pools.contains("> \(ProviderPools.sectionFooter) <"),
                      "AccountPools.tsx no longer heads its pools with “\(ProviderPools.sectionFooter)”")
    }
}
