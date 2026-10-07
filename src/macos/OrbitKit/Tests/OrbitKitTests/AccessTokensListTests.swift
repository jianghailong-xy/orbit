import Foundation
import XCTest
@testable import OrbitKit

/// Settings → Access tokens on iOS and macOS (`AccessTokensList`): which tab a token is filed under,
/// whether it can be revoked, and each line its row says — what it reaches, when it stops, and when
/// it was last used. Also the list as the server answers it (`GET /access-tokens`).
final class AccessTokensListTests: XCTestCase {

    /// Noon UTC, so the day a date names is the same in every time zone a runner might be in.
    private let now = RelativeTime.parse("2026-10-06T12:00:00.000Z")!

    private func token(_ state: AccessTokenState = .active, scopes: [String] = ["tasks:read"],
                       workspaceIds: [String] = [], workspaces: [AccessTokenWorkspace] = [],
                       expiresAt: String? = nil, lastUsedAt: String? = nil, lastUsedIp: String? = nil,
                       revokedAt: String? = nil, revokedReason: String? = nil) -> AccessToken {
        AccessToken(id: "T-\(state.rawValue)", name: "deploy-bot", tokenHint: "k3Fq", scopes: scopes,
                    workspaceIds: workspaceIds, workspaces: workspaces, expiresAt: expiresAt,
                    lastUsedAt: lastUsedAt, lastUsedIp: lastUsedIp, revokedAt: revokedAt,
                    revokedReason: revokedReason, createdAt: "2026-09-01T12:00:00.000Z", state: state)
    }

    // MARK: - The tabs

    /// Active holds the tokens that work; every one that stopped — revoked, expired, or in a state
    /// this build does not know — is under the other tab, and only a working one can be revoked.
    func testTheTabsFileEachTokenByWhetherItStillWorks() {
        let all = [token(.active), token(.revoked), token(.expired), token(.unknown), token(.active)]
        XCTAssertEqual(AccessTokensList.Tab.allCases.map(\.label), ["Active", "Revoked & expired"])
        XCTAssertEqual(AccessTokensList.tokens(all, in: .active).map(\.state), [.active, .active])
        XCTAssertEqual(AccessTokensList.tokens(all, in: .ended).map(\.state), [.revoked, .expired, .unknown])
        XCTAssertTrue(AccessTokensList.canRevoke(token(.active)))
        for state in [AccessTokenState.revoked, .expired, .unknown] {
            XCTAssertFalse(AccessTokensList.canRevoke(token(state)), "a \(state) token has nothing left to revoke")
        }
    }

    func testTheHintIsTheEndOfTheTokenOnly() {
        XCTAssertEqual(AccessTokensList.hint(token()), "orbit_pat_…k3Fq")
    }

    // MARK: - What it can reach

    func testTheScopeSummaryNamesAPresetOrEachResource() {
        XCTAssertEqual(AccessTokensList.scopeSummary(AccessTokensList.allScopes), "Read & write · everything")
        XCTAssertEqual(AccessTokensList.scopeSummary(AccessTokensList.readScopes), "Read-only · everything")
        XCTAssertEqual(AccessTokensList.scopeSummary(AccessTokensList.readScopes.reversed()), "Read-only · everything",
                       "the order a token's scopes come in is not what it can do")
        XCTAssertEqual(AccessTokensList.scopeSummary(["sessions:read", "tasks:write", "tasks:read", "wiki:write"]),
                       "Tasks: read & write · Sessions: read · Wiki: write")
        XCTAssertEqual(AccessTokensList.scopeSummary(["events:read", "runners:read"]), "Runners: read · Events: read")
    }

    /// Twelve scopes, the server's PAT_SCOPES; the read-only preset is the seven `:read` ones.
    func testThePresetsAreTheServersScopes() {
        XCTAssertEqual(AccessTokensList.allScopes.count, 12)
        XCTAssertEqual(Set(AccessTokensList.allScopes).count, 12)
        XCTAssertEqual(AccessTokensList.readScopes.count, 7)
        XCTAssertTrue(AccessTokensList.readScopes.allSatisfy { $0.hasSuffix(":read") })
    }

    /// A scope newer than this build is still something the token holds: named, never a blank line.
    func testAScopeThisBuildDoesNotKnowIsStillNamed() {
        XCTAssertEqual(AccessTokensList.scopeSummary(["billing:read"]), "billing:read")
    }

