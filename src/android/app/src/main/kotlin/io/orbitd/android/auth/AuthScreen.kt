package io.orbitd.android.auth

import androidx.annotation.StringRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.orbitd.android.BuildConfig
import io.orbitd.android.R
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.SignOutReason
import io.orbitd.android.core.net.InvalidServerAddress
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.core.protocol.SignInMethods

/** The server the login page is on until another is remembered or chosen (iOS AppModel.defaultInstance, fdeb033ad). */
internal const val DEFAULT_INSTANCE = "orbitd.io"

/** iOS SignInButtonStyle's brand blue (the iOS AccentColor), fixed: disabled, the button fades instead of going grey. */
private val SignInBlue = Color(0xFF2E6BFF)

/** The Build information link under the form, and as much space above it, so the form itself sits in the middle. */
private val BuildLinkHeight = 48.dp

/** How the page writes a server: an HTTPS one as it is typed (orbitd.io), a loopback fixture's HTTP in full. */
internal fun displayAddress(server: ServerAddress?): String =
    server?.value?.removePrefix("https://")?.removeSuffix("/") ?: DEFAULT_INSTANCE

/** The login page's backdrop, behind the status bar too: a faint [accent] glow from the top edge (iOS LoginView). */
fun Modifier.loginBackground(accent: Color): Modifier = drawBehind {
    drawRect(Brush.radialGradient(listOf(accent.copy(alpha = 0.10f), Color.Transparent),
        center = Offset(size.width / 2, 0f), radius = 520.dp.toPx()))
}

@Composable
fun AuthScreen(
    state: AuthState,
    message: AuthMessage?,
    googleBusy: Boolean,
    login: (String, String, String) -> Unit,
    logout: () -> Unit,
    signInMethods: suspend (String) -> SignInMethods?,
    rememberedEmail: suspend (String) -> String?,
    continueWithGoogle: (String) -> Unit,
    showBuildInformation: () -> Unit,
) {
    when (state) {
        AuthState.Restoring -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        is AuthState.SignedIn -> key(state.handle) {
            Column {
                Text(stringResource(R.string.signed_in), style = MaterialTheme.typography.titleLarge)
                Text(state.user.name)
                Text(state.user.email)
                Text(state.handle.account.server)
                Button(onClick = logout) { Text(stringResource(R.string.sign_out)) }
                Button(onClick = logout) { Text(stringResource(R.string.switch_account_instance)) }
            }
        }
        // One call for both, so a failed sign-in finds the form as it left it.
        else -> LoginPage(
            sessionServer = (state as? AuthState.SigningIn)?.server ?: (state as AuthState.SignedOut).server,
            busy = state is AuthState.SigningIn,
            googleBusy = googleBusy,
            reason = (state as? AuthState.SignedOut)?.reason,
            message = message,
            login = login,
            cancel = logout,
            signInMethods = signInMethods,
            rememberedEmail = rememberedEmail,
            continueWithGoogle = continueWithGoogle,
            showBuildInformation = showBuildInformation,
        )
    }
}

