package io.orbitd.android.core.cards

import java.io.File
import org.junit.Assert.*
import org.junit.Test

class ConversationCardWidthTest {
    @Test fun theWidthIsTheApproved720() = assertEquals(720, ConversationCardWidth.DP)

    /** No conversation card spells the width as a literal: each reads the one constant through `conversationCard()`. */
    @Test fun noConversationCardKeepsItsOwn720() {
        val app = listOf("src/main/kotlin/io/orbitd/android/cards", "src/main/kotlin/io/orbitd/android/reader", "src/main/kotlin/io/orbitd/android/composer")
            .map { File("../app/$it") }.filter { it.isDirectory }
        assertTrue("app sources not found from ${File(".").absolutePath}", app.isNotEmpty())
        val literal = Regex("""widthIn\(max = 720\.dp\)""")
        val offenders = app.flatMap { it.walkTopDown().filter { f -> f.extension == "kt" }.toList() }
            .filter { literal.containsMatchIn(it.readText()) }.map { it.name }
        assertEquals(emptyList<String>(), offenders)
    }
}
