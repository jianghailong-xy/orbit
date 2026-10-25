import XCTest
@testable import OrbitKit

/// A DeepSeek key's account balance as this client reads it: what GET /providers/mine/:id/balance
/// answers decodes, what each answer comes to on Infrastructure's API keys and on the key's page — and that
/// no answer short of DeepSeek's own balance is ever drawn as an amount. Mirrors web's
/// deepseekBalance.test.ts and DeepSeekBalance.test.tsx where the two overlap.
final class DeepSeekBalanceTests: XCTestCase {
    private let decoder = JSONDecoder()
    private let now = RelativeTime.parse("2026-10-06T08:00:00.000Z")!

    private func answer(_ json: String) throws -> ProviderBalance {
        try decoder.decode(ProviderBalance.self, from: Data(json.utf8))
    }

    /// What the server sends a public client for a read: ids replaced by their public form, and a
    /// `publicId` twin beside each (PublicIdInterceptor).
    private let read = """
    {"ok": true, "isAvailable": true, "fetchedAt": "2026-10-06T07:58:00.000Z",
     "balances": [{"currency": "CNY", "totalBalance": "110.00", "grantedBalance": "10.00", "toppedUpBalance": "100.00"},
                  {"currency": "USD", "totalBalance": "5.00", "grantedBalance": "0.00", "toppedUpBalance": "5.00"}],
     "sharedWith": [{"id": "34ZvICehHBjT5Ky6b4utr", "publicId": "34ZvICehHBjT5Ky6b4utr", "label": "DeepSeek Harness"}]}
    """

    private func failure(_ reason: String, _ message: String) -> String {
        """
        {"ok": false, "reason": "\(reason)", "message": "\(message)", "fetchedAt": "2026-10-06T08:00:00.000Z", "sharedWith": []}
        """
    }

    private let cny = ProviderBalanceAmount(currency: "CNY", totalBalance: "110.00", grantedBalance: "10.00",
                                            toppedUpBalance: "100.00")

    // MARK: decoding and state

    func testAReadDecodesEveryCurrencyAndWhoElseHoldsTheKey() throws {
        let decoded = try answer(read)
        XCTAssertTrue(decoded.ok)
        XCTAssertEqual(decoded.balances?.map(\.currency), ["CNY", "USD"])
        XCTAssertEqual(decoded.balances?.first, cny)
        XCTAssertEqual(decoded.sharedWith, [ProviderBalanceSibling(id: "34ZvICehHBjT5Ky6b4utr", label: "DeepSeek Harness")])
        guard case .read(let balances, let low, let fetchedAt, let sharedWith) = DeepSeekBalance.state(.answered(decoded)) else {
            return XCTFail("a read is a read")
        }
        XCTAssertEqual(balances.count, 2)
        XCTAssertFalse(low)
        XCTAssertEqual(fetchedAt, "2026-10-06T07:58:00.000Z")
        XCTAssertEqual(sharedWith.map(\.label), ["DeepSeek Harness"])
    }

    func testIsAvailableFalseIsALowBalanceWithItsRealAmount() throws {
        let low = try answer("""
        {"ok": true, "isAvailable": false, "fetchedAt": "2026-10-06T08:00:00.000Z", "sharedWith": [],
         "balances": [{"currency": "CNY", "totalBalance": "0.42", "grantedBalance": "0.00", "toppedUpBalance": "0.42"}]}
        """)
        let state = DeepSeekBalance.state(.answered(low))
        guard case .read(let balances, true, _, _) = state else { return XCTFail("is_available=false is low: \(state)") }
        XCTAssertEqual(balances.first?.totalBalance, "0.42")
        XCTAssertEqual(DeepSeekBalance.rowValue(state), PoolStatus(label: "¥0.42", tone: .danger))
    }

