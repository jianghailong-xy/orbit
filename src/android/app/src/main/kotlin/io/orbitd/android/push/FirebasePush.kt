package io.orbitd.android.push

import android.content.Context
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailabilityLight
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import io.orbitd.android.BuildConfig
import io.orbitd.android.OrbitApplication
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

interface PushTokenSource {
    val available: Boolean
    fun requestToken(receive: (String) -> Unit)
}

internal class FirebaseTokenSource(private val context: Context) : PushTokenSource {
    private val messaging by lazy { firebaseMessaging(context) }
    override val available get() = messaging != null
    override fun requestToken(receive: (String) -> Unit) { messaging?.token?.addOnSuccessListener(receive) }
}

private fun firebaseMessaging(context: Context): FirebaseMessaging? {
    if (BuildConfig.FIREBASE_ANDROID_PACKAGE != context.packageName ||
        listOf(BuildConfig.FIREBASE_APP_ID, BuildConfig.FIREBASE_API_KEY, BuildConfig.FIREBASE_PROJECT_ID,
            BuildConfig.FIREBASE_SENDER_ID).any { it.isBlank() }) return null
    if (GoogleApiAvailabilityLight.getInstance().isGooglePlayServicesAvailable(context) != ConnectionResult.SUCCESS) return null
    return runCatching {
        if (FirebaseApp.getApps(context).none { it.name == FirebaseApp.DEFAULT_APP_NAME }) {
            FirebaseApp.initializeApp(context, FirebaseOptions.Builder()
                .setApplicationId(BuildConfig.FIREBASE_APP_ID).setApiKey(BuildConfig.FIREBASE_API_KEY)
                .setProjectId(BuildConfig.FIREBASE_PROJECT_ID).setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID).build())
        }
        FirebaseMessaging.getInstance().apply { isAutoInitEnabled = true }
    }.getOrNull()
}

/** FCM invokes these on its service thread. Slow HTTP continues as persisted, expiring work. */
class OrbitFirebaseMessagingService : FirebaseMessagingService() {
    private val push get() = (application as OrbitApplication).push
    override fun onMessageReceived(message: RemoteMessage) {
        if (!push.configured) return
        if (!process { push.receive(message.data) }) PushWorker.enqueue(this, message.data, message.priority == RemoteMessage.PRIORITY_HIGH)
    }
    override fun onNewToken(token: String) {
        if (!process { push.tokenChanged(token) }) PushWorker.enqueue(this, null, false)
    }
    override fun onDeletedMessages() {
        if (push.configured && !process { push.messagesDeleted() }) PushWorker.enqueue(this, null, false)
    }
    private fun process(block: suspend () -> Boolean): Boolean = runBlocking(Dispatchers.IO) {
        withTimeoutOrNull(2_000) {
            try { block() } catch (_: kotlinx.coroutines.CancellationException) { currentCoroutineContext().ensureActive(); true }
            catch (_: Exception) { false }
        } ?: false
    }
}
