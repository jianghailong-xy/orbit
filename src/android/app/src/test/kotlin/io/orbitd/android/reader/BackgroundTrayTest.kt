package io.orbitd.android.reader

import android.content.ComponentName
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.compose.LocalLifecycleOwner
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.BackgroundRow
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.ui.OrbitTheme
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
import java.io.File
import java.time.Instant

/**
 * The Background row in the composer band as it is drawn (board v2, project 34yq7HVPsPDGBiMEm8sL2; iOS `BackgroundTrayView`): every
 * case of the shared fixture folded as it says, its names rotating newest first every 3000 ms and pausing while the list is open,
 * the band is folded or the app is not in front, a crossfade in place of the push with animations removed, the screen reader's
 * label from the rule, and the opened list listing every process — bg_run jobs too — each opening to its output.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class BackgroundTrayTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()

    @Before fun manualClock() { compose.mainClock.autoAdvance = false }

    private class Owner : LifecycleOwner {
        val registry = LifecycleRegistry(this).apply { currentState = Lifecycle.State.RESUMED }
        override val lifecycle: Lifecycle get() = registry
    }

    private fun obj(json: String) = Wire.json.parseToJsonElement(json).jsonObject
    private fun ago(seconds: Long) = Instant.now().minusSeconds(seconds).toString()
    private fun running(id: String, seq: Int, description: String, kind: String = "shell") = obj("""{"shellId":"$id","kind":"$kind",
        "toolUseId":"tu_$id","command":"npm test","description":"$description","startedSeq":$seq,"startedTs":"${ago(300)}","status":"running"}""")

    /** Three running, started in this order: the newest (seq 30) is named first. */
    private val three = listOf(running("a", 10, "web tsc + full Vitest suite"), running("b", 20, "OrbitKit swift test"),
        running("bgj_c", 30, "apiserver tsc + full npm test", kind = "job"))

    private fun row() = compose.onNodeWithTag("background-tray:row")
    private fun shown(): String = row().fetchSemanticsNode().config[BackgroundTrayLogic.ShownName]
    private fun frames(ms: Long) { compose.mainClock.advanceTimeBy(ms); settle() }
    /** A state change or a press drawn: its snapshot applied, one frame, and the UI idle again (the clock is the test's). */
    private fun settle() { compose.waitForIdle(); compose.mainClock.advanceTimeByFrame(); compose.waitForIdle() }

    private fun setTray(list: List<JsonObject>, live: Boolean = true,
        lastUser: String? = null, folded: () -> Boolean = { false }, owner: Owner = Owner()) {
        compose.setContent {
            CompositionLocalProvider(LocalLifecycleOwner provides owner) {
                OrbitTheme { BackgroundTray(list, lastUser, live, folded = folded()) }
            }
        }
        settle()
    }

    // MARK: the shared fixture, by path

    private val fixture: JsonObject by lazy {
        val file = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .map { File(it, FIXTURE) }.firstOrNull { it.isFile }
        assertNotNull("$FIXTURE was not found above ${System.getProperty("user.dir")}; if it moved, move this check with it.", file)
        Wire.json.parseToJsonElement(file!!.readText()).jsonObject
    }

    @Test fun everyFixtureCaseFoldsTheRowAsItSays() {
        val cases = fixture["cases"]!!.jsonArray.map { it.jsonObject }
        assertTrue("the fixture lost its cases", cases.size >= 15)
        var index by mutableStateOf(0)
        compose.setContent {
            val c = cases[index]
            OrbitTheme {
                BackgroundTray(c["list"]!!.jsonArray.map { it.jsonObject }, BackgroundRow.clearedAt(c["lastUserMessageAt"]?.jsonPrimitive?.contentOrNull, c["lastAgentTurnStartedAt"]?.jsonPrimitive?.contentOrNull),
                    c["sessionLive"]!!.jsonPrimitive.boolean)
            }
        }
        cases.forEachIndexed { i, c ->
            compose.runOnIdle { index = i }
            settle()
            val name = c["case"]!!.jsonPrimitive.content
            val expect = c["expect"]!!.jsonObject
            // A case that carries its transcript is read through the reader, as every client must.
            c["events"]?.jsonArray?.map { it.jsonObject }?.let { raw ->
                val events = raw.map { e -> RunEvent(e["type"]!!.jsonPrimitive.content, e["seq"]!!.jsonPrimitive.long, e["payload"]!!, ts = e["ts"]?.jsonPrimitive?.contentOrNull) }
                assertEquals(name, c["lastUserMessageAt"]?.jsonPrimitive?.contentOrNull, BackgroundTrayLogic.lastUserMessageAt(events))
            }
            if (expect["hidden"]?.jsonPrimitive?.boolean == true) {
                compose.onAllNodesWithTag("background-tray").assertCountEquals(0)
                return@forEachIndexed
            }
            val config = row().fetchSemanticsNode().config
            assertEquals(name, listOf(expect["accessibilityLabel"]!!.jsonPrimitive.content), config[SemanticsProperties.ContentDescription])
            val n = expect["name"]!!.jsonObject
            val first = (n["item"] ?: n["items"]!!.jsonArray.first()).jsonObject["name"]!!.jsonPrimitive.content
            assertEquals(name, first, config[BackgroundTrayLogic.ShownName])
        }
    }

    // MARK: rotation and its pauses

    @Test fun severalRunningRotateNewestFirstEvery3000Ms() {
        setTray(list = three)
        assertEquals("apiserver tsc + full npm test", shown())
        frames(2_900)
        assertEquals("not before 3000 ms", "apiserver tsc + full npm test", shown())
        frames(200)
        assertEquals("OrbitKit swift test", shown())
        frames(3_000)
        assertEquals("web tsc + full Vitest suite", shown())
        frames(3_000)
        assertEquals("and round again", "apiserver tsc + full npm test", shown())
    }

    @Test fun theNamesPauseWhileTheListIsOpen() {
        setTray(list = three)
        frames(3_100)
        assertEquals("OrbitKit swift test", shown())
        row().performClick()
        settle()
        compose.onNodeWithTag("background-tray:list").assertExists()
        frames(9_000)
        compose.onNodeWithTag("background-tray:header").performClick()
        settle()
        assertEquals("nothing moved while it was open", "OrbitKit swift test", shown())
        frames(3_100)
        assertEquals("closed, it goes on from there", "web tsc + full Vitest suite", shown())
    }

    @Test fun theNamesPauseWhileTheAppIsInTheBackground() {
        val owner = Owner()
        setTray(list = three, owner = owner)
        owner.registry.currentState = Lifecycle.State.CREATED
        settle()
        frames(9_000)
        assertEquals("apiserver tsc + full npm test", shown())
        owner.registry.currentState = Lifecycle.State.RESUMED
        settle()
        frames(3_100)
        assertEquals("back in front, it moves on", "OrbitKit swift test", shown())
    }

    @Test fun theNamesPauseWhileTheBandIsFolded() {
        var folded by mutableStateOf(true)
        setTray(list = three, folded = { folded })
        frames(9_000)
        assertEquals("apiserver tsc + full npm test", shown())
        folded = false
        settle()
        frames(3_100)
        assertEquals("OrbitKit swift test", shown())
    }

    @Test fun thePauseRuleIsTheListTheAppAndTheFold() {
        assertFalse(BackgroundTrayLogic.paused(open = false, foreground = true, folded = false))
        assertTrue(BackgroundTrayLogic.paused(open = true, foreground = true, folded = false))
        assertTrue(BackgroundTrayLogic.paused(open = false, foreground = false, folded = false))
        assertTrue(BackgroundTrayLogic.paused(open = false, foreground = true, folded = true))
    }

    // MARK: remove animations

    @Test fun namesArePushedFromBelowWhileAnimationsRun() {
        setTray(list = three)
        assertEquals(BackgroundTrayLogic.Change.PUSH, row().fetchSemanticsNode().config[BackgroundTrayLogic.NameChange])
    }

    @Test fun withAnimationsRemovedTheNamesCrossfadeInPlace() {
        val app = RuntimeEnvironment.getApplication()
        Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        assertTrue(BackgroundTrayLogic.animationsRemoved(app))
        setTray(list = three)
        assertEquals(BackgroundTrayLogic.Change.CROSSFADE, row().fetchSemanticsNode().config[BackgroundTrayLogic.NameChange])
        frames(3_100)
        assertEquals("it still rotates, only without the push", "OrbitKit swift test", shown())
        assertEquals(BackgroundTrayLogic.Change.CROSSFADE, BackgroundTrayLogic.change(animationsRemoved = true))
        assertEquals(BackgroundTrayLogic.Change.PUSH, BackgroundTrayLogic.change(animationsRemoved = false))
    }

    // MARK: the screen reader and the list

    @Test fun theScreenReaderReadsTheCountNeverTheRotatingName() {
        setTray(list = three)
        compose.onNodeWithContentDescription("Background processes, 3 running").assertExists()
        frames(3_100)
        compose.onNodeWithContentDescription("Background processes, 3 running").assertExists()
    }

    @Test fun theOpenedListListsEveryProcessBgRunJobsTooEachOpeningToItsOutput() {
        val job = obj("""{"shellId":"bgj_7f3a","kind":"job","toolUseId":"tu_job","command":"./gradlew :app:test","description":"Android unit tests",
            "startedSeq":40,"startedTs":"${ago(300)}","status":"running","latestOutput":"BUILD SUCCESSFUL in 3m"}""")
        val failed = obj("""{"shellId":"b2","kind":"shell","toolUseId":"tu_b2","command":"npm run build","startedSeq":12,
            "startedTs":"${ago(7_200)}","status":"failed","endedAt":"${ago(60)}"}""")
        setTray(list = listOf(running("a", 10, "web suite"), failed, job), lastUser = ago(3_600))
        compose.onNodeWithContentDescription("Background processes, 2 running").performClick()
        settle()
        compose.onNodeWithText("Background processes").assertExists()
        compose.onNodeWithText("2 running · 3 total").assertExists()
        compose.onNode(hasTestTag("background-proc:bgj_7f3a")).assertExists()
        compose.onNode(hasTestTag("background-status:running") and hasAnyAncestor(hasTestTag("background-proc:bgj_7f3a")), useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Android unit tests").assertExists()
        compose.onAllNodesWithText("5m ago").assertCountEquals(2)
        compose.onNodeWithText("npm run build").assertExists()
        compose.onNodeWithText("2h ago").assertExists()
        compose.onNodeWithText("BUILD SUCCESSFUL in 3m").assertDoesNotExist()

        compose.onNodeWithText("Android unit tests").performClick()
        settle()
        compose.onNodeWithTag("background-proc:bgj_7f3a:output").assertExists()
        compose.onNodeWithText("BUILD SUCCESSFUL in 3m").assertExists()
        compose.onNodeWithText("$ ./gradlew :app:test").assertExists()
    }

    // MARK: a bg_run job's row and its Job card (board 350t1lTONlrPMjilBdXx7 D1, rulings R1 and R3)

    private fun job(id: String, status: String, stoppable: Boolean? = null) = obj("""{"shellId":"$id","kind":"job","toolUseId":"$id",
        "command":"./gradlew :app:test","description":"Job $id","startedSeq":40,"startedTs":"${ago(300)}","status":"$status"
        ${stoppable?.let { ",\"stoppable\":$it" }.orEmpty()}}""")

    private fun setJobTray(list: List<JsonObject>, jobs: JobCards, jump: (String) -> (() -> Unit)?) {
        compose.setContent {
            CompositionLocalProvider(LocalLifecycleOwner provides Owner(), LocalJobCards provides jobs) {
                OrbitTheme { BackgroundTray(list, null, true, jumpToJob = jump) }
            }
        }
        settle()
    }

    // E2 (revised 2026-11-21): the owner can do nothing about a failed job, so the folded row does not count it.
    @Test fun aFailedJobIsNotCounted() {
        val failed = JsonObject(job("bgj_f", "failed") + ("endedAt" to JsonPrimitive(ago(60))))
        val row = BackgroundRow.rowOf(listOf(failed, job("bgj_r", "running")), null, true)!!
        assertEquals(listOf(BackgroundRow.CountPart("running", "1 running")), row.countParts)
    }

    @Test fun tappingAJobInTheOpenedListGoesToItsCard() {
        val jumped = mutableListOf<String>()
        setJobTray(listOf(job("bgj_a", "running"), running("s", 10, "web suite")), JobCards()) { id -> if (id == "bgj_a") ({ jumped += id }) else null }
        compose.onNodeWithTag("background-tray:row").performClick(); settle()
        compose.onNodeWithText("Job bgj_a").performClick(); settle()
        assertEquals(listOf("bgj_a"), jumped)
        // The list closes onto the card; a shell row (or a job whose card is not drawn) still opens to its output.
        compose.onNodeWithTag("background-tray:list").assertDoesNotExist()
        compose.onNodeWithTag("background-tray:row").performClick(); settle()
        compose.onNodeWithText("web suite").performClick(); settle()
        compose.onNodeWithTag("background-proc:s:output").assertExists()
    }

    @Test fun aRunningStoppableJobTakesStopBehindTheCardsConfirmation() {
        val stopped = mutableListOf<String>()
        setJobTray(listOf(job("bgj_a", "running", stoppable = true), job("bgj_b", "running", stoppable = false), job("bgj_c", "running"),
            job("bgj_d", "done", stoppable = true), running("s", 10, "web suite")), JobCards(stop = { stopped += it })) { null }
        compose.onNodeWithTag("background-tray:row").performClick(); settle()
        compose.onNodeWithTag("background-proc:bgj_a:stop").assertExists()
        listOf("bgj_b", "bgj_c", "bgj_d", "s").forEach { compose.onNodeWithTag("background-proc:$it:stop").assertDoesNotExist() }
        compose.onNodeWithTag("background-proc:bgj_a:stop").performClick(); settle()
        compose.onNodeWithText("Stop this job?").assertExists()
        compose.onNodeWithTag("job-stop-confirm").performClick(); settle()
        assertEquals(listOf("bgj_a"), stopped)
    }

    @Test fun aSessionThatIsNotLiveDropsItsStaleRunningItems() {
        setTray(list = three, live = false)
        compose.onAllNodesWithTag("background-tray").assertCountEquals(0)
        assertFalse(BackgroundTrayLogic.sessionLive(obj("""{"runStatus":"SUCCEEDED"}""")))
        assertFalse(BackgroundTrayLogic.sessionLive(obj("""{"status":"CANCELLED"}""")))
        assertTrue(BackgroundTrayLogic.sessionLive(obj("""{"runStatus":"AWAITING_INPUT"}""")))
        // The list, opened over an ended item, does not spin a stale running one either.
        assertEquals("unknown", BackgroundTrayLogic.status(three[0], sessionLive = false))
        assertEquals("1 total", BackgroundTrayLogic.countText(listOf(three[0]), sessionLive = false))
    }

    @Test fun theLatestAgentTurnStartsAtItsEarliestEvent() {
        assertNull(BackgroundTrayLogic.lastAgentTurnStartedAt(listOf(RunEvent("user", 1, obj("""{"text":"Hi"}"""), ts = "2026-11-16T02:40:00.000Z"))))
        val events = listOf(
            RunEvent("assistant", 1, obj("{}"), turnId = "t1", ts = "2026-11-16T02:41:00.000Z"),
            RunEvent("assistant", 2, obj("{}"), turnId = "t2", ts = "2026-11-16T02:42:00.000Z"),
            RunEvent("tool_use", 3, obj("{}"), turnId = "t2", ts = "2026-11-16T02:43:00.000Z"))
        assertEquals("2026-11-16T02:42:00.000Z", BackgroundTrayLogic.lastAgentTurnStartedAt(events))
    }

    @Test fun theLastUserMessageIsTheNewestTypedTurn() {
        val events = listOf(
            RunEvent("user", 1, obj("""{"text":"First"}"""), ts = "2026-11-16T02:00:00.000Z"),
            RunEvent("assistant", 2, obj("""{"text":"Answer"}"""), ts = "2026-11-16T02:10:00.000Z"),
            RunEvent("user", 3, obj("""{"text":"Second"}"""), ts = "2026-11-16T02:40:00.000Z"),
            RunEvent("assistant", 4, obj("""{"text":"Later"}"""), ts = "2026-11-16T02:50:00.000Z"))
        assertEquals("2026-11-16T02:40:00.000Z", BackgroundTrayLogic.lastUserMessageAt(events))
        assertNull(BackgroundTrayLogic.lastUserMessageAt(events.filter { it.type != "user" }))
    }

    // MARK: its place in the band

    @Test fun theRowStandsBetweenWatchingAndTasks() {
        val reader = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .map { File(it, "app/src/main/kotlin/io/orbitd/android/reader/SessionReader.kt") }.first { it.isFile }.readText()
        val watching = reader.indexOf("SessionWatches(app, handle, route.id!!")
        val tray = reader.indexOf("BackgroundTray(background.orEmpty()")
        val tasks = reader.indexOf("SessionTasksCard(app, handle, route.id!!")
        assertTrue("all three are in the band: $watching $tray $tasks", watching > 0 && tray > 0 && tasks > 0)
        assertTrue("Watching, then Background, then Tasks", watching < tray && tray < tasks)
        assertEquals("one Background row", tray, reader.lastIndexOf("BackgroundTray("))
    }

    @Test fun theFoldedRowEndsCountThenMarkThenChevronAsTheAgentsRow() {
        // The row's semantics are cleared to its one label, so its children's order is read from the source.
        val tray = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .map { File(it, "app/src/main/kotlin/io/orbitd/android/reader/BackgroundTray.kt") }.first { it.isFile }.readText()
        val folded = tray.substring(tray.indexOf("private fun FoldedRow("), tray.indexOf("private fun Mark("))
        val at = listOf("AnimatedContent(item, Modifier.weight(1f)", "row.countParts.isNotEmpty()", "Mark(item.mark)",
            "Icon(WatchIcons.chevronRight").map { piece -> folded.indexOf(piece).also { assertTrue("no $piece", it > 0) } }
        assertEquals("name, count, mark, chevron", at.sorted(), at)
    }

    private companion object { const val FIXTURE = "src/shared/src/background-row.fixture.json" }
}
