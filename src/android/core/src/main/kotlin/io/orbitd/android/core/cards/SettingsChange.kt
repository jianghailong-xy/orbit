package io.orbitd.android.core.cards

import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.translation.Translation
import java.time.Instant
import kotlinx.serialization.json.*

/*
 * Settings from a conversation, on Android (docs/settings-from-conversation-design.md §8): the words of a SETTINGS_CHANGE card, of an
 * `orbit-settings:` link row and of a changed Settings row, and the rules with no view in them — where a setting is in Settings and
 * how a value reads there. iOS `SettingsFromConversation.swift`; web `lib/settingsChange.ts`, `SettingsChangeCard.tsx`,
 * `SettingsLinkCard.tsx`, `settings/SettingChangedLine.tsx`.
 */
object SettingsChangeCopy {
    fun heading(count: Int) = "⚙️ Confirm: change $count setting${if (count == 1) "" else "s"}?"
    const val newSessionsOnly = "Applies to new sessions only."
    fun agentSays(why: String) = "The agent says: $why"
    const val foot = "Only these change. You can change them back in Settings."
    const val save = "Save changes"
    const val chat = "💬 Chat about this"
    const val declinePlaceholder = "What should the agent know? It reads this."
    const val decline = "Decline"
    const val keep = "Keep it"
    fun changed(count: Int) = "✓ Changed $count setting${if (count == 1) "" else "s"}"
    const val undo = "Undo"
    const val undone = "Undone"
    const val declined = "Declined"
    const val stale = "This setting changed since it was proposed."
    const val openInSettings = "Open in Settings"
    const val turnedOn = "Turned on from"
    const val turnedOff = "Turned off from"
    const val setFrom = "Set from"
    const val aConversation = "a conversation"
    const val untitledConversation = "Untitled conversation"
}

/** One change on a card, as the request's payload holds it (`{changes: [{key, from, to, tier}]}`). */
data class SettingsChangeEntry(val key: String, val from: JsonElement, val to: JsonElement, val tier: Int)

/** One setting's mark from `GET /users/me` (design §5.3): the conversation it was changed from, when, and what it was. */
data class SettingChangedBy(val sessionId: String, val requestId: String, val at: String, val from: JsonElement?, val sessionTitle: String?)

/** A Settings row, found by its link name or by the preference key it writes. [page] is the Settings page's route id that holds the
 * row; null for a row on Settings' own list (Theme). [webPage] and [section] name it on the web, for `Settings › General › Translation`. */
data class SettingPlace(val key: String, val title: String, val page: String?, val webPage: String, val section: String?)

object SettingsFromConversation {
    private fun row(key: String, title: String, page: String?, webPage: String, section: String?) =
        key to SettingPlace(key, title, page, webPage, section)

    private val rows: Map<String, SettingPlace> = mapOf(
        row("theme", "Theme", null, "Appearance", null),
        row("translationEnabled", "Translate conversations", GENERAL_PAGE, "General", "Translation"),
        row("translationLanguage", "Your language", GENERAL_PAGE, "General", "Translation"),
        row("translationAgentLanguage", "Agents work in", GENERAL_PAGE, "General", "Translation"),
        row("translationBilingual", "Show both languages", GENERAL_PAGE, "General", "Translation"),
        row("notifySessionFinished", "When a session finishes", NOTIFICATIONS_PAGE, "Notifications", null),
        row("notifyAgentMessage", "When an agent asks for you", NOTIFICATIONS_PAGE, "Notifications", null),
        row("recaps", "Session recaps", GENERAL_PAGE, "General", "New sessions"),
        row("promptSuggestions", "Suggested replies", GENERAL_PAGE, "General", "New sessions"),
        row("promptOptimizer", "Prompt optimizer", GENERAL_PAGE, "General", "New sessions"),
        row("modelRouting", "Route by tier", GENERAL_PAGE, "General", "New sessions"),
        row("optimizeFor", "Optimize For", GENERAL_PAGE, "General", "New sessions"),
        row("defaultPermissionMode", "Default permission mode", GENERAL_PAGE, "General", "New sessions"),
        row("enableOrchestration", "Let sessions orchestrate", GENERAL_PAGE, "General", "Orchestration"),
        row("cardFreeTaskCreates", "Tasks a session files without asking", GENERAL_PAGE, "General", "Orchestration"),
    )