/** The sentence each message reads as. */
@StringRes
internal fun AuthMessage.sentence(): Int = when (this) {
    AuthMessage.INVALID_ADDRESS -> R.string.auth_address_error
    AuthMessage.INVALID_CREDENTIALS -> R.string.auth_credentials_error
    AuthMessage.NETWORK -> R.string.auth_network_error
    AuthMessage.STORAGE -> R.string.auth_storage_error
    AuthMessage.SERVER -> R.string.auth_server_error
    AuthMessage.UNEXPECTED -> R.string.auth_unexpected_error
    AuthMessage.GOOGLE_FAILED -> R.string.auth_google_failed
    AuthMessage.GOOGLE_UNAVAILABLE -> R.string.auth_google_unavailable
    AuthMessage.GOOGLE_INTERRUPTED -> R.string.auth_google_interrupted
    AuthMessage.GOOGLE_STATE_MISMATCH -> R.string.auth_google_state_mismatch
    AuthMessage.ACCOUNT_DISABLED -> R.string.auth_account_disabled
    AuthMessage.SETUP_REQUIRED -> R.string.auth_setup_required
    AuthMessage.GOOGLE_NOT_CONFIGURED -> R.string.auth_google_not_configured
    AuthMessage.GOOGLE_RATE_LIMITED -> R.string.auth_google_rate_limited
    AuthMessage.GOOGLE_SIGN_IN_BUSY -> R.string.auth_google_sign_in_busy
    AuthMessage.GOOGLE_BAD_REQUEST -> R.string.auth_google_bad_request
    AuthMessage.GOOGLE_FLOW_EXPIRED -> R.string.auth_google_flow_expired
    AuthMessage.GOOGLE_CANCELLED -> R.string.auth_google_cancelled
    AuthMessage.GOOGLE_EXCHANGE_FAILED -> R.string.auth_google_exchange_failed
    AuthMessage.GOOGLE_EMAIL_UNVERIFIED -> R.string.auth_google_email_unverified
    AuthMessage.GOOGLE_FLOW_MISMATCH -> R.string.auth_google_flow_mismatch
    AuthMessage.GOOGLE_EMAIL_AMBIGUOUS -> R.string.auth_google_email_ambiguous
    AuthMessage.GOOGLE_ACCOUNT_MISMATCH -> R.string.auth_google_account_mismatch
    AuthMessage.GOOGLE_EMAIL_NOT_AUTHORITATIVE -> R.string.auth_google_email_not_authoritative
    AuthMessage.GOOGLE_ACCOUNT_NOT_FOUND -> R.string.auth_google_account_not_found
}

