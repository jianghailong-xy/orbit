package io.orbitd.android.management

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

/** AccessTokens, ported with iOS's AccessTokensListTests: which tab a token is filed under, whether it can be revoked, and each
 * line its row says — what it reaches, when it stops, when it was last used — and the list as the server answers it. */
class AccessTokensLogicTest {
    /** Noon UTC, read in UTC, so the day a date names is the same wherever the test runs. */
    private val now = Instant.parse("2026-10-06T12:00:00.000Z").toEpochMilli()
    private val utc = ZoneOffset.UTC

    private fun token(state: String = "ACTIVE", scopes: List<String> = listOf("tasks:read"), workspaceIds: List<String> = emptyList(),
        workspaces: List<Pair<String, String>> = emptyList(), expiresAt: String? = null, lastUsedAt: String? = null, lastUsedIp: String? = null,
        revokedAt: String? = null, revokedReason: String? = null) = buildJsonObject {
        put("id", "T-$state"); put("name", "deploy-bot"); put("tokenHint", "k3Fq"); put("state", state)
        put("scopes", JsonArray(scopes.map(::JsonPrimitive))); put("workspaceIds", JsonArray(workspaceIds.map(::JsonPrimitive)))
        put("workspaces", JsonArray(workspaces.map { (id, name) -> buildJsonObject { put("id", id); put("name", name) } }))
        put("expiresAt", expiresAt?.let(::JsonPrimitive) ?: JsonNull); put("lastUsedAt", lastUsedAt?.let(::JsonPrimitive) ?: JsonNull)
        put("lastUsedIp", lastUsedIp?.let(::JsonPrimitive) ?: JsonNull); put("revokedAt", revokedAt?.let(::JsonPrimitive) ?: JsonNull)
        put("revokedReason", revokedReason?.let(::JsonPrimitive) ?: JsonNull)
    }

    @Test fun theTabsFileEachTokenByWhetherItStillWorks() {
        val all = listOf(token("ACTIVE"), token("REVOKED"), token("EXPIRED"), token("SUSPENDED"), token("ACTIVE"))
        assertEquals(listOf("Active", "Revoked & expired"), AccessTokens.Tab.entries.map { it.label })
        assertEquals(listOf("ACTIVE", "ACTIVE"), AccessTokens.tokens(all, AccessTokens.Tab.ACTIVE).map { it.text("state") })
        assertEquals(listOf("REVOKED", "EXPIRED", "SUSPENDED"), AccessTokens.tokens(all, AccessTokens.Tab.ENDED).map { it.text("state") })
        assertTrue(AccessTokens.canRevoke(token("ACTIVE")))
        listOf("REVOKED", "EXPIRED", "SUSPENDED").forEach { assertFalse("a $it token has nothing left to revoke", AccessTokens.canRevoke(token(it))) }
        assertEquals("orbit_pat_…k3Fq", AccessTokens.hint(token()))
    }

    @Test fun theScopeSummaryNamesAPresetOrEachResource() {
        assertEquals("Read & write · everything", AccessTokens.scopeSummary(AccessTokens.allScopes))
        assertEquals("Read-only · everything", AccessTokens.scopeSummary(AccessTokens.readScopes))
        assertEquals("the order a token's scopes come in is not what it can do", "Read-only · everything", AccessTokens.scopeSummary(AccessTokens.readScopes.reversed()))
        assertEquals("Tasks: read & write · Sessions: read · Wiki: write", AccessTokens.scopeSummary(listOf("sessions:read", "tasks:write", "tasks:read", "wiki:write")))
        assertEquals("Runners: read · Events: read", AccessTokens.scopeSummary(listOf("events:read", "runners:read")))
        // Twelve scopes, the server's PAT_SCOPES; the read-only preset is the seven :read ones.
        assertEquals(12, AccessTokens.allScopes.toSet().size)
        assertEquals(7, AccessTokens.readScopes.size)
        assertTrue(AccessTokens.readScopes.all { it.endsWith(":read") })
        // A scope newer than this build is still something the token holds: named, never a blank line.
        assertEquals("billing:read", AccessTokens.scopeSummary(listOf("billing:read")))
    }

    @Test fun theAccessLineSaysWhereAConfinedTokenReaches() {
        assertEquals("Read-only · everything", AccessTokens.accessLine(token(scopes = AccessTokens.readScopes)))
        assertEquals("All workspaces", AccessTokens.workspacesLine(token()))
        val confined = token(scopes = listOf("tasks:read", "tasks:write"), workspaceIds = listOf("w1", "w2"), workspaces = listOf("w1" to "orbit", "w2" to "docs"))
        assertEquals("Tasks: read & write · in orbit, docs", AccessTokens.accessLine(confined))
        assertEquals("orbit, a deleted workspace", AccessTokens.workspacesLine(token(workspaceIds = listOf("w1", "w2"), workspaces = listOf("w1" to "orbit"))))
        assertEquals("2 deleted workspaces", AccessTokens.workspacesLine(token(workspaceIds = listOf("w1", "w2"))))
    }

