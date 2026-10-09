package io.orbitd.android.management

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

/** DeepSeekBalance, ported with iOS's DeepSeekBalanceTests: what GET providers/mine/:id/balance answers comes to on Settings →
 * Providers and on the key's page — and no answer short of DeepSeek's own balance is ever drawn as an amount. */
class DeepSeekBalanceLogicTest {
    private val now = Instant.parse("2026-10-06T08:00:00.000Z").toEpochMilli()
    private fun json(text: String) = Json.parseToJsonElement(text).jsonObject
    private fun answered(text: String) = DeepSeekBalance.Reading.Answered(json(text))

    /** What the server sends a public client for a read: ids replaced by their public form, and a publicId twin beside each. */
    private val read = """{"ok": true, "isAvailable": true, "fetchedAt": "2026-10-06T07:58:00.000Z",
        "balances": [{"currency": "CNY", "totalBalance": "110.00", "grantedBalance": "10.00", "toppedUpBalance": "100.00"},
                     {"currency": "USD", "totalBalance": "5.00", "grantedBalance": "0.00", "toppedUpBalance": "5.00"}],
        "sharedWith": [{"id": "34ZvICehHBjT5Ky6b4utr", "publicId": "34ZvICehHBjT5Ky6b4utr", "label": "DeepSeek Harness"}]}"""
    private fun failure(reason: String, message: String) =
        """{"ok": false, "reason": "$reason", "message": "$message", "fetchedAt": "2026-10-06T08:00:00.000Z", "sharedWith": []}"""
    private val cny = json("""{"currency": "CNY", "totalBalance": "110.00", "grantedBalance": "10.00", "toppedUpBalance": "100.00"}""")

    @Test fun aReadKeepsEveryCurrencyAndWhoElseHoldsTheKey() {
        val state = DeepSeekBalance.state(answered(read)) as DeepSeekBalance.State.Read
        assertEquals(listOf("CNY", "USD"), state.balances.map { it.text("currency") })
        assertFalse(state.low)
        assertEquals("2026-10-06T07:58:00.000Z", state.fetchedAt)
        assertEquals(listOf("DeepSeek Harness"), state.sharedWith.map { it.text("label") })
        assertEquals(PoolStatus("¥110.00 · $5.00", "neutral"), DeepSeekBalance.rowValue(state))
    }

    @Test fun isAvailableFalseIsALowBalanceWithItsRealAmount() {
        val state = DeepSeekBalance.state(answered("""{"ok": true, "isAvailable": false, "fetchedAt": "2026-10-06T08:00:00.000Z", "sharedWith": [],
            "balances": [{"currency": "CNY", "totalBalance": "0.42", "grantedBalance": "0.00", "toppedUpBalance": "0.42"}]}"""))
        assertTrue("is_available=false is low", (state as DeepSeekBalance.State.Read).low)
        assertEquals("0.42", state.balances.first().text("totalBalance"))
        assertEquals(PoolStatus("¥0.42", "danger"), DeepSeekBalance.rowValue(state))
    }

    @Test fun eachFailureKeepsItsReasonMessageAndWhenItWasTried() {
        val rejected = DeepSeekBalance.state(answered(failure("KEY_REJECTED", "DeepSeek rejected this API key (401 Authentication Fails).")))
        assertEquals(DeepSeekBalance.State.Failed(DeepSeekBalance.Failure.KEY_REJECTED, "DeepSeek rejected this API key (401 Authentication Fails).",
            "2026-10-06T08:00:00.000Z"), rejected)
        assertEquals("DeepSeek rejected this API key (401 Authentication Fails). Change the key on the web, then retry.",
            DeepSeekBalance.detail(DeepSeekBalance.Failure.KEY_REJECTED, "DeepSeek rejected this API key (401 Authentication Fails)."))
        val network = DeepSeekBalance.state(answered(failure("NETWORK", "Couldn't reach api.deepseek.com. The key itself wasn't checked."))) as DeepSeekBalance.State.Failed
        assertEquals(DeepSeekBalance.Failure.NETWORK, network.failure)
        assertEquals("only a rejected key is the key's to fix", "Couldn't reach api.deepseek.com. The key itself wasn't checked.",
            DeepSeekBalance.detail(network.failure, network.message))
        for (reason in listOf("UPSTREAM_ERROR", "SOMETHING_NEWER")) {
            assertEquals(reason, DeepSeekBalance.Failure.UPSTREAM,
                (DeepSeekBalance.state(answered(failure(reason, "DeepSeek answered 503 Server Overloaded."))) as DeepSeekBalance.State.Failed).failure)
        }
    }

