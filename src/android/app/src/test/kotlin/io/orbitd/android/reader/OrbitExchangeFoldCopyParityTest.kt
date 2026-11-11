package io.orbitd.android.reader

import io.orbitd.android.core.cards.OrbitExchangeFold
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A folded turn says the same words on every client: the group's line, how it counts by kind, a branch's sums, the branch of
 * everything else, a reply's line, and which facts stay in view are the web's (`lib/orbitExchangeFold.ts`, `OrbitExchangeFold.tsx`,
 * `Transcript.tsx`), word for word and in order. A missing counterpart is a failure, never a skip.
 */
class OrbitExchangeFoldCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/web/src/lib").isDirectory }
    private fun read(path: String) = File(root, path).also { assertTrue("$path is gone", it.isFile) }.readText()
    private val lib = read("src/web/src/lib/orbitExchangeFold.ts")
    private val view = read("src/web/src/components/OrbitExchangeFold.tsx")
    private val transcript = read("src/web/src/components/Transcript.tsx")

    private fun assertHas(source: String, file: String, needle: String) = assertTrue("$file no longer contains $needle", source.contains(needle))

    @Test fun aGroupCountsByTheWebsKindsInItsOrder() {
        val theirs = Regex("""\['(\w+)', '([^']*)', '([^']*)'\]""").findAll(lib).map { Triple(it.groupValues[1], it.groupValues[2], it.groupValues[3]) }.toList()
        assertEquals(OrbitExchangeFold.categoryWords, theirs)
    }

    @Test fun theLinesSayTheWebsWords() {
        assertHas(lib, "orbitExchangeFold.ts", "export const OTHER_BRANCH_TITLE = '${OrbitExchangeFold.otherBranch}';")
        assertHas(view, "OrbitExchangeFold.tsx", "`\${exchanges.length} Orbit updates handled`")
        assertEquals("7 Orbit updates handled", OrbitExchangeFold.handled(7))
        assertHas(view, "OrbitExchangeFold.tsx", "`\${every.length} \${every.length === 1 ? 'update' : 'updates'}`")
        assertEquals(listOf("1 update", "2 updates"), listOf(OrbitExchangeFold.updates(1), OrbitExchangeFold.updates(2)))
        assertHas(view, "OrbitExchangeFold.tsx", "`\${below} downstream`")
        assertEquals("3 downstream", OrbitExchangeFold.downstream(3))
        assertHas(view, "OrbitExchangeFold.tsx", "`last: \${latest.reply}`")
        assertEquals("last: ok", OrbitExchangeFold.last("ok"))
        assertHas(transcript, "Transcript.tsx", "what: `Reply from \${reply.fromTitle}`,")
        assertEquals("Reply from B4", OrbitExchangeFold.replyFrom("B4"))
        assertHas(transcript, "Transcript.tsx", "what: `Message from \${task ?? card.fromTitle}`,")
        assertHas(transcript, "Transcript.tsx", "whatInTask: '${OrbitExchangeFold.message}',")
        assertEquals("Message from B4", OrbitExchangeFold.messageFrom("B4"))
        assertHas(transcript, "Transcript.tsx", "what: notice.taskTitle ? `Run notice: \${notice.taskTitle}` : '${OrbitExchangeFold.runNotice}',")
        assertHas(transcript, "Transcript.tsx", "whatInTask: '${OrbitExchangeFold.runNotice}',")
        assertEquals("Run notice: B4", OrbitExchangeFold.runNoticeFor("B4"))
        assertHas(lib, "orbitExchangeFold.ts", "A run of the task “([\\s\\S]*?)” used notify\\.")
    }

    @Test fun theSameFactsStayInView() {
        val body = Regex("""const LOUD_DELIVERIES: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)""").find(transcript)
            ?.groupValues?.get(1) ?: error("Transcript.tsx declares no LOUD_DELIVERIES")
        assertEquals(OrbitExchangeFold.loudDeliveries, Regex("'(\\w+)'").findAll(body).map { it.groupValues[1] }.toSet())
        assertHas(transcript, "Transcript.tsx", "(ask_owner|request_owner_action)")
    }
}