    func testEachFailureKeepsItsReasonMessageAndWhenItWasTried() throws {
        let rejected = try answer(failure("KEY_REJECTED", "DeepSeek rejected this API key (401 Authentication Fails)."))
        XCTAssertEqual(DeepSeekBalance.state(.answered(rejected)),
                       .failed(.keyRejected, message: "DeepSeek rejected this API key (401 Authentication Fails).",
                               triedAt: "2026-10-06T08:00:00.000Z"))
        XCTAssertEqual(DeepSeekBalance.detail(.keyRejected, message: rejected.message!),
                       "DeepSeek rejected this API key (401 Authentication Fails). Change the key on the web, then retry.")

        let network = try answer(failure("NETWORK", "Couldn't reach api.deepseek.com. The key itself wasn't checked."))
        guard case .failed(.network, let message, _) = DeepSeekBalance.state(.answered(network)) else {
            return XCTFail("NETWORK is a network failure")
        }
        XCTAssertEqual(DeepSeekBalance.detail(.network, message: message), "Couldn't reach api.deepseek.com. The key itself wasn't checked.",
                       "only a rejected key is the key's to fix")

        for reason in ["UPSTREAM_ERROR", "SOMETHING_NEWER"] {
            let upstream = try answer(failure(reason, "DeepSeek answered 503 Server Overloaded."))
            guard case .failed(.upstream, _, _) = DeepSeekBalance.state(.answered(upstream)) else {
                return XCTFail("\(reason) is an upstream failure")
            }
        }
    }

