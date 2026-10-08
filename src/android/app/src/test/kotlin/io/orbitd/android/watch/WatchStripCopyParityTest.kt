package io.orbitd.android.watch

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

/** The Watching strip's sentences, proved against `src/shared/src/watch-strip.fixture.json` — the cases the web
 * (`lib/watches.test.ts`) and OrbitKit (`WatchStripCopyParityTests`) are proved against too, so the three clients
 * cannot drift into different sentences about one wait. The OrbitKit parts that read the web's source files are
 * left to OrbitKit; this holds the same words through the shared fixture, and the strip's fixed words to theirs. */
class WatchStripCopyParityTest {
    private val fixture = WatchFixture.strip()
    private val now: Instant = WatchTime.parse(fixture["now"]!!.jsonPrimitive.content)!!
    private fun JsonObject.text(key: String) = this[key]!!.jsonPrimitive.content
    private fun JsonObject.cases(key: String) = this[key]!!.jsonArray.map { it.jsonObject }

    /** The strip's fixed words: OrbitKit's declarations, which its parity test holds to the browser's `STRIP_*`. */
    @Test fun theStripsWordsAreOrbitKitsDeclarations() {
        assertEquals("Watching", WatchProjection.STRIP_LABEL)
        assertEquals("Manage in Watches ›", WatchProjection.STRIP_MANAGE)
        assertEquals("Open task ›", WatchProjection.STRIP_OPEN_TASK)
        assertEquals("Open session ›", WatchProjection.STRIP_OPEN_SESSION)
        assertEquals("Resumes this session when", WatchProjection.STRIP_RESUMES)
        assertEquals("Paused · resumes this session when", WatchProjection.STRIP_PAUSED)
        assertEquals("its condition is met", WatchProjection.STRIP_UNREAD)
        assertEquals("Not checked for", WatchProjection.STRIP_NOT_CHECKED)
        assertEquals("the resume may be late.", WatchProjection.STRIP_MAY_BE_LATE)
        // The leaf verbs the sentence borrows from the browser's `LEAF_COPY`.
        assertEquals(listOf("finishes its turn", "ends", "is moved to Completed or Trash", "asks for an approval", "finishes", "fails", "is done"),
            WatchLeaf.entries.filter { it != WatchLeaf.UNKNOWN }.map { WatchProjection.stripVerb(it, false) })
        assertEquals(listOf("finish their turns", "end", "are moved to Completed or Trash", "ask for an approval", "finish", "fail", "are done"),
            WatchLeaf.entries.filter { it != WatchLeaf.UNKNOWN }.map { WatchProjection.stripVerb(it, true) })
        assertNull(WatchProjection.stripVerb(WatchLeaf.UNKNOWN, false))
        // The header's words over a session parked on a watch (`WATCHING_WORDS`).
        assertEquals("Watching 1 target", WatchProjection.watchingLabel(1))
        assertEquals("Watching 7 targets", WatchProjection.watchingLabel(7))
        assertEquals("Watch paused", WatchSessionSummary.of("S1", listOf(WatchFixture.watch(id = "W1", state = "PAUSED")))!!.word)
        assertEquals("2 watches paused", WatchSessionSummary.of("S1",
            listOf(WatchFixture.watch(id = "W1", state = "PAUSED"), WatchFixture.watch(id = "W2", state = "PAUSED")))!!.word)
    }

    @Test fun eachWatchsSentenceIsTheFixtures() {
        val sentences = fixture.cases("sentences")
        assertTrue(sentences.size > 10)
        sentences.forEach { c ->
            val targets = c["targets"]!!.jsonArray.mapIndexed { index, spec ->
                val parts = spec.jsonPrimitive.content.split(':')
                WatchFixture.target("T$index", kind = parts[0], state = parts.getOrElse(1) { "OBSERVED" })
            }
            val watch = WatchFixture.watch(state = c.text("state"), predicate = c["predicate"]!!.jsonObject, targets = targets, expiresAt = c.text("expiresAt"))
            assertEquals(c.text("case"), c.text("sentence"), WatchProjection.stripSentence(watch, now))
        }
    }

    @Test fun theUncheckedLineIsTheFixtures() {
        fixture.cases("stale").forEach { c ->
            val watch = WatchFixture.watch(state = c.text("state"), lastEvaluatedAt = c["lastEvaluatedAt"]?.jsonPrimitive?.contentOrNull,
                createdAt = c.text("createdAt"))
            assertEquals(c.text("case"), c["line"]?.jsonPrimitive?.contentOrNull, WatchProjection.stripStaleLine(watch, now))
        }
    }

    @Test fun theLinesSentenceOverSeveralTargetsIsTheFixtures() {
        fixture.cases("counts").forEach { c ->
            val targets = c["targets"]!!.jsonArray.mapIndexed { index, t ->
                WatchFixture.target("T$index", kind = t.jsonObject.text("kind"), status = t.jsonObject["status"] as? JsonObject)
            }
            // One watch over them all, so the line counts every one of them.
            val summary = WatchSessionSummary.of("S1", listOf(WatchFixture.watch(targets = targets)))!!
            assertEquals(c.text("case"), c.text("line"), summary.lineParts.joinToString(WatchCountCopy.SEPARATOR) { it.text })
        }
    }

    /** A session list row over a session these watches will resume: the strip's line in one string, and the word
     * its header says — over the same rows the web's `watchingSessions` reads. */
    @Test fun aSessionListRowSaysTheStripsLineAndTheHeadersWord() {
        val rows = fixture.cases("rows")
        assertTrue(rows.size > 8)
        rows.forEach { c ->
            val watches = c["watches"]!!.jsonArray.mapIndexed { index, w ->
                val row = w.jsonObject
                val targets = row["targets"]!!.jsonArray.map { t ->
                    val target = t.jsonObject
                    WatchFixture.target(target.text("id"), kind = target.text("kind"), state = target["state"]?.jsonPrimitive?.content ?: "OBSERVED",
                        title = target.text("title"), status = target["status"] as? JsonObject)
                }
                WatchFixture.watch(id = "W$index", state = row.text("state"), predicate = row["predicate"]!!.jsonObject, targets = targets)
            }
            val summary = WatchSessionSummary.of("S1", watches)!!
            assertEquals(c.text("case"), c.text("line"), summary.rowLine)
            assertEquals(c.text("case"), c.text("word"), summary.word)
        }
    }

    /** A session target's word is the one its own header's glyph says for that run state. */
    @Test fun aSessionTargetsWordIsItsHeadersGlyphs() {
        val words = fixture["sessionWords"]!!.jsonObject
        assertEquals("every run state a session can be in has a word, and no other",
            setOf("QUEUED", "RUNNING", "AWAITING_INPUT", "INTERRUPTED", "SUCCEEDED", "FAILED", "ENDED"), words.keys)
        words.forEach { (state, word) ->
            val target = WatchFixture.watch(targets = listOf(WatchFixture.target("S0", kind = "SESSION", status = WatchFixture.status(state)))).targets[0]
            assertEquals(state, word.jsonPrimitive.content, WatchProjection.stripGlyph(target)?.label)
        }
    }
}
