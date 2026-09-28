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

    /// What web's pool types declare for its shared-pool adapter alone (see the type's comment).
    private static let webSharedMember: Set<String> = ["key"]
    private static let webSharedPool: Set<String> = ["shared"]
    private static let webSharedState: Set<String> = ["INVALID"]

    func testTheMemberDecodesExactlyTheFieldsWebDeclares() throws {
        let web = try declaredFields(interfaceBody("PoolMember", in: source(Self.anchor), file: Self.anchor))
        XCTAssertEqual(try encodedKeys(fullMember), web.subtracting(Self.webSharedMember))
        XCTAssertTrue(Self.webSharedMember.isSubset(of: web),
                      "\(Self.anchor)'s PoolMember no longer carries a shared pool's key — drop it from this check")
    }

    func testThePoolDecodesExactlyTheFieldsWebDeclares() throws {
        let web = try declaredFields(interfaceBody("ProviderPool", in: source(Self.anchor), file: Self.anchor))
        let pool = ProviderPool(id: "p", slug: "claude-accounts", label: "Claude accounts",
                                resetsAt: "2026-09-25T10:00:00.000Z", unavailable: "No account can run",
                                members: [fullMember])
        XCTAssertEqual(try encodedKeys(pool), web.subtracting(Self.webSharedPool))
        XCTAssertTrue(Self.webSharedPool.isSubset(of: web),
                      "\(Self.anchor)'s ProviderPool no longer carries the shared pool — drop it from this check")
        XCTAssertTrue(web.contains("unavailable"), "\(Self.anchor) no longer declares `unavailable` on a pool")
    }

    func testTheMemberStatesAreTheServersAndTheWebs() throws {
        let mine = Set(PoolMemberState.allCases.map(\.rawValue)).subtracting(["UNKNOWN"])
        let server = "src/apiserver/src/providers/providers.service.ts"
        XCTAssertEqual(try unionMembers("PoolMemberState", in: source(server), file: server), mine)
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
        let chosen = " — the account with the most room right now"
        XCTAssertTrue(next.hasSuffix(chosen))
        let opening = next.dropLast(chosen.count)
        XCTAssertTrue(web.contains("`\(opening) — ${ shownPool.shared ? 'the key it picks for you' : 'the account with the most room' } right now`"),
                      "WorkspaceView.tsx no longer says `\(next)` for an account pool")
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
        // The head's first run is chosen by the pool's kind — a shared pool's keys are capped, not spent —
        // and an account pool's reset is `formatResetTime`, the same clock this client reads.
        let prose = web.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        XCTAssertTrue(prose.contains("const spent = pool.shared ? 'All at cap' : '\(head)';"),
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