    /** The keys with no row of their own in Settings, by title. */
    private val rowless = mapOf(
        "defaultModel" to "Default model", "defaultModels" to "Default model per provider",
        "defaultEffort" to "Default effort", "subagentBlockedProviders" to "SubAgent providers",
        "relaxBlockedPins" to "Run pinned tasks elsewhere when their account can't run",
    )

    /** Settings' route ids for the pages that hold rows (`SettingsScreen`). */
    const val GENERAL_PAGE = "sessions"
    const val NOTIFICATIONS_PAGE = "notifications"

    private val permissionLabels = mapOf("default" to "Default", "acceptEdits" to "Accept Edits", "plan" to "Plan", "auto" to "Auto",
        "dontAsk" to "Don't Ask", "bypassPermissions" to "Bypass")
    private val optimizeLabels = mapOf("cost" to "Cost", "balance" to "Balance", "intelligence" to "Intelligence")
    private val themeLabels = mapOf("system" to "System", "light" to "Light", "dark" to "Dark")

    private val loneSettings = Regex("""^\[([^\]]*)]\(orbit-settings:([^)\s]+)\)$""")

    /** The row an `orbit-settings:` link or a key names, in either spelling the web takes. Null for a name with no row. */
    fun place(name: String): SettingPlace? = rows[if (name == "agentLanguage") "translationAgentLanguage" else name]

    /** The row a paragraph that is nothing but an `orbit-settings:` link names, else null. */
    fun loneLink(paragraph: String): SettingPlace? =
        loneSettings.matchEntire(paragraph.trim())?.groupValues?.get(2)?.let(::place)

    fun title(key: String): String = place(key)?.title ?: rowless[key] ?: key

    /** `Settings › General › Translation`. */
    fun pathLabel(place: SettingPlace): String = listOfNotNull("Settings", place.webPage, place.section).joinToString(" › ")
    fun pathLabel(forKey: String): String? = place(forKey)?.let(::pathLabel)

