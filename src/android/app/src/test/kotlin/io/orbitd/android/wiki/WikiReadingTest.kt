package io.orbitd.android.wiki

import io.orbitd.android.core.cards.objects
import io.orbitd.android.core.cards.obj
import io.orbitd.android.core.cards.text
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/** The shared Swift/web expected labels and order, executed through Android 10's ICU surface. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = android.app.Application::class)
class WikiReadingTest {
    private fun corpus(name: String): JsonObject {
        val file = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .map { File(it, "src/shared/src/$name.fixture.json") }.first { it.isFile }
        return Json.parseToJsonElement(file.readText()).jsonObject
    }

    @Test fun articleInitialsMatchAllSharedMultilingualCases() {
        corpus("wiki-articles").objects("initials").forEach { sample ->
            assertEquals(sample.text("title"), sample.text("says"), wikiIndexInitial(sample.text("title")!!))
        }
    }

    @Test fun documentIndexGroupsAndOrderMatchTheSharedFixture() {
        val index = corpus("wiki-docs").obj("docs")!!.obj("index")!!
        val actual = wikiIndexGroups(index.objects("items"))
        val expected = index.objects("groups")
        assertEquals(expected.map { it.text("letter") }, actual.map { it.first })
        expected.zip(actual).forEach { (want, got) ->
            assertEquals("group ${got.first}", want.objects("rows").map { it.text("title") }, got.second.map { it.text("title") })
        }
        assertEquals("#", actual.last().first)
    }
}
