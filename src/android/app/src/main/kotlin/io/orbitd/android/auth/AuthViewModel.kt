package io.orbitd.android.auth

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.orbitd.android.BuildConfig
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.GoogleCallback
import io.orbitd.android.core.auth.SecureStorageException
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.InvalidServerAddress
import io.orbitd.android.core.net.NetworkException
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.core.net.me
import io.orbitd.android.core.protocol.SignInMethods
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

enum class AuthMessage {
    INVALID_ADDRESS, INVALID_CREDENTIALS, NETWORK, STORAGE, SERVER, UNEXPECTED,
    GOOGLE_FAILED, GOOGLE_UNAVAILABLE, GOOGLE_INTERRUPTED, GOOGLE_STATE_MISMATCH,
    // Refusals the server names by code (docs/google-sign-in-design.md §4.1–4.3, §5.2, §5.5).
    ACCOUNT_DISABLED, SETUP_REQUIRED, GOOGLE_NOT_CONFIGURED, GOOGLE_RATE_LIMITED, GOOGLE_SIGN_IN_BUSY,
    GOOGLE_BAD_REQUEST, GOOGLE_FLOW_EXPIRED, GOOGLE_CANCELLED, GOOGLE_EXCHANGE_FAILED, GOOGLE_EMAIL_UNVERIFIED,
    GOOGLE_FLOW_MISMATCH, GOOGLE_EMAIL_AMBIGUOUS, GOOGLE_ACCOUNT_MISMATCH, GOOGLE_EMAIL_NOT_AUTHORITATIVE,
    GOOGLE_ACCOUNT_NOT_FOUND,
}

class AuthViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as OrbitApplication
    private val session = app.session
    private val google = app.googleSignIn
    val state = session.state
    private val mutableMessage = MutableStateFlow<AuthMessage?>(null)
    val message = mutableMessage.asStateFlow()
    private var attempt = 0

    init {
        viewModelScope.launch {
            try {
                session.restore()
                val signedIn = state.value as? AuthState.SignedIn
                // Verifies a restored login, including reactive rotation if the access token expired.
                if (signedIn != null) session.me(signedIn.handle)
            } catch (_: CancellationException) { /* A newer login owns the screen. */ }
            catch (error: Exception) { mutableMessage.value = messageFor(error) }
        }
    }

    fun login(address: String, email: String, password: String) = signIn(::messageFor) {
        val server = ServerAddress.parse(address, allowLoopbackHttp = BuildConfig.DEBUG)
        session.login(server, email.trim(), password)
    }

    fun logout() {
        val mine = ++attempt
        mutableMessage.value = null
        viewModelScope.launch {
            try {
                app.push.beforeSignOut()
                if (mine == attempt) session.logout()
            } catch (error: Exception) { if (mine == attempt) mutableMessage.value = messageFor(error) }
        }
    }

    /** What the instance at [address] offers; null — the password alone — when it cannot say. */
    suspend fun signInMethods(address: String): SignInMethods? {
        val server = try {
            ServerAddress.parse(address, allowLoopbackHttp = BuildConfig.DEBUG)
        } catch (_: InvalidServerAddress) { return null }
        return try { session.signInMethods(server) } catch (error: CancellationException) { throw error }
        catch (_: Exception) { null }
    }

    /** Opens the instance's Google sign-in with [open]; its answer comes back to [handleGoogleCallback]. */
    fun continueWithGoogle(address: String, open: (String) -> Boolean) {
        ++attempt
        mutableMessage.value = null
        val server = try {
            ServerAddress.parse(address, allowLoopbackHttp = BuildConfig.DEBUG)
        } catch (_: InvalidServerAddress) {
            mutableMessage.value = AuthMessage.INVALID_ADDRESS
            return
        }
        if (!open(google.begin(server))) {
            google.abandon()
            mutableMessage.value = AuthMessage.GOOGLE_UNAVAILABLE
        }
    }

    /** An address the app was opened with: a Google sign-in's answer finishes the sign-in this process started. */
    fun handleGoogleCallback(uri: String) {
        val failure = when (val callback = google.complete(uri)) {
            GoogleCallback.NotGoogle -> return
            is GoogleCallback.Ticket -> return signIn(::googleMessageFor) {
                session.loginWithGoogleTicket(callback.server, callback.ticket, callback.codeVerifier)
            }
            GoogleCallback.Interrupted -> AuthMessage.GOOGLE_INTERRUPTED
            GoogleCallback.StateMismatch -> AuthMessage.GOOGLE_STATE_MISMATCH
            is GoogleCallback.Refused -> refusalMessage(callback.code) ?: AuthMessage.GOOGLE_FAILED
        }
        ++attempt
        mutableMessage.value = failure
    }

    private fun signIn(describe: (Exception) -> AuthMessage, block: suspend () -> Unit) {
        val mine = ++attempt
        mutableMessage.value = null
        viewModelScope.launch {
            try {
                // A login switches accounts: the previous login's push binding goes first, and a newer attempt
                // that started while it went owns the screen.
                app.push.beforeSignOut()
                if (mine == attempt) block()
            }
            catch (_: CancellationException) { /* Superseded or cancelled. */ }
            catch (error: Exception) { if (mine == attempt) mutableMessage.value = describe(error) }
        }
    }
}

