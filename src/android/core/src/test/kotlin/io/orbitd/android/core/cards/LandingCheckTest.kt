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
        // Web's landingCheck.ts holds five copy objects. This module's own is LANDING_CHECK_COPY; the other four are revision 42 part
        // two's words, which the app module declares once (`LandingMeasuredCopy`) and LandingMeasuredCopyParityTest holds whole.
        val pairs = mapOf(
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
        )
        val block = Regex("""export const LANDING_CHECK_COPY = \{\n(.*?)\n\} as const;""", RegexOption.DOT_MATCHES_ALL)
        val body = block.find(web)?.groupValues?.get(1) ?: error("landingCheck.ts no longer declares LANDING_CHECK_COPY")
        val entries = Regex("""(?m)^  ([A-Z_]+): '([^']*)',""").findAll(body).toList()
        assertEquals("A missing counterpart or duplicate must fail", pairs.keys.sorted(), entries.map { it.groupValues[1] }.sorted())
        entries.forEach { match ->
            val (key, value) = match.destructured
            assertEquals("LANDING_CHECK_COPY.$key", value, pairs[key])
        }
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
