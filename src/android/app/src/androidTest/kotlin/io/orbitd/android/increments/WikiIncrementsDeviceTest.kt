package io.orbitd.android.increments

import android.content.ClipboardManager
import android.content.Context
import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A12 increments and DL-7's Copy link on a device, over the test's own fixture: one wiki space the server executes — its health with a
 * System model that refused the key, two server runs and a run's calls (A12-6), a plan the System model drafts (A12-7) — or a space no
 * server executes, whose maintenance is set up without a provider (A12-8), and an entry whose Copy link needs the space's slug (DL-7).
 * The shapes are the wiki JVM tests' (WikiFixtures, WikiScreensTest, src/shared/src/wiki-server-execution.fixture.json, wiki-health
 * and wiki-docs fixtures).
 */
@RunWith(AndroidJUnit4::class)
class WikiIncrementsDeviceTest : IncrementDeviceTest() {
    private val space = "34UAq0rbitSpaceOrbit01"
    private val entry = "34UDFnrgM4q5odj4MVdXD"
    override val ids get() = listOf(workspace, runner, space, entry)

    /** Whether the server executes this space's wiki (health and system model both say so). */
    @Volatile private var serverExecutes = true
    @Volatile private var slug = "orbit"
    @Volatile private var plan = """{"spaceId":"$space","confirmed":null,"draft":null,"proposals":[],"job":null}"""
    @Volatile private var maintenanceOn = false

    private fun spaceRow() = """{"id":"$space","publicId":"$space","slug":"$slug","title":"Orbit","repoUrlNorm":"github.com/jianghailong-xy/orbit",
        "rootCommitSha":"4db4f9f0a1b2c3d4e5f60718293a4b5c6d7e8f90","pendingOps":0,"planWaiting":0,"workspaceIds":["$workspace"],"docs":null,
        "createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-25T09:00:00.000Z",
        "settings":{"reviewMode":"automatic","automaticSpotChecks":false,"push":true,"autoAcceptReinforce":true,
        "maintenance":{"enabled":$maintenanceOn,"workspaceId":"$workspace","provider":"local-vllm","dailyRunLimit":4,"lookbackDays":14}}}"""
    private fun health() = if (serverExecutes) """{"spaceId":"$space","entries":11689,"maintenance":{"look":"failing","enabled":true,
        "lastOkAt":"${ago(2 * 24 * 60)}","lastRunAt":"${ago(60)}","consecutiveFailures":3,"backlog":57,
        "lastRun":{"sessionId":null,"jobId":"34cE0job0000000000009","outcome":"failed","endedAt":"${ago(60)}"}},"repo":{"look":"ready","pending":0},
        "executor":{"mode":"server","serverExecutes":true},"systemModel":{"state":"auth_failed","model":"qwen3.8-27b-fp8"}}"""
        else """{"spaceId":"$space","entries":9,"maintenance":{"look":"off","enabled":false,"backlog":0},"repo":{"look":"ready","pending":0}}"""
    private fun systemModel() = if (serverExecutes) json("""{"state":"up","model":"qwen3.8-27b-fp8","since":"${ago(30)}","checkedAt":"${ago(0)}",
        "workerSeenAt":"${ago(0)}","executor":{"mode":"server","serverExecutes":true}}""") else json("""{"message":"not found"}""", 404)
    private val callRows = """[{"id":"34cE0call000000000001","step":"verify","unit":"01a11a88-de31-74bb-a86c-84793f2a9c1e","attempt":1,"attempts":0,
        "state":"succeeded","enqueuedAt":"${ago(9)}","startedAt":"${ago(9)}","endedAt":"${ago(8)}","inputTokens":1204,"outputTokens":296,
        "httpStatus":200,"error":null,"errorKind":null,"ahead":null},
        {"id":"34cE0call000000000002","step":"verify","unit":"01a11a88-de31-7a02-9d1e-5c0277b0e1d2","attempt":1,"attempts":1,"state":"succeeded",
        "enqueuedAt":"${ago(9)}","startedAt":"${ago(9)}","endedAt":"${ago(8)}","inputTokens":1388,"outputTokens":311,"httpStatus":200,
        "error":null,"errorKind":null,"ahead":null},
        {"id":"34cE0call000000000003","step":"verify","unit":"01a11a88-de32-7c4b-8f31-0e6aa1c3e9f0","attempt":1,"attempts":0,"state":"failed",
        "enqueuedAt":"${ago(40)}","startedAt":"${ago(40)}","endedAt":"${ago(25)}","inputTokens":null,"outputTokens":null,"httpStatus":null,
        "error":"The call ran past its 15-minute budget.\nAbortError","errorKind":"other","ahead":null}]"""
    private fun jobs() = """{"spaceId":"$space","jobs":[
        {"id":"34cE0job0000000000001","kind":"verify","state":"running","waitingFor":null,"priority":1,"attempts":0,"createdAt":"${ago(10)}",
         "updatedAt":"${ago(1)}","startedAt":"${ago(9)}","endedAt":null,"nextAttemptAt":null,"failureKind":null,"error":null,"ahead":null,
         "progress":null,"calls":{"total":7,"queued":2,"running":2,"succeeded":2,"failed":1,"cancelled":0,"inputTokens":2592,"outputTokens":607},
         "nextCall":{"ahead":2,"enqueuedAt":"${ago(1)}"},"requests":$callRows},
        {"id":"34cE0job0000000000002","kind":"articles","state":"queued","waitingFor":null,"priority":0,"attempts":0,"createdAt":"${ago(5)}",
         "updatedAt":"${ago(5)}","startedAt":null,"endedAt":null,"nextAttemptAt":null,"failureKind":null,"error":null,"ahead":1,"progress":null,
         "calls":{"total":0,"queued":0,"running":0,"succeeded":0,"failed":0,"cancelled":0,"inputTokens":0,"outputTokens":0},"nextCall":null,"requests":[]}]}"""
    private val entryDetail = """{"id":"$entry","publicId":"$entry","spaceId":"$space","kind":"pitfall","status":"active","trust":"confirmed",
        "currentRevision":2,"title":"runner-go’s full suite inside a session reaches production","summary":"Fix: unset the ORBIT_* variables before go test ./...",
        "fields":{"symptom":"11 CLI tests fail and one hangs until -timeout panics.","fix":"env -u ORBIT_SESSION_ID go test ./..."},
        "topics":["runner-engines"],"aliases":[],"anchors":[],"anchorState":"verified","anchorCheckedRef":null,"anchorCheckedAt":null,
        "tainted":false,"challenged":false,"unsupported":false,"pinned":false,"supersedesId":null,"supersededById":null,
        "validFrom":"2026-09-23T09:00:00.000Z","validTo":null,"recordedAt":"2026-09-23T09:00:00.000Z","retiredAt":null,
        "sources":[],"history":[],"exposure":[]}"""

