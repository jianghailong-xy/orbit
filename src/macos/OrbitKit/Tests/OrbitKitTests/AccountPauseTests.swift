import Foundation
import XCTest
@testable import OrbitKit

final class AccountPauseTests: XCTestCase {
    private let until = "2026-10-04T10:50:00.000Z"

    func testPauseExpiresAtTheDeadlineWithoutChangingAuthentication() throws {
        let account = try JSONDecoder().decode(RunnerEngineAccount.self, from: Data(
            #"{"id":"default","auth":"yes","pausedUntil":"2026-10-04T10:50:00.000Z"}"#.utf8))
        let deadline = try XCTUnwrap(RelativeTime.parse(until))
        XCTAssertTrue(AccountPause.isPaused(account.pausedUntil, now: deadline.addingTimeInterval(-1)))
        XCTAssertFalse(AccountPause.isPaused(account.pausedUntil, now: deadline))
        XCTAssertEqual(account.auth, "yes")
        XCTAssertFalse(AccountPause.isPaused(nil, now: deadline))
        XCTAssertFalse(AccountPause.isPaused("bad date", now: deadline))
    }

    func testDefaultRunnerAccountKeepsItsPauseInThePageModel() throws {
        let health = try JSONDecoder().decode(RunnerEngineHealth.self, from: Data(
            #"{"engine":"codex","auth":"yes","accounts":[{"id":"default","auth":"yes","pausedUntil":"2026-10-04T10:50:00.000Z"}]}"#.utf8))
        let line = try XCTUnwrap(RunnerPageFormat.accountLines(health).first)
        XCTAssertEqual(line.pausedUntil, until)
        XCTAssertEqual(line.auth, "yes")
    }

    func testPoolAdaptersKeepPauseAndQuotaSeparateFromState() throws {
        let account = try JSONDecoder().decode(CodexLogin.self, from: Data(
            #"{"state":"ACTIVE","email":"a@example.com","fingerprint":"…AB12","pausedUntil":"2026-10-04T10:50:00.000Z","usage":{"primary":{"utilization":60}}}"#.utf8))
        let now = try XCTUnwrap(RelativeTime.parse("2026-10-04T08:50:00.000Z"))
        let drawn = CodexLoginPool.drawn(slug: "codex-pool", logins: [account], now: now)
        let member = try XCTUnwrap(drawn.members.first)
        XCTAssertEqual(member.pausedUntil, until)
        XCTAssertEqual(member.state, .available)
        XCTAssertEqual(member.planUsage?.primary?.utilization, 60)
        XCTAssertFalse(member.next)
        let resumed = CodexLoginPool.drawn(slug: "codex-pool", logins: [account], now: now.addingTimeInterval(7200))
        XCTAssertTrue(try XCTUnwrap(resumed.members.first).next)

        let key = SharedPoolKey(id: "key", label: "Key", fingerprint: "sk-…1234",
                                contributor: PoolKeyContributor(userId: "u", name: "Owner"), pausedUntil: until)
        let shared = SharedPool(id: "p", slug: "p", label: "P", logins: [account], keys: [key])
        XCTAssertEqual(SharedPools.asProviderPool(shared).members.map(\.pausedUntil), [until, until])
        XCTAssertEqual(key.state, .active)
        XCTAssertTrue(key.enabled)

        let claude = try JSONDecoder().decode(PoolMember.self, from: Data(
            #"{"id":"m","slug":"m","state":"AVAILABLE","pausedUntil":"2026-10-04T10:50:00.000Z"}"#.utf8))
        XCTAssertEqual(claude.pausedUntil, until)
        XCTAssertEqual(claude.state, .available)
    }

    func testHoursMustMapToWholeMinutesWithinOneWeek() {
        XCTAssertEqual(AccountPause.minutes(hours: "2"), 120)
        XCTAssertEqual(AccountPause.minutes(hours: " 0.5 "), 30)
        XCTAssertEqual(AccountPause.minutes(hours: "168"), 10080)
        for invalid in ["", "0", "-1", "169", "nan", "inf", "0.001", "0.123", "abc"] {
            XCTAssertNil(AccountPause.minutes(hours: invalid), invalid)
        }
    }

    func testPausedPoolMembersAreExcludedFromAvailabilityAndNext() throws {
        let until = ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))
        let member = PoolMember(id: "m", slug: "m", label: "Account", state: .available,
                                next: true, pausedUntil: until)
        let pool = ProviderPool(id: "p", slug: "p", label: "Pool", members: [member])
        XCTAssertEqual(ProviderPools.readyCount(pool), 0)
        XCTAssertEqual(ProviderPools.headline(pool), "1 paused")

        let login = CodexLogin(email: "paused@example.com", fingerprint: "…1111", pausedUntil: until)
        let other = CodexLogin(email: "other@example.com", fingerprint: "…2222")
        let drawn = CodexLoginPool.drawn(slug: "p", logins: [login, other])
        let own = ProviderPool(id: "p", slug: "p", label: "Pool", members: drawn.members,
                               engine: "codex", logins: [login, other])
        let access = SharedPool(id: "p", slug: "p", label: "Pool")
        let merged = SharedPools.ownPoolWithAccess(own, access)
        XCTAssertFalse(merged.members.contains(where: \.next), "Do not choose a replacement for the server's first login")
        XCTAssertEqual(ProviderPools.readyCount(merged), 1)

        let serverNext = CodexLogin(email: "other@example.com", fingerprint: "…2222", next: true)
        let reported = SharedPool(id: "p", slug: "p", label: "Pool", logins: [login, serverNext])
        let selected = SharedPools.ownPoolWithAccess(own, reported)
        XCTAssertEqual(selected.members.first(where: \.next)?.id, "login:…2222")
        XCTAssertEqual(ProviderPools.headline(selected), "Next: other@example.com")
    }

    func testResumeEncodesExplicitNull() throws {
        let data = try JSONEncoder().encode(AccountPauseRequest(durationMinutes: nil))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertTrue(body["durationMinutes"] is NSNull)
    }
}
