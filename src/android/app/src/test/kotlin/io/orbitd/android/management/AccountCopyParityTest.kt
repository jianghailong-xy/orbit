package io.orbitd.android.management

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Every word the engine page's accounts and Antigravity's Google sign-in share with iOS is the Swift source's, byte for byte
 * (as TaskCopyParityTest holds the Tasks pages): each AccountCopy String constant appears as a literal in those sources. */
class AccountCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }
    private val kit = "src/macos/OrbitKit/Sources/OrbitKit/App/"
    private val views = "src/macos/OrbitApp/Sources/OrbitApp/Views/"

    @Test fun accountWordsAreIosOwn() {
        val swift = listOf("${kit}RunnerPageCopy.swift", "${kit}RunnerPageFormat.swift", "${kit}EngineAuth.swift", "${views}RunnerEnginePage.swift",
            "${views}RunnerSignInView.swift", "${views}AccountPauseControls.swift").joinToString("\n") { File(root, it).readText() }
            .replace(Regex("\"\\s*\\+\\s*\""), "")
        val words = AccountCopy.javaClass.declaredFields.mapNotNull { field ->
            field.isAccessible = true
            (runCatching { field.get(AccountCopy) }.getOrNull() as? String)?.let { field.name to it }
        }.toMap()
        assertTrue("AccountCopy holds no words", words.size >= 10)
        val missing = words.filterValues { !swift.contains("\"$it\"") }
        assertTrue("AccountCopy strings not in the Swift sources: $missing", missing.isEmpty())
    }
}