    override fun answer(req: Req): MockResponse? {
        val p = req.parts
        if (p[0] != "wiki" && req.path != "link-previews") return null
        return when {
            req.path == "link-previews" -> json("""{"previews":[]}""")
            req.path == "wiki/spaces" -> json("[${spaceRow()}]")
            req.path == "wiki/system-model" -> systemModel()
            req.path == "wiki/search" -> json("""{"q":"","hits":[]}""")
            req.path == "wiki/review" -> json("[]")
            req.path == "wiki/entries/$entry" -> json(entryDetail)
            req.path == "wiki/spaces/$space" && req.method == "GET" -> json(spaceRow())
            req.path == "wiki/spaces/$space" && req.method == "PATCH" -> {
                Json.parseToJsonElement(req.body).jsonObject["maintenance"]?.jsonObject?.get("enabled")?.toString()?.let { maintenanceOn = it == "true" }
                json(spaceRow())
            }
            req.path == "wiki/spaces/$space/entries" -> json("[]")
            req.path == "wiki/spaces/$space/timeline" -> json("""{"items":[]}""")
            req.path == "wiki/spaces/$space/health" -> json(health())
            req.path == "wiki/spaces/$space/jobs" -> if (serverExecutes) json(jobs()) else json("""{"message":"not found"}""", 404)
            req.path == "wiki/spaces/$space/plan" -> json(plan)
            req.path == "wiki/spaces/$space/plan/versions" -> json("""{"spaceId":"$space","versions":[]}""")
            req.path == "wiki/spaces/$space/plan/redraft" -> json("""{"created":false}""")
            else -> json("""{"message":"not found"}""", 404)
        }
    }

