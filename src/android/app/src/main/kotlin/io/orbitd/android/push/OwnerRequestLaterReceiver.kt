package io.orbitd.android.push

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import io.orbitd.android.OrbitApplication
import io.orbitd.android.cards.OwnerRequestSnoozes
import io.orbitd.android.core.cards.OwnerRequests
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * An owner request notification's Later (web Remind me later, for an hour): the request is put off on this device — out of the waiting
 * count, its card folded — its notification goes, and an alarm brings the notification back when the hour is up. Nothing is sent to
 * the server and the request is not ended. The intent carries the push's own routing data, which holds no secret.
 */
class OwnerRequestLaterReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val data = PushNotifications.map(intent.getBundleExtra(DATA))
        val message = PushMessage.parse(data)?.takeIf { it.payload.isOwnerRequest } ?: return
        val id = message.payload.ownerRequestId ?: return
        val snoozes = OwnerRequestSnoozes.of(context)
        val app = context.applicationContext as OrbitApplication
        when (intent.action) {
            LATER -> {
                val until = System.currentTimeMillis() + OwnerRequests.laterDuration.toMillis()
                snoozes.snooze(id, until)
                app.push.notifications.cancel(message)
                context.getSystemService(AlarmManager::class.java)
                    .set(AlarmManager.RTC_WAKEUP, until, pending(context, REPOST, data, "${message.registrationKey}:${message.notificationKey}:repost"))
            }
            REPOST -> {
                // Shown again from the card, or put off again since: this alarm is not the one that counts.
                if (snoozes.until(id) > System.currentTimeMillis()) return
                val result = goAsync()
                app.processScope.launch(Dispatchers.IO) {
                    try { app.push.repost(data) } catch (_: CancellationException) { } catch (_: Exception) { } finally { result.finish() }
                }
            }
        }
    }

    companion object {
        const val LATER = "io.orbitd.android.push.OWNER_REQUEST_LATER"
        const val REPOST = "io.orbitd.android.push.OWNER_REQUEST_REPOST"
        private const val DATA = "orbit.push.data"

        fun pending(context: Context, action: String, data: Map<String, String>, identifier: String): PendingIntent =
            PendingIntent.getBroadcast(context, 0, Intent(action, null, context, OwnerRequestLaterReceiver::class.java)
                .setIdentifier(identifier).putExtra(DATA, PushNotifications.bundle(data)),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
}
