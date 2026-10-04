package io.orbitd.android

import android.app.Application
import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.net.OkHttpTransport
import io.orbitd.android.storage.AndroidCredentialStore
import io.orbitd.android.storage.AndroidInstanceStore
import io.orbitd.android.storage.AndroidSessionDataStore
import io.orbitd.android.core.realtime.RealtimeStore
import io.orbitd.android.realtime.RealtimeLifecycle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/** One process-wide session owns all HTTP requests and token rotations, across activity recreation. */
open class OrbitApplication : Application() {
    val session: AuthSession by lazy { createSession() }
    internal val processScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    val realtime: RealtimeStore by lazy { RealtimeStore(session, processScope).also { RealtimeLifecycle(this, it) } }
    override fun onCreate() {
        super.onCreate()
        realtime // Register lifecycle/network callbacks before the first Activity starts.
    }
    protected open fun createSession() = AuthSession(
        OkHttpTransport(), AndroidCredentialStore(this), AndroidInstanceStore(this),
        AndroidSessionDataStore(this), BuildConfig.VERSION_NAME, allowLoopbackHttp = BuildConfig.DEBUG,
    )
}
