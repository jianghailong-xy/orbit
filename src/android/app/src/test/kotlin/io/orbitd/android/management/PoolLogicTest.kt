package io.orbitd.android.management

import io.orbitd.android.core.net.ApiError
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

/** The Providers rules as OrbitKit states them: who may do what in a pool, and what each row says. */
class PoolLogicTest {
    private val now = Instant.parse("2026-10-07T12:00:00Z").toEpochMilli()

    private fun person(userId: String, name: String, role: String = "MEMBER", creator: Boolean = false, you: Boolean = false, cost: Double = 0.0, keys: Int = 0) =
        buildJsonObject { put("userId", userId); put("name", name); put("role", role); put("creator", creator); put("you", you)
            put("keys", keys); put("sessions", 2); put("usage", buildJsonObject { put("costUsd", cost) }) }
    private fun key(id: String, contributor: String, you: Boolean, state: String = "ACTIVE", enabled: Boolean = true, cap: Int? = null, others: Double = 0.0) =
        buildJsonObject { put("id", id); put("label", "Key $id"); put("fingerprint", "sk-…$id"); put("state", state); put("enabled", enabled)
            cap?.let { put("shareCap", it) }; put("running", false); put("next", false)
            put("contributor", buildJsonObject { put("userId", contributor); put("name", contributor.uppercase()); put("you", you) })
            put("usage", buildJsonObject { put("othersCostUsd", others) }) }
    private fun pool(viewerRole: String, people: List<JsonObject>, keys: List<JsonObject> = emptyList(), shared: Boolean = true,
                     membersCanAdd: Boolean = false, membersCanAddAccounts: Boolean = false, logins: List<JsonObject> = emptyList()) = buildJsonObject {
        put("id", "pool"); put("slug", "team"); put("label", "Team pool"); put("engine", "codex"); put("shared", shared)
        put("viewerRole", viewerRole); put("membersCanAdd", membersCanAdd); put("membersCanAddAccounts", membersCanAddAccounts); put("ownKeyFirst", false)
        put("people", JsonArray(people)); put("keys", JsonArray(keys)); put("logins", JsonArray(logins))
        put("window", buildJsonObject { put("start", "2026-10-01T00:00:00Z"); put("end", "2026-11-01T00:00:00Z") })
    }
    private fun login(fingerprint: String, userId: String, state: String = "ACTIVE", next: Boolean = false, utilization: Double = 10.0) = buildJsonObject {
        put("state", state); put("email", "$fingerprint@example.test"); put("plan", "plus"); put("fingerprint", "…$fingerprint"); put("userId", userId); put("next", next)
        put("usage", buildJsonObject { put("provider", "codex"); put("primary", buildJsonObject { put("utilization", utilization); put("windowDurationMins", 300); put("resetsAt", "2026-10-07T14:00:00Z") }) })
    }

    @Test fun peopleAndRulesBelongToTheOwnerNotToEveryPoolAdmin() {
        val people = listOf(person("owner", "Olive", "ADMIN", creator = true), person("admin", "Ada", "ADMIN"), person("member", "Max"))
        val asOwner = WhoCanUseIt(pool("ADMIN", people.map { if (it.text("userId") == "owner") JsonObject(it + ("you" to JsonPrimitive(true))) else it }), 1)
        val asAdmin = WhoCanUseIt(pool("ADMIN", people.map { if (it.text("userId") == "admin") JsonObject(it + ("you" to JsonPrimitive(true))) else it }), 1)
        assertTrue(asOwner.mine && asOwner.showsRule && asOwner.addsPeople && asOwner.manages(people[1]))
        assertFalse(asOwner.manages(people[0]))
        assertFalse(asAdmin.mine || asAdmin.showsRule || asAdmin.addsPeople || asAdmin.manages(people[2]))
        assertEquals("Set by Olive · share of this month’s API key use", asAdmin.note)
        val adminView = CodexPoolView(null, asAdmin.pool, now)
        assertEquals("Leave pool", adminView.exitLabel)
        assertEquals("Your keys leave with you.", adminView.outNote)
        assertNotNull("The server refuses an admin's leave (shared-pools.service leave)", adminView.exitBlocked)
        assertEquals("Delete pool", CodexPoolView(null, asOwner.pool, now).exitLabel)
    }

