package io.orbitd.android.auth

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.orbitd.android.BuildConfig
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.SecureStorageException
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.InvalidServerAddress
import io.orbitd.android.core.net.NetworkException
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.core.net.me
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

enum class AuthMessage { INVALID_ADDRESS, INVALID_CREDENTIALS, NETWORK, STORAGE, SERVER }

class AuthViewModel(application: Application) : AndroidViewModel(application) {
    private val session = (application as OrbitApplication).session
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

    fun login(address: String, email: String, password: String) {
        val mine = ++attempt
        mutableMessage.value = null
        viewModelScope.launch {
            try {
                val server = ServerAddress.parse(address, allowLoopbackHttp = BuildConfig.DEBUG)
                session.login(server, email.trim(), password)
            } catch (_: CancellationException) { /* Superseded or cancelled. */ }
            catch (error: Exception) { if (mine == attempt) mutableMessage.value = messageFor(error) }
        }
    }

    fun logout() {
        ++attempt
        mutableMessage.value = null
        viewModelScope.launch {
            try { session.logout() } catch (error: Exception) { mutableMessage.value = messageFor(error) }
        }
    }

    private fun messageFor(error: Exception): AuthMessage = when {
        error is InvalidServerAddress -> AuthMessage.INVALID_ADDRESS
        error is SecureStorageException -> AuthMessage.STORAGE
        error is ApiError && error.status == 401 -> AuthMessage.INVALID_CREDENTIALS
        error is NetworkException -> AuthMessage.NETWORK
        else -> AuthMessage.SERVER
    }
}
