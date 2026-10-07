package io.orbitd.android

import android.app.Application
import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.GoogleSignIn
import io.orbitd.android.core.net.OkHttpTransport
import io.orbitd.android.storage.AndroidCredentialStore
import io.orbitd.android.storage.AndroidInstanceStore
import io.orbitd.android.storage.AndroidSessionDataStore
import io.orbitd.android.core.realtime.RealtimeStore
import io.orbitd.android.realtime.RealtimeLifecycle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.composer.ComposerModel
import io.orbitd.android.composer.DraftTarget
import io.orbitd.android.attachments.clearAttachmentHandoffs
import io.orbitd.android.attachments.clearAttachmentImports
import io.orbitd.android.navigation.ObjectId

/** One process-wide session owns all HTTP requests and token rotations, across activity recreation. */
open class OrbitApplication : Application() {
    val session: AuthSession by lazy { createSession() }
    /** The Google sign-in this process started, if any: its verifier is in memory only. */
    val googleSignIn = GoogleSignIn()
    internal val processScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    val realtime: RealtimeStore by lazy { RealtimeStore(session, processScope).also { RealtimeLifecycle(this, it) } }
    private var composerHandle: SessionHandle? = null
    private val composers = mutableMapOf<String, ComposerModel>()
    fun composer(handle: SessionHandle, sessionId: String, target: DraftTarget? = null): ComposerModel {
        check((session.state.value as? AuthState.SignedIn)?.handle === handle)
        if (composerHandle !== handle) { composers.values.forEach { it.close() }; composers.clear(); composerHandle = handle }
        val key = ObjectId.canonical(sessionId) ?: sessionId
        return composers.getOrPut(key) { ComposerModel(session, handle, key, processScope, target) { realtime.refreshSession(); realtime.refreshDirectory() } }
    }
    override fun onCreate() {
        super.onCreate()
        realtime // Register lifecycle/network callbacks before the first Activity starts.
        clearAttachmentHandoffs(this)
        processScope.launch { session.state.collect { state ->
            if (state is AuthState.SignedOut || composerHandle != null && state is AuthState.SignedIn && state.handle !== composerHandle) {
                clearAttachmentImports(this@OrbitApplication)
            }
            if ((state as? AuthState.SignedIn)?.handle !== composerHandle) {
                composers.values.forEach { it.close() }; composers.clear(); composerHandle = null
                clearAttachmentHandoffs(this@OrbitApplication)
            }
        } }
    }
    protected open fun createSession() = AuthSession(
        OkHttpTransport(), AndroidCredentialStore(this), AndroidInstanceStore(this),
        AndroidSessionDataStore(this), BuildConfig.VERSION_NAME, allowLoopbackHttp = BuildConfig.DEBUG,
    )
}