/**
 * Why signing in or restoring failed: a code the server names comes first, so no refusal reads as a wrong password; then, as
 * iOS LoginFailure.message says it (40a70be24), the server turning the form down, the server out of reach, the server broken,
 * or an answer that is no Orbit sign-in.
 */
internal fun messageFor(error: Exception): AuthMessage = when (error) {
    is InvalidServerAddress -> AuthMessage.INVALID_ADDRESS
    is SecureStorageException -> AuthMessage.STORAGE
    is ApiError -> refusalMessage(error.code) ?: when (error.status) {
        // 400 is the server refusing the form itself, such as an email it can't read as one.
        400, 401, 403, 422 -> AuthMessage.INVALID_CREDENTIALS
        in 500..599 -> AuthMessage.SERVER
        else -> AuthMessage.UNEXPECTED
    }
    is NetworkException -> AuthMessage.NETWORK
    else -> AuthMessage.UNEXPECTED
}

/** Why a Google ticket's exchange failed (§4.3). Never that the password is wrong: none was asked for. */
internal fun googleMessageFor(error: Exception): AuthMessage =
    if (error !is ApiError) messageFor(error)
    else refusalMessage(error.code) ?: when (error.status) {
        // The exchange's rate limit answers 429 without a code (§7.4).
        429 -> AuthMessage.GOOGLE_RATE_LIMITED
        in 500..599 -> AuthMessage.SERVER
        else -> AuthMessage.GOOGLE_FAILED
    }

/** A refusal's own sentence, by the code a URL or a response body names; null for any other text. */
internal fun refusalMessage(code: String?): AuthMessage? = when (code) {
    "ACCOUNT_DISABLED" -> AuthMessage.ACCOUNT_DISABLED
    "SETUP_REQUIRED" -> AuthMessage.SETUP_REQUIRED
    "GOOGLE_NOT_CONFIGURED" -> AuthMessage.GOOGLE_NOT_CONFIGURED
    "GOOGLE_RATE_LIMITED" -> AuthMessage.GOOGLE_RATE_LIMITED
    "GOOGLE_SIGN_IN_BUSY" -> AuthMessage.GOOGLE_SIGN_IN_BUSY
    "GOOGLE_BAD_REQUEST" -> AuthMessage.GOOGLE_BAD_REQUEST
    "GOOGLE_FLOW_EXPIRED" -> AuthMessage.GOOGLE_FLOW_EXPIRED
    "GOOGLE_CANCELLED" -> AuthMessage.GOOGLE_CANCELLED
    "GOOGLE_EXCHANGE_FAILED" -> AuthMessage.GOOGLE_EXCHANGE_FAILED
    "GOOGLE_EMAIL_UNVERIFIED" -> AuthMessage.GOOGLE_EMAIL_UNVERIFIED
    "GOOGLE_FLOW_MISMATCH" -> AuthMessage.GOOGLE_FLOW_MISMATCH
    "GOOGLE_EMAIL_AMBIGUOUS" -> AuthMessage.GOOGLE_EMAIL_AMBIGUOUS
    "GOOGLE_ACCOUNT_MISMATCH" -> AuthMessage.GOOGLE_ACCOUNT_MISMATCH
    "GOOGLE_EMAIL_NOT_AUTHORITATIVE" -> AuthMessage.GOOGLE_EMAIL_NOT_AUTHORITATIVE
    "GOOGLE_ACCOUNT_NOT_FOUND" -> AuthMessage.GOOGLE_ACCOUNT_NOT_FOUND
    else -> null
}
