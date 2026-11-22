package io.orbitd.android.cards

import io.orbitd.android.core.cards.SettingsChangeCopy
import io.orbitd.android.core.cards.SettingsFromConversation
import io.orbitd.android.core.translation.Translation
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Settings from a conversation says on Android what the web and OrbitKit say (docs/settings-from-conversation-design.md §8): every
 * Android string is looked up in the web source and in `SettingsFromConversation.swift` it came from. A missing counterpart is a
 * failure, never a skip (SettingsFromConversationCopyParityTests' rule). */
class SettingsChangeCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }
    private fun read(path: String) = File(root, path).also { assertTrue("$path is gone", it.isFile) }.readText().replace(Regex("\\s+"), " ")

    private val copyFile = "src/web/src/lib/settingsChange.ts"
    private val web = read(copyFile)
    private val cardFile = "src/web/src/components/SettingsChangeCard.tsx"
    private val card = read(cardFile)
    private val swiftFile = "src/macos/OrbitKit/Sources/OrbitKit/App/SettingsFromConversation.swift"
    private val swift = read(swiftFile)

    private fun assertSays(source: String, file: String, literal: String) = assertTrue("$file no longer says $literal", source.contains(literal))

    @Test fun theCardAndItsFoldedLinesSayWhatTheWebAndOrbitKitSay() {
        assertSays(web, copyFile, "heading: (count: number) => `⚙️ Confirm: change \${count} setting\${count === 1 ? '' : 's'}?`")
        assertSays(web, copyFile, "changed: (count: number) => `✓ Changed \${count} setting\${count === 1 ? '' : 's'}`")
        assertSays(web, copyFile, "agentSays: (why: string) => `The agent says: \${why}`")
        for ((key, native) in mapOf(
            "newSessionsOnly" to SettingsChangeCopy.newSessionsOnly, "foot" to SettingsChangeCopy.foot, "save" to SettingsChangeCopy.save,
            "chat" to SettingsChangeCopy.chat, "declinePlaceholder" to SettingsChangeCopy.declinePlaceholder,
            "decline" to SettingsChangeCopy.decline, "keep" to SettingsChangeCopy.keep, "undo" to SettingsChangeCopy.undo,
            "undone" to SettingsChangeCopy.undone, "declined" to SettingsChangeCopy.declined, "stale" to SettingsChangeCopy.stale,
            "openInSettings" to SettingsChangeCopy.openInSettings, "turnedOn" to SettingsChangeCopy.turnedOn,
            "turnedOff" to SettingsChangeCopy.turnedOff, "setFrom" to SettingsChangeCopy.setFrom, "aConversation" to SettingsChangeCopy.aConversation,
        )) {
            assertSays(web, copyFile, "$key: '$native'")
            assertSays(swift, swiftFile, "static let $key = \"$native\"")
        }
        assertSays(read("src/web/src/components/settings/SettingChangedLine.tsx"), "SettingChangedLine.tsx", "'${SettingsChangeCopy.untitledConversation}'")
        assertSays(swift, swiftFile, "static let untitledConversation = \"${SettingsChangeCopy.untitledConversation}\"")
        assertSays(swift, swiftFile, "\"⚙️ Confirm: change \\(count) setting\\(count == 1 ? \"\" : \"s\")?\"")
        assertEquals("⚙️ Confirm: change 2 settings?", SettingsChangeCopy.heading(2))
        assertEquals("✓ Changed 1 setting", SettingsChangeCopy.changed(1))
        assertEquals("The agent says: why", SettingsChangeCopy.agentSays("why"))
    }

    @Test fun theStaleFoldAndTheTwoButtonsAreTheWebCards() {
        assertSays(card, cardFile, "{COPY.stale}")
        assertSays(card, cardFile, "decline.mutate(COPY.stale)")
        assertSays(card, cardFile, "=== 'SETTINGS_STALE'")
        assertSays(card, cardFile, "{COPY.save}")
        assertSays(card, cardFile, "{COPY.chat}")
        val drawn = card.replace(Regex("/\\*.*?\\*/"), " ")
        assertFalse("the web card grew an Always allow; the Android card has none", drawn.contains("Always allow"))
    }

    @Test fun everyRowTitlePageSectionAndValueNameIsTheWebs() {
        val index = read("src/shared/src/settingsIndex.ts")
        val tiers = read("src/shared/src/settingsTiers.ts")
        val pages = read("src/web/src/pages/settings/settingsIndex.ts")
        for (key in listOf("theme", "translationEnabled", "translationLanguage", "translationAgentLanguage", "translationBilingual",
            "notifySessionFinished", "notifyAgentMessage", "recaps", "promptSuggestions", "promptOptimizer",
            // modelRouting and optimizeFor left out: the web moved them to Providers → Model routing, and this client
            // still draws them in General › New sessions until its Settings follows.
            "defaultPermissionMode", "enableOrchestration", "cardFreeTaskCreates")) {
            val place = SettingsFromConversation.place(key)!!
            assertSays(index, "settingsIndex.ts", "'${place.title}'")
            assertSays(pages, "pages/settingsIndex.ts", "label: '${place.webPage}'")
            place.section?.let { assertSays(web, copyFile, "${if (key == "translationAgentLanguage") "agentLanguage" else key}: '$it'") }
        }
        for (key in listOf("defaultModel", "defaultModels", "defaultEffort", "subagentBlockedProviders"))
            assertSays(tiers, "settingsTiers.ts", "'${SettingsFromConversation.title(key)}'")
        for (literal in listOf("system: 'System'", "light: 'Light'", "dark: 'Dark'", "cost: 'Cost'", "balance: 'Balance'", "intelligence: 'Intelligence'",
            "'Engine default'", "'None'", "'Default'", "'On'", "'Off'")) assertSays(web, copyFile, literal)
        val languages = read("src/shared/src/translation.ts")
        Translation.LANGUAGES.forEach { (_, name) -> assertSays(languages, "translation.ts", "'$name'") }
        val modes = read("src/web/src/lib/workspaceDefaults.ts")
        for (label in listOf("Default", "Accept Edits", "Plan", "Auto", "Don't Ask", "Bypass")) {
            val quoted = if (label.contains("'")) "\"$label\"" else "'$label'"
            assertSays(modes, "workspaceDefaults.ts", "label: $quoted")
        }
    }
}
