package io.orbitd.android.cards

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The owner's 11-12 decision (project 34vUNVEqe1OFz1uHNULOO): a cross-project move is answered on the ONE crossing decision card
 * (`CrossingCardView`, 474dbe301), never on a second move card. A search of the app's sources: no task-move card, store or copy object,
 * and the session's task-move doors are reached only from `ProjectApi`, called only by the crossing card's store. (Web's
 * `noSecondMoveCard.test.ts`.)
 */
class NoSecondMoveCardTest {
    private val main: File = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/android/settings.gradle.kts").isFile }.resolve("src/android/app/src/main/kotlin")
    private val sources = main.walkTopDown().filter { it.isFile && it.extension == "kt" }.associateWith { it.readText() }
    private fun where(pattern: Regex) = sources.filterValues { pattern.containsMatchIn(it) }.keys.map { it.relativeTo(main).path }.sorted()

    @Test fun thereIsNoSecondMoveCard() {
        assertTrue("the sources were found", sources.size > 100)
        assertEquals(emptyList<String>(), where(Regex("""\b(fun|class|object)\s+(TaskMoveCard|TaskMoveResolved|TaskMoveStore|TaskMoves|MoveCard)\b""")))
        assertEquals(emptyList<String>(), where(Regex(""""task-moves:""")))
    }

    @Test fun theSessionsMoveDoorsAreTheCrossingCardsOnly() {
        assertEquals(listOf("io/orbitd/android/projects/ProjectData.kt"), where(Regex(""""task-moves"""")))
        assertEquals(listOf("io/orbitd/android/cards/CrossingCardStore.kt"), where(Regex("""\.(decideMoveBatch|taskMoves)\(""")))
    }
}
