package io.orbitd.android.directory

import android.graphics.Bitmap
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.util.Base64
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.BuildConfig
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.auth.chooseServer
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.protocol.Wire
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A11-9 on the isolated Orbit stack (A11's: an apiserver built from a main SHA, its own PostgreSQL, the repo's Go runner with a stand-in
 * engine), signed in through the product's own screen as the stack's owner. The seeded main project's merge into main is answered on
 * its sessions page — one candidate with Not now, the next with Merge to main — and each answer is read back from the stack's API as the
 * same account: the candidate's state, and the merge it became on `promotions/merged`. The merge then sits on the page's timeline and
 * opens its receipt, and the coordinator conversation draws it as one line. A candidate the journey needs and the stack has not offered
 * is made the way the platform makes one: a task in the project runs on the stack's runner, lands on the project branch, and the merge
 * check offers the branch again. No fixture; the reads are kept beside the screenshots. Arguments as RealStackDeviceTest's
 * (scripts/tasks-projects-stack-args.py), run through scripts/tasks-projects-stack-device-test.sh with A11_TEST naming this class.
 */
@RunWith(AndroidJUnit4::class)
class ProjectMergeRealStackDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrument.targetContext.applicationContext as OrbitApplication
    private val output get() = File(app.filesDir, "a11-tasks-projects").also { it.mkdirs() }
    private fun arg(key: String) = String(Base64.decode(requireNotNull(InstrumentationRegistry.getArguments().getString(key)) { "missing argument $key" }, Base64.DEFAULT))
    private val seed by lazy { Wire.json.parseToJsonElement(arg("a11Seed")).jsonObject }
    private val server by lazy { seed.text("server")!! }
    private val reads = mutableListOf<String>()
    private fun <T> record(what: String, value: T): T { reads += "${java.time.Instant.now()} $what => $value"; return value }

    // MARK: the stack's own API, as the owner

    private var token: String? = null
    private fun http(method: String, path: String, body: String?, bearer: String?): Pair<Int, String> =
        (URL("$server/api$path").openConnection() as HttpURLConnection).run {
            connectTimeout = 10_000; readTimeout = 30_000; requestMethod = method
            bearer?.let { setRequestProperty("Authorization", "Bearer $it") }
            if (body != null) { doOutput = true; setRequestProperty("Content-Type", "application/json"); outputStream.use { it.write(body.toByteArray()) } }
            try { responseCode to ((if (responseCode < 400) inputStream else errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()) }
            finally { disconnect() }
        }
    private fun api(method: String, path: String, body: JsonObject? = null): JsonElement? {
        val bearer = token ?: run {
            val (status, text) = http("POST", "/auth/login", buildJsonObject { put("email", arg("ownerEmail")); put("password", arg("ownerPassword")) }.toString(), null)
            assertTrue("API sign-in: HTTP $status", status in 200..299)
            Wire.json.parseToJsonElement(text).jsonObject.text("accessToken")!!.also { token = it }
        }
        val (status, text) = http(method, path, body?.toString(), bearer)
        assertTrue("$method $path: HTTP $status ${text.take(300)}", status in 200..299)
        return if (text.isBlank()) null else Wire.json.parseToJsonElement(text).takeUnless { it is JsonNull }
    }
    /** The candidate the project is offering now, as the server says. */
    private fun current(project: String) = api("GET", "/projects/$project/promotions/current") as? JsonObject
    private fun mergedIds(project: String) = (api("GET", "/projects/$project/promotions/merged") as JsonArray).map { it.jsonObject.text("promotionId") }
    private fun until(what: String, timeoutMs: Long, everyMs: Long = 3_000, check: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (!check()) {
            if (SystemClock.uptimeMillis() > deadline) throw AssertionError("timed out waiting for $what")
            SystemClock.sleep(everyMs)
        }
    }

    /** A READY candidate other than [not]: the one the stack offers now, or — when it offers none — the one a new landing makes: a task
     * in the project, run on the stack's runner (its stand-in engine writes A11_STACK_NOTES.md, which the task's check reads), lands
     * on the project branch, and the platform's merge check offers the branch. */
    private fun readyCandidate(project: String, not: String?): JsonObject {
        current(project)?.takeIf { it.text("state") == "READY" && it.text("promotionId") != not }?.let { record("candidate on offer", it.brief()); return it }
        val document = api("GET", "/projects/$project") as JsonObject
        val criterion = document.objects("acceptanceCriteriaItems").firstOrNull()?.text("key")
        val task = api("POST", "/tasks", buildJsonObject {
            put("projectId", project); put("title", "A11d landing ${UUID.randomUUID().toString().take(8)}")
            put("description", "Made by the A11d device journey: it lands on the project branch so the merge into main is offered again.")
            put("assigneeId", seed.obj("workspace")!!.text("id")); put("autoRunWhenReady", false)
            criterion?.let { put("criterionKey", it) }
            put("completionCriterion", "EXECUTABLE"); put("acceptanceCommand", "test -f A11_STACK_NOTES.md")
            put("acceptanceExpectedExitCode", 0); put("acceptanceTimeoutSeconds", 60)
        })!!.jsonObject.text("id")!!
        record("POST /tasks (a landing for the next candidate)", task)
        api("POST", "/tasks/$task/execute", buildJsonObject { put("triggerId", UUID.randomUUID().toString()) })
        until("the landing task to be DONE", 240_000) { (api("GET", "/tasks/$task") as JsonObject).text("status").also { check(it != "FAILED") { "the landing task failed" } } == "DONE" }
        record("GET /tasks/$task", "DONE")
        var offered: JsonObject? = null
        until("a new READY candidate", 300_000, 5_000) {
            offered = current(project)?.takeIf { it.text("promotionId") != not && it.text("state") in setOf("READY", "BLOCKED") }
            offered != null
        }
        val candidate = offered!!
        check(candidate.text("state") == "READY") { "the new candidate is ${candidate.brief()}" }
        record("GET promotions/current (new candidate)", candidate.brief())
        return candidate
    }
    private fun JsonObject.brief() = "${text("promotionId")} ${text("state")} ${text("sourceRef")}@${text("sourceSha")?.take(7)} → ${text("upstreamRef")} tasks=${strings("taskIds").size}"

    // MARK: the screen

    private fun exists(matcher: SemanticsMatcher, unmerged: Boolean = false) = compose.onAllNodes(matcher, unmerged).fetchSemanticsNodes().isNotEmpty()
    private fun await(timeout: Long = 30_000, condition: () -> Boolean) = compose.waitUntil(timeout, condition)
    private fun cardSays(text: String) = exists(hasText(text) and hasAnyAncestor(SemanticsMatcher("the merge card") {
        it.config.getOrNull(SemanticsProperties.TestTag)?.startsWith("project-merge-card:") == true }), unmerged = true)
    private fun press(tag: String) = compose.onNodeWithTag(tag).performScrollTo().assertIsEnabled().performClick()
    private fun capture(name: String) {
        compose.waitForIdle(); SystemClock.sleep(700)
        instrument.uiAutomation.takeScreenshot()?.let { bitmap ->
            File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        } ?: File(output, "$name.missing").writeText("takeScreenshot returned null\n")
    }
    private fun signIn() {
        instrument.sendStatus(0, Bundle().apply { putString("a11_pid", Process.myPid().toString()) })
        File(output, "identity.txt").writeText("sha=${BuildConfig.SOURCE_SHA}\ndirty=${BuildConfig.SOURCE_DIRTY}\nserver=$server\n" +
            "scope=isolated Orbit stack (server trees of ${seed.text("sourceSha")}), test account ${arg("ownerEmail")}; not production\n")
        compose.waitUntil(10_000) { app.session.state.value !is AuthState.Restoring }
        if (app.session.state.value is AuthState.SignedIn) runBlocking { app.session.logout() }
        compose.waitUntil(30_000) { compose.onAllNodesWithText("Welcome back").fetchSemanticsNodes().isNotEmpty() }
        compose.chooseServer(server)
        compose.onNodeWithText("Email").performTextReplacement(arg("ownerEmail"))
        compose.onNodeWithText("Password").performTextReplacement(arg("ownerPassword"))
        compose.onNodeWithText("Sign In").performScrollTo().performClick()
        compose.waitUntil(30_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
        record("signed in", (app.session.state.value as AuthState.SignedIn).handle.account.let { "${it.userId} at ${it.server}" })
    }
    /** The drawer's project row: the project's sessions page as its destination's root. */
    private fun openSessionsPage(title: String) {
        compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
        val row = hasText(title) and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)
        await { exists(row) }
        compose.onNode(row).performScrollTo().performClick()
        await { exists(hasTestTag("project-sessions")) }
    }

    @Test fun theMergeIntoMainIsAnsweredOnTheProjectSessionsPage() {
        try {
            val main = seed.obj("projects")!!.obj("main")!!
            val id = main.text("id")!!; val title = main.text("title")!!
            record("GET promotions/current before", current(id)?.brief())
            record("GET promotions/merged before", mergedIds(id))
            signIn()
            openSessionsPage(title)

            // Not now, on the card: the server records the candidate declined, and the card goes.
            val first = readyCandidate(id, null); val firstId = first.text("promotionId")!!
            await(60_000) { exists(hasTestTag("project-merge-card:asking")) && cardSays("Merge into main?") }
            assertTrue(cardSays(PromotionCards.branchLine(first)))
            assertTrue(cardSays(PromotionCards.pageCounts(first)))
            capture("a11d-stack-01-asking")
            press("project-merge-card:decline")
            until("the server to record Not now", 30_000, 1_000) { current(id)?.let { it.text("promotionId") == firstId && it.text("state") == "DECLINED" } == true }
            record("after Not now: GET promotions/current", current(id)?.brief())
            await(30_000) { !exists(hasTestTag("project-merge-card:asking")) }
            capture("a11d-stack-02-declined")

            // Merge to main, on the card, for the candidate the next landing offers: the server records it confirmed, then merged.
            val second = readyCandidate(id, firstId); val secondId = second.text("promotionId")!!
            await(60_000) { exists(hasTestTag("project-merge-card:asking")) && cardSays(PromotionCards.branchLine(second)) }
            capture("a11d-stack-03-asking-again")
            press("project-merge-card:confirm")
            until("the server to record Merge to main", 30_000, 1_000) {
                current(id)?.let { it.text("promotionId") == secondId && it.text("state") in setOf("CONFIRMED", "RECHECKING", "MERGED") } == true
            }
            record("after Merge to main: GET promotions/current", current(id)?.let { "${it.brief()} sourceSha=${it.text("sourceSha")} confirmed for ${second.text("sourceSha")}" })
            runCatching { await(20_000) { exists(hasTestTag("project-merge-card:merging")) }; capture("a11d-stack-04-merging") }
                .onFailure { record("the merging card", "not drawn before the merge finished (it merged within a poll)") }
            until("the merge to be on promotions/merged", 300_000, 5_000) { secondId in mergedIds(id) }
            val merged = (api("GET", "/projects/$id/promotions/merged") as JsonArray).map { it.jsonObject }.first { it.text("promotionId") == secondId }
            record("GET promotions/merged (the merge)", "${merged.brief()} merged=${merged.obj("merged")}")
            assertEquals("the merge is the candidate pressed, at the SHA the card carried", second.text("sourceSha"), merged.text("sourceSha"))

            // The merge on the page's timeline, opening its receipt: the server's own record.
            val row = hasTestTag("project-merge-row:$secondId")
            await(90_000) { runCatching { compose.onNodeWithTag("project-sessions-list").performScrollToNode(row) }.isSuccess }
            compose.onNode(row).assert(hasText(PromotionCards.timelineDetail(merged), substring = true))
            capture("a11d-stack-05-timeline")
            compose.onNode(row).performClick()
            await { exists(hasTestTag("promotion-receipt")) }
            val sha = merged.obj("merged")!!.text("sha")!!.take(7)
            await { exists(hasText("$sha · merge of ${PromotionCards.shortRef(merged.text("sourceRef")!!)}", substring = true) and hasAnyAncestor(hasTestTag("promotion-receipt"))) }
            capture("a11d-stack-06-receipt")
            compose.onNodeWithTag("promotion-receipt:close").performClick()
            await { !exists(hasTestTag("promotion-receipt")) }

            // The coordinator conversation: the same merge as one line.
            compose.onNodeWithTag("project-sessions-list").performScrollToIndex(0)
            val coordinator = (api("GET", "/sessions/${main.text("coordinatorSessionId")}") as JsonObject).text("title")!!
            record("GET the coordinator session", coordinator)
            compose.onNode(hasText("Coordinator") and hasAnyAncestor(hasTestTag("project-sessions"))).assertExists()
            compose.onNode(hasText(coordinator) and hasClickAction() and hasAnyAncestor(hasTestTag("project-sessions-list"))).performClick()
            await(60_000) { exists(hasTestTag("merge:$secondId:line")) || runCatching {
                compose.onNodeWithTag("transcript-list").performScrollToNode(hasTestTag("merge:$secondId:line")) }.isSuccess }
            compose.onNodeWithTag("transcript-list").performScrollToNode(hasTestTag("merge:$secondId:line"))
            compose.onNodeWithTag("merge:$secondId:line").assert(hasText(PromotionCards.receiptLine(merged)))
            capture("a11d-stack-07-conversation-line")
            File(output, "a11d-stack-merge-result.txt").writeText("PASS\n")
        } catch (error: Throwable) {
            capture("a11d-stack-merge-failed"); reads += "FAILED: $error"; throw error
        } finally {
            File(output, "a11d-stack-merge-readback.txt").writeText(reads.joinToString("\n"))
            runBlocking { app.session.logout() }
        }
    }
}
