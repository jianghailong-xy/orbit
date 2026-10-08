package io.orbitd.android.composer

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * The account rows of the composer's model menu (OrbitKit SessionProviderChoices.accountChoices, AntigravityAccountsTests'
 * picker case): each of the runner's accounts with its own quota's tightest window — an Antigravity bucket by what it has
 * left, in agy's words for it — "env key" for a Default on the runner's own Gemini key, and the capability that moves a session.
 */
class ComposerAccountsTest {
    private fun obj(s: String) = Wire.json.parseToJsonElement(s).jsonObject
    private fun buckets(vararg left: Double) = listOf("gemini-weekly", "gemini-5h", "3p-weekly", "3p-5h").zip(left.toList()).joinToString(",", "[", "]") { (id, rest) ->
        """{"id":"$id","window":"${if (id.endsWith("5h")) "5h" else "weekly"}","remainingFraction":$rest}"""
    }
    private fun runner(authSource: String, defaultAuth: String, defaultBuckets: String?, capabilities: String = "\"antigravity-account-login/v1\"") =
        ComposerCatalog(obj("""{"id":"r","capabilities":[$capabilities],"engines":[{"engine":"antigravity","installed":true,"auth":"yes","authSource":"$authSource",
            "accounts":[{"id":"default","auth":"$defaultAuth"},{"id":"5c2e91a0","name":"Work","auth":"yes"}],
            "planUsage":{"provider":"antigravity"${defaultBuckets?.let { ""","buckets":$it""" }.orEmpty()},
              "accounts":{"5c2e91a0":{"provider":"antigravity","buckets":${buckets(0.61, 0.04, 1.0, 1.0)}}}}}]}"""), emptyList())

    @Test fun theGoogleAccountsAreListedByTheBucketWithTheLeastLeft() {
        assertEquals(listOf(AccountChoice("default", "Default", "3p-weekly 98% left"), AccountChoice("5c2e91a0", "Work", "gemini-5h 4% left", nearLimit = true)),
            runner("google", "yes", buckets(1.0, 1.0, 0.98, 1.0)).accountChoices("antigravity"))
        assertEquals("it runs, on the key: not an account that is signed out",
            listOf(AccountChoice("default", "Default", "env key"), AccountChoice("5c2e91a0", "Work", "gemini-5h 4% left", nearLimit = true)),
            runner("env_key", "no", null).accountChoices("antigravity"))
    }

    @Test fun codexRowsSayTheirTightestWindowAndASignedOutOneWhy() {
        val catalog = ComposerCatalog(obj("""{"id":"r","engines":[{"engine":"codex","installed":true,"auth":"yes",
            "accounts":[{"id":"default","auth":"yes"},{"id":"1a2b3c4d","name":"Second account","auth":"yes"},{"id":"deadbeef","name":"Expired account","auth":"no"}]}],
            "planUsage":{"codex":{"provider":"codex","primary":{"utilization":23,"windowDurationMins":300},"secondary":{"utilization":40,"windowDurationMins":10080},
              "accounts":{"1a2b3c4d":{"provider":"codex","primary":{"utilization":71,"windowDurationMins":300}}}}}}"""), emptyList())
        assertEquals(listOf(AccountChoice("default", "Default", "Weekly 40%"), AccountChoice("1a2b3c4d", "Second account", "5h 71%"),
            AccountChoice("deadbeef", "Expired account", unavailable = "Not signed in")), catalog.accountChoices("codex"))
        assertEquals(emptyList<AccountChoice>(), catalog.accountChoices("kimi"))
    }

    /** Kimi Code's accounts are rows too, each by its own tightest window — the month drawn once, so its coding share never
     * names one — and a Kimi session moves on kimi-account-move/v1, never on Codex's. A session's quota is its account's. */
    @Test fun kimiAccountsAreRowsAndMoveOnKimisOwnCapability() {
        fun catalog(capabilities: String) = ComposerCatalog(obj("""{"id":"r","capabilities":[$capabilities],"engines":[{"engine":"kimi","installed":true,"auth":"yes",
            "accounts":[{"id":"default","auth":"yes","kimiRegion":"global"},{"id":"5c2e91a0","name":"Work","auth":"yes","kimiRegion":"mainland-cn"},
              {"id":"deadbeef","name":"Old","auth":"no"}]}],
            "planUsage":{"kimi":{"provider":"kimi","fiveHour":{"utilization":12},"sevenDay":{"utilization":34},"month":{"utilization":8},"monthCode":{"utilization":50},
              "accounts":{"5c2e91a0":{"provider":"kimi","fiveHour":{"utilization":91},"sevenDay":{"utilization":61},"month":{"utilization":22}}}}}}"""), emptyList())
        val kimi = catalog("\"kimi-account-move/v1\"")
        assertEquals(listOf(AccountChoice("default", "Default", "Weekly 34%"), AccountChoice("5c2e91a0", "Work", "5h 91%", nearLimit = true),
            AccountChoice("deadbeef", "Old", unavailable = "Not signed in")), kimi.accountChoices("kimi"))
        assertTrue(kimi.movesAccounts("kimi"))
        assertFalse("Codex's capability carries no Kimi conversation", catalog("\"codex-account-move/v1\"").movesAccounts("kimi"))
        fun fiveHours(detail: String) = kimi.usage(obj(detail))?.get("fiveHour")?.jsonObject?.get("utilization")?.jsonPrimitive?.int
        assertEquals(91, fiveHours("""{"provider":"kimi","kimiAccount":"5c2e91a0"}"""))
        assertEquals(12, fiveHours("""{"provider":"kimi","kimiAccount":"default"}"""))
        assertNull("Automatic has not chosen the account yet", kimi.usage(obj("""{"provider":"kimi","kimiAccount":"automatic"}""")))
    }

    /** A session moves between Google accounts on a runner that keeps them (antigravity-account-login/v1); Codex's and Claude
     * Code's carry the conversation across (…-account-move/v1). */
    @Test fun aSessionMovesWhereTheRunnerSaysItCan() {
        val google = runner("google", "yes", null)
        assertTrue(google.movesAccounts("antigravity"))
        assertFalse(google.movesAccounts("codex"))
        assertFalse(runner("google", "yes", null, capabilities = "\"codex-account-move/v1\"").movesAccounts("antigravity"))
        assertTrue(runner("google", "yes", null, capabilities = "\"codex-account-move/v1\"").movesAccounts("codex"))
    }
}
