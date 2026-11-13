package io.orbitd.android.composer

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.management.Ink
import io.orbitd.android.management.ManagementApi
import io.orbitd.android.management.RunnerCopy
import io.orbitd.android.management.RunnerPage
import io.orbitd.android.management.RunnerSignInCard
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonObject

/**
 * The setup card on a bare machine's new session page (docs/mocks/first-workspace-in-conversation, board 03 and rules of 04):
 * asks for the folder sessions may read and change and the coding CLI they run on.
 */
@Composable
internal fun MachineSetupCard(
    runner: JsonObject,
    online: Boolean,
    state: MachineSetupState,
    engine: String,
    credential: SetupCredential,
    ready: Boolean,
    otherEngines: List<String>,
    keyToUse: EnginePick?,
    managementApi: ManagementApi,
    probeDir: suspend (path: String, ask: Boolean) -> DirProbeRelay.Outcome,
    onPickFolder: (PickedFolder?) -> Unit,
    onUseEngine: (String) -> Unit,
    onUseKey: () -> Unit,
    onOpenMachine: () -> Unit,
    onSignedIn: () -> Unit,
    /** A new account's first machine (docs/mocks/new-user-onboarding): the card greets it, and offers first messages to try, which fill
     *  the page's composer. */
    welcome: MachineWelcome? = null,
) {
    val machine = RunnerPage.displayName(runner)
    val offline = !online
    val probes = MachineSetup.answersDirProbe(runner)
    val engineName = ProviderEngines.cliName(engine)

    val notice = when {
        // Never heard from is a machine still coming up, not one gone away, nor one too old to check folders.
        offline -> if (MachineSetup.isConnecting(runner)) MachineSetupCopy.setupConnecting(machine) else MachineSetupCopy.setupOffline(machine)
        !probes -> if (MachineSetup.updatesItself(runner)) MachineSetupCopy.setupUpdating(machine)
            else MachineSetupCopy.setupNeedsUpdate(machine)
        else -> null
    }

    Surface(
        modifier = Modifier.fillMaxWidth().testTag("machine-setup-card"),
        shape = RoundedCornerShape(18.dp),
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 1.dp,
        shadowElevation = 2.dp,
        border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp)) {
            if (welcome != null) WelcomeHead(welcome.name)
            else Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(
                    Modifier
                        .size(32.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.12f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        painterResource(R.drawable.ic_runner),
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(18.dp),
                    )
                }
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        MachineSetupCopy.setupTitle(machine),
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        MachineSetupCopy.SETUP_LEAD,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            if (notice != null) {
                Column(
                    Modifier
                        .padding(top = 10.dp)
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(10.dp))
                        .background(Ink.amber.copy(alpha = 0.12f))
                        .padding(10.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(notice, style = MaterialTheme.typography.bodySmall, color = Ink.amber)
                    if (!offline && !probes && !MachineSetup.updatesItself(runner)) {
                        Text(
                            MachineSetupCopy.SETUP_OPEN_MACHINE,
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.clickable(role = Role.Button, onClick = onOpenMachine),
                        )
                    }
                }
            }

            HorizontalDivider(Modifier.padding(top = 12.dp))

            SetupStepRow(number = 1, done = state.folder != null) {
                val folder = state.folder
                if (folder != null) {
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Row(
                            Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(MachineSetupCopy.SETUP_FOLDER, fontWeight = FontWeight.SemiBold)
                            Text(
                                folder.path,
                                style = MaterialTheme.typography.bodySmall,
                                fontFamily = FontFamily.Monospace,
                                maxLines = 1,
                                overflow = TextOverflow.MiddleEllipsis,
                                modifier = Modifier.weight(1f),
                            )
                            Text(
                                MachineSetupCopy.SETUP_CHANGE,
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.primary,
                                modifier = Modifier
                                    .alpha(if (offline) 0.38f else 1f)
                                    .clickable(enabled = !offline, role = Role.Button) { onPickFolder(null) },
                            )
                        }
                        Text(
                            when (folder) {
                                is PickedFolder.Existing -> folder.note
                                is PickedFolder.New -> MachineSetupCopy.SETUP_NEW_FOLDER_DONE
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                } else {
                    FolderOptionsSection(
                        runner = runner,
                        online = online,
                        disabled = offline || !probes,
                        probeDir = probeDir,
                        onPick = onPickFolder,
                    )
                }
            }

            HorizontalDivider()

            SetupStepRow(number = 2, done = credential.done) {
                when (credential) {
                    SetupCredential.SignedIn -> {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(engineName, fontWeight = FontWeight.SemiBold)
                            Text(
                                MachineSetupCopy.setupSignedIn(machine),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    is SetupCredential.OnKey -> {
                        Row(
                            Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(credential.label, fontWeight = FontWeight.SemiBold, maxLines = 1)
                            Text(
                                if (credential.pool) MachineSetupCopy.SETUP_ON_A_POOL else MachineSetupCopy.SETUP_ON_A_KEY,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.weight(1f),
                            )
                            Text(
                                MachineSetupCopy.SETUP_CHANGE,
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.primary,
                                modifier = Modifier
                                    .alpha(if (offline) 0.38f else 1f)
                                    .clickable(enabled = !offline, role = Role.Button) {
                                        onUseEngine(if (engine in ProviderEngines.LOGIN_ENGINES) engine else MachineSetup.firstEngineOn(runner))
                                    },
                            )
                        }
                    }
                    SetupCredential.SignIn -> {
                        SignInHeader(engineName, machine)
                        if (!offline && engine in ProviderEngines.LOGIN_ENGINES) {
                            Box(Modifier.padding(top = 8.dp)) {
                                key(engine) {
                                    // A new account's card draws the web's sign-in (Sign in to <engine>, Use an API key instead, and
                                    // its hint); everybody else's keeps the setup card's own.
                                    if (welcome != null) RunnerSignInCard(
                                        api = managementApi,
                                        runner = runner,
                                        engine = engine,
                                        onUseApiKey = if (keyToUse != null) onUseKey else welcome.onOpenKeys,
                                        onSignedIn = onSignedIn,
                                        apiKeyLabel = WelcomeSignInCopy.USE_API_KEY_INSTEAD,
                                        apiKeyHint = WelcomeSignInCopy.KEY_HINT,
                                    ) else RunnerSignInCard(
                                        api = managementApi,
                                        runner = runner,
                                        engine = engine,
                                        signInTitle = RunnerCopy.SIGN_IN,
                                        onUseApiKey = if (keyToUse != null) onUseKey else null,
                                        onSignedIn = onSignedIn,
                                    )
                                }
                            }
                        }
                        OtherEngineButtons(otherEngines, offline, onUseEngine)
                    }
                    SetupCredential.NotInstalled -> {
                        SignInHeader(engineName, machine)
                        Text(
                            MachineSetupCopy.setupNotInstalled(engineName, machine),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(top = 4.dp),
                        )
                        Text(
                            MachineSetupCopy.SETUP_OPEN_MACHINE,
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier
                                .padding(top = 4.dp)
                                .clickable(role = Role.Button, onClick = onOpenMachine),
                        )
                        OtherEngineButtons(otherEngines, offline, onUseEngine)
                    }
                }
            }

            HorizontalDivider()

            if (welcome != null) {
                WelcomeExamples(step = 3, picked = welcome.composerText, onPick = welcome.onExample)
                HorizontalDivider()
            }

            val folder = state.folder
            if (ready && folder != null) {
                Text(
                    MachineSetupCopy.setupReady(folder.workspaceName, folder.path),
                    style = MaterialTheme.typography.bodySmall,
                    color = Ink.green,
                    modifier = Modifier.padding(top = 8.dp),
                )
            } else {
                Text(
                    MachineSetupCopy.SETUP_FOOT,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
        }
    }
}

/** What a new account's first machine adds to the setup card. */
internal data class MachineWelcome(
    val name: String?,
    val composerText: String,
    val onExample: (String) -> Unit,
    /** Use an API key instead with no key that runs here: where one is connected (Machines & models). */
    val onOpenKeys: () -> Unit,
)

@Composable
internal fun SetupStepRow(number: Int, done: Boolean, content: @Composable ColumnScope.() -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 9.dp),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (done) {
            Box(
                Modifier.size(22.dp).clip(CircleShape).background(Ink.green),
                contentAlignment = Alignment.Center,
            ) {
                Text("✓", color = Color.White, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
            }
        } else {
            Box(
                Modifier
                    .size(22.dp)
                    .border(1.dp, MaterialTheme.colorScheme.outline, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    number.toString(),
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp), content = content)
    }
}

@Composable
private fun SignInHeader(engineName: String, machine: String) {
    Text(MachineSetupCopy.setupSignIn(engineName, machine), fontWeight = FontWeight.SemiBold)
    Text(
        MachineSetupCopy.SETUP_SIGN_IN_HELP,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun OtherEngineButtons(otherEngines: List<String>, offline: Boolean, onUseEngine: (String) -> Unit) {
    otherEngines.forEach { other ->
        Text(
            MachineSetupCopy.setupUseEngine(ProviderEngines.cliName(other)),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier
                .padding(top = 6.dp)
                .alpha(if (offline) 0.38f else 1f)
                .clickable(enabled = !offline, role = Role.Button) { onUseEngine(other) },
        )
    }
}

@Composable
private fun FolderOptionsSection(
    runner: JsonObject,
    online: Boolean,
    disabled: Boolean,
    probeDir: suspend (path: String, ask: Boolean) -> DirProbeRelay.Outcome,
    onPick: (PickedFolder) -> Unit,
) {
    val runnerId = runner.text("id").orEmpty()
    val machine = RunnerPage.displayName(runner)
    val offersNewFolder = MachineSetup.makesNewFolders(runner)
    var touched by remember(runnerId) { mutableStateOf<FolderChoice?>(null) }
    var newName by remember(runnerId) { mutableStateOf("") }
    var typed by remember(runnerId) { mutableStateOf("") }
    var registered by remember(runnerId) { mutableStateOf<DirProbeRelay.Outcome?>(null) }
    var newAnswer by remember(runnerId) { mutableStateOf<DirProbeRelay.Outcome?>(null) }
    var typedAnswer by remember(runnerId) { mutableStateOf<DirProbeRelay.Outcome?>(null) }
    // Check again, for each question. The register directory's is asked again by itself.
    var attempt by remember(runnerId) { mutableIntStateOf(0) }
    var newAttempt by remember(runnerId) { mutableIntStateOf(0) }
    var registerAttempt by remember(runnerId) { mutableIntStateOf(0) }

    val name = newName.trim()
    val path = typed.trim()
    val reposRoot = runner.text("reposRoot").orEmpty()

    val suggested = (registered as? DirProbeRelay.Outcome.Answered)?.probe?.takeIf(MachineSetup::isOfferedFolder)
    val choice = touched ?: MachineSetup.defaultFolderChoice(suggested, offersNewFolder)
    val checked = (typedAnswer as? DirProbeRelay.Outcome.Answered)?.probe
    val found = (newAnswer as? DirProbeRelay.Outcome.Answered)?.probe

    val candidate: PickedFolder? = when (choice) {
        FolderChoice.SUGGESTED -> suggested?.let {
            PickedFolder.Existing(it.path, MachineSetup.folderVerdict(it, machine).short)
        }
        FolderChoice.NEW -> if (offersNewFolder && MachineSetup.isValidNewFolder(name) && found != null) {
            MachineSetup.newFolderPick(found, name, reposRoot, machine)
        } else null
        FolderChoice.OTHER -> checked?.let {
            val verdict = MachineSetup.folderVerdict(it, machine)
            if (verdict.usable) PickedFolder.Existing(it.path, verdict.short) else null
        }
    }

    val registerDir = if (MachineSetup.answersDirProbe(runner)) MachineSetup.registerDirToProbe(runner.text("registerDir")) else null
    LaunchedEffect(runnerId, registerDir, online, registerAttempt) {
        registered = null
        if (registerDir == null) return@LaunchedEffect
        registered = try {
            probeDir(registerDir, online)
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (_: Exception) {
            null
        }
    }

    // Where a new folder's name would go, asked about as it is typed: a folder, or a file, may be there already.
    val newQuery = if (choice == FolderChoice.NEW && offersNewFolder && !disabled && MachineSetup.isValidNewFolder(name)) {
        MachineSetup.newFolderPath(reposRoot, name)
    } else null
    LaunchedEffect(runnerId, newQuery, newAttempt) {
        newAnswer = null
        if (newQuery == null) return@LaunchedEffect
        delay(300)
        newAnswer = try {
            probeDir(newQuery, true)
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (e: Exception) {
            DirProbeRelay.Outcome.Answered(DirProbe(path = newQuery, exists = false, isDir = false, isGit = false, isHome = false, error = e.message ?: "Request failed"))
        }
    }

    val otherQuery = if (choice == FolderChoice.OTHER && !disabled && path.isNotEmpty()) path else null
    LaunchedEffect(runnerId, otherQuery, attempt) {
        typedAnswer = null
        if (otherQuery == null) return@LaunchedEffect
        delay(300)
        typedAnswer = try {
            probeDir(otherQuery, true)
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (e: Exception) {
            DirProbeRelay.Outcome.Answered(DirProbe(path = otherQuery, exists = false, isDir = false, isGit = false, isHome = false, error = e.message ?: "Request failed"))
        }
    }

    // A path asked before the machine had answered about the register directory took that question's place (one question per
    // machine, contract §2): it is asked again once nothing else here waits, so the suggestion still comes.
    val waiting = (newQuery != null && newAnswer == null) || (otherQuery != null && typedAnswer == null)
    val askRegisteredAgain = DirProbeRelay.asksAgain(registered, online, waiting)
    LaunchedEffect(askRegisteredAgain) { if (askRegisteredAgain) registerAttempt++ }

    Text(MachineSetupCopy.SETUP_FOLDER, fontWeight = FontWeight.SemiBold)
    Text(
        MachineSetupCopy.setupFolderHelp(machine),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )

    Column(
        Modifier
            .padding(top = 8.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f))
            .alpha(if (disabled) 0.5f else 1f),
    ) {
        if (suggested != null) {
            val verdict = MachineSetup.folderVerdict(suggested, machine)
            FolderOptionRow(
                selected = choice == FolderChoice.SUGGESTED,
                enabled = !disabled,
                onClick = { touched = FolderChoice.SUGGESTED },
            ) {
                Text(
                    suggested.path,
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.MiddleEllipsis,
                )
                VerdictText(verdict.text, verdict.tone)
                Text(
                    MachineSetupCopy.SETUP_REGISTER_DIR,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (offersNewFolder) {
            if (suggested != null) HorizontalDivider(Modifier.padding(start = 36.dp))
            Column {
                FolderOptionRow(
                    selected = choice == FolderChoice.NEW,
                    enabled = !disabled,
                    onClick = { touched = FolderChoice.NEW },
                ) {
                    Text(MachineSetupCopy.SETUP_NEW_FOLDER, style = MaterialTheme.typography.bodyMedium)
                    // Chosen, what it says goes under its name, as the web's does, and as the name is checked.
                    if (choice != FolderChoice.NEW) MetaText(MachineSetupCopy.SETUP_NEW_FOLDER_META)
                }
                if (choice == FolderChoice.NEW) {
                    Column(
                        Modifier.fillMaxWidth().padding(start = 36.dp, end = 10.dp, bottom = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Row(
                            Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            // The folder it goes in shares the row with the name: on a phone a long one is cut from its start, so the
                            // field keeps room to type in (it was measured first and left the field a sliver).
                            Text(
                                MachineSetup.newFolderPath(reposRoot, ""),
                                style = MaterialTheme.typography.bodySmall,
                                fontFamily = FontFamily.Monospace,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.StartEllipsis,
                                modifier = Modifier.weight(1f, fill = false),
                            )
                            OutlinedTextField(
                                value = newName,
                                onValueChange = { touched = FolderChoice.NEW; newName = it },
                                placeholder = { Text(MachineSetupCopy.SETUP_NEW_FOLDER_NAME) },
                                singleLine = true,
                                enabled = !disabled,
                                textStyle = LocalTextStyle.current.copy(fontFamily = FontFamily.Monospace),
                                keyboardOptions = KeyboardOptions(
                                    capitalization = KeyboardCapitalization.None,
                                    autoCorrectEnabled = false,
                                    imeAction = ImeAction.Done,
                                ),
                                keyboardActions = KeyboardActions(onDone = { candidate?.let(onPick) }),
                                modifier = Modifier.weight(1f).testTag("setup-new-folder-name"),
                            )
                        }
                        // What a new folder is while nothing is typed, then what the machine finds where it would go.
                        when {
                            name.isEmpty() -> MetaText(MachineSetupCopy.SETUP_NEW_FOLDER_META)
                            !MachineSetup.isValidNewFolder(name) ->
                                VerdictText(MachineSetupCopy.SETUP_NEW_FOLDER_INVALID, FolderVerdict.Tone.BAD)
                            found != null -> {
                                val verdict = MachineSetup.newFolderVerdict(found, machine)
                                // Nothing there yet reads as the board draws a new folder; anything there says what it means.
                                if (verdict.tone == FolderVerdict.Tone.OK) MetaText(verdict.text) else VerdictText(verdict.text, verdict.tone)
                            }
                            newAnswer != null -> NoAnswerRow(machine) { newAttempt++ }
                            else -> CheckingText(machine)
                        }
                    }
                }
            }
        }
        if (suggested != null || offersNewFolder) HorizontalDivider(Modifier.padding(start = 36.dp))
        Column {
            FolderOptionRow(
                selected = choice == FolderChoice.OTHER,
                enabled = !disabled,
                onClick = { touched = FolderChoice.OTHER },
            ) {
                Text(MachineSetupCopy.setupOtherFolder(machine), style = MaterialTheme.typography.bodyMedium)
            }
            if (choice == FolderChoice.OTHER) {
                Column(
                    Modifier.fillMaxWidth().padding(start = 36.dp, end = 10.dp, bottom = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    OutlinedTextField(
                        value = typed,
                        onValueChange = { touched = FolderChoice.OTHER; typed = it },
                        placeholder = { Text("/path/to/project") },
                        singleLine = true,
                        enabled = !disabled,
                        textStyle = LocalTextStyle.current.copy(fontFamily = FontFamily.Monospace),
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.None,
                            autoCorrectEnabled = false,
                            imeAction = ImeAction.Done,
                        ),
                        keyboardActions = KeyboardActions(onDone = { candidate?.let(onPick) }),
                        modifier = Modifier.fillMaxWidth().testTag("setup-other-folder-path"),
                    )
                    if (path.isNotEmpty()) {
                        when {
                            checked != null -> {
                                val verdict = MachineSetup.folderVerdict(checked, machine)
                                VerdictText(verdict.text, verdict.tone)
                            }
                            typedAnswer != null -> NoAnswerRow(machine) { attempt++ }
                            else -> CheckingText(machine)
                        }
                    }
                }
            }
        }
    }

    Button(
        onClick = { candidate?.let(onPick) },
        enabled = candidate != null && !disabled,
        shape = CircleShape,
        modifier = Modifier.padding(top = 9.dp),
    ) {
        Text(MachineSetupCopy.SETUP_USE_FOLDER)
    }
}

@Composable
private fun FolderOptionRow(
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, role = Role.RadioButton, onClick = onClick)
            .semantics { this.selected = selected }
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            if (selected) "✓" else "",
            color = MaterialTheme.colorScheme.primary,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.width(18.dp),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp), content = content)
    }
}

@Composable
private fun MetaText(text: String) {
    Text(text, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun CheckingText(machine: String) = MetaText(MachineSetupCopy.setupChecking(machine))

/** A check the machine gave no answer to, and the way to ask it again. */
@Composable
private fun NoAnswerRow(machine: String, onAgain: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        VerdictText(MachineSetupCopy.setupNoAnswer(machine), FolderVerdict.Tone.BAD)
        Text(
            MachineSetupCopy.SETUP_CHECK_AGAIN,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier.clickable(role = Role.Button, onClick = onAgain),
        )
    }
}

@Composable
private fun VerdictText(text: String, tone: FolderVerdict.Tone) {
    val color = when (tone) {
        FolderVerdict.Tone.OK -> Ink.green
        FolderVerdict.Tone.WARN -> Ink.amber
        FolderVerdict.Tone.BAD -> Ink.red
    }
    Text(text, style = MaterialTheme.typography.labelSmall, color = color)
}

/**
 * The first message, waiting under the card for both steps (rule 6): the user bubble it will be, with what it is waiting for beneath
 * it and Withdraw (or Try again on failure).
 */
@Composable
internal fun HeldFirstMessageView(
    held: HeldMessage,
    machine: String,
    sending: Boolean,
    onWithdraw: () -> Unit,
    onRetry: () -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().padding(top = 12.dp).testTag("held-first-message"),
        horizontalAlignment = Alignment.End,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Surface(
            shape = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp, bottomStart = 16.dp, bottomEnd = 4.dp),
            color = MaterialTheme.colorScheme.primary.copy(alpha = 0.14f),
            contentColor = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.widthIn(max = 320.dp),
        ) {
            Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                if (held.content.isNotEmpty()) {
                    Text(
                        if (held.shell) "!${held.content}" else held.content,
                        style = MaterialTheme.typography.bodyMedium,
                        fontFamily = if (held.shell) FontFamily.Monospace else null,
                    )
                }
                held.attachments.forEach { att ->
                    Text(att.name, style = MaterialTheme.typography.labelSmall)
                }
            }
        }
        if (sending) {
            Text(
                MachineSetupCopy.HELD_SENDING,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                if (held.error != null) {
                    Text(
                        MachineSetupCopy.heldFailed(held.error),
                        style = MaterialTheme.typography.labelSmall,
                        color = Ink.red,
                    )
                    Text(
                        MachineSetupCopy.HELD_TRY_AGAIN,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.clickable(role = Role.Button, onClick = onRetry),
                    )
                } else {
                    Text(
                        MachineSetupCopy.heldWaiting(machine),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Text(
                    MachineSetupCopy.HELD_WITHDRAW,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.clickable(role = Role.Button, onClick = onWithdraw),
                )
            }
        }
    }
}

/**
 * The first line of a conversation that made its workspace (rule 8): what was made, where, and Rename · Settings.
 */
@Composable
internal fun CreatedWorkspaceLineView(
    line: CreatedWorkspaceLine,
    settingsEnabled: Boolean,
    onRename: (String) -> Unit,
    onOpenSettings: () -> Unit,
) {
    var renaming by remember { mutableStateOf(false) }
    var draft by remember { mutableStateOf("") }

    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 6.dp)
            .testTag("created-workspace"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(
            buildAnnotatedString {
                append("${MachineSetupCopy.CREATED_WORKSPACE} ")
                withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface)) {
                    append(line.name)
                }
                append(" ${MachineSetupCopy.CREATED_ON} ${line.machine}")
                if (!line.path.isNullOrEmpty()) {
                    append(" · ${line.path}")
                }
            },
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        if (renaming) {
            Row(
                Modifier.padding(top = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    label = { Text(MachineSetupCopy.CREATED_RENAME_LABEL) },
                    singleLine = true,
                    modifier = Modifier.widthIn(min = 160.dp, max = 240.dp).testTag("created-workspace-rename-input"),
                )
                TextButton(onClick = {
                    val next = draft.trim()
                    renaming = false
                    if (next.isNotEmpty() && next != line.name) onRename(next)
                }) { Text("Save") }
                TextButton(onClick = { renaming = false }) { Text("Cancel") }
            }
        } else if (line.live) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    MachineSetupCopy.CREATED_RENAME,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.clickable(role = Role.Button) {
                        draft = line.name
                        renaming = true
                    },
                )
                Text("·", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(
                    MachineSetupCopy.CREATED_SETTINGS,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier
                        .alpha(if (settingsEnabled) 1f else 0.38f)
                        .clickable(enabled = settingsEnabled, role = Role.Button, onClick = onOpenSettings),
                )
            }
        }
    }
}