    @Test fun accountsAndKeysFollowContributorAndRoleGates() {
        val people = listOf(person("owner", "Olive", "ADMIN", creator = true), person("me", "Mia", you = true))
        val member = pool("MEMBER", people, membersCanAdd = true)
        val view = CodexPoolView(null, member, now)
        assertTrue(view.mayAddKey); assertFalse(view.mayAddAccount)
        assertEquals("key", view.adding); assertEquals("Add a key", view.addLabel)
        val mine = key("1", "me", you = true); val theirs = key("2", "owner", you = false)
        assertTrue(PoolPage.canSwitch(mine) && PoolPage.canRemove(mine, member))
        assertFalse(PoolPage.canSwitch(theirs) || PoolPage.canRemove(theirs, member) || PoolPage.canReplace(theirs, member))
        val admin = pool("ADMIN", people)
        assertTrue(PoolPage.canRemove(theirs, admin)); assertFalse(PoolPage.canSwitch(theirs))
        val ownLogin = login("a1", "me"); val otherLogin = login("b2", "owner")
        // Signing in again is an add (codex-login.service assertMayAddAccount): this member's rule lets in keys, not accounts.
        assertFalse(PoolPage.canSignInAgain(ownLogin, member)); assertTrue(PoolPage.canSignOut(ownLogin, member))
        assertFalse(PoolPage.canSignInAgain(otherLogin, admin)); assertTrue(PoolPage.canSignOut(otherLogin, admin))
        assertFalse(PoolPage.canSignOut(otherLogin, member))
        assertNull(CodexPoolView(null, pool("MEMBER", people), now).adding)
    }

    /** What the server takes from each role (shared-pools.service addKey/leave, codex-login.service assertMayAddAccount),
     *  and so what each is offered. iOS offers more than the server takes; Android does not copy that. */
    @Test fun eachRoleIsOfferedOnlyWhatTheServerTakes() {
        fun as_(role: String, creator: Boolean, keys: Boolean = false, accounts: Boolean = false): Pair<JsonObject, CodexPoolView> {
            val people = listOf(person("me", "Mia", role, creator = creator, you = true), person("other", "Olive", if (creator) "MEMBER" else "ADMIN", creator = !creator))
            val p = pool(role, people, membersCanAdd = keys, membersCanAddAccounts = accounts, logins = listOf(login("a1", "me", state = "SIGNED_OUT")))
            return p to CodexPoolView(null, p, now)
        }
        val signedOut = login("a1", "me", state = "SIGNED_OUT")
        // Owner: everything, and deleting rather than leaving.
        as_("ADMIN", creator = true).let { (p, v) ->
            assertEquals("choose", v.adding); assertTrue(PoolPage.canSignInAgain(signedOut, p)); assertNull(v.exitBlocked); assertEquals("Delete pool", v.exitLabel)
        }
        // An admin who did not make it: adds anything, but cannot leave until made a member.
        as_("ADMIN", creator = false).let { (p, v) ->
            assertEquals("choose", v.adding); assertTrue(PoolPage.canSignInAgain(signedOut, p)); assertEquals("Leave pool", v.exitLabel); assertNotNull(v.exitBlocked)
        }
        // Members: what the two rules allow, and leaving.
        as_("MEMBER", creator = false).let { (p, v) ->
            assertNull(v.adding); assertFalse(PoolPage.canSignInAgain(signedOut, p)); assertNull(v.exitBlocked)
        }
        as_("MEMBER", creator = false, keys = true).let { (p, v) -> assertEquals("key", v.adding); assertFalse(PoolPage.canSignInAgain(signedOut, p)) }
        as_("MEMBER", creator = false, accounts = true).let { (p, v) -> assertEquals("signIn", v.adding); assertTrue(PoolPage.canSignInAgain(signedOut, p)) }
        as_("MEMBER", creator = false, keys = true, accounts = true).let { (p, v) -> assertEquals("choose", v.adding); assertTrue(PoolPage.canSignInAgain(signedOut, p)) }
    }

