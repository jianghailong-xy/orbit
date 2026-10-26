package io.orbitd.android.realtime

import android.app.Activity
import android.app.Application
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import io.orbitd.android.core.realtime.RealtimeStore
import io.orbitd.android.perf.OrbitPerf

/** Install once from Application with the process-owned store. START/STOP supports multi-window;
 * configuration recreation keeps the same connections. A real background stop closes both SSEs.
 * No foreground service, keep-alive job, or assumption that Android will keep the process alive.
 * It also writes D09 P06's recovery lines (P06Marks.kt), which are off unless OrbitPerf is on. */
class RealtimeLifecycle(private val application: Application, private val store: RealtimeStore) :
    Application.ActivityLifecycleCallbacks, AutoCloseable {
    private val handler = Handler(Looper.getMainLooper())
    private val connectivity = application.getSystemService(ConnectivityManager::class.java)
    private var started = 0
    private var currentNetwork: Network? = null
    private var closed = false
    // P06: whether a real stop sent the store to the background, the Activity in front, the default network's edges and the
    // rounds those start.
    private var backgrounded = false
    private var resumed: Activity? = null
    private var created = false
    private val p06Network = P06Network()
    private val rounds = P06Rounds(store.state) { resumed?.findViewById<View>(android.R.id.content) }
    /** The process's first Activity came back with saved state: the system relaunched it after reclaiming the process. */
    internal var relaunched = false
        private set
    /** That relaunch's restored page has written its `p06_restored`: one per relaunch. */
    internal var restoredReported = false
    private val stop = Runnable { if (started == 0 && !closed) { store.setForeground(false); backgrounded = true } }
    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { currentNetwork = network }
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
            // Use the callback's capabilities, not a synchronous lookup racing a path change.
            // Public-network validation does not determine reachability of the user's server.
            // Let actual HTTP/SSE results and bounded retries decide; no extra probe service.
            if (network == currentNetwork && !closed) {
                val internet = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                val round = p06Network.capabilities(network, internet,
                    capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED), P06Network.transport(capabilities))
                store.setNetwork(internet, network.toString())
                if (round) rounds.start(P06Rounds.NET)
            }
        }
        override fun onLost(network: Network) {
            if (network == currentNetwork && !closed) {
                p06Network.lost(network)
                currentNetwork = null
                store.setNetwork(false)
            }
        }
    }

    init {
        application.registerActivityLifecycleCallbacks(this)
        connectivity.registerDefaultNetworkCallback(callback, handler)
        rounds.start(P06Rounds.RELAUNCH)
    }

    override fun onActivityStarted(activity: Activity) {
        if (OrbitPerf.enabled) OrbitPerf.emit("p06_start_cb", "activity=${activity.javaClass.simpleName}")
        started++
        handler.removeCallbacks(stop)
        store.setForeground(true)
        if (backgrounded) { backgrounded = false; rounds.start(P06Rounds.FOREGROUND) }
    }
    override fun onActivityStopped(activity: Activity) {
        started--
        if (started == 0) {
            if (activity.isChangingConfigurations) handler.postDelayed(stop, 700) else stop.run()
        }
    }
    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
        if (!created) { created = true; relaunched = savedInstanceState != null }
    }
    override fun onActivityResumed(activity: Activity) {
        if (OrbitPerf.enabled) OrbitPerf.emit("p06_foreground", "activity=${activity.javaClass.simpleName}")
        resumed = activity
    }
    override fun onActivityPaused(activity: Activity) { if (resumed === activity) resumed = null }
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) { if (resumed === activity) resumed = null }
    override fun close() {
        if (closed) return
        closed = true
        handler.removeCallbacks(stop)
        rounds.close()
        application.unregisterActivityLifecycleCallbacks(this)
        connectivity.unregisterNetworkCallback(callback)
        store.setForeground(false)
        store.setNetwork(false)
    }
}
