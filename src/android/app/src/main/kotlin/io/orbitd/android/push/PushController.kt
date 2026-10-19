package io.orbitd.android.push

import android.app.Activity
import android.app.Application
import android.os.Bundle
import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.realtime.RealtimeStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import java.io.File
import java.util.concurrent.atomic.AtomicLong
import io.orbitd.android.navigation.ObjectId

/** One process-owned coordinator. Business state always stays in the authenticated REST/SSE stores. */
class PushController(
    private val app: Application,
    private val session: AuthSession,
    private val realtime: RealtimeStore,
    private val scope: CoroutineScope,
    private val tokenSource: PushTokenSource = FirebaseTokenSource(app),
) : Application.ActivityLifecycleCallbacks {
    val notifications = PushNotifications(app)
    private val mutableNotice = MutableStateFlow<PushMessage?>(null)
    val notice = mutableNotice.asStateFlow()
    fun dismissNotice() { mutableNotice.value = null }
    val registration = PushRegistration(session, PushStorage(File(app.noBackupFilesDir, "push")), app.packageName, {
        notifications.clear(); dismissNotice()
    })
    val configured: Boolean get() = tokenSource.available
    private val work = Mutex()
    private val refresh = Channel<Unit>(Channel.CONFLATED)
    @Volatile private var foreground = false
    private var started = 0
    private val tokenRevision = AtomicLong()
    private val tokenWork = Mutex()

    fun start() {
        app.registerActivityLifecycleCallbacks(this)
        scope.launch {
            session.state.collect {
                safely { withContext(Dispatchers.IO) {
                    if (configured) registration.onAuthStateChanged()
                    else if (it != AuthState.Restoring) registration.beforeSignOut()
                } }
                if (it is AuthState.SignedIn) { fetchToken(); requestReconcile() }
            }
        }
        scope.launch {
            realtime.state.map { Triple(it.handle, it.invalidationRevision, it.session?.id) }.distinctUntilChanged().collect {
                if (mutableNotice.value?.payload?.sessionId?.let { id -> ObjectId.same(id, it.third) } == true) dismissNotice()
                if (foreground) {
                    safely { if (configured) registration.ensureRegistered() }
                    requestReconcile()
                }
            }
        }
        scope.launch(Dispatchers.IO) { for (ignored in refresh) safely { reconcile() } }
    }

    private fun fetchToken() {
        val revision = tokenRevision.get()
        tokenSource.requestToken { token ->
            scope.launch(Dispatchers.IO) { safely {
                tokenWork.withLock {
                    if (revision == tokenRevision.get()) {
                        if (registration.hasToken(token)) registration.ensureRegistered() else registration.updateToken(token)
                    }
                }
            } }
        }
        // Failed token acquisition is retried on the next foreground/sign-in; no blocking login dependency.
    }

    suspend fun tokenChanged(token: String): Boolean {
        if (!configured) return true
        val revision = tokenRevision.incrementAndGet()
        session.restore()
        tokenWork.withLock { if (revision == tokenRevision.get()) registration.updateToken(token) }
        return session.state.value !is AuthState.SignedIn || registration.activeBinding() != null
    }

    suspend fun beforeSignOut() = withContext(Dispatchers.IO) { tokenRevision.incrementAndGet(); registration.beforeSignOut() }

    /** false means authority could not be read yet; the bounded background worker may retry. */
    suspend fun receive(data: Map<String, String>): Boolean {
        if (!configured) return true
        session.restore()
        registration.onAuthStateChanged()
        return work.withLock {
            val message = PushMessage.parse(data) ?: return true
            if (!registration.accepts(message.registrationKey)) return true
            if (notifications.hasSeen(message)) return true
            refreshBusiness()
            if (message.type == PushType.SYNC) {
                // clearSessions/badge are hints, including zero/same-count changes. A delayed sync
                // must not erase a newer approval edge; re-read the owner state before removal.
                val complete = reconcileLocked()
                if (complete && registration.accepts(message.registrationKey)) notifications.remember(message)
                return complete
            }
            val handle = (session.state.value as? AuthState.SignedIn)?.handle ?: return true
            val result = PushAuthority(session, handle).check(message)
            if (!registration.accepts(message.registrationKey)) return true
            when (result) {
                PushCheck.ACTIVE -> {
                    if (foreground) {
                        if (message.payload.kind == "approval" && !ObjectId.same(message.payload.sessionId, realtime.state.value.session?.id)) {
                            mutableNotice.value = message
                        }
                        notifications.remember(message)
                    } else if (notifications.show(message, data)) notifications.remember(message)
                    // A logout/token update may clear notifications while the system notify call runs.
                    if (!registration.accepts(message.registrationKey)) {
                        notifications.cancel(message)
                        if (mutableNotice.value == message) dismissNotice()
                    }
                }
                PushCheck.STALE, PushCheck.MISSING, PushCheck.FORBIDDEN -> {
                    notifications.cancel(message); notifications.remember(message)
                }
                PushCheck.UNKNOWN -> return false // Offline cannot authorize a new actionable banner.
            }
            true
        }
    }

    suspend fun messagesDeleted(): Boolean {
        if (!configured) return true
        session.restore(); registration.onAuthStateChanged(); refreshBusiness()
        if (session.state.value is AuthState.SignedIn && registration.activeBinding() == null) return false
        return reconcile()
    }
    fun requestReconcile() { refresh.trySend(Unit) }
    suspend fun reconcile() = work.withLock { reconcileLocked() }

    private suspend fun reconcileLocked(): Boolean {
        val handle = (session.state.value as? AuthState.SignedIn)?.handle ?: return true
        val binding = registration.activeBinding() ?: return true
        val active = (notifications.active() + listOfNotNull(mutableNotice.value)).distinctBy { it.notificationKey }
        if (active.isEmpty()) return true
        val authority = PushAuthority(session, handle)
        val needsYou = try { authority.needsYou() } catch (cancel: CancellationException) { throw cancel }
            catch (_: Exception) { null }
        var complete = true
        for (message in active) {
            if (!registration.accepts(binding.registrationKey)) return true
            if (message.registrationKey != binding.registrationKey) { remove(message); continue }
            val noLongerNeeded = message.payload.isReminder && needsYou != null && message.payload.sessionId != null &&
                message.payload.sessionId !in needsYou
            val result = if (noLongerNeeded) PushCheck.STALE else authority.check(message)
            if (!registration.accepts(binding.registrationKey)) return true
            if (result == PushCheck.UNKNOWN) complete = false
            if (result in setOf(PushCheck.STALE, PushCheck.MISSING, PushCheck.FORBIDDEN)) remove(message)
        }
        return complete
    }

    private fun remove(message: PushMessage) {
        notifications.cancel(message)
        if (mutableNotice.value == message) dismissNotice()
    }

    private fun refreshBusiness() { realtime.refreshDirectory(); realtime.refreshSession() }
    private suspend fun safely(block: suspend () -> Unit) {
        try { block() } catch (_: CancellationException) { currentCoroutineContext().ensureActive() }
        catch (_: Exception) { /* Isolate push failures from foreground business and login. */ }
    }
    override fun onActivityStarted(activity: Activity) {
        started++; foreground = true
        fetchToken(); refreshBusiness(); requestReconcile()
    }
    override fun onActivityStopped(activity: Activity) { started--; foreground = started > 0 || activity.isChangingConfigurations }
    override fun onActivityResumed(activity: Activity) { requestReconcile() }
    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) = Unit
}
