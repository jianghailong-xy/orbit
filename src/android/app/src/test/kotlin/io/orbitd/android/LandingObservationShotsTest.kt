package io.orbitd.android

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.view.View
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.cards.ExceptionCard
import io.orbitd.android.cards.NeedsYouBar
import io.orbitd.android.cards.NeedsYouLogic
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.cards.CardActionState
import io.orbitd.android.core.cards.CardCatalog
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.projects.ProjectPageState
import io.orbitd.android.projects.RunSettingsSection
import io.orbitd.android.projects.StartCriterion
import io.orbitd.android.projects.StartProjectCard
import io.orbitd.android.projects.StartProjectCopy
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * R29-12's NATIVE frames, light and dark, beside the browser's (docs/evidence/landing-observation/web): the start card and How it runs
 * with the Delivery row (§10.5 O-L1/O-L2), the two revision-29 items' cards with Accept and Observe again and the observation's
 * handling line (§10.7, §10.8, §4.7 H1), Observe again's reason, the item a project's failing observations open, the needs-you bar for
 * the fifth owner item (§7.6 V13), and — over the shell's controlled server — the project page's task rows (§10.9), its Open items and
 * the projects list's chip (§7.1 V2). Each is drawn by the production composables with the web rig's items, and written as
 * `<scene>-<theme>.png` under `src/android/build/evidence/landing-observation-android/` beside its semantics tree; a menu's or a
 * sheet's window is drawn over the page it opened on.
 */
abstract class LandingObservationShots {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    protected abstract val theme: String
    protected abstract val dark: Boolean

    @Before fun start() = ProjectShell.reset()