    /** The changes a SETTINGS_CHANGE request carries, in the order filed. Entries naming no known key are left out. */
    fun entries(payload: JsonElement?): List<SettingsChangeEntry> =
        ((payload as? JsonObject)?.get("changes") as? JsonArray).orEmpty().mapNotNull { change ->
            val c = change as? JsonObject ?: return@mapNotNull null
            val key = (c["key"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return@mapNotNull null
            if (place(key) == null && key !in rowless) return@mapNotNull null
            SettingsChangeEntry(key, c["from"] ?: JsonNull, c["to"] ?: JsonNull, (c["tier"] as? JsonPrimitive)?.intOrNull ?: 1)
        }

    /** Consecutive rows on the same Settings page share one path line; a key with no row of its own has none. */
    fun groups(entries: List<SettingsChangeEntry>): List<Pair<String?, List<SettingsChangeEntry>>> {
        val out = mutableListOf<Pair<String?, MutableList<SettingsChangeEntry>>>()
        for (entry in entries) {
            val path = pathLabel(entry.key)
            if (out.lastOrNull()?.first == path) out.last().second.add(entry) else out.add(path to mutableListOf(entry))
        }
        return out
    }

    private fun JsonElement.str(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

    /** A value as the Settings page shows it: `Chinese (Simplified)`, not `zh-Hans`; `On`, not `true`. */
    fun valueLabel(key: String, value: JsonElement): String {
        (value as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull?.let { return if (it) "On" else "Off" }
        when (key) {
            "translationLanguage", "translationAgentLanguage" -> value.str()?.let { raw -> Translation.LANGUAGES.firstOrNull { it.first == raw }?.let { return it.second } }
            "theme" -> value.str()?.let { themeLabels[it] }?.let { return it }
            "optimizeFor" -> value.str()?.let { optimizeLabels[it] }?.let { return it }
            "defaultPermissionMode" -> value.str()?.let { permissionLabels[it] }?.let { return it }
            "defaultEffort" -> return value.str()?.takeIf { it.isNotEmpty() } ?: "Engine default"
            "defaultModel" -> return value.str()?.takeIf { it.isNotEmpty() } ?: "None"
            "defaultModels" -> return (value as? JsonObject)?.takeIf { it.isNotEmpty() }
                ?.let { models -> models.keys.sorted().joinToString(", ") { "$it: ${models[it]?.str().orEmpty()}" } } ?: "None"
            "subagentBlockedProviders" -> return (value as? JsonArray)?.mapNotNull { it.str() }?.takeIf { it.isNotEmpty() }?.joinToString(", ") ?: "None"
        }
        if (value is JsonNull) return "Default"
        return (value as? JsonPrimitive)?.content ?: "Default"
    }

    // MARK: the changed Settings row

    /** `GET /users/me`'s `changedBy`: each mark this build can read, by preference key. A mark it cannot read costs the one line. */
    fun changedBy(user: JsonObject?): Map<String, SettingChangedBy> =
        (user?.get("changedBy") as? JsonObject).orEmpty().mapNotNull { (key, raw) ->
            val m = raw as? JsonObject ?: return@mapNotNull null
            key to SettingChangedBy(m["sessionId"]?.str().orEmpty(), m["requestId"]?.str().orEmpty(), m["at"]?.str().orEmpty(),
                m["from"], m["sessionTitle"]?.str())
        }.toMap()

    /** A switch was turned on or off; any other value was set. */
    fun changedLead(mark: SettingChangedBy): String {
        val was = (mark.from as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: return SettingsChangeCopy.setFrom
        return if (was) SettingsChangeCopy.turnedOff else SettingsChangeCopy.turnedOn
    }

    /** The conversation's name on the line: its title, `Untitled conversation`, or `a conversation` when the server no longer knows it. */
    fun changedConversation(mark: SettingChangedBy): String =
        mark.sessionTitle?.ifEmpty { SettingsChangeCopy.untitledConversation } ?: SettingsChangeCopy.aConversation

    /** `Turned on from <conversation> · 2m ago · ` — everything before the Undo button. */
    fun changedLine(mark: SettingChangedBy, now: Instant = Instant.now()): String {
        val when_ = if (OwnerRequests.parse(mark.at) != null) " · ${OwnerRequests.ago(mark.at, now)}" else ""
        return "${changedLead(mark)} ${changedConversation(mark)}$when_ · "
    }

    // MARK: Undo

    /** The PATCH body that puts back what the card replaced: each key this request still marks, with its `from` (§5.3). A setting the
     * owner changed since carries no mark of this request and is left alone. */
    fun undoBody(request: OwnerRequest, user: JsonObject?): JsonObject {
        val marks = changedBy(user)
        return buildJsonObject {
            entries(request.payload).forEach { entry ->
                val mark = marks[entry.key] ?: return@forEach
                if (OwnerRequests.key(mark.requestId) == OwnerRequests.key(request.id)) put(entry.key, entry.from)
            }
        }
    }

    /** Whether an apply was refused because a value moved since it was proposed (`409 SETTINGS_STALE`). */
    fun isStale(error: Throwable): Boolean =
        error is ApiError && error.status == 409 && (error.code == "SETTINGS_STALE" || error.messages.any { it.contains("SETTINGS_STALE") } ||
            error.body?.toString()?.contains("SETTINGS_STALE") == true)
}