    func testTheAccessLineSaysWhereAConfinedTokenReaches() {
        XCTAssertEqual(AccessTokensList.accessLine(token(scopes: AccessTokensList.readScopes)), "Read-only · everything")
        XCTAssertEqual(AccessTokensList.workspacesLine(token()), "All workspaces")
        let confined = token(scopes: ["tasks:read", "tasks:write"], workspaceIds: ["w1", "w2"],
                             workspaces: [AccessTokenWorkspace(id: "w1", name: "orbit"),
                                          AccessTokenWorkspace(id: "w2", name: "docs")])
        XCTAssertEqual(AccessTokensList.accessLine(confined), "Tasks: read & write · in orbit, docs")
        let oneGone = token(workspaceIds: ["w1", "w2"], workspaces: [AccessTokenWorkspace(id: "w1", name: "orbit")])
        XCTAssertEqual(AccessTokensList.workspacesLine(oneGone), "orbit, a deleted workspace")
        let allGone = token(workspaceIds: ["w1", "w2"])
        XCTAssertEqual(AccessTokensList.workspacesLine(allGone), "2 deleted workspaces")
    }

    // MARK: - When it stops

    func testAWorkingTokenSaysWhenItExpiresOrIsMarkedAsNeverExpiring() {
        let ninety = token(expiresAt: "2027-01-04T12:00:00.000Z")
        XCTAssertEqual(AccessTokensList.expiryLine(ninety, now: now), "Expires Jan 4, 2027 · in 90 days")
        XCTAssertFalse(AccessTokensList.isNeverExpiring(ninety))
        let never = token(expiresAt: nil)
        XCTAssertTrue(AccessTokensList.isNeverExpiring(never))
        XCTAssertEqual(AccessTokensList.expiryLine(never, now: now), "Never expires")
        XCTAssertFalse(AccessTokensList.isNeverExpiring(token(.revoked, expiresAt: nil, revokedAt: "2026-10-01T12:00:00.000Z")),
                       "only a token that still works carries the mark")
    }

    /// The web's `untilLine`, rounding to the nearest hour, then day.
    func testHowFarOffAnExpiryIs() {
        func until(_ seconds: TimeInterval) -> String? {
            let iso = ISO8601DateFormatter().string(from: now.addingTimeInterval(seconds))
            return AccessTokensList.untilLine(iso, now: now)
        }
        XCTAssertEqual(until(20 * 60), "in less than an hour")
        XCTAssertEqual(until(-60), "in less than an hour", "past due but not yet settled")
        XCTAssertEqual(until(3600), "in 1 hour")
        XCTAssertEqual(until(5 * 3600 + 10 * 60), "in 5 hours")
        XCTAssertEqual(until(30 * 3600), "in 1 day")
        XCTAssertEqual(until(89 * 86_400 + 20 * 3600), "in 90 days")
        XCTAssertNil(AccessTokensList.untilLine("not a date", now: now))
    }

    /// Why a token that no longer works stopped, in the web list's words.
    func testAnEndedTokenSaysWhyItStopped() {
        XCTAssertEqual(AccessTokensList.expiryLine(token(.revoked, revokedAt: "2026-10-01T12:00:00.000Z",
                                                         revokedReason: "USER"), now: now),
                       "Revoked Oct 1, 2026")
        XCTAssertEqual(AccessTokensList.endedLine(token(.revoked, revokedAt: "2026-10-02T12:00:00.000Z",
                                                        revokedReason: "ADMIN")),
                       "Revoked by an administrator Oct 2, 2026")
        XCTAssertEqual(AccessTokensList.endedLine(token(.revoked, revokedAt: "2026-10-03T12:00:00.000Z",
                                                        revokedReason: "PASSWORD_CHANGED")),
                       "Revoked with a password change Oct 3, 2026")
        XCTAssertEqual(AccessTokensList.endedLine(token(.revoked)), "Revoked")
        XCTAssertEqual(AccessTokensList.endedLine(token(.expired, expiresAt: "2026-09-30T12:00:00.000Z",
                                                        revokedAt: "2026-10-01T12:00:00.000Z",
                                                        revokedReason: "EXPIRED")),
                       "Expired Sep 30, 2026", "the day it ran out, not the day that was noticed")
        XCTAssertEqual(AccessTokensList.endedLine(token(.expired, revokedAt: "2026-10-01T12:00:00.000Z")),
                       "Expired Oct 1, 2026")
        XCTAssertEqual(AccessTokensList.endedLine(token(.expired)), "Expired")
    }

