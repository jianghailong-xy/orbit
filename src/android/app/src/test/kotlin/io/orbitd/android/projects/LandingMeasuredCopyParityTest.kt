package io.orbitd.android.projects

import io.orbitd.android.core.cards.LandingCheckCopy
import java.io.File
import org.junit.Assert.*
import org.junit.Test

/** Every copy object web's landingCheck.ts declares, key for key, against the one Android constant for each sentence: core's
 * [LandingCheckCopy] for `LANDING_CHECK_COPY`, [LandingMeasuredCopy] for revision 42 part two's four. A key web adds without a
 * counterpart here, a counterpart web dropped, or a copy object nobody maps fails. */
class LandingMeasuredCopyParityTest {
    private val web = File(generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/web/src/lib/landingCheck.ts").isFile }, "src/web/src/lib/landingCheck.ts").readText()

    @Test fun everyCopyObjectOfTheWebHasItsAndroidWords() {
        val copy = mapOf(
            "LANDING_CHECK_COPY" to mapOf(
                "LABEL" to LandingCheckCopy.label, "CONFIRM_TITLE" to LandingCheckCopy.confirmTitle,
                "CONFIRM_ACTION" to LandingCheckCopy.confirmAction, "COMMAND" to LandingCheckCopy.command,
                "TIMEOUT" to LandingCheckCopy.timeout, "HINT" to LandingCheckCopy.hint, "INHERITS" to LandingCheckCopy.inherits,
                "COMMAND_PLACEHOLDER" to LandingCheckCopy.commandPlaceholder, "INHERITS_TIMEOUT" to LandingCheckCopy.inheritsTimeout,
                "TIMEOUT_PLACEHOLDER" to LandingCheckCopy.timeoutPlaceholder, "TIMEOUT_HINT" to LandingCheckCopy.timeoutHint,
                "MAIN" to LandingCheckCopy.main, "APPLIES" to LandingCheckCopy.applies, "WAITING" to LandingCheckCopy.waiting,
                "RESUMES" to LandingCheckCopy.resumes, "BASELINE_BODY" to LandingCheckCopy.baselineBody, "HELD" to LandingCheckCopy.held,
                "UPSTREAM" to LandingCheckCopy.upstream, "TIP" to LandingCheckCopy.tip, "BASELINE" to LandingCheckCopy.baseline,
                "VIEW_HELD" to LandingCheckCopy.viewHeld,
            ),
            "LANDING_MODE_COPY" to mapOf(
                "MERGE_CHECK" to LandingMeasuredCopy.mergeCheck,
                "COMMAND" to LandingMeasuredCopy.command,
                "NONE" to LandingMeasuredCopy.noCheck,
                "NONE_HEAD" to LandingMeasuredCopy.noCheckLead,
                // Android draws the second sentence muted, so it holds the two apart; together they are web's one.
                "NONE_BODY" to "${LandingMeasuredCopy.noCheckBody} ${LandingMeasuredCopy.noCheckMain}",
                // The hint's tail, with the list's title set bold in the middle of it.
                "COMMAND_NOTE" to "${LandingMeasuredCopy.hintChanges} ${LandingMeasuredCopy.changesTitle}.",
                "WHO_CAN_SET" to LandingMeasuredCopy.whoCanSet,
            ),
            "LANDING_CHECK_ORIGIN_COPY" to mapOf(
                "OWNER" to LandingMeasuredCopy.whoOwner, "COORDINATOR" to LandingMeasuredCopy.whoCoordinator,
                "CARD" to LandingMeasuredCopy.whoCard, "START" to LandingMeasuredCopy.whoStart,
            ),
            "CHANGES_COPY" to mapOf(
                "TITLE" to LandingMeasuredCopy.changesTitle,
                "INTRO" to LandingMeasuredCopy.changesIntro,
                "EMPTY" to LandingMeasuredCopy.changesEmpty,
                "LANDING_CHECK" to LandingMeasuredCopy.fieldLandingCheck,
                "CHECK_EXEMPT" to LandingMeasuredCopy.fieldExempt,
                "USES_MERGE_CHECK" to LandingMeasuredCopy.usesMergeCheck,
                "NO_CHECK" to LandingMeasuredCopy.noCheck,
                "EXEMPT" to LandingMeasuredCopy.exemptValue,
                "NOT_EXEMPT" to LandingMeasuredCopy.notExempt,
                "REVERT" to LandingMeasuredCopy.revert,
                "YOUR_CHANGE" to LandingMeasuredCopy.yourChangeLabel,
                "YOUR_CHANGE_NOTHING" to LandingMeasuredCopy.yourChange,
                "CONFIRM_TITLE" to LandingMeasuredCopy.revertTitle,
                "CONFIRM_CONSEQUENCE" to LandingMeasuredCopy.revertNote,
                "CANCEL" to LandingMeasuredCopy.cancel,
            ),
            "TASK_EXEMPT_COPY" to mapOf(
                "LABEL" to LandingCheckCopy.label,
                "BADGE" to LandingMeasuredCopy.exempt,
                "REMOVE" to LandingMeasuredCopy.removeExemption,
                "SKIPPED" to LandingMeasuredCopy.skipped,
                "MERGE_CHECK_STILL_RUNS" to LandingMeasuredCopy.mergeCheckBeforeMain,
                "STILL_RUNS" to LandingMeasuredCopy.stillRuns,
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
    }

    @Test fun theSentencesWebBuildsAreBuiltTheSameWay() {
        val originNote = Regex("""\{ by: '([A-Z]+)', note: '([^']*)' \}""")
        assertEquals(LandingMeasuredCopy.originNotes, originNote.findAll(web).map { match ->
            val (by, note) = match.destructured
            by to note
        }.toList())
        assertTrue(web.contains("`${'$'}{count} ${'$'}{count === 1 ? 'change' : 'changes'}`"))
        assertEquals("1 change", LandingMeasuredCopy.changesCount(1))
        assertEquals("3 changes", LandingMeasuredCopy.changesCount(3))
        assertTrue(web.contains("`Reverted by you · ${'$'}{when} · coordinator needs a card for this field`"))
        assertEquals("Reverted by you · 2h ago · coordinator needs a card for this field", LandingMeasuredCopy.revertedBy("2h ago"))
        assertTrue(web.contains("`Exempt: ${'$'}{reason}`"))
        assertEquals("Exempt: docs only", LandingMeasuredCopy.exemptBecause("docs only"))
    }
}