    private fun openWiki() {
        signIn()
        compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
        await("the drawer's Wiki row") { exists(hasText("Wiki") and hasClickAction()) }
        compose.onAllNodes(hasText("Wiki") and hasClickAction()).onFirst().performClick()
        await("the wiki's home") { exists(hasTestTag("wiki-bar-activity")) }
    }

    /** A12-6: a space the server executes says why maintenance fails (the System model refused the key), lists the server's runs
     * under the System model, opens a run's calls, and its settings name the System model. */
    @Test fun theServerExecutesTheWikiRunsAndSystemModel() = journey {
        maintenanceOn = true
        openWiki()
        compose.onNodeWithTag("wiki-bar-activity").performClick()
        await("Activity's status line") { exists(hasTestTag("wiki-status-line"), unmerged = true) }
        await("it says why maintenance fails") { says("wiki-status-line", "System model refused the key", substring = true) }
        capture("01-status-reason")
        await("the Runs band's runs") { count(hasTestTag("wiki-job-row")) >= 1 ||
            runCatching { compose.onNodeWithTag("wiki-activity-list").performScrollToNode(hasTestTag("wiki-job-row")) }.isSuccess && exists(hasTestTag("wiki-job-row")) }
        compose.onNodeWithTag("wiki-activity-list").performScrollToNode(hasText("Runs"))
        verify("the band names the System model", exists(hasText("System model · qwen3.8-27b-fp8"), unmerged = true))
        compose.onNodeWithTag("wiki-activity-list").performScrollToNode(hasText("3 of 7 calls ended", substring = true))
        verify("both runs are rows", count(hasTestTag("wiki-job-row")) == 2)
        capture("02-runs-band")
        compose.onAllNodesWithTag("wiki-job-row").onFirst().performClick()
        await("the run's page") { exists(hasTestTag("wiki-job-page")) }
        verify("it is running", says("wiki-job-state", "Running", substring = true))
        await("its calls") { count(hasTestTag("wiki-call-row")) == 3 }
        compose.onNodeWithTag("wiki-job-page").performScrollToNode(hasText("The call ran past its 15-minute budget.", substring = true))
        capture("03-run-page")
        back(); await("back on Activity") { exists(hasTestTag("wiki-activity-list")) }
        back(); await("back on the wiki's home") { exists(hasTestTag("wiki-bar-settings")) }
        compose.onNodeWithTag("wiki-bar-settings").performClick()
        await("settings name the System model") { exists(hasTestTag("wiki-settings-model-row"), unmerged = true) &&
            says("wiki-settings-model-row", "System model · qwen3.8-27b-fp8", substring = true) }
        capture("04-settings-system-model")
    }

    /** A12-7: the plan page says the System model drafts the plan — empty, and while its draft runs. */
    @Test fun thePlanPageNamesTheSystemModelWhileTheServerDrafts() = journey {
        openWiki()
        compose.onNodeWithTag("wiki-bar-contents").performClick()
        await("the contents' plan door") { exists(hasTestTag("wiki-contents-plan")) }
        compose.onNodeWithTag("wiki-contents-plan").performClick()
        await("an empty plan page") { exists(hasTestTag("wiki-plan-empty"), unmerged = true) }
        verify("the System model drafts it", says("wiki-plan-empty", "The System model drafts it; nothing is written until you confirm it.", substring = true))
        verify("on the server", says("wiki-plan-empty", "Runs on the server with the System model", substring = true))
        verify("Draft plan is offered", exists(hasTestTag("wiki-plan-draft")))
        capture("01-empty-plan")
        plan = """{"spaceId":"$space","confirmed":null,"draft":null,"proposals":[],"job":{"id":"job-drafting","spaceId":"$space","kind":"draft",
            "trigger":"owner","state":"running","instructions":null,"requestedAt":"${ago(12)}","held":null,"waitingFor":null,"taskId":"tk-job",
            "provider":null,"sessionId":null,"madeAt":"${ago(12)}","startedAt":"${ago(10)}","endedAt":null,"attempt":1,"attemptsMax":3,
            "progress":null,"version":null,"errors":[],"error":null,"report":null,"draft":null}}"""
        compose.onNodeWithTag("wiki-plan-draft").performClick()
        await("Draft plan asks the server") { calls.any { it == "POST wiki/spaces/$space/plan/redraft" } }
        await("the drafting card names the System model") { exists(hasTestTag("wiki-plan-job"), unmerged = true) &&
            says("wiki-plan-job", "System model · attempt 1 of 3 · started", substring = true) }
        capture("02-drafting")
    }