/**
 * The login page as iOS LoginView draws it (fdeb033ad): the app icon, "Welcome back", Email and Password with standing labels,
 * and one full-width Sign In. The server stays off the page: it is orbitd.io until a sign-in elsewhere is remembered, and three
 * taps on the logo (or its "Change server" action) open the Server dialog for self-hosters.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun LoginPage(
    sessionServer: ServerAddress?,
    busy: Boolean,
    googleBusy: Boolean,
    reason: SignOutReason?,
    message: AuthMessage?,
    login: (String, String, String) -> Unit,
    cancel: () -> Unit,
    signInMethods: suspend (String) -> SignInMethods?,
    rememberedEmail: suspend (String) -> String?,
    continueWithGoogle: (String) -> Unit,
    showBuildInformation: () -> Unit,
) {
    // The session's server — the remembered one, or the one a sign-in just tried — until the Server dialog picks another.
    var server by remember(sessionServer) { mutableStateOf(displayAddress(sessionServer)) }
    // No password in saved-instance state, navigation arguments, disk preferences or logs. The email a server's last
    // successful sign-in used is kept on disk, encrypted, for this page to prefill: a deliberate change to A03's "no email
    // on disk", decided by the coordinator for A03c to follow iOS fdeb033ad. Neither field goes into saved-instance state.
    var email by remember { mutableStateOf(TextFieldValue()) }
    var prefilled by remember { mutableStateOf<String?>(null) }
    var password by remember { mutableStateOf(TextFieldValue()) }
    var showsPassword by remember { mutableStateOf(false) }
    var focusedFields by remember { mutableStateOf(emptySet<String>()) }
    var serverDialog by remember { mutableStateOf(false) }
    val focus = LocalFocusManager.current
    val haptics = LocalHapticFeedback.current
    // While typing on a phone the keyboard takes half the screen: the brand folds into one row to keep the form above it.
    // iOS folds while a field has focus; here it takes the keyboard too, so focus from a hardware keyboard folds nothing.
    val compact = focusedFields.isNotEmpty() && WindowInsets.isImeVisible
    val canSubmit = !busy && !googleBusy && email.text.isNotBlank() && password.text.isNotEmpty()

    fun submit() {
        if (!canSubmit) return
        val secret = password.text
        password = TextFieldValue()
        // The email as it is sent, surrounding whitespace dropped (iOS LoginFailure.submittedEmail).
        val sent = email.text.trim()
        email = TextFieldValue(sent, TextRange(sent.length))
        focus.clearFocus()
        login(server, sent, secret)
    }
    fun focusOf(field: String) = { focused: Boolean ->
        focusedFields = if (focused) focusedFields + field else focusedFields - field
    }
    val openServer = {
        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
        serverDialog = true
    }
    // What the instance offers (docs/google-sign-in-design.md §6, §8.3): asked when the page appears and again when the
    // Server dialog changes the server. Until it answers, and when it cannot (an older server), the password alone.
    val methods by produceState<SignInMethods?>(null, server) {
        value = null
        value = signInMethods(server)
    }
    // Each server prefills its own remembered email; one typed by hand stays.
    LaunchedEffect(server) {
        val remembered = rememberedEmail(server)
        if (email.text.isEmpty() || email.text == prefilled) remembered.orEmpty().let { email = TextFieldValue(it, TextRange(it.length)) }
        prefilled = remembered
    }

    BoxWithConstraints(Modifier.fillMaxSize()) {
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).heightIn(min = maxHeight)
                .padding(horizontal = 24.dp, vertical = if (compact) 16.dp else 40.dp),
            verticalArrangement = if (compact) Arrangement.Top else Arrangement.SpaceBetween,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            if (!compact) Spacer(Modifier.height(BuildLinkHeight))
            Column(Modifier.widthIn(max = 360.dp).fillMaxWidth()) {
                LoginHeader(compact, openServer)
                Column(Modifier.padding(top = if (compact) 24.dp else 36.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    LoginField(
                        label = stringResource(R.string.email), value = email, onValueChange = { email = it },
                        placeholder = stringResource(R.string.email_placeholder), onFocusChange = focusOf("email"),
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false,
                            keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
                        keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) }),
                    )
                    LoginField(
                        label = stringResource(R.string.password), value = password, onValueChange = { password = it },
                        placeholder = stringResource(R.string.password_placeholder), onFocusChange = focusOf("password"),
                        keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Password, imeAction = ImeAction.Go),
                        keyboardActions = KeyboardActions(onGo = { submit() }),
                        visualTransformation = if (showsPassword) VisualTransformation.None else PasswordVisualTransformation(),
                    ) {
                        IconButton(onClick = { showsPassword = !showsPassword }, modifier = Modifier.size(32.dp)) {
                            Icon(painterResource(if (showsPassword) R.drawable.ic_eye_slash else R.drawable.ic_eye),
                                contentDescription = stringResource(if (showsPassword) R.string.hide_password else R.string.show_password),
                                modifier = Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    when (reason) {
                        SignOutReason.EXPIRED -> R.string.session_expired
                        SignOutReason.STORAGE -> R.string.auth_storage_error
                        else -> null
                    }?.let { Text(stringResource(it), style = ProseAside, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    message?.let {
                        Text(stringResource(it.sentence()), Modifier.fillMaxWidth(), style = ProseAside, color = MaterialTheme.colorScheme.error)
                    }
                    Button(
                        onClick = ::submit, enabled = canSubmit, shape = CircleShape,
                        modifier = Modifier.padding(top = 8.dp).fillMaxWidth().heightIn(min = 50.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = SignInBlue, contentColor = Color.White,
                            disabledContainerColor = SignInBlue.copy(alpha = 0.38f), disabledContentColor = Color.White),
                    ) {
                        Text(stringResource(if (busy && !googleBusy) R.string.signing_in else R.string.sign_in_button), style = MaterialTheme.typography.titleMedium)
                    }
                    if (busy) TextButton(onClick = cancel, modifier = Modifier.align(Alignment.CenterHorizontally)) {
                        Text(stringResource(R.string.cancel_sign_in))
                    }
                    if (methods?.google == true) {
                        GoogleSection(enabled = !busy && !googleBusy, busy = googleBusy, signup = methods?.googleSignup == true) { continueWithGoogle(server) }
                    }
                }
            }
            if (!compact) TextButton(onClick = showBuildInformation, modifier = Modifier.height(BuildLinkHeight)) {
                Text(stringResource(R.string.build_information))
            }
        }
    }
    if (serverDialog) ServerDialog(server, choose = { server = it }, dismiss = { serverDialog = false })
}

/** iOS `.orbitProseAside` (callout): the error line under the form. */
private val ProseAside = TextStyle(fontSize = 16.sp, lineHeight = 21.sp)

