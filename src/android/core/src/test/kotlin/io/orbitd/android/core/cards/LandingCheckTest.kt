package io.orbitd.android.core.cards

import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class LandingCheckTest {
    @Test fun everyWebCopyKeyHasAnExactCounterpart() {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .firstOrNull { File(it, "src/web/src/lib/landingCheck.ts").isFile } ?: error("Missing web copy")
        val web = File(root, "src/web/src/lib/landingCheck.ts").readText()
        val copy = mapOf(
            "LANDING_CHECK_COPY" to mapOf(
                "LABEL" to LandingCheckCopy.label,
                "CONFIRM_TITLE" to LandingCheckCopy.confirmTitle,
                "CONFIRM_ACTION" to LandingCheckCopy.confirmAction,
                "COMMAND" to LandingCheckCopy.command,
                "TIMEOUT" to LandingCheckCopy.timeout,
                "HINT" to LandingCheckCopy.hint,
                "INHERITS" to LandingCheckCopy.inherits,
                "COMMAND_PLACEHOLDER" to LandingCheckCopy.commandPlaceholder,
                "INHERITS_TIMEOUT" to LandingCheckCopy.inheritsTimeout,
                "TIMEOUT_PLACEHOLDER" to LandingCheckCopy.timeoutPlaceholder,
                "TIMEOUT_HINT" to LandingCheckCopy.timeoutHint,
                "MAIN" to LandingCheckCopy.main,
                "APPLIES" to LandingCheckCopy.applies,
                "WAITING" to LandingCheckCopy.waiting,
                "RESUMES" to LandingCheckCopy.resumes,
                "BASELINE_BODY" to LandingCheckCopy.baselineBody,
                "HELD" to LandingCheckCopy.held,
                "UPSTREAM" to LandingCheckCopy.upstream,
                "TIP" to LandingCheckCopy.tip,
                "BASELINE" to LandingCheckCopy.baseline,
                "VIEW_HELD" to LandingCheckCopy.viewHeld
            ),
            "LANDING_MODE_COPY" to mapOf(
                "MERGE_CHECK" to LandingModeCopy.mergeCheck,
                "COMMAND" to LandingModeCopy.command,
                "NONE" to LandingModeCopy.none,
                "NONE_HEAD" to LandingModeCopy.noneHead,
                "NONE_BODY" to LandingModeCopy.noneBody,
                "COMMAND_NOTE" to LandingModeCopy.commandNote,
                "WHO_CAN_SET" to LandingModeCopy.whoCanSet,
            ),
            "LANDING_CHECK_ORIGIN_COPY" to mapOf(
                "OWNER" to LandingCheckOriginCopy.owner,
                "COORDINATOR" to LandingCheckOriginCopy.coordinator,
                "CARD" to LandingCheckOriginCopy.card,
                "START" to LandingCheckOriginCopy.start,
            ),
            "CHANGES_COPY" to mapOf(
                "TITLE" to LandingChangesCopy.title,
                "INTRO" to LandingChangesCopy.intro,
                "EMPTY" to LandingChangesCopy.empty,
                "LANDING_CHECK" to LandingChangesCopy.landingCheck,
                "CHECK_EXEMPT" to LandingChangesCopy.checkExempt,
                "USES_MERGE_CHECK" to LandingChangesCopy.usesMergeCheck,
                "NO_CHECK" to LandingChangesCopy.noCheck,
                "EXEMPT" to LandingChangesCopy.exempt,
                "NOT_EXEMPT" to LandingChangesCopy.notExempt,
                "REVERT" to LandingChangesCopy.revert,
                "YOUR_CHANGE" to LandingChangesCopy.yourChange,
                "YOUR_CHANGE_NOTHING" to LandingChangesCopy.yourChangeNothing,
                "CONFIRM_TITLE" to LandingChangesCopy.confirmTitle,
                "CONFIRM_CONSEQUENCE" to LandingChangesCopy.confirmConsequence,
                "CANCEL" to LandingChangesCopy.cancel,
            ),
            "TASK_EXEMPT_COPY" to mapOf(
                "LABEL" to TaskExemptCopy.label,
                "BADGE" to TaskExemptCopy.badge,
                "REMOVE" to TaskExemptCopy.remove,
                "SKIPPED" to TaskExemptCopy.skipped,
                "MERGE_CHECK_STILL_RUNS" to TaskExemptCopy.mergeCheckStillRuns,
                "STILL_RUNS" to TaskExemptCopy.stillRuns,
            ),
        )
        val block = Regex("""export const ([A-Z_]+) = \{\n(.*?)\n\} as const;""", RegexOption.DOT_MATCHES_ALL)
        val entry = Regex("""(?m)^  ([A-Z_]+): '([^']*)',""")
        val objects = block.findAll(web).toList()
        assertEquals("A missing copy object or duplicate must fail", copy.keys.sorted(), objects.map { it.groupValues[1] }.sorted())
        for ((_, name, body) in objects.map { it.groupValues }) {
            val entries = entry.findAll(body).toList()
            val expected = copy.getValue(name)
            assertEquals("A missing counterpart or duplicate in $name must fail", expected.keys.sorted(), entries.map { it.groupValues[1] }.sorted())
            entries.forEach { match ->
                val (key, value) = match.destructured
                assertEquals("$name.$key", value, expected[key])
            }
        }
        val originNote = Regex("""\{ by: '([A-Z]+)', note: '([^']*)' \}""")
        assertEquals(LandingCheckOriginCopy.notes, originNote.findAll(web).map { match ->
            val (by, note) = match.destructured
            by to note
        }.toList())
        assertTrue(web.contains("`${'$'}{count} ${'$'}{count === 1 ? 'change' : 'changes'}`"))
        assertEquals("1 change", LandingChangesCopy.rowLabel(1))
        assertEquals("3 changes", LandingChangesCopy.rowLabel(3))
        assertTrue(web.contains("`Reverted by you · ${'$'}{when} · coordinator needs a card for this field`"))
        assertEquals("Reverted by you · 2h ago · coordinator needs a card for this field", LandingChangesCopy.revertedLine("2h ago"))
        assertTrue(web.contains("`Exempt: ${'$'}{reason}`"))
        assertEquals("Exempt: docs only", TaskExemptCopy.reason("docs only"))
        assertEquals("Uses merge check: make all", LandingCheckCopy.inheritedCommand("make all"))
        assertEquals("Uses merge check timeout: 900 seconds", LandingCheckCopy.inheritedTimeout(900))
    }
    @Test fun confirmationShowsBothChecksAndIndependentInheritance() {
        val input = Json.parseToJsonElement("""{"currentLandingCheckCommand":"  make fast  ",
          "currentLandingCheckTimeoutSeconds":300,"currentMergeCheckCommand":"make all",
          "currentMergeCheckTimeoutSeconds":900,"landingCheckTimeoutSeconds":null}""").jsonObject
        assertEquals("  make fast  ", IntegrationCheckProposal.command(input, "landing", true))
        assertEquals("make all", IntegrationCheckProposal.command(input, "merge", true))
        assertEquals("300 seconds", IntegrationCheckProposal.timeout(input, "landing", false))
        assertEquals("Uses merge check timeout: 900 seconds", IntegrationCheckProposal.timeout(input, "landing", true))
    }
    @Test fun baselineCardShowsMeasurementsAndHeldTaskCount() {
        val row = Json.parseToJsonElement("""{"kind":"INTEGRATION_CHECK_FAILED",
          "baseline":{"upstreamSha":"u","targetSha":"t","mergeTreeSha":"m","check":{"command":"make fast"}},
          "heldTaskIds":["t1","t2"]}""").jsonObject
        val facts = ExceptionCards.facts(row) as ExceptionCards.Facts.Rows
        assertEquals(listOf("", "Landings on hold", "Upstream", "Project tip", "Combined baseline", "Landing check", ""), facts.rows.map { it.label })
        assertEquals(listOf(LandingCheckCopy.baselineBody, "2", "u", "t", "m", "make fast", LandingCheckCopy.resumes), facts.rows.map { it.value })
        assertEquals("Baseline checks failing on the project branch", ExceptionCards.headingLine(row))
    }
}