    // MARK: - When it was last used

    func testTheLastUseSaysWhenAndFromWhere() {
        XCTAssertEqual(AccessTokensList.lastUsedLine(token(), now: now), "Never used")
        XCTAssertEqual(AccessTokensList.lastUsedLine(token(lastUsedAt: "2026-10-06T08:40:00.000Z",
                                                           lastUsedIp: "203.0.113.7"), now: now),
                       "Last used 3h 20m ago · 203.0.113.7")
        XCTAssertEqual(AccessTokensList.lastUsedLine(token(lastUsedAt: "2026-10-06T11:59:58.000Z"), now: now),
                       "Last used just now · Address unknown")
    }

    // MARK: - Settings' row and the revoke

    func testTheSettingsRowCountsTheTokensThatWork() {
        XCTAssertEqual(SettingsHome.accessTokensValue(active: 3), "3 active")
        XCTAssertEqual(SettingsHome.accessTokensValue(active: 0), "None")
    }

    func testRevokingAsksByNameAndSaysWhyItFailed() {
        XCTAssertEqual(AccessTokensList.revokeTitle(token()), "Revoke “deploy-bot”?")
        XCTAssertEqual(AccessTokensList.notRevoked("the connection dropped"),
                       "Couldn't revoke the token: the connection dropped")
    }

    // MARK: - The list as the server answers it

    /// `GET /access-tokens` as `PatService.list` answers it: every column but the hash, with the
    /// workspaces named and where each token stands.
    func testTheServersListDecodes() throws {
        let json = """
        {"tokens":[
          {"id":"34ajTok1","name":"deploy-bot","tokenHint":"k3Fq","scopes":["tasks:read","tasks:write"],
           "workspaceIds":["w1"],"workspaces":[{"id":"w1","name":"orbit"}],"expiresAt":null,
           "createdVia":"WEB","lastUsedAt":"2026-10-06T08:40:00.000Z","lastUsedIp":"203.0.113.7",
           "lastUsedUserAgent":"curl/8.7.1","revokedAt":null,"revokedReason":null,
           "createdAt":"2026-09-01T12:00:00.000Z","state":"ACTIVE"},
          {"id":"34ajTok2","name":"old laptop","tokenHint":"a9Zx","scopes":["sessions:read"],
           "workspaceIds":[],"workspaces":[],"expiresAt":"2026-12-01T00:00:00.000Z",
           "createdVia":"CLI_DEVICE","lastUsedAt":null,"lastUsedIp":null,"lastUsedUserAgent":null,
           "revokedAt":"2026-10-05T09:00:00.000Z","revokedReason":"ADMIN",
           "createdAt":"2026-09-02T12:00:00.000Z","state":"REVOKED"},
          {"id":"34ajTok3","name":"from the future","tokenHint":"zzzz","scopes":[],"workspaceIds":[],
           "workspaces":[],"expiresAt":null,"createdVia":"SOMETHING_NEW","lastUsedAt":null,"lastUsedIp":null,
           "lastUsedUserAgent":null,"revokedAt":null,"revokedReason":null,
           "createdAt":"2026-09-03T12:00:00.000Z","state":"SUSPENDED"}
        ]}
        """
        let list = try JSONDecoder().decode(AccessTokenList.self, from: Data(json.utf8))
        XCTAssertEqual(list.tokens.map(\.id), ["34ajTok1", "34ajTok2", "34ajTok3"])
        let first = list.tokens[0]
        XCTAssertEqual(first.workspaces, [AccessTokenWorkspace(id: "w1", name: "orbit")])
        XCTAssertNil(first.expiresAt)
        XCTAssertEqual(first.state, .active)
        XCTAssertTrue(AccessTokensList.isNeverExpiring(first))
        XCTAssertEqual(list.tokens[1].revokedReason, "ADMIN")
        XCTAssertEqual(list.tokens[1].createdVia, "CLI_DEVICE")
        XCTAssertEqual(list.tokens[2].state, .unknown, "a state this build doesn't know never fails the list")
    }
}
