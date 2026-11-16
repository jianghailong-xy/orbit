package io.orbitd.android

import android.app.Application
import android.util.Log
import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.GoogleSignIn
import io.orbitd.android.core.net.OkHttpTransport
import io.orbitd.android.storage.AndroidCredentialStore
import io.orbitd.android.storage.AndroidEmailStore
import io.orbitd.android.storage.AndroidInstanceStore
import io.orbitd.android.storage.AndroidSessionDataStore
import io.orbitd.android.core.realtime.RealtimeStore
import io.orbitd.android.realtime.RealtimeLifecycle
import io.orbitd.android.realtime.RealtimeLines
import io.orbitd.android.realtime.p06ProcessStart
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
import io.orbitd.android.directory.TrashingSessions
import io.orbitd.android.reader.LandingJobSnapshots
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.toast.OrbitToasts

/** One process-wide session owns all HTTP requests and token rotations, across activity recreation. */
open class OrbitApplication : Application() {
    val session: AuthSession by lazy { createSession() }
    /** The Google sign-in this process started, if any: its verifier is in memory only. */
    val googleSignIn = GoogleSignIn()
    internal val processScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    val realtime: RealtimeStore by lazy {
        RealtimeStore(session, processScope, Dispatchers.Default, RealtimeLines).also { realtimeLifecycle = RealtimeLifecycle(this, it) }
    }
    /** [realtime]'s Android side, installed with it: what the session page asks about a relaunch (D09 P06). */
    internal var realtimeLifecycle: RealtimeLifecycle? = null
        private set
    /** The sessions on their way to Trash from this device, kept out of every list until their move has settled (A05-9). */
    internal val trashing = TrashingSessions()
    /** Each landing job as the last integration read described it: a landing opened while the server cannot be read draws it as a
     *  card in its project's Landings window, frozen (A11-20 e, iOS `landingInFlightCache`). */
    internal val landingJobs = LandingJobSnapshots()
    val push: io.orbitd.android.push.PushController by lazy { createPush() }
    val updates: io.orbitd.android.update.AppUpdater by lazy { createUpdates() }
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
        p06ProcessStart()
        realtime // Register lifecycle/network callbacks before the first Activity starts.
        // D09 P03: each window's frames, while `log.tag.OrbitPerf` is D; otherwise one property read per Activity callback.
        registerActivityLifecycleCallbacks(io.orbitd.android.perf.WindowFrames)
        push.start()
        updates.start()
        clearAttachmentHandoffs(this)
        OrbitToasts.clear()
        var toastsFor: SessionHandle? = null
        processScope.launch { session.state.collect { state ->
            // Another account's outcomes never show under this one (A05-4).
            val signedIn = (state as? AuthState.SignedIn)?.handle
            if (state is AuthState.SignedOut || signedIn != null && signedIn !== toastsFor) { OrbitToasts.clear(); toastsFor = signedIn }
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
        AndroidSessionDataStore(this), BuildConfig.VERSION_NAME,
        emails = AndroidEmailStore(this), log = { Log.i("OrbitAuth", it) },
    )
    protected open fun createPush() = io.orbitd.android.push.PushController(this, session, realtime, processScope)
    protected open fun createUpdates() = io.orbitd.android.update.AppUpdater(this, processScope, io.orbitd.android.update.UpdateConfig.forBuild())
}
