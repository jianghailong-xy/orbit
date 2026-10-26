package io.orbitd.android.push

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.AtomicFile
import io.orbitd.android.MainActivity
import io.orbitd.android.R
import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.encodeToString
import java.io.File

/** System notifications carry only a navigation intent, never an approval mutation. */
class PushNotifications(private val context: Context) {
    private val manager = context.getSystemService(NotificationManager::class.java)
    private val history = AtomicFile(File(context.noBackupFilesDir, "push/seen-events.json"))
    private var seen = runCatching { Wire.json.decodeFromString<List<String>>(history.readFully().decodeToString()) }
        .getOrDefault(emptyList()).takeLast(128).toMutableList()

    /** The channel needs-you alerts post to. Android never raises an existing channel's importance,
     * so 482b132e8's DEFAULT `orbit.needs-you` is replaced by a new HIGH channel (pops up like the iOS
     * banner) unless its user changed that importance, which then stays theirs. */
    val needsYou: String = manager.getNotificationChannel(LEGACY_NEEDS_YOU).let { legacy ->
        if (legacy?.hasUserSetImportance() == true) LEGACY_NEEDS_YOU
        else { if (legacy != null) manager.deleteNotificationChannel(LEGACY_NEEDS_YOU); NEEDS_YOU }
    }

    init {
        listOfNotNull(Triple(NEEDS_YOU, "Needs your reply", NotificationManager.IMPORTANCE_HIGH).takeIf { needsYou == NEEDS_YOU },
            Triple(SESSIONS, "Sessions", NotificationManager.IMPORTANCE_DEFAULT),
            Triple(UPDATES, "Project and account updates", NotificationManager.IMPORTANCE_DEFAULT)).forEach { (id, title, importance) ->
            manager.createNotificationChannel(NotificationChannel(id, title, importance))
        }
    }

    fun permitted(): Boolean = Build.VERSION.SDK_INT < 33 ||
        context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun allowed(channel: String? = null): Boolean = manager.areNotificationsEnabled() && permitted() &&
        (channel == null || manager.getNotificationChannel(channel)?.importance?.let { it != NotificationManager.IMPORTANCE_NONE } == true)

    @Synchronized fun hasSeen(message: PushMessage) = "${message.registrationKey}:${message.eventId}" in seen
    @Synchronized fun remember(message: PushMessage) {
        val key = "${message.registrationKey}:${message.eventId}"
        seen.remove(key); seen.add(key)
        seen = seen.takeLast(128).toMutableList()
        val stream = history.startWrite()
        try { stream.write(Wire.json.encodeToString(seen).encodeToByteArray()); history.finishWrite(stream) }
        catch (error: Exception) { history.failWrite(stream); throw error }
    }

    /** [silent] keeps the entry in the tray without sound, vibration or heads-up: the platform has no
     * per-post switch, so (as NotificationCompat.setSilent does) it joins a group without a summary
     * and lets only the summary alert. */
    fun show(message: PushMessage, data: Map<String, String>, silent: Boolean = false): Boolean {
        val link = message.link
        val channel = channel(message)
        if (!allowed(channel)) return false
        val tag = tag(message)
        // A unique identifier prevents PendingIntent extras from one notification replacing another.
        // Without an object route (a headless agent message) the tap still opens Orbit, as on iOS.
        val intent = (link?.let { Intent(Intent.ACTION_VIEW, Uri.parse(it), context, MainActivity::class.java) }
            ?: Intent(Intent.ACTION_MAIN, null, context, MainActivity::class.java).addCategory(Intent.CATEGORY_LAUNCHER))
            .setIdentifier(tag).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pending = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val extras = Bundle().apply { putBundle(DATA, Bundle().apply { data.forEach { (key, value) -> putString(key, value) } }) }
        val notification = Notification.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification).setContentTitle(message.payload.title)
            .setContentText(message.payload.body).setStyle(Notification.BigTextStyle().bigText(message.payload.body))
            .setContentIntent(pending).setAutoCancel(true).setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setCategory(if (message.payload.isReminder) Notification.CATEGORY_REMINDER else Notification.CATEGORY_STATUS)
            .addExtras(extras)
            .apply { if (silent) setGroup(SILENT_GROUP).setGroupAlertBehavior(Notification.GROUP_ALERT_SUMMARY) }
            .build()
        return try { manager.notify(tag, 0, notification); true } catch (_: SecurityException) { false }
    }

    fun active(): List<PushMessage> = manager.activeNotifications.filter { it.tag?.startsWith(PREFIX) == true }.mapNotNull {
        val data = it.notification.extras.getBundle(DATA) ?: return@mapNotNull null
        PushMessage.parse(data.keySet().mapNotNull { key -> data.getString(key)?.let { value -> key to value } }.toMap())
    }
    fun cancel(message: PushMessage) { manager.cancel(tag(message), 0) }
    @Synchronized fun clear() {
        manager.activeNotifications.filter { it.tag?.startsWith(PREFIX) == true }.forEach { manager.cancel(it.tag, it.id) }
        seen.clear(); history.delete()
    }
    fun channel(message: PushMessage) = when {
        message.payload.isReminder || message.payload.kind == "confirmation-problems" -> needsYou
        message.payload.sessionId != null -> SESSIONS
        else -> UPDATES
    }
    private fun tag(message: PushMessage) = "$PREFIX${message.registrationKey}:${message.notificationKey}"
    companion object {
        const val NEEDS_YOU = "orbit.needs-you.alert"
        const val LEGACY_NEEDS_YOU = "orbit.needs-you"
        const val SILENT_GROUP = "orbit.silent"
        const val SESSIONS = "orbit.sessions"
        const val UPDATES = "orbit.updates"
        private const val PREFIX = "orbit:"
        private const val DATA = "orbit.push.data"
    }
}
