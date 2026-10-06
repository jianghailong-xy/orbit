package io.orbitd.android.management

import io.orbitd.android.navigation.ObjectId
import kotlinx.serialization.json.*

/** The pool's server-projected role is independent of the instance's ADMIN role. */
class ProviderAccess(val pool: JsonObject) {
    val known = pool.text("viewerRole") in setOf("ADMIN", "MEMBER")
    val admin = known && pool.text("viewerRole") == "ADMIN"
    val owner = known && pool.list("people").any { it.flag("you") && it.flag("creator") }
    val canAddKey = known && (admin || pool.flag("membersCanAdd"))
    val canAddAccount = known && (admin || pool.flag("membersCanAddAccounts"))
    fun canSwitch(key: JsonObject) = known && (key["contributor"] as? JsonObject)?.flag("you") == true
    fun canManage(key: JsonObject) = known && (admin || canSwitch(key))
    fun ownsAccount(login: JsonObject): Boolean {
        val viewer = pool.list("people").firstOrNull { it.flag("you") }?.text("userId")
        return known && !viewer.isNullOrBlank() && login.text("userId").isNotBlank() &&
            ObjectId.same(viewer, login.text("userId"))
    }
    fun canRemoveAccount(login: JsonObject) = admin || ownsAccount(login)
    fun canRemovePerson(person: JsonObject) = admin && !person.flag("creator") && !person.flag("you")
    fun canChangeRole(person: JsonObject) = admin && pool.flag("shared") && !person.flag("creator")
}

internal fun providerObjects(element: JsonElement): List<JsonObject> =
    (element as? JsonArray)?.filterIsInstance<JsonObject>() ?: error("The server returned an unreadable list.")

internal fun providerKeyStatus(key: JsonObject): String {
    if (key.text("state") == "INVALID") return "Invalid — replace the rejected key"
    if (key.text("state") == "DISABLED" || !key.flag("enabled")) return "Disabled"
    if (key.text("state") != "ACTIVE") return "Status unknown"
    if (key.text("spentUntil").isNotBlank()) return "Out of budget · resets ${key.text("spentUntil")}"
    val cap = (key["shareCap"] as? JsonPrimitive)?.doubleOrNull
    val used = ((key["usage"] as? JsonObject)?.get("othersCostUsd") as? JsonPrimitive)?.doubleOrNull ?: 0.0
    if ((key["contributor"] as? JsonObject)?.flag("you") != true && cap != null && used >= cap) return "At monthly cap"
    return if (key.flag("running")) "Running now" else "Available"
}

/** Never interpret an absent usage window as zero use or available quota. */
internal fun providerUsage(value: JsonObject?): String {
    if (value == null) return "Usage not reported"
    fun row(window: JsonObject?, label: String): String? {
        if (window == null) return null
        val used = (window["utilization"] as? JsonPrimitive)?.doubleOrNull ?: return null
        if (!used.isFinite()) return null
        val percent = used.toString().removeSuffix(".0")
        return "${window.text("label").ifBlank { label }}: $percent% used" +
            window.text("resetsAt").takeIf { it.isNotBlank() }?.let { " · resets $it" }.orEmpty()
    }
    val named = listOf("primary" to "Primary window", "secondary" to "Secondary window", "fiveHour" to "5-hour window",
        "sevenDay" to "Weekly window", "sevenDayOpus" to "Weekly Opus", "sevenDaySonnet" to "Weekly Sonnet")
    val windows = named.mapNotNull { (field, label) -> row(value[field] as? JsonObject, label) } +
        value.list("rateLimits").flatMap { bucket ->
            listOf("primary", "secondary").mapNotNull { field ->
                row(bucket[field] as? JsonObject, "${bucket.text("limitName").ifBlank { bucket.text("limitId") }} $field")
            }
        }
    return windows.joinToString("\n").ifBlank { "Usage not reported" }
}

internal fun providerError(error: Throwable): String = when (error) {
    is io.orbitd.android.core.net.ApiError -> when (error.status) {
        401 -> "Your sign-in expired. Sign in again to continue."
        403 -> "You no longer have permission. Refresh to check access."
        404 -> "This resource no longer exists or is no longer shared with you."
        else -> "The server could not complete the request (HTTP ${error.status}). Refresh before trying again."
    }
    else -> "Could not load current data. Check your connection and retry."
}
