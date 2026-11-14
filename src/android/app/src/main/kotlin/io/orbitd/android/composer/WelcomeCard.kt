package io.orbitd.android.composer

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.management.Ink
import io.orbitd.android.management.ManagementApi
import io.orbitd.android.management.RunnerCopy
import io.orbitd.android.management.RunnerPage
import io.orbitd.android.management.RunnerSignInCard
import io.orbitd.android.management.copyText
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.util.UUID

/*
 * A new account's welcome card (docs/mocks/new-user-onboarding, board 02, the owner's picks A/A/A/A): the web's WelcomeCard.tsx on
 * Android. Three steps — a computer, a model, a first message — on the managed runner's default workspace draft, on a bare machine's
 * setup card, and on the home of an account with no machine. Only while the account has never had a session; nothing is stored.
 */

/**
 * Whether this account has never had a session: `GET /sessions?view=open&limit=1` and `?view=completed&limit=1` both answer empty
 * lists. A read that fails, or answers anything else, is an account that is not new.
 */
internal suspend fun isNewAccount(api: ManagementApi): Boolean = try {
    coroutineScope {
        val reads = listOf("open", "completed").map { view ->
            async { api.get("sessions", listOf("view" to view, "limit" to "1")) }
        }
        reads.all { (it.await() as? JsonArray)?.isEmpty() == true }
    }
} catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { false }

/** [isNewAccount], asked while [enabled]; false until it answers. */
@Composable
internal fun rememberNewAccount(api: ManagementApi, enabled: Boolean): Boolean {
    var answer by remember(api) { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(api, enabled) { if (enabled && answer == null) answer = isNewAccount(api) }
    return enabled && answer == true
}

/** The account's name for the card's greeting (`GET /users/me`); null until read, or without one. */
@Composable
internal fun rememberAccountName(api: ManagementApi, enabled: Boolean): String? {
    var name by remember(api) { mutableStateOf<String?>(null) }
    LaunchedEffect(api, enabled) {
        if (!enabled || name != null) return@LaunchedEffect
        name = runCatching { (api.get("users/me") as? JsonObject)?.text("name") }.getOrNull()
    }
    return name
}

/** Whether the server offers managed runners (`GET /auth/capabilities`); null until it answers, false on any failure. */
@Composable
internal fun rememberManagedOffered(api: ManagementApi, enabled: Boolean = true): Boolean? {
    var offered by remember(api) { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(api, enabled) {
        if (!enabled || offered != null) return@LaunchedEffect
        offered = try { ManagedRunner.offered(api.get("auth/capabilities")) }
            catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { false }
    }
    return offered
}

/** The owner's managed runner and its Retry and Set up, as the welcome card reads them. */
@Stable
internal class ManagedRunnerReader(private val api: ManagementApi) {
    var shown by mutableStateOf<ManagedRunner.Shown?>(null)
        private set
    var busy by mutableStateOf(false)
        private set
    /** A refused Retry or Set up, in the server's words. */
    var refusal by mutableStateOf<String?>(null)
        private set

    suspend fun read() {
        val status = runCatching { ManagedRunner.status(api.get("managed-runner")) }.getOrNull()
        shown = ManagedRunner.display(status)?.let { ManagedRunner.Shown(status!!, it) }
    }

    suspend fun retry() = act("Couldn't retry the managed runner") { status ->
        api.post("managed-runner/retry", buildJsonObject { put("idempotencyKey", UUID.randomUUID().toString()); put("revision", status.revision) })
    }

    suspend fun ensure() = act("Couldn't set up the managed runner") {
        api.post("managed-runner/ensure", buildJsonObject { put("idempotencyKey", UUID.randomUUID().toString()) })
    }

    private suspend fun act(headline: String, call: suspend (ManagedRunner.Status) -> JsonElement) {
        val current = shown?.status ?: return
        busy = true; refusal = null
        try {
            val status = ManagedRunner.status(call(current))
            shown = ManagedRunner.display(status)?.let { ManagedRunner.Shown(status!!, it) }
        } catch (cancel: CancellationException) { throw cancel }
        catch (e: Exception) { refusal = listOfNotNull(headline, e.message?.takeIf { it.isNotBlank() }).joinToString(": "); read() }
        finally { busy = false }
    }
}

/** The managed runner, read once while [ask]: nothing at all without the capability. [FollowManagedRunner] keeps it current. */
@Composable
internal fun rememberManagedRunner(api: ManagementApi, ask: Boolean): ManagedRunnerReader {
    val reader = remember(api) { ManagedRunnerReader(api) }
    val offered = rememberManagedOffered(api, ask) == true
    LaunchedEffect(reader, ask && offered) { if (ask && offered) reader.read() }
    return reader
}

/** Reads the managed runner again every few seconds while it moves by itself and every half minute otherwise, while [follow]. */
@Composable
internal fun FollowManagedRunner(reader: ManagedRunnerReader, follow: Boolean) {
    LaunchedEffect(reader, follow) {
        while (follow) {
            delay(1_000L * if (reader.shown?.display?.moving == true) ManagedRunner.POLL_MOVING_SECONDS else ManagedRunner.POLL_SETTLED_SECONDS)
            reader.read()
        }
    }
}

/**
 * The sign-in's words on the welcome card, as the web's RunnerSignIn draws them (`WelcomeSignInCopyTest` finds each in
 * src/web/src/components/RunnerSignIn.tsx). Its main button is the shared card's own "Sign in to <engine>".
 */
internal object WelcomeSignInCopy {
    const val USE_API_KEY_INSTEAD = "Use an API key instead"
    const val KEY_HINT = "Signing in fixes this runner. A key is account-wide — switch to its model to use it."
}

private val CARD_SHAPE = RoundedCornerShape(18.dp)

/** The card's frame: the setup card's surface. */
@Composable
internal fun WelcomeSurface(tag: String, content: @Composable ColumnScope.() -> Unit) {
    Surface(
        modifier = Modifier.fillMaxWidth().testTag(tag),
        shape = CARD_SHAPE,
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 1.dp,
        shadowElevation = 2.dp,
        border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outlineVariant),
    ) { Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp), content = content) }
}

