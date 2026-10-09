package io.orbitd.android.push

import android.content.Context
import android.os.Build
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.protocol.Wire
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.encodeToString
import java.util.concurrent.TimeUnit

/** Continues slow authority reads without relying on the FCM service/process remaining alive.
 * Stored input remains scoped to its binding and expires; it can never restore a logged-out account. */
class PushWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val push = (applicationContext as OrbitApplication).push
        if (!push.configured || expired(inputData.getLong(RECEIVED, 0), System.currentTimeMillis())) return Result.success()
        val completed = try {
            withTimeoutOrNull(15_000) {
                val raw = inputData.getString(MESSAGE)
                if (raw == null) push.messagesDeleted()
                else push.receive(Wire.json.decodeFromString<Map<String, String>>(raw))
            } ?: false
        } catch (_: CancellationException) { currentCoroutineContext().ensureActive(); true }
        catch (_: Exception) { false }
        return if (completed) Result.success() else Result.retry()
    }

    companion object {
        private const val MESSAGE = "message"
        private const val RECEIVED = "received"
        internal fun expired(received: Long, now: Long) = received <= 0 || now < received || now - received > 300_000
        fun enqueue(context: Context, data: Map<String, String>?, highPriority: Boolean) {
            val message = data?.let(PushMessage::parse)
            if (data != null && message == null) return
            val input = Data.Builder().putLong(RECEIVED, System.currentTimeMillis()).apply {
                if (data != null) putString(MESSAGE, Wire.json.encodeToString(data))
            }.build()
            val work = OneTimeWorkRequestBuilder<PushWorker>().setInputData(input)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.LINEAR, 10, TimeUnit.SECONDS)
            // API29–30 use ordinary scheduled work after the short immediate attempt. No persistent
            // foreground service or extra "checking" notification is needed on those platforms.
            if (Build.VERSION.SDK_INT >= 31 && highPriority) work.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            val key = message?.let { "${it.registrationKey}:${it.eventId}" } ?: "resync"
            WorkManager.getInstance(context).enqueueUniqueWork("orbit-push:$key", ExistingWorkPolicy.KEEP, work.build())
        }
    }
}
