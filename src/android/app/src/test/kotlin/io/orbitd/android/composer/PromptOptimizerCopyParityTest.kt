package io.orbitd.android.composer

import io.orbitd.android.core.promptoptimizer.PromptOptimizerCopy
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/** The prompt optimizer says what iOS says, byte for byte: every String constant of PromptOptimizerCopy appears as a literal in OrbitKit's
 * PromptOptimizer.swift, which Android follows. "Show original" is iOS's too, from TranslationCopy (Translation.swift). */
class PromptOptimizerCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }

    @Test fun everyWordIsIosOwn() {
        val swift = File(root, "src/macos/OrbitKit/Sources/OrbitKit/Models/PromptOptimizer.swift").readText() + "\n" +
            File(root, "src/macos/OrbitKit/Sources/OrbitKit").walk().filter { it.name.startsWith("Translation") && it.extension == "swift" }
                .joinToString("\n") { it.readText() }
        val words = PromptOptimizerCopy.javaClass.declaredFields.mapNotNull { field ->
            field.isAccessible = true
            (runCatching { field.get(PromptOptimizerCopy) }.getOrNull() as? String)?.let { field.name to it }
        }.toMap()
        assertEquals(18, words.size)
        assertEquals("PromptOptimizerCopy strings not in PromptOptimizer.swift", emptyMap<String, String>(),
            words.filterValues { !swift.contains("\"$it\"") })
    }
}