@Composable
private fun LoginHeader(compact: Boolean, openServer: () -> Unit) {
    val welcome = stringResource(R.string.welcome_back)
    val subtitle = stringResource(R.string.sign_in_subtitle)
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    if (compact) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        OrbitLogo(40.dp, rings = false, openServer)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(welcome, style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold))
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = secondary)
        }
    } else Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        OrbitLogo(76.dp, rings = true, openServer)
        Spacer(Modifier.height(20.dp))
        Text(welcome, style = MaterialTheme.typography.headlineLarge.copy(fontSize = 34.sp, lineHeight = 41.sp), textAlign = TextAlign.Center)
        Text(subtitle, Modifier.padding(top = 6.dp), style = MaterialTheme.typography.bodyLarge, color = secondary, textAlign = TextAlign.Center)
    }
}

/** The app icon, which hides the server: three taps on it, or its "Change server" action, open the Server dialog. */
@Composable
private fun OrbitLogo(size: Dp, rings: Boolean, openServer: () -> Unit) {
    val accent = MaterialTheme.colorScheme.primary
    val open by rememberUpdatedState(openServer)
    val label = stringResource(R.string.orbit_logo)
    val changeServer = stringResource(R.string.change_server)
    Image(
        painterResource(R.drawable.orbit_app_icon), contentDescription = null,
        modifier = Modifier
            .then(if (rings) Modifier.drawBehind {
                // Faint orbits around the mark.
                listOf(90.dp to 0.14f, 140.dp to 0.09f, 196.dp to 0.05f).forEach { (radius, alpha) ->
                    drawCircle(accent.copy(alpha = alpha), radius.toPx(), style = Stroke(1.dp.toPx()))
                }
            } else Modifier)
            .shadow(size / 8, RoundedCornerShape(percent = 22), ambientColor = accent, spotColor = accent)
            .size(size)
            .semantics {
                contentDescription = label
                customActions = listOf(CustomAccessibilityAction(changeServer) { open(); true })
            }
            .pointerInput(Unit) { detectTripleTap { open() } },
    )
}

/** Three taps, each within the double-tap timeout of the one before (iOS `onTapGesture(count: 3)`). */
private suspend fun PointerInputScope.detectTripleTap(onTripleTap: () -> Unit) {
    var taps = 0
    var lastUp = 0L
    awaitEachGesture {
        val down = awaitFirstDown()
        val up = waitForUpOrCancellation() ?: return@awaitEachGesture
        taps = if (taps > 0 && down.uptimeMillis - lastUp <= viewConfiguration.doubleTapTimeoutMillis) taps + 1 else 1
        lastUp = up.uptimeMillis
        if (taps == 3) {
            taps = 0
            onTripleTap()
        }
    }
}

/**
 * A rounded field with a standing label, so an empty field still says what goes in it (iOS LoginField). The label and the
 * placeholder are drawn in the field's own decoration, so they name the text field for TalkBack and for tests.
 */
@Composable
private fun LoginField(
    label: String,
    value: TextFieldValue,
    onValueChange: (TextFieldValue) -> Unit,
    placeholder: String,
    keyboardOptions: KeyboardOptions,
    keyboardActions: KeyboardActions,
    modifier: Modifier = Modifier,
    onFocusChange: (Boolean) -> Unit = {},
    visualTransformation: VisualTransformation = VisualTransformation.None,
    trailing: (@Composable () -> Unit)? = null,
) {
    var focused by remember { mutableStateOf(false) }
    val colors = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(14.dp)
    BasicTextField(
        value = value, onValueChange = onValueChange,
        modifier = modifier.fillMaxWidth().onFocusChanged {
            if (focused != it.isFocused) {
                focused = it.isFocused
                onFocusChange(it.isFocused)
            }
        },
        textStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.onSurface),
        cursorBrush = SolidColor(colors.primary),
        keyboardOptions = keyboardOptions, keyboardActions = keyboardActions,
        visualTransformation = visualTransformation, singleLine = true,
        decorationBox = { input ->
            Row(
                Modifier.background(if (focused) colors.background else colors.onSurfaceVariant.copy(alpha = 0.1f), shape)
                    .then(if (focused) Modifier.border(1.5.dp, colors.primary, shape) else Modifier)
                    .padding(horizontal = 16.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(label, style = MaterialTheme.typography.bodySmall, color = if (focused) colors.primary else colors.onSurfaceVariant)
                    Box {
                        if (value.text.isEmpty()) Text(placeholder, style = MaterialTheme.typography.bodyLarge, color = colors.onSurfaceVariant.copy(alpha = 0.6f))
                        input()
                    }
                }
                if (trailing != null) {
                    Spacer(Modifier.width(8.dp))
                    trailing()
                }
            }
        },
    )
}

