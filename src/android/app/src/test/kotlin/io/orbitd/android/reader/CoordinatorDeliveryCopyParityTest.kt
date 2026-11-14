package io.orbitd.android.reader

import io.orbitd.android.core.cards.CoordinatorDelivery
import io.orbitd.android.core.cards.CoordinatorDeliveryLine
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A fact told to a session says the same line on every client: every sentence, every way a count is said, the kinds a card can be, its
 * fields and the task's link are the web's `lib/coordinatorDelivery.ts` and the shared declaration's
 * (`project-progress.ts`), word for word and in order — and the web reads a payload into a card by the rules this client reads it by. A
 * missing counterpart is a failure, never a skip (ProjectCopyParityTest's rule).
 */
class CoordinatorDeliveryCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/web/src/lib").isDirectory && File(it, "src/shared/src").isDirectory }
    private fun read(path: String) = File(root, path).also { assertTrue("$path is gone", it.isFile) }.readText()
    private val web = read("src/web/src/lib/coordinatorDelivery.ts")
    private val shared = read("src/shared/src/project-progress.ts")

    private fun assertHas(source: String, file: String, needle: String) =
        assertTrue("$file no longer contains $needle", source.contains(needle))

    /** From one marker to the next occurrence of another. */
    private fun section(source: String, file: String, from: String, to: String): String {
        val start = source.indexOf(from).also { assertTrue("$file declares no $from", it >= 0) }
        val end = source.indexOf(to, start + from.length).also { assertTrue("$file has no $to after $from", it >= 0) }
        return source.substring(start, end)
    }

    @Test fun theKindsAreTheSharedDeclarationsInItsOrder() {
        val body = section(shared, "project-progress.ts", "export const COORDINATOR_DELIVERY_KINDS = [", "] as const;")
        val theirs = Regex("""(?m)^\s*'(\w+)',""").findAll(body).map { it.groupValues[1] }.toList()
        assertEquals(CoordinatorDeliveryLine.kinds, theirs)
    }

    /** Every field of the card goes by the same name on both ends, in the same order — and the card this client builds holds that order. */
    @Test fun theFieldsAreTheSharedDeclarationsInItsOrder() {
        val body = section(shared, "project-progress.ts", "export interface CoordinatorDeliveryCard {", "\n}")
        val theirs = Regex("""(?m)^  (\w+):""").findAll(body).map { it.groupValues[1] }.toList()
        assertEquals(CoordinatorDeliveryLine.fields, theirs)
        val mine = Regex("""(\w+)=""").findAll(CoordinatorDelivery("k", null, null, null, "d").toString()).map { it.groupValues[1] }.toList()
        assertEquals("the card's constructor order", CoordinatorDeliveryLine.fields, mine)
    }

    /** Each sentence, by kind, as the web writes it — and the web writes no sentence this client does not. */
    @Test fun everySentenceIsTheWebsWordForWord() {
        val body = section(web, "coordinatorDelivery.ts", "export const COORDINATOR_DELIVERY_SENTENCES", "\n};")
        val theirs = Regex("""(?m)^  (\w+): '([^']*)',""").findAll(body).associate { it.groupValues[1] to it.groupValues[2] }
        assertEquals(CoordinatorDeliveryLine.sentences.entries.map { it.toPair() }, theirs.entries.map { it.toPair() })
        CoordinatorDeliveryLine.sentences.forEach { (kind, sentence) -> assertHas(web, "coordinatorDelivery.ts", "  $kind: '$sentence',") }
    }

    /** How each count is said — one, and many with its number — by kind, as the web says it. */
    @Test fun everyCountIsSaidAsTheWebSaysIt() {
        val forms = Regex("""const (\w+) = \{ one: '([^']*)', many: '([^']*)' \} as const;""").findAll(web)
            .associate { it.groupValues[1] to (it.groupValues[2] to it.groupValues[3]) }
        val body = section(web, "coordinatorDelivery.ts", "export const COORDINATOR_DELIVERY_COUNTS", "\n};")
        val theirs = Regex("""(?m)^  (\w+): (\w+),""").findAll(body).associate { match ->
            match.groupValues[1] to forms[match.groupValues[2]].also { assertTrue("no ${match.groupValues[2]} in coordinatorDelivery.ts", it != null) }!!
        }
        assertTrue("no count was captured — the check is asleep", theirs.isNotEmpty())
        assertEquals(CoordinatorDeliveryLine.counts.entries.map { it.toPair() }, theirs.entries.map { it.toPair() })
        // One is the singular, and the number goes where `{n}` stands; the title goes in last.
        assertHas(web, "coordinatorDelivery.ts", "(card.count === 1 ? counts.one : counts.many).replace('{n}', String(card.count))")
        val revision = web.indexOf(".replace('{revision}'")
        val count = web.indexOf(".replace('{count}'")
        val task = web.indexOf(".replace('{task}'")
        assertTrue("the web fills the revision, then the count, then the title", revision in 0 until count && count < task)
    }

    @Test fun theTasksLinkIsTheWebs() {
        assertHas(web, "coordinatorDelivery.ts", "export const COORDINATOR_DELIVERY_ITS_TASK = '${CoordinatorDeliveryLine.itsTask}';")
    }

    /** Where a reply told to a session that is not the project's coordinator says it went, and the heading its words open under. */
    @Test fun thisSessionsWordsAreTheWebs() {
        assertHas(web, "coordinatorDelivery.ts",
            "export const COORDINATOR_DELIVERY_SENT_TO_SESSION = '${CoordinatorDeliveryLine.sentToThisSession}';")
        assertHas(web, "coordinatorDelivery.ts",
            "export const COORDINATOR_DELIVERY_SESSION_TOLD = '${CoordinatorDeliveryLine.toldThisSession}';")
    }

    /** What makes a payload a card at all. One that is not must parse as NOTHING at either end, never as half a line. */
    @Test fun theWebReadsACardByTheseRules() {
        assertHas(web, "coordinatorDelivery.ts", "(payload as { coordinatorDelivery?: unknown } | null)?.coordinatorDelivery")
        assertHas(web, "coordinatorDelivery.ts", "if (!(COORDINATOR_DELIVERY_KINDS as readonly unknown[]).includes(kind)) return null;")
        assertHas(web, "coordinatorDelivery.ts",
            "if (typeof card.deliveredAt !== 'string' || Number.isNaN(Date.parse(card.deliveredAt))) return null;")
        assertHas(web, "coordinatorDelivery.ts", "&& typeof task.id === 'string' && task.id !== ''")
        assertHas(web, "coordinatorDelivery.ts", "&& typeof task.title === 'string' && task.title.trim() !== ''")
        assertHas(web, "coordinatorDelivery.ts", "typeof value === 'number' && Number.isSafeInteger(value) && value > 0;")
        assertHas(web, "coordinatorDelivery.ts", "if (sentence.includes('{task}') && !named) return null;")
        assertHas(web, "coordinatorDelivery.ts", "if (sentence.includes('{revision}') && !positive(card.revision)) return null;")
        assertHas(web, "coordinatorDelivery.ts", "if (sentence.includes('{count}') && !positive(card.count)) return null;")
        // Only the server's own false says the conversation is not the coordinator.
        assertHas(web, "coordinatorDelivery.ts", "toCoordinator: card.toCoordinator !== false,")
    }
}