    private val launch = ProjectShell.LAUNCH
    private val seal = "d".repeat(64)
    private fun ago(minutes: Long) = Instant.now().minusSeconds(minutes * 60).toString()
    private fun j(text: String) = Wire.json.parseToJsonElement(text).jsonObject

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/landing-observation-android").also { it.mkdirs() }
    }

    private fun show(content: @Composable () -> Unit) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = dark) {
            Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) { content() }
        } } }
        compose.waitForIdle()
    }

    /** The integration read of a project bound to acme/checkout on [line], delivering by [mode]. */
    private fun view(line: String?, mode: String, locked: Boolean = false) = buildJsonObject {
        put("line", line?.let(::JsonPrimitive) ?: JsonNull); put("ref", if (line == "PROJECT_BRANCH") "project/checkout" else "main")
        put("locked", locked); put("escalationSeconds", 7200); put("upstreamRef", "main"); put("upstreamChosenAt", JsonNull)
        put("repository", "acme/checkout"); put("mergeCheckCommand", "npm test"); put("branches", JsonNull); put("lastMainBranch", JsonNull)
        put("startedAt", if (locked) JsonPrimitive(ago(3 * 24 * 60)) else JsonNull); put("deliveryMode", mode)
    }

    // MARK: the delivery mode

    private fun startCard(line: String, agentPushes: Boolean) {
        val request = StartProjectCopy.Request(StartProjectCopy.Settings(line, "refs/heads/project/checkout", true, 3, "npm test"),
            "The tasks are filed and the criteria are set.", seal)
        val plan = StartProjectCopy.PlanView(4, listOf(
            listOf(StartProjectCopy.LevelTask("o1", "P1", "P1 · Ship the delivery mode picker", now = true, you = false)),
            listOf(StartProjectCopy.LevelTask("o2", "P2", "P2 · Draw the observation cards", now = false, you = false),
                StartProjectCopy.LevelTask("o3", "P3", "P3 · Fix the login redirect", now = false, you = false)),
            listOf(StartProjectCopy.LevelTask("o4", "P4", "P4 · Pay with a saved card", now = false, you = true))),
            ownerConfirmed = listOf(StartProjectCopy.NamedTask("P4", "Pay with a saved card")), evidenceJudged = 3, startsNow = listOf("P1"))
        show {
            var draft by remember { mutableStateOf(StartProjectCopy.Draft.of(request.settings, view(null, "PLATFORM"))
                .let { if (agentPushes) it.copy(deliveryMode = "AGENT_PUSH") else it }) }
            Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp)) {
                StartProjectCard(launch, "Checkout redesign", asked = true, askedAgo = "12m ago", request = request,
                    criteria = listOf(StartCriterion(1, "A buyer can pay with a saved card in two taps.")), plan = plan, hasCoordinator = true,
                    escalationSeconds = 7_200, draft = draft, onDraft = { draft = it }, standing = StartProjectCopy.Standing.LIVE, enabled = true,
                    starting = false, error = null, tag = "start-card", startTag = "start-card-confirm", onStart = {}, onViewTasks = {})
            }
        }
        compose.onNodeWithTag("start-card-delivery").performScrollTo()
    }

    /** The start card on a main line, the agent pushing: what Delivery means, Automatic's sentence, and Comes to you without a merge. */
    @Test fun startAgentPush() { startCard("MAIN", agentPushes = true); shot("start-agent-push") }

    /** The Delivery menu open: both ways, each with what it means. */
    @Test fun startDeliveryMenu() {
        startCard("MAIN", agentPushes = false)
        compose.onNodeWithTag("start-card-delivery").performClick()
        compose.waitForIdle()
        shot("start-delivery-menu")
    }

    /** On a project branch: Delivery stays on Orbit's way, and the line under it says why. */
    @Test fun startProjectBranch() { startCard("PROJECT_BRANCH", agentPushes = false); shot("start-project-branch") }

    private fun settings(view: JsonObject) {
        val state = ProjectPageState().apply { integration = view }
        val doc = j("""{"id":"$launch","coordinatorEnabled":true,"configRevision":"3","maxConcurrentTasks":3,"pausedAt":null}""")
        show {
            Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp)) {
                RunSettingsSection(state, doc, Instant.now(), enabled = true, editMergeCheck = {}, integration = {}, automatic = {}, stepConcurrency = {}, pause = {})
            }
        }
    }

    /** How it runs on a started main line: the line locked, the way not — the agent pushes, in the line's and Automatic's own words. */
    @Test fun settingsAgentPush() { settings(view("MAIN", "AGENT_PUSH", locked = true)); shot("settings-agent-push") }

    /** How it runs on a project branch: the agent's way drawn and not offered, with why. */
    @Test fun settingsProjectBranch() { settings(view("PROJECT_BRANCH", "PLATFORM")); shot("settings-project-branch") }

    // MARK: the items

    private fun card(row: String) {
        val card = CardCatalog.project(ProjectShell.COORD, launch, mapOf("project" to buildJsonObject { put("id", launch) },
            "openItems" to j("""{"needsYou":[$row],"withCoordinator":[]}"""))).single()
        show {
            Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp)) {
                ExceptionCard(card, fresh = true, result = CardActionState(), mergeCard = null, open = {}, discuss = {}, review = {}, main = "main") { _, _ -> }
            }
        }
    }

    /** LANDED_WITHOUT_CONFIRMATION: its kind word, its §10.7 title, the receipt line, Accept leading. */
    @Test fun cardLandedWithoutConfirmation() { card(LandingObservationItems.landed()); shot("card-landed-without-confirmation") }

    /** LANDING_UNOBSERVED handed to the owner: the hand-over heading, the §10.7 title under it, Observe again among the doors, and the
     * observation it asked for running. */
    @Test fun cardLandingUnobserved() { card(LandingObservationItems.unobservedOwner()); shot("card-landing-unobserved") }

    /** Observe again's reason, asked for in place. */
    @Test fun observePanel() {
        card(LandingObservationItems.unobservedOwner())
        val key = "item:${LandingObservationItems.UNOBSERVED_OWNER}"
        compose.onNodeWithTag("$key:OBSERVE").performScrollTo().performClick()
        compose.onNodeWithTag("$key:observe-reason").performScrollTo().performTextInput("The runner can reach the repository again — its deploy key was rotated.")
        compose.onNodeWithTag("$key:observe-confirm").performScrollTo()
        shot("observe-panel")
    }

    /** `IE:observe`, the owner's: Observe again its one, leading door. */
    @Test fun cardObserveFailing() { card(LandingObservationItems.observeFailing("OWNER")); shot("card-observe-failing") }

    /** The needs-you bar for the fifth owner item: its kind word over the project, with the merge's mark. */
    @Test fun needsYouBar() {
        val coordinator = j("""{"id":"${ProjectShell.COORD}","title":"Coordinate checkout","status":"AWAITING_INPUT","pendingApprovals":1,
            "waitingKind":"OWNER_ITEM","projectId":"$launch","projectTitle":"Checkout redesign","agent":{"id":"${ProjectShell.ALPHA}","name":"Alpha"},
            "ownerItems":[{"itemId":"${LandingObservationItems.LANDED}","kind":"LANDED_WITHOUT_CONFIRMATION",
            "title":"Reached main without your confirmation: Fix the login redirect","since":"${ago(120)}",
            "need":"Landed without your confirmation","mainBranch":"main"}]}""")
        val banner = NeedsYouLogic.banner(listOf(coordinator))!!
        show {
            Column(Modifier.padding(16.dp)) {
                NeedsYouBar(banner.text, null, NeedsYouLogic.itemHint, detail = banner.detail, since = banner.since, more = banner.more, glyph = banner.glyph) {}
            }
        }
        shot("needs-you-bar")
    }

    // MARK: the pages

    /** The project page's task rows: waiting to be seen on main with the short commit, without it, on main, and the task waiting. */
    @Test fun taskRows() {
        ProjectShell.tasks = LandingObservationItems.tasks()
        openProjectPage()
        await { runCatching { compose.onNodeWithTag("project-detail").performScrollToNode(hasTestTag("project-task:o4")) }.isSuccess }
        shot("task-rows")
    }

    /** Open items: the owner's two, and the coordinator's two, each saying what is handling it. */
    @Test fun openItems() {
        ProjectShell.needsYouItems = "[${LandingObservationItems.unobservedOwner()},${LandingObservationItems.landed()}]"
        ProjectShell.holder = "${LandingObservationItems.unobserved()},${LandingObservationItems.observeFailing()}"
        openProjectPage()
        compose.onNodeWithTag("project-open-items").performClick()
        await { exists(hasTestTag("open-item:${LandingObservationItems.LANDED}")) }
        // Opened all the way, so the coordinator's two show under the owner's.
        compose.onNodeWithTag("project-open-items-sheet").performTouchInput { swipeUp() }
        compose.waitForIdle()
        shot("open-items")
    }

    /** The projects list's chip, and the drawer's count beside it. */
    @Test fun projectsList() {
        ProjectShell.attention = """{"ownerItems":[{"kind":"LANDED_WITHOUT_CONFIRMATION","count":1,"oldestWaitingSince":"${ago(125)}"}]}"""
        signIn()
        compose.onNodeWithContentDescription("Open navigation").performClick()
        await { exists(hasText("Projects") and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)) }
        compose.onNode(hasText("Projects") and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)).performClick()
        await { exists(hasTestTag("project:$launch")) }
        shot("projects-list")
    }

    // MARK: helpers

    private fun openProjectPage() {
        signIn(); open("orbit-project:$launch")
        await { exists(hasTestTag("project-detail")) && exists(hasTestTag("project-open-items")) }
    }
    private fun signIn() {
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedOut }
        app().realtime.setNetwork(true, "fixture")
        runBlocking { ProjectShell.signIn(app().session) }
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedIn && app().realtime.state.value.directoryFresh }
    }
    private fun open(link: String) {
        compose.activityRule.scenario.onActivity {
            val launch = it.intent
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                .invoke(it, Intent(Intent.ACTION_VIEW, Uri.parse(link)).setClass(it, MainActivity::class.java))
            it.intent = launch
        }
        compose.waitForIdle()
    }

    /** The windows on screen, bottom first: the Activity's, then a menu's or a sheet's over it. */
    private fun windows(): List<View> {
        val global = Class.forName("android.view.WindowManagerGlobal")
        val manager = global.getMethod("getInstance").invoke(null)
        val views = (global.getDeclaredField("mViews").apply { isAccessible = true }.get(manager) as List<*>).filterIsInstance<View>()
        val decor = compose.activity.window.decorView
        return listOf(decor) + views.filter { it !== decor && it.isAttachedToWindow && it.isShown && it.width > 0 }
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        File(output, "$name-$theme-semantics.txt").writeText(compose.onAllNodes(isRoot()).printToString(maxDepth = Int.MAX_VALUE))
        val decor = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        windows().forEach { view ->
            val at = (view.layoutParams as? WindowManager.LayoutParams)?.takeIf { view !== decor }
            canvas.save()
            at?.let { canvas.translate(it.x.toFloat(), it.y.toFloat()) }
            view.draw(canvas)
            canvas.restore()
        }
        File(output, "$name-$theme.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    private fun exists(matcher: SemanticsMatcher) = compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty()
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000, condition)
    private fun app() = compose.activity.application as OrbitApplication
}

/** Light frames, at twice the density, as the browser's are drawn. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ProjectShellApplication::class, qualifiers = "w411dp-h1100dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class LandingObservationShotsTest : LandingObservationShots() {
    override val theme = "light"
    override val dark = false
}

/** Dark frames: `isSystemInDarkTheme()` reads the night qualifier, as on a device. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ProjectShellApplication::class, qualifiers = "w411dp-h1100dp-night-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class LandingObservationDarkShotsTest : LandingObservationShots() {
    override val theme = "dark"
    override val dark = true
}
