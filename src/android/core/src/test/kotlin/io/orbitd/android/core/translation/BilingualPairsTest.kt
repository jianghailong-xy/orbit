package io.orbitd.android.core.translation

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * "Show both languages", interleaved (docs/mocks/session-translation/03-interleaved.png): how a reply and its translation pair block by
 * block on Android against the web and iOS. src/shared/src/bilingual-pairs.fixture.json is the contract — @orbit/shared walks it through
 * `bilingualPairs` (translation.spec.ts), OrbitKit through `BilingualPairs.pairs`, and this through [Translation.bilingualPairs].
 */
class BilingualPairsTest {
    private val cases = Wire.json.parseToJsonElement(
        generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .map { File(it, "src/shared/src/bilingual-pairs.fixture.json") }.first { it.isFile }.readText(),
    ).jsonObject["cases"]!!.jsonArray.map { it.jsonObject }

    private fun JsonObject.text(key: String): String? = (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull

    @Test fun everySharedCasePairsAsTheWebPairsIt() {
        val names = cases.map { it.text("name")!! }
        listOf("paragraphs", "headings", "nested lists", "code blocks", "merged two paragraphs").forEach { kind ->
            assertTrue("the fixture lost its $kind case", names.any { it.contains(kind) })
        }
        cases.forEach { c ->
            val expected = c["pairs"].let { pairs ->
                if (pairs == null || pairs is JsonNull) null else pairs.jsonArray.map { it.jsonObject }.map { p ->
                    Translation.BilingualPair(
                        Translation.BlockKind.valueOf(p.text("kind")!!.uppercase()),
                        p["depth"]!!.jsonPrimitive.intOrNull!!,
                        p.text("marker"),
                        p.text("text")!!,
                        p.text("original"),
                    )
                }
            }
            assertEquals(c.text("name"), expected, Translation.bilingualPairs(c.text("translation")!!, c.text("original")!!))
        }
    }

    @Test fun anOrderedItemKeepsItsNumber() {
        assertEquals(3, Translation.BilingualPair(Translation.BlockKind.ITEM, 0, "3.", "x", "y").number)
        assertEquals(12, Translation.BilingualPair(Translation.BlockKind.ITEM, 0, "12)", "x", "y").number)
        assertNull(Translation.BilingualPair(Translation.BlockKind.ITEM, 0, "-", "x", "y").number)
    }
}
