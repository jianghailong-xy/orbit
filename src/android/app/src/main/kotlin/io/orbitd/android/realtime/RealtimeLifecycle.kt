package io.orbitd.android.realtime

import android.app.Activity
import android.app.Application
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import io.orbitd.android.core.realtime.RealtimeStore

/** Install once from Application with the process-owned store. START/STOP supports multi-window;
 * configuration recreation keeps the same connections. A real background stop closes both SSEs.
 * No foreground service, keep-alive job, or assumption that Android will keep the process alive. */
class RealtimeLifecycle(private val application: Application, private val store: RealtimeStore) :
    Application.ActivityLifecycleCallbacks, AutoCloseable {
    private val handler = Handler(Looper.getMainLooper())
    private val connectivity = application.getSystemService(ConnectivityManager::class.java)
    private var started = 0
    private var currentNetwork: Network? = null
    private var closed = false
    private val stop = Runnable { if (started == 0 && !closed) store.setForeground(false) }
    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { currentNetwork = network }
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
            // Use the callback's capabilities, not a synchronous lookup racing a path change.
            // Public-network validation does not determine reachability of the user's server.
            // Let actual HTTP/SSE results and bounded retries decide; no extra probe service.
            if (network == currentNetwork && !closed) store.setNetwork(
                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET), network.toString())
        }
        override fun onLost(network: Network) {
            if (network == currentNetwork && !closed) {
                currentNetwork = null
                store.setNetwork(false)
            }
        }
    }

    init {
        application.registerActivityLifecycleCallbacks(this)
        connectivity.registerDefaultNetworkCallback(callback, handler)
    }

    override fun onActivityStarted(activity: Activity) {
        started++
        handler.removeCallbacks(stop)
        store.setForeground(true)
    }
    override fun onActivityStopped(activity: Activity) {
        started--
        if (started == 0) {
            if (activity.isChangingConfigurations) handler.postDelayed(stop, 700) else stop.run()
        }
    }
    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
    override fun onActivityResumed(activity: Activity) = Unit
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) = Unit
    override fun close() {
        if (closed) return
        closed = true
        handler.removeCallbacks(stop)
        application.unregisterActivityLifecycleCallbacks(this)
        connectivity.unregisterNetworkCallback(callback)
        store.setForeground(false)
        store.setNetwork(false)
    }
}
