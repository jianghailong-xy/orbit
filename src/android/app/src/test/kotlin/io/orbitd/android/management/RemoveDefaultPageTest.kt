package io.orbitd.android.management

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Removing a runner's Default from Orbit on its engine page, and bringing it back, over the controlled server (the web's
 * RunnerEngines.removeDefault.test.tsx on Android): Default's menu offers Remove… while another account of the engine is listed — offline
 * too — behind the web's question, and Remove sends the DELETE; the removed state lists the accounts that remain, each with its own state
 * and the one a new session starts on marked NEXT, then the line naming Default with Use again, which POSTs the restore route; and an
 * added account's question while Default is removed never says its workspaces run on Default.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class)
class RemoveDefaultPageTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()
    private val fixture = ManagementFixture

    @Before fun start() { fixture.reset(); fixture.runnerAlias = "wikova" }

    private var record by mutableStateOf<String?>(null)
    private var revision by mutableLongStateOf(0L)
    private var shownOnce = false
    /** The runner's page, or one of its own ([where]), read again from the fixture as it stands now. */
    private fun page(where: String?) {
        record = where; revision++
        if (!shownOnce) {
            shownOnce = true
            val session = fixture.session()
            runBlocking { fixture.signIn(session) }
            val api = ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
            compose.setContent { RunnerScreen(api, fixture.RUNNER, record, revision, {}, {}, {}) }
        }
        compose.waitForIdle()
    }
    private fun await(text: String) = compose.waitUntil(60_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    private fun gone(text: String) = compose.waitUntil(60_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isEmpty() }
    private fun shown(text: String) = compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().size
    private fun click(matcher: SemanticsMatcher) {
        compose.waitUntil(60_000) { compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
        val node = compose.onAllNodes(matcher).onFirst()
        try { node.performScrollTo() } catch (_: AssertionError) { }
        node.performClick()
        compose.waitForIdle()
    }
    private fun menu(account: String) = click(hasContentDescription("More for $account"))
    private val removeItem = hasText(AccountCopy.REMOVE) and hasClickAction()
    /** The confirmation's own Remove, pressed through its semantics: a dialog's buttons take no injected touch while it settles. */
    private fun confirm(button: String = "Remove") {
        compose.waitUntil(60_000) { compose.onAllNodes(hasText(button) and hasClickAction()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(hasText(button) and hasClickAction()).performSemanticsAction(SemanticsActions.OnClick)
        compose.waitForIdle()
    }
    private fun writes(path: String) = fixture.writes("runners/${fixture.RUNNER}/accounts/codex/$path")
    private fun centre(text: String) = compose.onAllNodesWithText(text, useUnmergedTree = true).onFirst().fetchSemanticsNode().boundsInRoot.center.y
    /** Where a text starts down the page, unclipped: below the window, a node's bounds in the root are clipped to nothing. */
    private fun top(text: String) = compose.onAllNodesWithText(text, useUnmergedTree = true).onFirst().fetchSemanticsNode().positionInRoot.y

    private val default = """{"id":"default","home":"/root/.codex","codexHome":"/root/.codex","auth":"yes"}"""
    private fun work(auth: String = "yes") = """{"id":"$WORK","name":"Work","home":"/root/.orbit/codex-accounts/$WORK","auth":"$auth"}"""
    private fun personal(auth: String = "yes") = """{"id":"$PERSONAL","name":"Personal","home":"/root/.orbit/codex-accounts/$PERSONAL","auth":"$auth"}"""
    private fun codex(auth: String, accounts: List<String>, extra: String = "") =
        """[{"engine":"codex","installed":true,"version":"codex-cli 0.158.0","auth":"$auth","accounts":[${accounts.joinToString(",")}]$extra}]"""
    /** Codex as the runner reports it: Default first, beside [others]. */
    private fun withDefault(vararg others: String) = codex("yes", listOf(default) + others)
    /** Codex as the server serves it with Default removed: the accounts that remain, marked with what names Default. */
    private fun removed(vararg remaining: String, name: String? = null) = codex(if (remaining.any { "\"auth\":\"yes\"" in it }) "yes" else "no",
        remaining.toList(), ""","removedDefault":{"home":"/root/.codex"${name?.let { ""","name":"$it"""" }.orEmpty()},"fingerprintPrefix":"cxa1_2b7e9013"}""")
    /** Each account's 5-hour window (Work 8%, Personal 30%), and Default's 62% where it is in use; one remaining account's is the
     * snapshot's own too, as the server serves it. */
    private fun usage(default: Boolean, vararg ids: String) = ""","planUsage":{"codex":{"provider":"codex"""" +
        (if (default) ""","primary":{"utilization":62,"windowDurationMins":300}""" else if (ids.size == 1) window(ids[0]) else "") +
        ""","accounts":{${ids.joinToString(",") { """"$it":{"provider":"codex"${window(it)}}""" }}}}}"""
    private fun window(id: String) = ""","primary":{"utilization":${if (id == WORK) 8 else 30},"windowDurationMins":300}"""

    // Offering it

    @Test fun defaultOffersRemoveWhileAnotherAccountIsListedAndAsksInTheWebsWords() {
        fixture.runnerEngines = withDefault(work(), personal())
        fixture.runnerExtra = usage(true, WORK, PERSONAL)
        // Recorded at once, the runner then served without Default.
        fixture.onAccountWrite = { fixture.runnerEngines = removed(work(), personal()); fixture.runnerExtra = usage(false, WORK, PERSONAL) }
        page("engine:codex")
        await("Personal")
        menu("Default")
        click(removeItem)
        await("Remove Default?")
        await("Orbit stops using it on wikova. Its sign-in stays on the machine, and Codex in a terminal there keeps working. " +
            "Workspaces set to it run on Automatic.")
        assertTrue("asked first", writes("default").isEmpty())
        confirm()
        await("Default · ~/.codex isn’t used by Orbit")
        assertEquals(listOf("DELETE runners/${fixture.RUNNER}/accounts/codex/default"), writes("default"))
        assertEquals("Default's row is gone", 0, compose.onAllNodes(hasContentDescription("More for Default")).fetchSemanticsNodes().size)
    }

    @Test fun defaultOffersNoRemoveAsTheOnlyAccountNorWhileTheOtherIsOnItsWayOff() {
        fixture.runnerEngines = withDefault()
        page("engine:codex")
        await("Default")
        menu("Default")
        await(AccountCopy.RENAME)
        assertEquals("the only account", 0, shown(AccountCopy.REMOVE))
        click(hasText(AccountCopy.RENAME))
        confirm("Cancel")
        fixture.runnerEngines = withDefault(work())
        fixture.runnerExtra = ""","accountRemove":{"engine":"codex","account":"$WORK","status":"pending","message":null}"""
        page("engine:codex")
        await("Work")
        menu("Default")
        await(AccountCopy.RENAME)
        assertEquals("Work is on its way off the machine", 0, shown(AccountCopy.REMOVE))
    }

    @Test fun defaultsRemoveStaysEnabledOfflineWhereAnAddedAccountsDoesNot() {
        fixture.runnerOnline = false
        fixture.runnerEngines = withDefault(work(), personal())
        fixture.onAccountWrite = { fixture.runnerEngines = removed(work(), personal()) }
        page("engine:codex")
        await("Personal")
        menu("Default")
        compose.onNode(removeItem).assertIsEnabled()
        click(removeItem)
        confirm()
        await("Default · ~/.codex isn’t used by Orbit")
        assertEquals(listOf("DELETE runners/${fixture.RUNNER}/accounts/codex/default"), writes("default"))
        // An added account's sign-in is deleted on the machine, which has to be there.
        menu("Work")
        compose.onNode(hasText(AccountCopy.REMOVE)).assertIsNotEnabled()
    }

    @Test fun aRefusalSaysTheServersSentence() {
        fixture.runnerEngines = withDefault(work())
        fixture.defaultRemoveRefusal = "Add another Codex account to this machine before removing Default."
        page("engine:codex")
        await("Work")
        menu("Default")
        click(removeItem)
        confirm()
        await("Add another Codex account to this machine before removing Default.")
        assertEquals(1, compose.onAllNodes(hasContentDescription("More for Default")).fetchSemanticsNodes().size)
    }

    // The removed state

    @Test fun theAccountsThatRemainEachHaveTheirOwnStateThenDefaultsLineEndsThem() {
        fixture.runnerEngines = removed(work(), personal("no"))
        fixture.runnerExtra = usage(false, WORK, PERSONAL)
        page("engine:codex")
        await("Personal")
        await("~/.orbit/codex-accounts/$WORK"); await("~/.orbit/codex-accounts/$PERSONAL")
        await(RunnerCopy.SIGNED_IN); await(RunnerCopy.SIGNED_OUT)
        await("8%")
        assertEquals("Default's 62% is nowhere", 0, shown("62%"))
        // Automatic starts the next session on Work, never on Default.
        await("NEXT")
        assertEquals("NEXT beside Work", centre("Work"), centre("NEXT"), 8f)
        await("Default · ~/.codex isn’t used by Orbit")
        compose.onNode(hasText(RunnerAccountCopy.USE_AGAIN) and hasClickAction()).assertIsEnabled()
        assertTrue("after the accounts", top("Default · ~/.codex isn’t used by Orbit") > top("Personal"))
        assertEquals(0, compose.onAllNodes(hasContentDescription("More for Default")).fetchSemanticsNodes().size)
        // Each that remains keeps its own menu, Remove… included.
        menu("Work")
        compose.onNode(removeItem).assertExists()
    }

    @Test fun oneThatRemainsIsARowOfItsOwnWithNextAndItsOwnSignIn() {
        fixture.runnerEngines = removed(work(), name = "jianghailong.main")
        fixture.runnerExtra = usage(false, WORK)
        page("engine:codex")
        await("Work")
        await("8%")
        await("NEXT")
        assertEquals("NEXT beside Work", centre("Work"), centre("NEXT"), 8f)
        await("jianghailong.main · ~/.codex isn’t used by Orbit")
        // Signed out, its Sign In is its own account's, by id — not the engine's, whose sign-in on the machine is Default's.
        fixture.runnerEngines = removed(work("no"), name = "jianghailong.main")
        page("engine:codex")
        await("Sessions on this runner can’t use Codex until you sign in again.")
        click(hasText(RunnerCopy.SIGN_IN) and hasClickAction())
        compose.waitUntil(60_000) { fixture.loginBodies.isNotEmpty() }
        assertEquals(buildJsonObject { put("engine", "codex"); put("account", WORK) }, fixture.loginBodies.single())
    }

    @Test fun theRunnersEnginesRowNamesTheAccountThatRemainsAndNothingOfDefault() {
        fixture.runnerEngines = removed(work())
        fixture.runnerExtra = usage(false, WORK)
        page(null)
        await("Next: Work")
        await("8%")
        await(RunnerCopy.SIGNED_IN)
        assertEquals(0, shown("Default"))
    }

    // The way back

    @Test fun useAgainPostsTheRestoreRouteAndDefaultComesBack() {
        fixture.runnerEngines = removed(work())
        fixture.runnerExtra = usage(false, WORK)
        fixture.onAccountWrite = { fixture.runnerEngines = withDefault(work()); fixture.runnerExtra = usage(true, WORK) }
        page("engine:codex")
        await("Default · ~/.codex isn’t used by Orbit")
        click(hasText(RunnerAccountCopy.USE_AGAIN) and hasClickAction())
        gone("isn’t used by Orbit")
        compose.waitUntil(60_000) { compose.onAllNodes(hasContentDescription("More for Default")).fetchSemanticsNodes().isNotEmpty() }
        assertEquals(listOf("POST runners/${fixture.RUNNER}/accounts/codex/default/restore"), writes("default/restore"))
    }

    @Test fun useAgainWorksWithTheRunnerOffline() {
        fixture.runnerOnline = false
        fixture.runnerEngines = removed(work(), personal())
        fixture.runnerExtra = usage(false, WORK, PERSONAL)
        fixture.onAccountWrite = { fixture.runnerEngines = withDefault(work(), personal()) }
        page("engine:codex")
        await("Default · ~/.codex isn’t used by Orbit")
        compose.onNode(hasText(RunnerAccountCopy.USE_AGAIN) and hasClickAction()).assertIsEnabled()
        click(hasText(RunnerAccountCopy.USE_AGAIN) and hasClickAction())
        gone("isn’t used by Orbit")
        assertEquals(listOf("POST runners/${fixture.RUNNER}/accounts/codex/default/restore"), writes("default/restore"))
    }

    @Test fun useAgainSaysSoWhenItCouldNot() {
        fixture.runnerEngines = removed(work())
        fixture.restoreFails = true
        page("engine:codex")
        await("Default · ~/.codex isn’t used by Orbit")
        click(hasText(RunnerAccountCopy.USE_AGAIN) and hasClickAction())
        await("Couldn’t use Default again — runner not found")
        await("Default · ~/.codex isn’t used by Orbit")
    }

    // An added account while Default is removed

    @Test fun removingAnAddedAccountWhileDefaultIsRemovedSaysAutomaticNotDefault() {
        fixture.runnerEngines = removed(work(), personal())
        fixture.runnerExtra = usage(false, WORK, PERSONAL)
        page("engine:codex")
        await("Personal")
        menu("Personal")
        click(removeItem)
        await("Remove Personal?")
        await("Its sign-in is deleted from wikova. Workspaces set to this account run on Automatic.")
        assertEquals(0, shown("run on Default"))
        confirm()
        compose.waitUntil(60_000) { writes(PERSONAL).isNotEmpty() }
        assertEquals(listOf("DELETE runners/${fixture.RUNNER}/accounts/codex/$PERSONAL"), writes(PERSONAL))
        // The last account Orbit uses there: without it, Orbit uses Default again.
        fixture.runnerEngines = removed(work(), name = "jianghailong.main")
        fixture.runnerExtra = usage(false, WORK)
        page("engine:codex")
        gone("Personal")
        menu("Work")
        click(removeItem)
        await("Its sign-in is deleted from wikova. Without it, Orbit uses jianghailong.main there again, and workspaces set to this account run on it.")
    }

    private companion object {
        const val WORK = "3fa91c2e"
        const val PERSONAL = "7c21de40"
    }
}