    @Test fun nothingButDeepSeeksOwnBalanceIsEverDrawnAsAnAmount() {
        assertEquals(DeepSeekBalance.State.Loading, DeepSeekBalance.state(null))
        assertNull("a row says nothing while it loads", DeepSeekBalance.rowValue(DeepSeekBalance.State.Loading))
        assertEquals(DeepSeekBalance.State.Failed(DeepSeekBalance.Failure.UNREACHABLE, "the connection dropped", null),
            DeepSeekBalance.state(DeepSeekBalance.Reading.Unreachable("the connection dropped")))
        // An answer that says ok but carries no balance is no balance — not an empty or zero one.
        for (text in listOf("""{"ok": true, "isAvailable": true, "fetchedAt": "2026-10-06T08:00:00.000Z"}""",
            """{"ok": true, "isAvailable": true, "balances": [], "fetchedAt": "2026-10-06T08:00:00.000Z"}""",
            """{"ok": true, "balances": [{"currency": "CNY", "totalBalance": "1.00", "grantedBalance": "0.00", "toppedUpBalance": "1.00"}], "fetchedAt": "2026-10-06T08:00:00.000Z"}""")) {
            assertEquals(text, DeepSeekBalance.Failure.UPSTREAM, (DeepSeekBalance.state(answered(text)) as DeepSeekBalance.State.Failed).failure)
        }
        val failures = listOf(answered(failure("KEY_REJECTED", "DeepSeek rejected this API key (401 Authentication Fails).")),
            answered(failure("NETWORK", "Couldn't reach api.deepseek.com. The key itself wasn't checked.")),
            answered(failure("UPSTREAM_ERROR", "DeepSeek answered 503 Server Overloaded.")), DeepSeekBalance.Reading.Unreachable("Bad Gateway"))
        val amount = Regex("""[¥$]|(^|[^\d.])0(\.\d+)?(?![\d.])""")
        for (reading in failures) {
            val state = DeepSeekBalance.state(reading) as DeepSeekBalance.State.Failed
            assertEquals(PoolStatus("Unavailable", "warning"), DeepSeekBalance.rowValue(state))
            val shown = DeepSeekBalance.detail(state.failure, state.message)
            assertFalse("$shown reads as an amount", amount.containsMatchIn(shown))
        }
        for (word in listOf(DeepSeekBalance.NO_AMOUNT_YET, DeepSeekBalance.UNKNOWN, DeepSeekBalance.UNAVAILABLE)) {
            assertFalse("$word reads as an amount", Regex("[¥$0]").containsMatchIn(word))
        }
    }

    @Test fun amountsKeepDeepSeeksFigureWithTheirCurrencysSign() {
        assertEquals("¥110.00", DeepSeekBalance.amount("110.00", "CNY"))
        assertEquals("$5.00", DeepSeekBalance.amount("5", "USD"))
        assertEquals("¥0.42", DeepSeekBalance.amount("0.42", "CNY"))
        assertEquals("¥12,345.60", DeepSeekBalance.amount("12345.6", "CNY"))
        assertEquals("$1,234,567.89", DeepSeekBalance.amount("1234567.891", "USD"))
        assertEquals("12.30 EUR", DeepSeekBalance.amount("12.30", "EUR"))
    }

    @Test fun theBarSplitsGrantedFromToppedUp() {
        assertEquals(DeepSeekBalance.Split(10.0 / 110, 100.0 / 110), DeepSeekBalance.split(cny))
        assertEquals(DeepSeekBalance.Split(0.0, 1.0), DeepSeekBalance.split(json("""{"currency": "CNY", "totalBalance": "0.42", "grantedBalance": "0.00", "toppedUpBalance": "0.42"}""")))
        assertNull(DeepSeekBalance.split(json("""{"currency": "CNY", "totalBalance": "0.00", "grantedBalance": "0.00", "toppedUpBalance": "0.00"}""")))
    }