/** The card's head: who it greets and what Orbit is, in one sentence. */
@Composable
internal fun WelcomeHead(name: String?) {
    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(
            Modifier.size(32.dp).clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.primary.copy(alpha = 0.12f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(painterResource(R.drawable.ic_rocket), contentDescription = null, tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(18.dp))
        }
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(WelcomeCopy.welcomeTitle(name), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Text(WelcomeCopy.WELCOME_LEAD, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun StepTitle(text: String) = Text(text, fontWeight = FontWeight.SemiBold)

@Composable
private fun StepHelp(text: String) =
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)

/** A step that opens later: its one quiet line. */
@Composable
private fun Later(text: String) = Text(text, style = MaterialTheme.typography.bodySmall,
    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f), modifier = Modifier.padding(top = 6.dp))

@Composable
private fun LinkText(text: String, onClick: () -> Unit, modifier: Modifier = Modifier) = Text(
    text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary,
    modifier = modifier.padding(top = 6.dp).clickable(role = Role.Button, onClick = onClick),
)

/** The last step: three first messages to try. Picking one only fills the composer. */
@Composable
internal fun WelcomeExamples(step: Int, picked: String, onPick: (String) -> Unit) {
    SetupStepRow(number = step, done = false) {
        StepTitle(WelcomeCopy.WELCOME_FIRST)
        StepHelp(WelcomeCopy.WELCOME_FIRST_HELP)
        Column(Modifier.padding(top = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            WelcomeCopy.WELCOME_EXAMPLES.forEach { text ->
                val on = picked.trim() == text
                Surface(
                    onClick = { onPick(text) },
                    modifier = Modifier.fillMaxWidth().testTag("welcome-example").semantics { selected = on },
                    shape = RoundedCornerShape(10.dp),
                    color = if (on) MaterialTheme.colorScheme.primary.copy(alpha = 0.08f) else MaterialTheme.colorScheme.surface,
                    border = BorderStroke(1.dp, if (on) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant),
                ) { Text(text, Modifier.padding(horizontal = 12.dp, vertical = 10.dp), style = MaterialTheme.typography.bodyMedium) }
            }
        }
    }
}

/** A step drawn as one line once it is done. */
@Composable
private fun DoneLine(title: String, detail: String, onChange: (() -> Unit)? = null) {
    SetupStepRow(number = 0, done = true) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, fontWeight = FontWeight.SemiBold)
            Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
            if (onChange != null) Text(MachineSetupCopy.SETUP_CHANGE, style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.primary, modifier = Modifier.clickable(role = Role.Button, onClick = onChange))
        }
    }
}