    @Test fun anOwnPoolWhosePeopleWereNotReadIsNotCalledJustMine() {
        val own = ProviderPools.own(buildJsonObject {
            put("id", "pool"); put("slug", "team"); put("label", "Team pool"); put("engine", "codex"); put("logins", JsonArray(listOf(login("a1", "me"))))
        }, now)
        val unread = CodexPoolView(own, null, now, peopleUnread = true)
        assertNull(unread.who); assertNotNull(unread.exitBlocked); assertEquals("signIn", unread.adding)
        assertEquals(CodexPoolView.justMe, CodexPoolView(own, null, now).who)
    }

    @Test fun keyStatusesCapsAndMoneyReadAsOnIos() {
        val people = listOf(person("owner", "Olive", "ADMIN", creator = true, you = true))
        val p = pool("ADMIN", people)
        assertEquals(PoolStatus("Invalid", "danger"), PoolPage.status(key("1", "x", false, state = "INVALID"), p))
        assertEquals(PoolStatus("Disabled", "neutral"), PoolPage.status(key("1", "x", false, enabled = false), p))
        assertEquals(PoolStatus("At cap · resets Nov 1", "warning"), PoolPage.status(key("1", "x", false, cap = 50, others = 50.0), p))
        assertEquals(PoolStatus("Available", "success"), PoolPage.status(key("1", "me", true, cap = 50, others = 80.0), p)) // a contributor is not capped
        assertEquals("$12.40 of $50", PoolPage.money(key("1", "x", false, cap = 50, others = 12.4)))
        assertEquals(25, PoolPage.capPercent(key("1", "x", false, cap = 50, others = 12.4)))
        assertEquals("Rejected by OpenAI — only X or the pool’s admins can replace it.",
            PoolPage.invalidReason(key("1", "x", false, state = "INVALID"), pool("MEMBER", listOf(person("me", "Mia", you = true)))))
        assertEquals("No key · 2 sessions", PoolPage.personLine(person("u", "U")))
        assertEquals("Nov 1", PoolPage.capReset("2026-11-01T00:00:00Z"))
    }

    @Test fun membersHeadlinesAndGaugesMatchProviderPools() {
        val own = ProviderPools.own(buildJsonObject {
            put("id", "p"); put("slug", "mine"); put("label", "Mine"); put("engine", "codex")
            put("logins", JsonArray(listOf(login("a1", "me"), login("b2", "me", utilization = 100.0))))
        }, now)
        assertEquals(listOf("AVAILABLE", "SPENT"), own.members.map { it.state })
        assertTrue(own.members[0].next)
        assertEquals("Next: a1@example.test", ProviderPools.headline(own, now, ZoneOffset.UTC))
        assertEquals(PoolStatus("5h 10%", "neutral"), ProviderPools.headGauge(own))
        assertEquals(PoolStatus("Spent · resets 14:00", "warning"), ProviderPools.memberStatus(own.members[1], now, ZoneOffset.UTC))
        assertEquals("1 of 2 accounts available", ProviderPools.availability(own, now))
        assertEquals("Just me · 1 of 2 accounts available", ProviderPools.codexPoolLine(own, now))
        val claude = ProviderPools.own(buildJsonObject {
            put("id", "c"); put("slug", "claude"); put("label", "Claude pool")
            put("members", buildJsonArray { add(buildJsonObject { put("id", "m"); put("label", "Work"); put("state", "AVAILABLE"); put("next", true)
                put("pausedUntil", "2026-10-07T13:00:00Z") }) })
        }, now)
        assertEquals("1 paused", ProviderPools.headline(claude, now))
        assertEquals("0 of 1 available", ProviderPools.poolSummary(claude, now))
        assertEquals("5h", ProviderPools.compactWindowLabel("5-hour limit"))
        assertEquals("Weekly", ProviderPools.compactWindowLabel("Weekly · all models"))
        assertEquals("Offline · 1 of 3 signed in", ProviderPools.runnerSummary(buildJsonObject {
            put("online", false); put("engines", buildJsonArray { add(buildJsonObject { put("engine", "claude"); put("auth", "yes") }) })
        }))
    }

