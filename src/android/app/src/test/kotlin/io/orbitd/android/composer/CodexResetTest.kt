package io.orbitd.android.composer

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

/** The Codex reset-credit card's rules (iOS ConsoleModel's codexReset…, CodexRateLimitResetAPIClientTests; A07-9 = c3a2e1463). */
class CodexResetTest {
    private fun obj(s: String) = Wire.json.parseToJsonElement(s).jsonObject
    private val now = Instant.parse("2026-10-09T12:00:00Z").toEpochMilli()
    private val fingerprint = "cxa1_0123456789abcdef0123456789abcdef"
    private fun block(available: Int? = 2, support: String = "SUPPORTED", fetched: String = "2026-10-09T11:58:00Z", credits: String =
        """[{"id":"c1","resetType":"weekly","status":"available","grantedAt":"2026-10-01T00:00:00Z","expiresAt":"2026-12-24T09:30:00Z"},
            {"id":"c2","resetType":"weekly","status":"available","grantedAt":"2026-10-02T00:00:00Z","expiresAt":"2027-01-05T09:30:00Z"}]""") =
        obj("""{"protocolVersion":1,"support":"$support","accountFingerprint":"$fingerprint",
            ${if (available == null) "" else """"rateLimitResetCredits":{"availableCount":$available,"credits":$credits},"""}
            "fetchedAt":"$fetched","generation":"3f2b8c1e-9d4a-4b7e-8c2f-1a2b3c4d5e6f","sequence":3}""")
    private val runner = obj("""{"id":"r","online":true,"capabilities":["codex-rate-limit-reset-v1"],
        "heartbeatLeaseOwner":"7c9e6679-7425-40de-944b-e07fc1f90ae7","heartbeatDraining":false}""")

    @Test fun onlyTheRunnersOwnCodexDefaultSpendsOne() {
        val usage = obj("""{"rateLimitReset":${block()}}""")
        assertNotNull(CodexReset.block(obj("""{"provider":"codex"}"""), usage))
        assertNull(CodexReset.block(obj("""{"provider":"codex","codexAccount":"1a2b3c4d"}"""), usage))
        assertNull(CodexReset.block(obj("""{"provider":"codex-pool"}"""), usage))
        assertNull(CodexReset.block(obj("""{"provider":"codex","workspace":{"codexAccount":"1a2b3c4d"}}"""), usage))
        assertTrue("the workspace's env brings a credential of its own", CodexReset.accountOverride(
            obj("""{"provider":"codex","workspace":{"env":{"OPENAI_API_KEY":"sk-test"}}}"""), draft = false, resumeAccount = null))
        assertFalse(CodexReset.accountOverride(obj("""{"provider":"codex","workspace":{"env":{"OPENAI_API_KEY":" "}}}"""), false, null))
    }

    /** A07-9: an account with no credit left draws no reset section at all — only its usage windows remain. */
    @Test fun theCardIsDrawnOnlyForAnIdentifiedAccountWithCreditToSpeakOf() {
        assertTrue(CodexReset.visible(block()))
        assertFalse("A07-9", CodexReset.visible(block(available = 0)))
        assertTrue("credits unavailable still says so", CodexReset.visible(block(available = null, support = "CREDITS_UNAVAILABLE")))
        assertFalse(CodexReset.visible(block(available = null, support = "UNSUPPORTED_AUTH").let { JsonObject(it - "accountFingerprint") }))
        assertFalse("a newer contract is not drawn", CodexReset.visible(JsonObject(block() + ("protocolVersion" to JsonPrimitive(2)))))
        assertFalse(CodexReset.visible(JsonObject(block() + ("accountFingerprint" to JsonPrimitive("cxa1_short")))))
        assertFalse(CodexReset.visible(null))
    }