/**
 * The managed runner's state in the shared display's words, with only the actions the server allows: Retry, Set up, and the way to the
 * runner's runtimes when what it lacks is one signed in (the web's ManagedRunnerNotice).
 */
@Composable
internal fun ManagedRunnerNotice(reader: ManagedRunnerReader, shown: ManagedRunner.Shown, onOpenRunner: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    val display = shown.display
    val attention = display.kind in ManagedRunner.ATTENTION
    val tint = if (attention) Ink.amber else MaterialTheme.colorScheme.primary
    Column(
        Modifier.padding(top = 8.dp).fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(tint.copy(alpha = 0.10f)).padding(10.dp)
            .testTag("managed-runner-notice"),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(Modifier.padding(top = 2.dp).size(16.dp), contentAlignment = Alignment.Center) {
                if (display.moving) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = tint)
                else Box(Modifier.size(8.dp).clip(RoundedCornerShape(4.dp)).background(tint))
            }
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(display.title, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodyMedium)
                Text(display.detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (display.retry || display.ensure || display.signIn) Row(horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically) {
            val runnerId = shown.status.runnerId
            if (display.signIn && runnerId != null) TextButton(onClick = { onOpenRunner(runnerId) }) { Text(ManagedRunner.SIGN_IN) }
            if (display.retry) OutlinedButton(enabled = !reader.busy, onClick = { scope.launch { reader.retry() } }) { Text(ManagedRunner.RETRY) }
            if (display.ensure) Button(enabled = !reader.busy, onClick = { scope.launch { reader.ensure() } }) { Text(ManagedRunner.ENSURE) }
        }
        reader.refusal?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Ink.red) }
    }
}

/**
 * A new account's first draft in its managed runner's default workspace: the runner Orbit starts for it, a model to run on, and a
 * first message (board 02, P1 and P2). It stands where the engine row stands for everybody else; the composer under it is the page's.
 */
@Composable
internal fun ManagedWelcomeCard(
    name: String?,
    reader: ManagedRunnerReader,
    shown: ManagedRunner.Shown,
    runner: JsonObject?,
    online: Boolean,
    engine: String,
    credential: SetupCredential,
    composerText: String,
    /** A first session can be sent now (`startsNewSession`): it starts, or waits for the runner. */
    startsNow: Boolean,
    managementApi: ManagementApi,
    onOpenRunner: (String) -> Unit,
    onOwnInstead: () -> Unit,
    onExample: (String) -> Unit,
    /** Use an API key instead: the draft's key when one can run there, else where a key is connected (the web's pickApiKey). */
    onUseKey: () -> Unit,
    onChangeCredential: () -> Unit,
    onSignedIn: () -> Unit,
) {
    val machine = runner?.let(RunnerPage::displayName).orEmpty()
    val up = shown.display.kind in ManagedRunner.UP || online
    val signedIn = credential.done
    val ready = startsNow && up && signedIn
    WelcomeSurface("welcome-card") {
        WelcomeHead(name)
        HorizontalDivider(Modifier.padding(top = 12.dp))

        if (up) DoneLine(WelcomeCopy.WELCOME_COMPUTER_DONE, WelcomeCopy.welcomeComputerReady(machine))
        else SetupStepRow(number = 1, done = false) {
            StepTitle(WelcomeCopy.WELCOME_COMPUTER)
            StepHelp(WelcomeCopy.WELCOME_COMPUTER_MANAGED)
            // The managed runner's own state, its Retry and Set up included: the same words as everywhere.
            ManagedRunnerNotice(reader, shown, onOpenRunner)
            LinkText(WelcomeCopy.WELCOME_OWN_INSTEAD, onOwnInstead)
        }
        HorizontalDivider()

        when (credential) {
            SetupCredential.SignedIn ->
                DoneLine(WelcomeCopy.WELCOME_MODEL_DONE, "${ProviderEngines.cliName(engine)} signed in on $machine")
            is SetupCredential.OnKey -> DoneLine(WelcomeCopy.WELCOME_MODEL_DONE,
                "${credential.label} · ${if (credential.pool) MachineSetupCopy.SETUP_ON_A_POOL else MachineSetupCopy.SETUP_ON_A_KEY}", onChangeCredential)
            else -> SetupStepRow(number = 2, done = false) {
                StepTitle(WelcomeCopy.WELCOME_MODEL)
                StepHelp(WelcomeCopy.WELCOME_MODEL_HELP)
                if (runner != null && online && engine in ProviderEngines.LOGIN_ENGINES) Box(Modifier.padding(top = 8.dp)) {
                    key(engine) {
                        RunnerSignInCard(api = managementApi, runner = runner, engine = engine, onUseApiKey = onUseKey,
                            onSignedIn = onSignedIn, apiKeyLabel = WelcomeSignInCopy.USE_API_KEY_INSTEAD,
                            apiKeyHint = WelcomeSignInCopy.KEY_HINT)
                    }
                } else Later(WelcomeCopy.WELCOME_AFTER_COMPUTER)
            }
        }
        HorizontalDivider()

        WelcomeExamples(step = 3, picked = composerText, onPick = onExample)
        HorizontalDivider()

        Text(
            when { ready -> WelcomeCopy.WELCOME_FOOT_READY; startsNow -> WelcomeCopy.WELCOME_FOOT_SEND_NOW; else -> WelcomeCopy.WELCOME_FOOT_WAIT },
            style = MaterialTheme.typography.bodySmall,
            color = if (ready) Ink.green else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 8.dp).testTag("welcome-foot"),
        )
    }
}

