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

    init {
        listOf(NEEDS_YOU to "Needs your reply", SESSIONS to "Sessions", UPDATES to "Project and account updates").forEach { (id, title) ->
            manager.createNotificationChannel(NotificationChannel(id, title, NotificationManager.IMPORTANCE_DEFAULT))
        }
    }

    fun allowed(channel: String? = null): Boolean = manager.areNotificationsEnabled() &&
        (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
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

    fun show(message: PushMessage, data: Map<String, String>): Boolean {
        val link = message.link
        val channel = channel(message)
        if (!allowed(channel)) return false
        val tag = tag(message)
        // A unique identifier prevents PendingIntent extras from one notification replacing another.
        val pending = link?.let {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(it), context, MainActivity::class.java)
                .setIdentifier(tag).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }
        val extras = Bundle().apply { putBundle(DATA, Bundle().apply { data.forEach { (key, value) -> putString(key, value) } }) }
        val notification = Notification.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification).setContentTitle(message.payload.title)
            .setContentText(message.payload.body).setStyle(Notification.BigTextStyle().bigText(message.payload.body))
            .setContentIntent(pending).setAutoCancel(true).setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setCategory(if (message.payload.isReminder) Notification.CATEGORY_REMINDER else Notification.CATEGORY_STATUS)
            .addExtras(extras).build()
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
        message.payload.isReminder || message.payload.kind == "confirmation-problems" -> NEEDS_YOU
        message.payload.sessionId != null -> SESSIONS
        else -> UPDATES
    }
    private fun tag(message: PushMessage) = "$PREFIX${message.registrationKey}:${message.notificationKey}"
    companion object {
        const val NEEDS_YOU = "orbit.needs-you"
        const val SESSIONS = "orbit.sessions"
        const val UPDATES = "orbit.updates"
        private const val PREFIX = "orbit:"
        private const val DATA = "orbit.push.data"
    }
}