    @Test fun theCardSaysHowManyWhenTheyExpireAndHowFreshItIs() {
        val zone = ZoneOffset.UTC
        assertEquals("2 available", CodexReset.countLabel(block()))
        assertEquals("Count unavailable", CodexReset.countLabel(block(available = null, support = "CREDITS_UNAVAILABLE")))
        assertEquals("Next expires Dec 24, 9:30 AM", CodexReset.expiryLabel(block(), zone))
        assertEquals("Expires Dec 24, 9:30 AM", CodexReset.expiryLabel(block(available = 1, credits =
            """[{"id":"c1","resetType":"weekly","status":"available","grantedAt":"2026-10-01T00:00:00Z","expiresAt":"2026-12-24T09:30:00Z"}]"""), zone))
        assertEquals("Earliest listed expires Dec 24, 9:30 AM · partial list", CodexReset.expiryLabel(block(available = 3), zone))
        assertEquals("Doesn't expire", CodexReset.expiryLabel(block(available = 1, credits =
            """[{"id":"c1","resetType":"weekly","status":"available","grantedAt":"2026-10-01T00:00:00Z"}]"""), zone))
        assertEquals("Updated 2 min ago", CodexReset.freshnessText(block(), now))
        assertEquals("Updated 20 min ago · out of date", CodexReset.freshnessText(block(fetched = "2026-10-09T11:40:00Z"), now))
        assertEquals("Updated at a time ahead of this device's clock", CodexReset.freshnessText(block(fetched = "2026-10-09T12:10:00Z"), now))
    }

    @Test fun thePressIsOfferedOnlyWhereTheServerWouldTakeIt() {
        fun reason(b: JsonObject = block(), r: JsonObject? = runner, override: Boolean = false, active: JsonObject? = null) =
            CodexReset.eligibilityReason(b, r, override, active, null, now)
        assertNull(reason())
        assertEquals("This workspace doesn't run on the runner's own Codex sign-in.", reason(override = true))
        assertEquals("A reset is already in progress for this Codex account.", reason(active = obj("""{"status":"CONSUMING"}""")))
        assertEquals("The runner is offline.", reason(r = JsonObject(runner + ("online" to JsonPrimitive(false)))))
        assertEquals("Update this runner to use reset credits.", reason(r = JsonObject(runner + ("capabilities" to JsonArray(emptyList())))))
        assertEquals("The runner hasn't checked in yet.", reason(r = JsonObject(runner - "heartbeatLeaseOwner")))
        assertEquals("The runner is restarting.", reason(r = JsonObject(runner + ("heartbeatDraining" to JsonPrimitive(true)))))
        assertEquals("Usage is out of date. Waiting for the runner to refresh it.", reason(b = block(fetched = "2026-10-09T11:40:00Z")))
        assertEquals("Codex isn't reporting reset credits right now.", reason(b = block(available = null, support = "CREDITS_UNAVAILABLE")))
        assertEquals("No reset credits available.", reason(b = block(available = 0)))
        assertEquals("No reset credits available.", CodexReset.refusalReason("NO_CREDIT_AVAILABLE"))
        assertNull(CodexReset.refusalReason("SOMETHING_NEW"))
    }

    @Test fun anOperationSaysWhereItIs() {
        assertTrue(CodexReset.isActive(obj("""{"status":"PENDING"}""")))
        assertTrue("a status this build has no word for fails closed", CodexReset.isActive(obj("""{"status":"VERIFYING"}""")))
        assertFalse(CodexReset.isActive(obj("""{"status":"SUCCEEDED"}""")))
        assertEquals("Waiting for the runner…", CodexReset.progress(obj("""{"status":"PENDING"}""")))
        assertEquals("Limits reset — refreshing usage…", CodexReset.progress(obj("""{"status":"REFRESHING","consumeOutcome":"reset"}""")))
        assertEquals("Usage limits reset · 1 credit used", CodexReset.result(obj("""{"status":"SUCCEEDED","consumeOutcome":"reset"}""")))
        assertEquals("Result unknown · a credit may have been used", CodexReset.result(obj("""{"status":"UNRESOLVED"}""")))
    }
}