/**
 * The home of a new account with no machine at all (board 02, P3): step 1 is how to connect one — the install command — and steps 2
 * and 3 open after it. The page moves on by itself once a machine comes online: [onArrived] reads the directory again, and the
 * launch's landing takes the new machine's setup page.
 */
@Composable
internal fun NoMachineWelcomeCard(name: String?, api: ManagementApi, onTrouble: () -> Unit, onArrived: () -> Unit) {
    val context = LocalContext.current
    var platform by rememberSaveable { mutableStateOf("macOS") }
    var copied by remember { mutableStateOf(false) }
    val command = RunnerPage.installCommand(platform, RunnerPage.origin(api.handle.account.server))
    LaunchedEffect(copied) { if (copied) { delay(1_600); copied = false } }
    // No push says a runner came online, so the list is read until one does.
    LaunchedEffect(api) {
        while (true) {
            delay(5_000)
            val runners = runCatching { api.get("runners") as? JsonArray }.getOrNull().orEmpty()
            if (runners.any { (it as? JsonObject)?.get("online")?.jsonPrimitive?.booleanOrNull == true }) onArrived()
        }
    }
    WelcomeSurface("welcome-card") {
        WelcomeHead(name)
        HorizontalDivider(Modifier.padding(top = 12.dp))
        SetupStepRow(number = 1, done = false) {
            StepTitle(WelcomeCopy.WELCOME_COMPUTER)
            StepHelp(WelcomeCopy.WELCOME_COMPUTER_OWN)
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(top = 8.dp)) {
                listOf("macOS", "Linux", "Windows").forEachIndexed { index, choice ->
                    SegmentedButton(selected = platform == choice, onClick = { platform = choice },
                        shape = SegmentedButtonDefaults.itemShape(index, 3)) { Text(choice) }
                }
            }
            Column(Modifier.fillMaxWidth().padding(top = 8.dp).clip(RoundedCornerShape(12.dp)).background(Color(0xFF1C1C1E)).padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SelectionContainer { Text(buildAnnotatedString { withStyle(SpanStyle(color = Color.Gray)) { append("$ ") }; append(command) },
                    color = Color.White, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
                FilledTonalButton(onClick = { copyText(context, "Install command", command); copied = true }) {
                    Text(if (copied) "Copied" else RunnerCopy.COPY)
                }
            }
            Text(WelcomeCopy.WELCOME_WAITING_CONNECT, style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
            LinkText(WelcomeCopy.WELCOME_HAVING_TROUBLE, onTrouble)
        }
        HorizontalDivider()
        SetupStepRow(number = 2, done = false) {
            StepTitle(WelcomeCopy.WELCOME_MODEL)
            StepHelp(WelcomeCopy.WELCOME_MODEL_HELP)
            Later(WelcomeCopy.WELCOME_AFTER_STEP_ONE)
        }
        HorizontalDivider()
        SetupStepRow(number = 3, done = false) {
            StepTitle(WelcomeCopy.WELCOME_FIRST)
            Later(WelcomeCopy.WELCOME_AFTER_STEP_ONE)
        }
    }
}
