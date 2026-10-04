package io.orbitd.android.auth

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.SignOutReason

@Composable
fun AuthScreen(state: AuthState, message: AuthMessage?, login: (String, String, String) -> Unit, logout: () -> Unit) {
    when (state) {
        AuthState.Restoring -> CircularProgressIndicator()
        is AuthState.SignedIn -> key(state.handle) {
            Text(stringResource(R.string.signed_in), style = MaterialTheme.typography.titleLarge)
            Text(state.user.name)
            Text(state.user.email)
            Text(state.handle.account.server)
            Button(onClick = logout) { Text(stringResource(R.string.sign_out)) }
            Button(onClick = logout) { Text(stringResource(R.string.switch_account_instance)) }
        }
        is AuthState.SigningIn -> {
            CircularProgressIndicator()
            Button(onClick = logout) { Text(stringResource(R.string.cancel_sign_in)) }
        }
        is AuthState.SignedOut -> {
            LoginForm(state.server?.value.orEmpty(), login)
            if (state.reason == SignOutReason.EXPIRED) Text(stringResource(R.string.session_expired))
            if (state.reason == SignOutReason.STORAGE) Text(stringResource(R.string.auth_storage_error))
        }
    }
    message?.let {
        Text(stringResource(when (it) {
            AuthMessage.INVALID_ADDRESS -> R.string.auth_address_error
            AuthMessage.INVALID_CREDENTIALS -> R.string.auth_credentials_error
            AuthMessage.NETWORK -> R.string.auth_network_error
            AuthMessage.STORAGE -> R.string.auth_storage_error
            AuthMessage.SERVER -> R.string.auth_server_error
        }), color = MaterialTheme.colorScheme.error)
    }
}

@Composable
private fun LoginForm(initialServer: String, login: (String, String, String) -> Unit) {
    // No password/email in saved-instance state, navigation arguments, disk preferences or logs.
    var server by remember(initialServer) { mutableStateOf(initialServer) }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    val focus = LocalFocusManager.current
    fun submit() {
        if (server.isBlank() || email.isBlank() || password.isEmpty()) return
        val secret = password
        password = ""
        focus.clearFocus()
        login(server, email, secret)
    }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(stringResource(R.string.sign_in), style = MaterialTheme.typography.titleLarge)
        OutlinedTextField(server, { server = it }, Modifier.fillMaxWidth(), singleLine = true,
            label = { Text(stringResource(R.string.instance_address)) },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
            keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Next) }))
        OutlinedTextField(email, { email = it }, Modifier.fillMaxWidth(), singleLine = true,
            label = { Text(stringResource(R.string.email)) },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
            keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Next) }))
        OutlinedTextField(password, { password = it }, Modifier.fillMaxWidth(), singleLine = true,
            label = { Text(stringResource(R.string.password)) }, visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { submit() }))
        Button(enabled = server.isNotBlank() && email.isNotBlank() && password.isNotEmpty(), onClick = ::submit) { Text(stringResource(R.string.sign_in)) }
    }
}