    @Test fun ownPoolWithPeopleNamesTheNextForYouAndItsKeys() {
        val own = ProviderPools.own(buildJsonObject {
            put("id", "p"); put("slug", "mine"); put("label", "Mine"); put("engine", "codex"); put("logins", JsonArray(listOf(login("a1", "me"))))
        }, now)
        val access = pool("ADMIN", listOf(person("me", "Mia", "ADMIN", creator = true, you = true), person("u", "Uma")), keys = listOf(key("k", "me", true)))
        val page = CodexPoolView(own, access, now)
        assertTrue(page.mine && page.people && page.tagged)
        assertEquals("Me and 1 person", page.who)
        assertEquals("Next for you: a1@example.test", ProviderPools.headline(page.pool, now))
        assertEquals(listOf("login:…a1", "k"), page.pool.members.map { it.id })
        assertFalse(page.pool.members[1].next)
        assertEquals("Its ChatGPT sign-in and API keys are deleted from the Orbit server, and nobody can run on it.", page.outNote)
        assertEquals("Uma loses it at once, and their sessions on it stop. Your ChatGPT account and Key k stay.", JustMine.cost(access, 1))
    }

    @Test fun deviceSignInStepsAndDuplicateRefusals() {
        assertNull(CodexSignInText.after(buildJsonObject { put("status", "PENDING") }))
        assertEquals(CodexSignInText.Step.Expired, CodexSignInText.after(buildJsonObject { put("status", "EXPIRED") }))
        assertEquals(CodexSignInText.Step.Failed("it was cancelled"), CodexSignInText.after(buildJsonObject { put("status", "CANCELLED") }))
        assertEquals(CodexSignInText.Step.Failed("token exchange failed"), CodexSignInText.after(buildJsonObject { put("status", "FAILED"); put("error", "token exchange failed") }))
        val done = CodexSignInText.after(buildJsonObject { put("status", "CONFIRMED"); put("account", login("a1", "me")); put("logins", JsonArray(listOf(login("a1", "me"), login("b2", "me")))) })
        assertEquals(2, (done as CodexSignInText.Step.Done).logins)
        assertEquals(CodexSignInText.Step.Duplicate("dup@example.test"),
            CodexSignInText.afterPollFailure(ApiError.parse(409, """{"code":"POOL_CODEX_ACCOUNT_DUPLICATE","email":"dup@example.test","message":"x"}""".toByteArray())))
        assertEquals(CodexSignInText.Step.Failed("this pool no longer exists"), CodexSignInText.afterPollFailure(ApiError.parse(404, "{}".toByteArray())))
        assertNull(CodexSignInText.afterPollFailure(ApiError.parse(500, "{}".toByteArray())))
        assertEquals("Token exchange failed.", CodexSignInText.sentence("token exchange failed"))
        assertEquals("Ada" to false, AddPoolKeyText.duplicateBy(ApiError.parse(409, """{"code":"POOL_KEY_DUPLICATE","addedBy":{"name":"Ada","you":false}}""".toByteArray())))
        assertNull(AddPoolKeyText.duplicateBy(ApiError.parse(400, """{"message":"bad key"}""".toByteArray())))
        assertEquals("sk-…WXYZ", AddPoolKeyText.fingerprint(" sk-abcdWXYZ "))
    }

    @Test fun shareSheetParsesEmailsAndSaysWhatTheyGet() {
        assertEquals(listOf("a@x.test", "b@x.test"), SharePool.emails("a@x.test, b@x.test a@x.test"))
        val p = pool("ADMIN", listOf(person("me", "Mia", "ADMIN", creator = true, you = true)), keys = listOf(key("k", "me", true)))
        assertEquals("Their sessions run on the pool’s API keys", SharePool.facts(p, 0)[1].lead)
        assertTrue(SharePool.empty(pool("ADMIN", listOf(person("me", "Mia", creator = true, you = true))), 0))
        assertEquals("Not added: z@x.test (No Orbit account has that email)", SharePool.outcome(p, listOf("z@x.test (No Orbit account has that email)")))
        assertEquals("Added to Team pool", SharePool.outcome(p, emptyList()))
    }
}
