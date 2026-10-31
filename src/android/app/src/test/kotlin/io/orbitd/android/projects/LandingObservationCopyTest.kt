package io.orbitd.android.projects

import io.orbitd.android.cards.NeedsYouLogic
import io.orbitd.android.core.cards.ExceptionCards
import io.orbitd.android.directory.SessionProjectCopy
import io.orbitd.android.push.PushPayload
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.Instant

/** R29-12: the words Android draws for revision 29 of the integration line contract (§10.5, §10.7–§10.9, §7.1 V2, §7.6 V12/V13) — the
 * delivery mode, the two items with Accept and Observe again, the handling line, the task row, the fifth owner item and its push — are
 * the browser's (R29-10), held to the web source the way MainBranchCopyTest holds the main branch's: every constant is the web's
 * literal, and every sentence that names a branch, rendered here with a sentinel put back as the web's interpolation, is one string or
 * template literal there. They are held to the web rather than the Swift because OrbitKit gains them in its own task (R29-11). A
 * missing counterpart is a failure, never a skip. */
class LandingObservationCopyTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/web/src/lib/projectStart.ts").isFile }
    /** A web source with `'a ' + 'b'` (and the template halves of one sentence) put back together. */
    private fun web(path: String) = File(root, "src/web/src/$path").readText().replace(Regex("""['`]\s*\+\s*['`]"""), "")
    private val start = web("lib/projectStart.ts")
    private val status = web("components/ProjectProgressStatus.tsx")

    /** A sentinel no sentence contains, and the web's interpolation of the main branch. */
    private val b = "§1"
    private val main = "\${main}"

    private fun assertDeclares(source: String, name: String, value: String) =
        assertTrue("$name drifted: the web no longer declares it as '$value'", source.contains("export const $name = '$value';"))

    /** [rendered] with each sentinel put back as the web's interpolation is one string or template literal of [source]. */
    private fun assertTemplate(source: String, rendered: String, vararg values: Pair<String, String>) {
        val template = values.fold(rendered) { text, (from, to) -> text.replace(from, to) }
        assertTrue("the web no longer says `$template`", Regex("[`']" + Regex.escape(template) + "[`']").containsMatchIn(source))
    }

    /** O-L1/O-L2: the Delivery row of the start card and How it runs, its two ways and what each means, why the agent's way needs a
     * main line, and the sentences that stop saying a merge into main asks the owner once the agent pushes. */
    @Test fun theDeliveryModesWordsAreTheWebs() {
        assertDeclares(start, "RUN_DELIVERY", RunSettings.delivery)
        assertDeclares(start, "RUN_DELIVERY_PLATFORM", RunSettings.deliveryPlatform)
        assertDeclares(start, "RUN_DELIVERY_AGENT_PUSH", RunSettings.deliveryAgentPush)
        assertTemplate(start, RunSettings.deliveryPlatformHint(b), b to main)
        assertTemplate(start, RunSettings.deliveryAgentPushHint(b), b to main)
        assertTemplate(start, RunSettings.deliveryNeedsMainLine(b), b to main)
        assertTemplate(start, RunSettings.lineMainHintAgentPush(b), b to main)
        assertTemplate(start, RunSettings.automaticHintAgentPush(b), b to main)
        val who = "\${automatic ? 'The coordinator decides' : 'You decide'}"
        assertTemplate(start, RunSettings.automaticSaysAgentPush(true, b), "The coordinator decides" to who, b to main)
        assertTemplate(start, RunSettings.automaticSaysAgentPush(false, b), "You decide" to who, b to main)
        // Comes to you drops the merge into main where the agent pushes, as the browser's `startComesToYou` does.
        assertTrue(start.contains("? input.deliveryMode === 'AGENT_PUSH' ? [] : [{ text: startEachMergeInto(input.main), detail: null }]"))
    }

    /** §10.8's two doors on a card, what each says it does, Observe again's reason, and what a refusal of each says. */
    @Test fun theItemsDoorsAreTheWebs() {
        val row = buildJsonObject { }
        assertTrue(status.contains("ACCEPT: '${ExceptionCards.accept}',"))
        assertTrue(status.contains("OBSERVE: '${ExceptionCards.observeAgain}',"))
        assertTrue(status.contains("ACCEPT: '${ExceptionCards.actionConsequence(row, "ACCEPT")}',"))
        assertTrue(status.contains("OBSERVE: '${ExceptionCards.actionConsequence(row, "OBSERVE")}',"))
        assertDeclares(status, "OBSERVE_MODAL_TITLE", ExceptionCards.observeTitle)
        assertTrue(status.contains("export const OBSERVE_MODAL_BODY =\n  '${ExceptionCards.observeBody}';"))
        assertDeclares(status, "OBSERVE_REASON_LABEL", ExceptionCards.observeReason)
        assertTrue("the field stops where the door does", status.contains("maxLength={${ExceptionCards.observeReasonMaxLength}}"))
        assertDeclares(status, "OBSERVE_FAILED", ExceptionCards.notObserved)
        assertDeclares(status, "ACCEPT_FAILED", ExceptionCards.notAccepted)
    }

    /** What a card from birth is headed by, and the handling line (§4.7 H1, §10.8): the observation's own words and the rerun's, in
     * the browser's code, beside this end's output for the same handling. */
    @Test fun theCardsHeadAndHandlingLineAreTheWebs() {
        assertDeclares(web("components/WorkspaceView.tsx"), "OWNER_ITEM_LANDED_WITHOUT_CONFIRMATION", ExceptionCards.landedTitle)
        assertDeclares(status, "HANDLING_TAG", ExceptionCards.handlingLabel)
        assertTrue(status.contains("<FactRow label=\"${ExceptionCards.reasonLabel}\">"))
        assertTemplate(status, ExceptionCards.observing(b), b to "\${branch}")
        listOf("return `\${observingLine(main)} — \${handling.state === 'RUNNING' ? 'running' : 'queued'} · asked \${ago(handling.startedAt, now)}`;",
            "const where = handling.state === 'RUNNING' ? 'is running' : 'is queued';",
            "return `\${rerunOf(row, handling.jobKind, main)} — generation \${handling.generation} \${where} · asked \${ago(handling.startedAt, now)}`;",
            "return check ? `the re-check of the merge into \${main}` : 'the rerun of the landing';",
        ).forEach { assertTrue("ProjectProgressStatus.tsx no longer says $it", status.contains(it)) }
        assertTrue(web("lib/watches.ts").contains("return diff < 10 * SECOND ? 'just now' : `\${formatSpan(diff)} ago`;"))
        val now = Instant.parse("2026-10-29T03:00:00Z")
        fun handled(jobKind: String, state: String) = Json.parseToJsonElement("""{"kind":"LANDING_UNOBSERVED","handling":{"reason":"r",
            "startedAt":"2026-10-29T02:58:00Z","jobId":"j","jobKind":"$jobKind","generation":4,"state":"$state"}}""").jsonObject
        assertEquals("Observing $b… — running · asked 2m ago", ExceptionCards.handlingLine(handled("OBSERVE_LANDING", "RUNNING"), now, b))
        assertEquals("Observing $b… — queued · asked 2m ago", ExceptionCards.handlingLine(handled("OBSERVE_LANDING", "QUEUED"), now, b))
        assertEquals("the rerun of the landing — generation 4 is running · asked 2m ago", ExceptionCards.handlingLine(handled("LAND_TASK", "RUNNING"), now, b))
        assertEquals("the re-check of the merge into $b — generation 4 is queued · asked 2m ago",
            ExceptionCards.handlingLine(handled("CHECK_PROMOTION", "QUEUED"), now, b))
    }

    /** §10.9's second segment of a task row, and the lane it waits in. */
    @Test fun theTaskRowsWordsAreTheWebs() {
        val page = web("pages/ProjectsPage.tsx")
        assertTemplate(page, ProjectPage.waitingToBeSeenOn(b, null), b to "\${branch}")
        assertTrue(page.contains("return deliveredSha ? `\${words} · \${deliveredSha.slice(0, 7)}` : words;"))
        assertEquals("${ProjectPage.waitingToBeSeenOn(b, null)} · 9f1c2ab", ProjectPage.waitingToBeSeenOn(b, "9f1c2ab7e4d0b5a6c3f8e1d2a7b4c9e0f1a2b3c4"))
        assertTrue(page.contains("'QUEUED', 'RUNNING', 'CONFLICT', 'CHECK_FAILED', 'ERROR', 'AWAITING_OWNER', 'AWAITING_OBSERVATION',"))
    }

    /** The fifth owner item (owner 2026-10-28): its kind word on the session row and the bar, its chip on the project list and where a
     * tie puts it, the coordinator's words for work not on the line yet, and the push slug the server sends for it. */
    @Test fun theFifthOwnerItemsWordsAreTheWebsAndItsPushTheServers() {
        val attention = web("lib/projectAttention.ts")
        val item = buildJsonObject { put("kind", "LANDED_WITHOUT_CONFIRMATION"); put("count", 1) }
        assertTrue(attention.contains("LANDED_WITHOUT_CONFIRMATION: () => '${ProjectAttention.ownerItemSays(item)}',"))
        assertTrue("a tie puts it last, after the pause", attention.contains("'FUSE_PAUSED',\n  'LANDED_WITHOUT_CONFIRMATION',\n];"))
        assertEquals(ExceptionCards.landedTitle, NeedsYouLogic.kindWord("LANDED_WITHOUT_CONFIRMATION"))
        // What the coordinator is doing with work not seen on its line: the list chip's words, and the session project row's.
        val now = Instant.parse("2026-10-05T00:00:00Z")
        val holding = Json.parseToJsonElement("""{"id":"p","title":"P","status":"OPEN","_count":{"tasks":1},"buckets":{"ready":1},
            "lastActivityAt":"2026-10-04T23:59:00Z","attention":{"coordinatorItems":{"count":1,"leadKind":"LANDING_UNOBSERVED",
            "oldestWaitingSince":"2026-10-04T23:42:00Z"}}}""").jsonObject
        val chip = ProjectAttention.chip(holding, now)!!.text
        val lead = chip.removePrefix("Coordinator · ").removeSuffix(" · 18m")
        assertEquals("Coordinator · $lead · 18m", chip)
        assertTrue(attention.contains("LANDING_UNOBSERVED: '$lead',"))
        assertTrue(web("lib/sessionProjects.ts").contains("LANDING_UNOBSERVED: '${SessionProjectCopy.coordinatorLead("LANDING_UNOBSERVED")}',"))
        // Every owner item's push slug the server sends (`OWNER_ITEM_PUSH_KINDS`) is one this build opens, and no other.
        val shared = File(root, "src/shared/src/project-progress.ts").readText()
            .substringAfter("export const OWNER_ITEM_PUSH_KINDS").substringBefore("};")
        assertEquals(Regex(""": '([a-z-]+)',""").findAll(shared).map { it.groupValues[1] }.toSet(), PushPayload.ownerItemKinds)
    }
}
