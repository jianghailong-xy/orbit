package io.orbitd.android.core.cards

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The SubAgent end block's reader is OrbitKit's (`SubagentFinished.swift`): the patterns it reads the block with are the ones OrbitKit pins.
 * The block is drawn as nothing of its own now — the run's card is its end (docs/mocks/subagent-card-and-end-line) — and the card's words
 * are held to the web's by the app's `SubagentCardEndCopyParityTest`.
 */
class SubagentFinishedCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit/App/SubagentFinished.swift").isFile }
    private val swift = File(root, "src/macos/OrbitKit/Sources/OrbitKit/App/SubagentFinished.swift").readText()

    private fun swiftHas(literal: String) = assertTrue("SubagentFinished.swift no longer contains $literal", swift.contains(literal))
    /** A Kotlin string as a Swift literal's source: each backslash written twice. */
    private fun swiftLiteral(value: String) = "\"" + value.replace("\\", "\\\\") + "\""

    @Test fun theReadersPatternsAreTheOnesOrbitKitPins() {
        swiftHas("static let headPattern = ${swiftLiteral(SubagentFinished.headPattern)}")
        swiftHas("static let sentencePattern = ${swiftLiteral(SubagentFinished.sentencePattern)}")
        // The web's block pattern escapes the closing tag's slash, which a Kotlin Regex does not need.
        assertTrue(swift.replace("<\\\\/orbit", "</orbit").contains("static let blockPattern = ${swiftLiteral(SubagentFinished.blockPattern)}"))
    }
}
