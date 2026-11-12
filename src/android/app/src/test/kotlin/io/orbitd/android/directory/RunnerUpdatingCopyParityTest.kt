package io.orbitd.android.directory

import java.io.File
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The runner_updating words are web `runnerSlots.ts`'s (board 2 and 5 of docs/mocks/runner-update-drain): every constant of
 *  [RunnerUpdating] is a literal there, and every sentence the Kotlin builds — rendered with sentinels, which are put back as the
 *  TypeScript's own interpolations — is one template literal there, so the words either side of a name or a number are held too. A
 *  missing counterpart is a failure, never a skip. */
class RunnerUpdatingCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/web/src/lib/runnerSlots.ts").isFile }
    private val web = File(root, "src/web/src/lib/runnerSlots.ts").readText()

    private fun assertHas(literal: String) = assertTrue("runnerSlots.ts no longer contains $literal", web.contains(literal))
    private fun quoted(words: String) = assertHas("'$words'")

    /** Sentinels that occur in no sentence. */
    private val who = "\u0001WHO\u0001"
    private val version = "\u0001VERSION\u0001"
    private val count = 23

    @Test fun theNamedConstantsAreWebsDeclarations() {
        assertHas("export const RUNNER_UPDATING_TITLE = '${RunnerUpdating.RUNNER_UPDATING_TITLE}';")
        assertHas("export const RUNNER_UPDATING_TAG = '${RunnerUpdating.RUNNER_UPDATING_TAG}';")
        assertHas("export const QUEUED_LABEL = '${RunnerUpdating.QUEUED}';")
        assertHas("queuedReason === 'runner_updating'")
        listOf(RunnerUpdating.THE_RUNNER, RunnerUpdating.UNTITLED_SESSION, RunnerUpdating.SESSION_STARTS, RunnerUpdating.LESS_THAN_A_MINUTE,
            RunnerUpdating.AND).forEach(::quoted)
        assertHas("`\${first} ${RunnerUpdating.MESSAGE_SENT}`")
        // Every string constant of the object is held above: a word added there and not here fails.
        val declared = RunnerUpdating::class.java.declaredFields.filter { it.type == String::class.java }
            .map { it.isAccessible = true; it.get(null) as String }
        assertEquals(9, declared.size)
    }

    @Test fun everyBuiltSentenceIsOneWebLiteral() {
        val update = QueuedRunnerUpdate(version, null, emptyList())
        val many = QueuedGate("runner_updating", count, update)
        val parts = RunnerUpdating.runnerUpdatingDescription(many, who).filterIsInstance<RunnerUpdatingPart.Words>().map { it.text }
        assertEquals("`\${who} is updating to \${version}. `", template(parts[0]))
        assertHas(template(parts[0]))
        assertHas(template(RunnerUpdating.runnerUpdatingDescription(many.copy(queuedRunnerUpdate = null), who).first()
            .let { (it as RunnerUpdatingPart.Words).text }))
        // "It starts no new work until ${turnsFinish(count)}: " with the count's own words beside it.
        assertEquals("It starts no new work until $count turns finish: ", parts[1])
        assertHas("`It starts no new work until \${turnsFinish(count)}: `")
        assertHas("`\${count} turns finish`")
        quoted("1 turn finishes")
        assertEquals("$count more", parts[2])
        assertHas("`\${count - named.length} more`")
        quoted(". ")
        quoted(", ")
        // The popover's sentence, both ways round.
        val message = RunnerUpdating.runnerUpdatingMessageText(many, who).removeSuffix(" ${RunnerUpdating.MESSAGE_SENT}")
        assertEquals("$who starts no new turns until $count turns finish, then updates to $version.", message)
        assertHas("`\${who} starts no new turns until \${turnsFinish(count)}, then \${update}.`")
        assertHas("`updates to \${version}`")
        quoted("updates")
        assertEquals("$who updates to $version now.", RunnerUpdating.runnerUpdatingMessageText(many.copy(queuedActive = 0), who)
            .removeSuffix(" ${RunnerUpdating.MESSAGE_SENT}"))
        assertHas("`\${who} \${update} now.`")
        // The wait, in minutes and in hours.
        val now = Instant.parse("2026-11-12T12:00:00Z")
        fun waited(minutes: Long) = RunnerUpdating.runnerUpdatingWaited(many.copy(queuedRunnerUpdate = update.copy(since = now.minusSeconds(minutes * 60).toString())), now)
        assertEquals("Waiting $count min", waited(count.toLong()))
        assertHas("`Waiting \${minutes} min`")
        assertEquals("Waiting 2 h $count min", waited(120L + count))
        assertHas("`Waiting \${Math.floor(minutes / 60)} h\${rest ? ` \${rest} min` : ''}`")
    }

    /** A rendered sentence as the TypeScript template it came from. */
    private fun template(rendered: String) = "`" + rendered.replace(who, "\${who}").replace(version, "\${version}") + "`"
}
