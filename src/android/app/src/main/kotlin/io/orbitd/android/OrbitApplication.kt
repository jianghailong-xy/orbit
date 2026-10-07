package io.orbitd.android

import android.app.Application
import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.GoogleSignIn
import io.orbitd.android.core.net.OkHttpTransport
import io.orbitd.android.storage.AndroidCredentialStore
import io.orbitd.android.storage.AndroidInstanceStore
import io.orbitd.android.storage.AndroidSessionDataStore

/** One process-wide session owns all HTTP requests and token rotations, across activity recreation. */
open class OrbitApplication : Application() {
    val session: AuthSession by lazy { createSession() }
    /** The Google sign-in this process started, if any: its verifier is in memory only. */
    val googleSignIn = GoogleSignIn()
    protected open fun createSession() = AuthSession(
        OkHttpTransport(), AndroidCredentialStore(this), AndroidInstanceStore(this),
        AndroidSessionDataStore(this), BuildConfig.VERSION_NAME, allowLoopbackHttp = BuildConfig.DEBUG,
    )
}