    func testNothingButDeepSeeksOwnBalanceIsEverDrawnAsAnAmount() throws {
        XCTAssertEqual(DeepSeekBalance.state(nil), .loading)
        XCTAssertNil(DeepSeekBalance.rowValue(.loading), "a row says nothing while it loads")
        XCTAssertEqual(DeepSeekBalance.state(.unreachable("The Internet connection appears to be offline.")),
                       .failed(.unreachable, message: "The Internet connection appears to be offline.", triedAt: nil))
        // An answer that says ok but carries no balance is no balance — not an empty or zero one.
        for json in [#"{"ok": true, "isAvailable": true, "fetchedAt": "2026-10-06T08:00:00.000Z"}"#,
                     #"{"ok": true, "isAvailable": true, "balances": [], "fetchedAt": "2026-10-06T08:00:00.000Z"}"#,
                     #"{"ok": true, "balances": [{"currency": "CNY", "totalBalance": "1.00", "grantedBalance": "0.00", "toppedUpBalance": "1.00"}], "fetchedAt": "2026-10-06T08:00:00.000Z"}"#] {
            guard case .failed(.upstream, _, _) = DeepSeekBalance.state(.answered(try answer(json))) else {
                return XCTFail("\(json) is no balance")
            }
        }
        let failures: [ProviderBalanceReading] = [
            .answered(try answer(failure("KEY_REJECTED", "DeepSeek rejected this API key (401 Authentication Fails)."))),
            .answered(try answer(failure("NETWORK", "Couldn't reach api.deepseek.com. The key itself wasn't checked."))),
            .answered(try answer(failure("UPSTREAM_ERROR", "DeepSeek answered 503 Server Overloaded."))),
            .unreachable("Bad Gateway"),
        ]
        for reading in failures {
            let state = DeepSeekBalance.state(reading)
            XCTAssertEqual(DeepSeekBalance.rowValue(state), PoolStatus(label: "Unavailable", tone: .warning))
            guard case .failed(let failure, let message, _) = state else { return XCTFail("\(reading) is a failure") }
            let shown = DeepSeekBalance.detail(failure, message: message)
            XCTAssertNil(shown.range(of: #"[¥$]|(^|[^\d.])0(\.\d+)?(?![\d.])"#, options: .regularExpression),
                         "\(shown) reads as an amount")
        }
        for word in [DeepSeekBalance.noAmountYet, DeepSeekBalance.unknown, DeepSeekBalance.unavailable] {
            XCTAssertNil(word.range(of: #"[¥$0]"#, options: .regularExpression), "\(word) reads as an amount")
        }
    }

    // MARK: rows, amounts and times

    func testARowEndsWithEveryCurrencysTotal() throws {
        XCTAssertEqual(DeepSeekBalance.rowValue(DeepSeekBalance.state(.answered(try answer(read)))),
                       PoolStatus(label: "¥110.00 · $5.00", tone: .neutral))
    }

    func testAmountsKeepDeepSeeksFigureWithTheirCurrencysSign() {
        XCTAssertEqual(DeepSeekBalance.amount("110.00", currency: "CNY"), "¥110.00")
        XCTAssertEqual(DeepSeekBalance.amount("5", currency: "USD"), "$5.00")
        XCTAssertEqual(DeepSeekBalance.amount("0.42", currency: "CNY"), "¥0.42")
        XCTAssertEqual(DeepSeekBalance.amount("12345.6", currency: "CNY"), "¥12,345.60")
        XCTAssertEqual(DeepSeekBalance.amount("1234567.891", currency: "USD"), "$1,234,567.89")
        XCTAssertEqual(DeepSeekBalance.amount("12.30", currency: "EUR"), "12.30 EUR")
    }

    func testTheBarSplitsGrantedFromToppedUp() {
        XCTAssertEqual(DeepSeekBalance.split(cny), DeepSeekBalance.Split(granted: 10.0 / 110, toppedUp: 100.0 / 110))
        XCTAssertEqual(DeepSeekBalance.split(ProviderBalanceAmount(currency: "CNY", totalBalance: "0.42",
                                                                   grantedBalance: "0.00", toppedUpBalance: "0.42")),
                       DeepSeekBalance.Split(granted: 0, toppedUp: 1))
        XCTAssertNil(DeepSeekBalance.split(ProviderBalanceAmount(currency: "CNY", totalBalance: "0.00",
                                                                 grantedBalance: "0.00", toppedUpBalance: "0.00")))
    }

    func testWhenTheServerLastAskedDeepSeek() {
        XCTAssertEqual(DeepSeekBalance.ago("2026-10-06T07:59:30.000Z", now: now), "Just now")
        XCTAssertEqual(DeepSeekBalance.ago("2026-10-06T07:58:00.000Z", now: now), "2 min ago")
        XCTAssertEqual(DeepSeekBalance.ago("2026-10-06T05:00:00.000Z", now: now), "3 h ago")
        XCTAssertEqual(DeepSeekBalance.ago("2026-10-04T08:00:00.000Z", now: now), "2 d ago")
    }

    func testTheFootnoteNamesTheOtherProvidersHoldingTheKey() {
        XCTAssertNil(DeepSeekBalance.sameAccount([]))
        let one = DeepSeekBalance.sameAccount([ProviderBalanceSibling(id: "a", label: "DeepSeek Harness")])
        XCTAssertEqual([one?.lead, one?.names, one?.tail],
                       ["Same DeepSeek account as ", "DeepSeek Harness", " — both show this balance."])
        let three = DeepSeekBalance.sameAccount([ProviderBalanceSibling(id: "a", label: "A"),
                                                 ProviderBalanceSibling(id: "b", label: "B"),
                                                 ProviderBalanceSibling(id: "c", label: "C")])
        XCTAssertEqual([three?.names, three?.tail], ["A, B and C", " — all show this balance."])
    }

    // MARK: which keys

    func testOnlyAStoredDeepSeekKeyHasABalance() throws {
        // GET /providers/mine names the endpoint and whether a key is stored.
        let mine = try decoder.decode([ConfiguredProvider].self, from: Data("""
        [{"id": "p1", "slug": "deepseek", "label": "DeepSeek", "runtime": "claude", "presetSlug": "deepseek",
          "baseUrl": "https://api.deepseek.com/anthropic", "hasApiKey": true, "models": [], "defaultModel": "deepseek-v4-pro",
          "engines": ["claude", "opencode", "dsh"]},
         {"id": "p2", "slug": "deepseek-harness", "label": "DeepSeek Harness", "runtime": "dsh", "presetSlug": "deepseek-harness",
          "baseUrl": "https://api.deepseek.com/anthropic", "hasApiKey": true, "models": [], "defaultModel": "",
          "engines": ["dsh", "claude", "opencode"]},
         {"id": "p3", "slug": "mine", "label": "Mine", "runtime": "codex", "presetSlug": null,
          "baseUrl": "https://api.deepseek.com/v1", "hasApiKey": true, "models": [], "defaultModel": null,
          "engines": ["codex", "opencode"]},
         {"id": "p4", "slug": "proxy", "label": "Proxy", "runtime": "claude", "presetSlug": null,
          "baseUrl": "https://deepseek-proxy.example.com/anthropic", "hasApiKey": true, "models": [], "defaultModel": null,
          "engines": ["claude", "opencode"]},
         {"id": "p5", "slug": "moonshot", "label": "Kimi", "runtime": "kimi", "presetSlug": "moonshot",
          "baseUrl": "https://api.moonshot.ai/v1", "hasApiKey": true, "models": [], "defaultModel": null,
          "engines": ["kimi", "opencode"]},
         {"id": "p6", "slug": "deepseek-2", "label": "Keyless", "runtime": "claude", "presetSlug": "deepseek",
          "baseUrl": "https://api.deepseek.com/anthropic", "hasApiKey": false, "models": [], "defaultModel": null,
          "engines": ["claude", "opencode", "dsh"]}]
        """.utf8))
        XCTAssertEqual(mine.filter(DeepSeekBalance.applies(to:)).map(\.providerID), ["p1", "p2", "p3"])
        // Each key's engines, as the server lists them: every DeepSeek key on DeepSeek Harness too.
        XCTAssertEqual(mine.map { DeepSeekBalance.engine(of: $0) },
                       ["Claude Code · OpenCode · DeepSeek Harness", "DeepSeek Harness · Claude Code · OpenCode",
                        "Codex · OpenCode", "Claude Code · OpenCode", "Kimi Code · OpenCode",
                        "Claude Code · OpenCode · DeepSeek Harness"])
        XCTAssertEqual(DeepSeekBalance.endpointHost(mine[0]), "api.deepseek.com")
        // The pickers' catalogue (GET /providers) carries neither, so nothing there reads as a DeepSeek key.
        XCTAssertFalse(DeepSeekBalance.applies(to: ConfiguredProvider(slug: "deepseek", label: "DeepSeek", runtime: "claude",
                                                                      presetSlug: "deepseek")))
        // The pickers' catalogue has neither: a row is matched by slug.
        let row = ConfiguredProvider(slug: "deepseek-harness", label: "DeepSeek Harness", runtime: "dsh",
                                     presetSlug: "deepseek-harness")
        XCTAssertEqual(DeepSeekBalance.key(for: row, mine: mine)?.providerID, "p2")
        XCTAssertNil(DeepSeekBalance.key(for: ConfiguredProvider(slug: "moonshot", label: "Kimi"), mine: mine))
        XCTAssertNil(DeepSeekBalance.key(for: ConfiguredProvider(slug: "deepseek-2", label: "Keyless"), mine: mine))
        XCTAssertNil(DeepSeekBalance.key(for: ConfiguredProvider(slug: "team-deepseek", label: "Shared DeepSeek",
                                                                 presetSlug: "deepseek"), mine: mine),
                     "a shared key, on nobody's own list, opens no page")

        XCTAssertEqual(ProvidersOverview.keyLine(mine[0]), "Claude Code · OpenCode · DeepSeek Harness")
        XCTAssertEqual(ProvidersOverview.keyLine(mine[1]), "DeepSeek Harness · Claude Code · OpenCode")
        XCTAssertEqual(ProvidersOverview.keyLine(mine[3]), "Claude Code · OpenCode")
    }
}