    @Test fun whenTheServerLastAskedDeepSeek() {
        assertEquals("Just now", DeepSeekBalance.ago("2026-10-06T07:59:30.000Z", now))
        assertEquals("2 min ago", DeepSeekBalance.ago("2026-10-06T07:58:00.000Z", now))
        assertEquals("3 h ago", DeepSeekBalance.ago("2026-10-06T05:00:00.000Z", now))
        assertEquals("2 d ago", DeepSeekBalance.ago("2026-10-04T08:00:00.000Z", now))
        assertEquals("Unknown", DeepSeekBalance.ago("not a date", now))
    }

    @Test fun theFootnoteNamesTheOtherProvidersHoldingTheKey() {
        assertNull(DeepSeekBalance.sameAccount(emptyList()))
        fun sibling(label: String) = json("""{"id": "$label", "label": "$label"}""")
        assertEquals(Triple("Same DeepSeek account as ", "DeepSeek Harness", " — both show this balance."), DeepSeekBalance.sameAccount(listOf(sibling("DeepSeek Harness"))))
        val three = DeepSeekBalance.sameAccount(listOf(sibling("A"), sibling("B"), sibling("C")))
        assertEquals("A, B and C" to " — all show this balance.", three?.second to three?.third)
    }

    @Test fun onlyAStoredDeepSeekKeyHasABalance() {
        // GET providers/mine names the endpoint and whether a key is stored.
        val mine = Json.parseToJsonElement("""[
          {"id": "p1", "slug": "deepseek", "label": "DeepSeek", "runtime": "claude", "presetSlug": "deepseek", "baseUrl": "https://api.deepseek.com/anthropic", "hasApiKey": true, "defaultModel": "deepseek-v4-pro"},
          {"id": "p2", "slug": "deepseek-harness", "label": "DeepSeek Harness", "runtime": "dsh", "presetSlug": "deepseek-harness", "baseUrl": "https://api.deepseek.com/anthropic", "hasApiKey": true, "defaultModel": ""},
          {"id": "p3", "slug": "mine", "label": "Mine", "runtime": "codex", "presetSlug": null, "baseUrl": "https://api.deepseek.com/v1", "hasApiKey": true, "defaultModel": null},
          {"id": "p4", "slug": "proxy", "label": "Proxy", "runtime": "claude", "presetSlug": null, "baseUrl": "https://deepseek-proxy.example.com/anthropic", "hasApiKey": true, "defaultModel": null},
          {"id": "p5", "slug": "moonshot", "label": "Kimi", "runtime": "kimi", "presetSlug": "moonshot", "baseUrl": "https://api.moonshot.ai/v1", "hasApiKey": true, "defaultModel": null},
          {"id": "p6", "slug": "deepseek-2", "label": "Keyless", "runtime": "claude", "presetSlug": "deepseek", "baseUrl": "https://api.deepseek.com/anthropic", "hasApiKey": false, "defaultModel": null}
        ]""").jsonArray.map { it.jsonObject }
        assertEquals(listOf("p1", "p2", "p3"), mine.filter(DeepSeekBalance::applies).map { it.text("id") })
        assertEquals(listOf("Claude Code", "DeepSeek Harness", "Codex", "Claude Code", "Claude Code", "Claude Code"), mine.map(DeepSeekBalance::engine))
        assertEquals("api.deepseek.com", DeepSeekBalance.endpointHost(mine[0]))
        // The pickers' catalogue (GET providers) carries neither, so nothing there reads as a DeepSeek key; a row is matched by slug.
        assertFalse(DeepSeekBalance.applies(json("""{"slug": "deepseek", "label": "DeepSeek", "runtime": "claude", "presetSlug": "deepseek"}""")))
        assertEquals("p2", DeepSeekBalance.key(json("""{"slug": "deepseek-harness", "label": "DeepSeek Harness", "runtime": "dsh"}"""), mine)?.text("id"))
        assertNull(DeepSeekBalance.key(json("""{"slug": "moonshot", "label": "Kimi"}"""), mine))
        assertNull(DeepSeekBalance.key(json("""{"slug": "deepseek-2", "label": "Keyless"}"""), mine))
        assertNull("a shared key, on nobody's own list, opens no page", DeepSeekBalance.key(json("""{"slug": "team-deepseek", "label": "Shared DeepSeek"}"""), mine))
        assertEquals("deepseek-v4-pro", providerKeyLine(mine[0]))
        assertEquals("Runs on DeepSeek Harness", providerKeyLine(mine[1]))
        assertNull(providerKeyLine(mine[3]))
    }
}