/** Continue with Google under the form, for a server that offers it (§8.2), and the line that says Google opens new accounts. */
@Composable
private fun GoogleSection(enabled: Boolean, busy: Boolean, signup: Boolean, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        HorizontalDivider(Modifier.weight(1f), color = colors.outlineVariant)
        Text(stringResource(R.string.or), style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
        HorizontalDivider(Modifier.weight(1f), color = colors.outlineVariant)
    }
    // The colours Google's branding guidelines give its sign-in button on a light and on a dark page, shaped like Sign In.
    val dark = colors.background.luminance() < 0.5f
    val container = if (dark) Color(0xFF131314) else Color.White
    val content = if (dark) Color(0xFFE3E3E3) else Color(0xFF1F1F1F)
    OutlinedButton(
        onClick = onClick, enabled = enabled, shape = CircleShape,
        modifier = Modifier.fillMaxWidth().heightIn(min = 50.dp).alpha(if (enabled) 1f else 0.5f),
        colors = ButtonDefaults.outlinedButtonColors(containerColor = container, contentColor = content,
            disabledContainerColor = container, disabledContentColor = content),
        border = BorderStroke(1.dp, if (dark) Color(0xFF8E918F) else Color(0xFF747775)),
    ) {
        // While its sign-in is under way the mark gives way to a spinner, as on iOS.
        if (busy) CircularProgressIndicator(Modifier.size(18.dp), color = content, strokeWidth = 2.dp)
        else Image(painterResource(R.drawable.google_g), contentDescription = null, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(10.dp))
        Text(stringResource(R.string.continue_with_google), style = MaterialTheme.typography.titleMedium)
    }
    if (signup) Text(stringResource(R.string.google_signup_hint), Modifier.fillMaxWidth(),
        style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant, textAlign = TextAlign.Center)
}

/**
 * The server picker behind the logo (iOS ServerSheet), as an Android dialog: the address, what it is for, a way back to
 * orbitd.io, and Cancel / Save. Save keeps only an address the app would sign in to.
 */
@Composable
private fun ServerDialog(current: String, choose: (String) -> Unit, dismiss: () -> Unit) {
    var draft by remember { mutableStateOf(TextFieldValue(current, TextRange(current.length))) }
    var invalid by remember { mutableStateOf(false) }
    val field = remember { FocusRequester() }
    fun save() {
        try {
            ServerAddress.parse(draft.text, allowLoopbackHttp = BuildConfig.DEBUG)
        } catch (_: InvalidServerAddress) {
            invalid = true
            return
        }
        choose(draft.text.trim())
        dismiss()
    }
    AlertDialog(
        onDismissRequest = dismiss,
        title = { Text(stringResource(R.string.server_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                LoginField(
                    label = stringResource(R.string.server_address), value = draft, onValueChange = { draft = it },
                    placeholder = DEFAULT_INSTANCE, modifier = Modifier.focusRequester(field),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false,
                        keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { save() }),
                )
                Text(if (invalid) stringResource(R.string.server_invalid) else stringResource(R.string.server_hint, DEFAULT_INSTANCE),
                    style = MaterialTheme.typography.bodySmall,
                    color = if (invalid) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                TextButton(onClick = {
                    draft = TextFieldValue(DEFAULT_INSTANCE, TextRange(DEFAULT_INSTANCE.length))
                    invalid = false
                }) { Text(stringResource(R.string.server_reset, DEFAULT_INSTANCE)) }
                LaunchedEffect(Unit) { field.requestFocus() }
            }
        },
        confirmButton = { TextButton(onClick = ::save) { Text(stringResource(R.string.save)) } },
        dismissButton = { TextButton(onClick = dismiss) { Text(stringResource(R.string.cancel)) } },
    )
}
