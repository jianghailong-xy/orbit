package io.orbitd.android.realtime

import android.annotation.SuppressLint
import android.app.Activity
import android.app.Application
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Bundle
import android.os.Process
import android.widget.TextView
import io.orbitd.android.BuildConfig
import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.net.OkHttpTransport
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.core.realtime.RealtimeState
import io.orbitd.android.core.realtime.RealtimeStore
import io.orbitd.android.storage.AndroidCredentialStore
import io.orbitd.android.storage.AndroidInstanceStore
import io.orbitd.android.storage.AndroidSessionDataStore
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import org.json.JSONArray
import org.json.JSONObject

/** Debug-only device probe. Separate credential/cache names never touch a user's normal login.
 * Exercises the production store, HTTP/SSE, Keystore/AtomicFile and real Activity/network callbacks.
 * It is not a replacement for A05's directory or A06's transcript UI. */
class RealtimeFixtureActivity : Activity() {
    private lateinit var label: TextView
    private var observer: Job? = null
    private val instance = ++instances

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        label = TextView(this).apply { textSize = 18f; setPadding(24, 64, 24, 24) }
        setContentView(label)
        Runtime.start(application)
        observer = Runtime.scope.launch { Runtime.store.state.collect { render(it) } }
        if (savedInstanceState == null) handle(intent)
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); handle(intent) }

    override fun onStart() { super.onStart(); lifecycleMarker("started") }
    override fun onStop() { super.onStop(); lifecycleMarker("stopped") }

    private fun lifecycleMarker(stage: String) {
        File(filesDir, "a04-realtime").apply { mkdirs() }
            .resolve("lifecycle.json").writeText(JSONObject().apply {
                put("pid", Process.myPid()); put("stage", stage); put("activityInstance", instance)
            }.toString())
    }

    private fun handle(intent: Intent) {
        Runtime.scope.launch {
            Runtime.auth.restore()
            if (intent.getBooleanExtra("finish_fixture", false)) {
                Runtime.auth.logout()
                return@launch
            }
            if (intent.getBooleanExtra("reset_fixture", false)) Runtime.auth.logout()
            if (Runtime.auth.state.value !is AuthState.SignedIn) {
                // adb reverse supplies this fixed loopback fixture; never a real deployment.
                Runtime.auth.login(ServerAddress.parse("http://127.0.0.1:18769", allowLoopbackHttp = true),
                    "realtime@example.test", "a04-fixture-password")
            }
            Runtime.store.selectSession("s1")
        }
    }

    @SuppressLint("SetTextI18n") // Fixed debug diagnostics, excluded from product UI and release.
    private fun render(state: RealtimeState) {
        val session = state.session
        val transcript = session?.transcript
        val connectivity = getSystemService(ConnectivityManager::class.java)
        val network = connectivity.activeNetwork
        val capabilities = network?.let(connectivity::getNetworkCapabilities)
        val result = JSONObject().apply {
            put("pid", Process.myPid()); put("activityInstance", instance)
            put("sourceSha", BuildConfig.SOURCE_SHA); put("sourceDirty", BuildConfig.SOURCE_DIRTY)
            put("defaultNetwork", network?.toString().orEmpty())
            put("networkTransport", when {
                capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true -> "WIFI"
                capabilities?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true -> "CELLULAR"
                else -> "NONE_OR_OTHER"
            })
            put("signedIn", state.handle != null); put("directoryCached", state.directory != null)
            put("directoryFresh", state.directoryFresh); put("sessionFresh", session?.fresh == true)
            put("control", state.controlConnection.name); put("sessionConnection", session?.connection?.name ?: "STOPPED")
            put("maxSeq", transcript?.maxSeq ?: 0); put("resumeSeq", transcript?.resumeSeq ?: 0)
            put("seqs", JSONArray(transcript?.events?.map { it.seq } ?: emptyList<Long>()))
            put("text", transcript?.events?.lastOrNull()?.fields?.get("text")?.jsonPrimitive?.contentOrNull ?: "")
            put("draft", transcript?.textDrafts?.get("").orEmpty())
            put("approvals", session?.snapshot?.approvals?.size ?: -1)
            put("queue", session?.snapshot?.queuedTurns?.size ?: -1)
            put("background", session?.snapshot?.background?.size ?: -1)
            put("error", session?.error?.reason?.name ?: state.directoryError?.reason?.name ?: "")
        }
        label.text = "A04 controlled recovery\n\n" +
            "PID ${Process.myPid()} · activity $instance\n" +
            "Control ${state.controlConnection} / session ${session?.connection}\n" +
            "Directory fresh ${state.directoryFresh} · cards fresh ${session?.fresh}\n" +
            "Durable ${transcript?.events?.size ?: 0} · seq ${transcript?.maxSeq ?: 0}\n" +
            "Approvals ${result.getInt("approvals")} · queued ${result.getInt("queue")}\n\n" + result.getString("text")
        val directory = File(filesDir, "a04-realtime").apply { mkdirs() }
        File(directory, "state.tmp").apply { writeText(result.toString()); renameTo(File(directory, "state.json")) }
    }

    override fun onDestroy() { observer?.cancel(); super.onDestroy() }

    companion object { private var instances = 0 }

    private object Runtime {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        lateinit var auth: AuthSession
        lateinit var store: RealtimeStore
        private lateinit var lifecycle: RealtimeLifecycle
        fun start(application: Application) {
            if (::auth.isInitialized) return
            auth = AuthSession(OkHttpTransport(), AndroidCredentialStore(application, "realtime-fixture"),
                AndroidInstanceStore(application, "realtime-fixture-instance"),
                AndroidSessionDataStore(application, "realtime-fixture-accounts"), BuildConfig.VERSION_NAME, allowLoopbackHttp = true)
            store = RealtimeStore(auth, scope)
            lifecycle = RealtimeLifecycle(application, store)
            scope.launch { auth.restore() }
        }
    }
}