    /** A12-8: a space no server executes shows no System model and no execution mode, and setting maintenance up writes no provider. */
    @Test fun theWikiDrawsNoExecutionModeAndWritesNoProvider() = journey {
        serverExecutes = false
        openWiki()
        compose.onNodeWithTag("wiki-bar-settings").performClick()
        await("the settings page") { exists(hasTestTag("wiki-settings-page")) }
        verify("no System model row", !exists(hasTestTag("wiki-settings-model-row"), unmerged = true))
        verify("no privacy line", !exists(hasTestTag("wiki-settings-privacy"), unmerged = true))
        verify("no provider is drawn", !exists(hasText("local-vllm", substring = true), unmerged = true))
        capture("01-settings-off")
        runCatching { compose.onNode(hasTestTag("wiki-settings-set-up")).performScrollTo() }
        compose.onNode(hasTestTag("wiki-settings-set-up")).performClick()
        await("the set-up form") { exists(hasTestTag("wiki-settings-form")) }
        verify("the form has no model or execution mode", !exists(hasTestTag("wiki-settings-form-model"), unmerged = true) &&
            !exists(hasText("Execution", substring = true), unmerged = true) && !exists(hasText("Runner mode", substring = true), unmerged = true))
        capture("02-set-up-form")
        runCatching { compose.onNode(hasTestTag("wiki-settings-form-submit")).performScrollTo() }
        compose.onNode(hasTestTag("wiki-settings-form-submit")).performClick()
        await("maintenance is written") { bodies.any { it.first == "PATCH wiki/spaces/$space" } }
        val written = Json.parseToJsonElement(bodies.last { it.first == "PATCH wiki/spaces/$space" }.second).jsonObject
        note("PATCH wiki/spaces/$space $written")
        val maintenance = written["maintenance"]?.jsonObject
        verify("it turns maintenance on", maintenance?.get("enabled")?.toString() == "true")
        verify("and writes no provider", maintenance?.containsKey("provider") == false && !written.containsKey("provider"))
        capture("03-saved")
    }

    private fun clipboard() = app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    private fun copied(): String? { var text: String? = null; instrumentation.runOnMainSync { text = clipboard().primaryClip?.getItemAt(0)?.text?.toString() }; return text }
    private fun copyLink() {
        instrumentation.runOnMainSync { clipboard().setPrimaryClip(android.content.ClipData.newPlainText("a15c", "before")) }
        signIn()
        open("orbit-wiki:$entry")
        await("the entry") { exists(hasTestTag("wiki-entry")) && exists(hasTestTag("wiki-entry-more")) }
        await("the spaces were read") { calls.any { it == "GET wiki/spaces" } }
        compose.onNodeWithTag("wiki-entry-more").performClick()
        compose.onNodeWithTag("wiki-entry-copy-link").performClick()
    }

    /** DL-7: Copy link builds /wiki/<slug>/e/<public id> from the account's server. */
    @Test fun anEntrysCopyLinkIsItsWikiAddress() = journey {
        copyLink()
        val expected = server.url("/wiki/orbit/e/$entry").toString()
        await("the link is copied") { copied() == expected }
        note("copied $expected")
        capture("01-copied")
    }

    /** DL-7: a space without a slug has no address to copy, and nothing is copied. */
    @Test fun anEntrysCopyLinkCopiesNothingWithoutASlug() = journey {
        slug = ""
        copyLink()
        android.os.SystemClock.sleep(1_500)
        verify("without a slug nothing is copied (${copied()})", copied() == "before")
        capture("01-nothing-copied")
    }
}