    @Test fun aWorkingTokenSaysWhenItExpiresOrIsMarkedAsNeverExpiring() {
        val ninety = token(expiresAt = "2027-01-04T12:00:00.000Z")
        assertEquals("Expires Jan 4, 2027 · in 90 days", AccessTokens.expiryLine(ninety, now, utc))
        assertFalse(AccessTokens.isNeverExpiring(ninety))
        val never = token(expiresAt = null)
        assertTrue(AccessTokens.isNeverExpiring(never))
        assertEquals("Never expires", AccessTokens.expiryLine(never, now, utc))
        assertFalse("only a token that still works carries the mark",
            AccessTokens.isNeverExpiring(token("REVOKED", expiresAt = null, revokedAt = "2026-10-01T12:00:00.000Z")))
    }

    /** The web's untilLine, rounding to the nearest hour, then day. */
    @Test fun howFarOffAnExpiryIs() {
        fun until(seconds: Long) = AccessTokens.untilLine(Instant.ofEpochMilli(now).plusSeconds(seconds).toString(), now)
        assertEquals("in less than an hour", until(20 * 60))
        assertEquals("past due but not yet settled", "in less than an hour", until(-60))
        assertEquals("in 1 hour", until(3600))
        assertEquals("in 5 hours", until(5 * 3600 + 10 * 60))
        assertEquals("in 1 day", until(30 * 3600))
        assertEquals("in 90 days", until(89 * 86_400 + 20 * 3600))
        assertNull(AccessTokens.untilLine("not a date", now))
    }

    @Test fun anEndedTokenSaysWhyItStopped() {
        assertEquals("Revoked Oct 1, 2026", AccessTokens.expiryLine(token("REVOKED", revokedAt = "2026-10-01T12:00:00.000Z", revokedReason = "USER"), now, utc))
        assertEquals("Revoked by an administrator Oct 2, 2026", AccessTokens.endedLine(token("REVOKED", revokedAt = "2026-10-02T12:00:00.000Z", revokedReason = "ADMIN"), utc))
        assertEquals("Revoked with a password change Oct 3, 2026",
            AccessTokens.endedLine(token("REVOKED", revokedAt = "2026-10-03T12:00:00.000Z", revokedReason = "PASSWORD_CHANGED"), utc))
        assertEquals("Revoked", AccessTokens.endedLine(token("REVOKED"), utc))
        assertEquals("the day it ran out, not the day that was noticed", "Expired Sep 30, 2026",
            AccessTokens.endedLine(token("EXPIRED", expiresAt = "2026-09-30T12:00:00.000Z", revokedAt = "2026-10-01T12:00:00.000Z", revokedReason = "EXPIRED"), utc))
        assertEquals("Expired Oct 1, 2026", AccessTokens.endedLine(token("EXPIRED", revokedAt = "2026-10-01T12:00:00.000Z"), utc))
        assertEquals("Expired", AccessTokens.endedLine(token("EXPIRED"), utc))
    }

    @Test fun theLastUseSaysWhenAndFromWhere() {
        assertEquals("Never used", AccessTokens.lastUsedLine(token(), now))
        assertEquals("Last used 3h 20m ago · 203.0.113.7", AccessTokens.lastUsedLine(token(lastUsedAt = "2026-10-06T08:40:00.000Z", lastUsedIp = "203.0.113.7"), now))
        assertEquals("Last used just now · Address unknown", AccessTokens.lastUsedLine(token(lastUsedAt = "2026-10-06T11:59:58.000Z"), now))
    }

    @Test fun theSettingsRowCountsTheTokensThatWorkAndTheRevokeAsksByName() {
        assertEquals("3 active", settingsAccessTokensValue(3))
        assertEquals("None", settingsAccessTokensValue(0))
        assertEquals("Revoke “deploy-bot”?", AccessTokens.revokeTitle(token()))
        assertEquals("Couldn't revoke the token: the connection dropped", AccessTokens.notRevoked("the connection dropped"))
    }

    /** GET /access-tokens as PatService.list answers it — and an answer that isn't a list is no list, never "No active tokens". */
    @Test fun theServersListIsReadAndAMalformedOneRefused() {
        val list = accessTokenList(Json.parseToJsonElement("""{"tokens":[
            {"id":"34ajTok1","name":"deploy-bot","tokenHint":"k3Fq","scopes":["tasks:read","tasks:write"],"workspaceIds":["w1"],
             "workspaces":[{"id":"w1","name":"orbit"}],"expiresAt":null,"createdVia":"WEB","lastUsedAt":"2026-10-06T08:40:00.000Z",
             "lastUsedIp":"203.0.113.7","lastUsedUserAgent":"curl/8.7.1","revokedAt":null,"revokedReason":null,"createdAt":"2026-09-01T12:00:00.000Z","state":"ACTIVE"},
            {"id":"34ajTok3","name":"from the future","tokenHint":"zzzz","scopes":[],"workspaceIds":[],"workspaces":[],"expiresAt":null,
             "createdVia":"SOMETHING_NEW","state":"SUSPENDED","createdAt":"2026-09-03T12:00:00.000Z"}]}"""))
        assertEquals(listOf("34ajTok1", "34ajTok3"), list.map { it.text("id") })
        assertTrue(AccessTokens.isNeverExpiring(list[0]))
        assertEquals("a state this build doesn't know never fails the list", listOf(list[1]), AccessTokens.tokens(list, AccessTokens.Tab.ENDED))
        for (bad in listOf("""[]""", """{"items":[]}""", """{"tokens":[{"name":"no id"}]}""")) {
            assertThrows(IllegalStateException::class.java) { accessTokenList(Json.parseToJsonElement(bad)) }
        }
    }
}
