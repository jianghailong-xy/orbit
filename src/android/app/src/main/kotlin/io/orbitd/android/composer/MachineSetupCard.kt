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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
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
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.withLink
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.stateDescription
import io.orbitd.android.toast.OrbitToasts
import io.orbitd.android.toast.ToastTone
import kotlinx.coroutines.launch
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
    /** The GitHub routes From GitHub asks; the app's own unless a test hands in its own. */
    github: GithubSource? = null,
    /** From GitHub's Change: Settings → GitHub. */
    onOpenGithubSettings: () -> Unit = {},
) {
    val githubSource = remember(managementApi, github) { github ?: ManagementGithub(managementApi) }
    val machine = RunnerPage.displayName(runner)
    val offline = !online
    val probes = MachineSetup.answersDirProbe(runner)
    val makesNewFolders = MachineSetup.makesNewFolders(runner)
    val engineName = ProviderEngines.cliName(engine)

    val notice = when {
        // Never heard from is a machine still coming up, not one gone away, nor one too old to check folders.
        offline -> if (MachineSetup.isConnecting(runner)) MachineSetupCopy.setupConnecting(machine) else MachineSetupCopy.setupOffline(machine)
        !(probes && makesNewFolders) -> if (MachineSetup.updatesItself(runner)) MachineSetupCopy.setupUpdating(machine)
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
                    if (!offline && !(probes && makesNewFolders) && !MachineSetup.updatesItself(runner)) {
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

            // The card's one question: no step number beside it.
            Column(Modifier.fillMaxWidth().padding(vertical = 9.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
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
                                folder.doneLine,
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
                            folder.doneNote,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                } else {
                    FolderStep(
                        runner = runner,
                        online = online,
                        disabled = offline || !probes || !makesNewFolders,
                        probeDir = probeDir,
                        onPick = onPickFolder,
                        github = githubSource,
                        onOpenGithubSettings = onOpenGithubSettings,
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
                    folder.readySentence,
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

/**
 * Step one before it has an answer: the folder's name, or, where the deployment has Orbit's GitHub App, a repository cloned from GitHub
 * (docs/mocks/github-workspace board 04 A). The name is the step; From GitHub is a row under it that swaps the step to the repository
 * picker. A sign-in to GitHub goes through the browser, and the card comes back on the picker (board 01, note 2).
 */
@Composable
private fun FolderStep(
    runner: JsonObject,
    online: Boolean,
    disabled: Boolean,
    probeDir: suspend (path: String, ask: Boolean) -> DirProbeRelay.Outcome,
    onPick: (PickedFolder) -> Unit,
    github: GithubSource,
    onOpenGithubSettings: () -> Unit,
) {
    val runnerId = runner.text("id").orEmpty()
    // Kept across the page being made again, which is where a sign-in in the browser comes back to.
    var githubOpen by rememberSaveable(runnerId) { mutableStateOf(false) }
    // From GitHub (docs/github-workspace-design.md §8): offered only where the deployment has a GitHub App. Read again each time the app
    // comes back to the front, which is where a sign-in in the browser ends; the last answer stands while it is read.
    var integration by remember(runnerId) { mutableStateOf<GithubIntegration?>(null) }
    val resumes = rememberResumes()
    LaunchedEffect(runnerId, resumes) {
        integration = try { github.integration() } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { integration }
    }
    val current = integration?.takeIf { it.available }
    if (current != null && githubOpen) {
        GithubStep(runner, current, github, disabled = !online, probeDir, onPick, onOpenGithubSettings, onBack = { githubOpen = false })
    } else {
        FolderNameSection(runner, disabled, probeDir, onPick)
        if (current != null) GithubRow(enabled = online) { githubOpen = true }
    }
}

/** Board 04 A: an "or" rule, then From GitHub with its NEW tag and what it does. Not the name field's lock: a machine too old to make
 *  folders may clone, and the picker says when it can't. */
@Composable
private fun GithubRow(enabled: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(top = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        HorizontalDivider(Modifier.weight(1f))
        MetaText(MachineSetupCopy.SETUP_OR)
        HorizontalDivider(Modifier.weight(1f))
    }
    Row(
        Modifier
            .padding(top = 8.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(8.dp))
            .alpha(if (enabled) 1f else 0.6f)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp)
            .testTag("setup-github-row"),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(painterResource(R.drawable.ic_github), null, Modifier.padding(top = 2.dp).size(16.dp))
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            GithubTitle()
            MetaText(MachineSetupCopy.SETUP_GITHUB_META)
        }
    }
}

/** From GitHub and its NEW tag, as the row and the picker's step both say it. */
@Composable
private fun GithubTitle(mark: Boolean = false) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (mark) Icon(painterResource(R.drawable.ic_github), null, Modifier.size(15.dp))
        Text(MachineSetupCopy.SETUP_FROM_GITHUB, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
        Text(
            MachineSetupCopy.SETUP_NEW_TAG,
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier
                .clip(RoundedCornerShape(4.dp))
                .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.12f))
                .padding(horizontal = 5.dp, vertical = 1.dp),
        )
    }
}

/** Step one on From GitHub (board 04 A, P3's picker): the repository and the folder it is cloned into, Use This Repository once the
 *  account is connected, and the way back to a folder's name. */
@Composable
private fun GithubStep(
    runner: JsonObject,
    integration: GithubIntegration,
    github: GithubSource,
    disabled: Boolean,
    probeDir: suspend (path: String, ask: Boolean) -> DirProbeRelay.Outcome,
    onPick: (PickedFolder) -> Unit,
    onOpenSettings: () -> Unit,
    onBack: () -> Unit,
) {
    var candidate by remember(runner.text("id")) { mutableStateOf<PickedFolder?>(null) }
    Text(MachineSetupCopy.SETUP_FOLDER, fontWeight = FontWeight.SemiBold)
    Text(
        MachineSetupCopy.setupFolderHelp(RunnerPage.displayName(runner)),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Box(Modifier.padding(top = 8.dp)) { GithubTitle(mark = true) }
    GithubFolderOption(
        runner = runner,
        integration = integration,
        github = github,
        disabled = disabled,
        probeDir = probeDir,
        onCandidate = { candidate = it },
        onEnter = { candidate?.let(onPick) },
        onOpenSettings = onOpenSettings,
    )
    if (integration.connected && !integration.needsReconnect) {
        Button(
            onClick = { candidate?.let(onPick) },
            enabled = candidate != null && !disabled,
            shape = CircleShape,
            modifier = Modifier.padding(top = 9.dp),
        ) {
            Text(MachineSetupCopy.SETUP_USE_REPOSITORY)
        }
    }
    Box(Modifier.padding(top = 6.dp)) {
        ChangeLink(MachineSetupCopy.SETUP_FOLDER_NAME_INSTEAD, enabled = true, tag = "setup-folder-name-instead", onClick = onBack)
    }
}

/**
 * Step one before it has an answer: one folder name in the machine's home (its Repos Folder on an older runner), which the machine
 * itself checks as it is typed. A folder that is there is used; one that isn't is made.
 */
@Composable
private fun FolderNameSection(
    runner: JsonObject,
    disabled: Boolean,
    probeDir: suspend (path: String, ask: Boolean) -> DirProbeRelay.Outcome,
    onPick: (PickedFolder) -> Unit,
) {
    val runnerId = runner.text("id").orEmpty()
    val machine = RunnerPage.displayName(runner)
    val root = MachineSetup.newFolderRootOf(runner)
    var typed by remember(runnerId) { mutableStateOf("") }
    var answer by remember(runnerId) { mutableStateOf<DirProbeRelay.Outcome?>(null) }
    // Check again.
    var attempt by remember(runnerId) { mutableIntStateOf(0) }

    val name = typed.trim()
    val found = (answer as? DirProbeRelay.Outcome.Answered)?.probe
    val candidate = if (found != null && MachineSetup.isValidNewFolder(name)) MachineSetup.newFolderPick(found, name, root, machine) else null

    // The name is asked about where it would go, as it is typed: a folder, or a file, may be there already.
    val query = if (!disabled && MachineSetup.isValidNewFolder(name)) MachineSetup.newFolderPath(root, name) else null
    LaunchedEffect(runnerId, query, attempt) {
        answer = null
        if (query == null) return@LaunchedEffect
        delay(300)
        answer = try {
            probeDir(query, true)
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (e: Exception) {
            DirProbeRelay.Outcome.Answered(DirProbe(path = query, exists = false, isDir = false, isGit = false, isHome = false, error = e.message ?: "Request failed"))
        }
    }

    Text(MachineSetupCopy.SETUP_FOLDER, fontWeight = FontWeight.SemiBold)
    Text(
        MachineSetupCopy.setupFolderHelp(machine),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )

    Column(
        Modifier.padding(top = 8.dp).fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        OutlinedTextField(
            value = typed,
            onValueChange = { typed = it },
            // The folder it goes in is fixed; on a phone a long one is cut from its start, so the field keeps room to type in.
            prefix = {
                Text(
                    MachineSetup.newFolderPath(root, ""),
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.StartEllipsis,
                    modifier = Modifier.widthIn(max = 160.dp),
                )
            },
            placeholder = { Text(MachineSetupCopy.SETUP_NEW_FOLDER_NAME) },
            singleLine = true,
            enabled = !disabled,
            isError = name.isNotEmpty() && !MachineSetup.isValidNewFolder(name),
            textStyle = LocalTextStyle.current.copy(fontFamily = FontFamily.Monospace),
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.None,
                autoCorrectEnabled = false,
                imeAction = ImeAction.Done,
            ),
            keyboardActions = KeyboardActions(onDone = { candidate?.let(onPick) }),
            modifier = Modifier
                .fillMaxWidth()
                .semantics { contentDescription = MachineSetupCopy.SETUP_FOLDER }
                .testTag("setup-new-folder-name"),
        )
        when {
            name.isEmpty() -> MetaText(MachineSetupCopy.SETUP_FOLDER_HINT)
            !MachineSetup.isValidNewFolder(name) -> VerdictText(MachineSetupCopy.SETUP_NEW_FOLDER_INVALID, FolderVerdict.Tone.BAD)
            found != null -> {
                val verdict = MachineSetup.newFolderVerdict(found, machine)
                // Nothing there yet reads as a note; anything there says what it is.
                if (found.exists) VerdictText(verdict.text, verdict.tone) else MetaText(verdict.text)
            }
            answer != null -> NoAnswerRow(machine) { attempt++ }
            else -> CheckingText(machine)
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
internal fun MetaText(text: String) {
    Text(text, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
internal fun CheckingText(machine: String) = MetaText(MachineSetupCopy.setupChecking(machine))

/** A check the machine gave no answer to, and the way to ask it again. */
@Composable
internal fun NoAnswerRow(machine: String, onAgain: () -> Unit) {
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
internal fun VerdictText(text: String, tone: FolderVerdict.Tone) {
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
 * The first line of a conversation that made its workspace (rule 8): what was made, where, and Rename · Settings. A workspace cloned
 * from GitHub draws the same line while its clone has not finished ([clone], what [WorkspaceClone.now] makes of the detail and the
 * stream), and once it has, the repository it came from.
 */
@Composable
internal fun CreatedWorkspaceLineView(
    line: CreatedWorkspaceLine,
    settingsEnabled: Boolean,
    onRename: (String) -> Unit,
    onOpenSettings: () -> Unit,
    clone: CloneHeard? = null,
    github: GithubSource? = null,
    /** Retry: `POST /workspaces/:id/clone/retry`, then PENDING heard here and the session read again. Throws what refused it. */
    onRetry: suspend () -> Unit = {},
) {
    val repository = line.repository?.takeIf { clone != null }
    if (clone != null && repository != null && line.live && clone.state != CloneState.READY) {
        CloneStatusLine(line, repository, clone, settingsEnabled, onOpenSettings, github, onRetry)
        return
    }
    var renaming by remember { mutableStateOf(false) }
    var draft by remember { mutableStateOf("") }
    val uri = LocalUriHandler.current
    val linkColor = MaterialTheme.colorScheme.primary

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
                if (repository != null) {
                    append(" · ")
                    val url = "https://github.com/$repository"
                    withLink(LinkAnnotation.Url(url, TextLinkStyles(SpanStyle(color = linkColor))) { uri.openUri(url) }) {
                        append(repository)
                    }
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

/**
 * The same first line while a GitHub workspace's clone has not finished (board 01, P5; web `CloneStatusLine`): Cloning with git's
 * percentage, or why it failed with the way out — Retry always, and before it what the reason asks for: the App installed again, GitHub
 * connected again, or the workspace's settings.
 */
@Composable
private fun CloneStatusLine(
    line: CreatedWorkspaceLine,
    repository: String,
    clone: CloneHeard,
    settingsEnabled: Boolean,
    onOpenSettings: () -> Unit,
    github: GithubSource?,
    onRetry: suspend () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val uri = LocalUriHandler.current
    val failure = if (clone.state == CloneState.FAILED) WorkspaceClone.failureOf(line.cloneError) else null
    var retrying by remember { mutableStateOf(false) }
    // Where to install the App again: only asked for when the App is what is missing.
    var installUrl by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(failure == CloneFailure.APP_REMOVED, github) {
        if (failure != CloneFailure.APP_REMOVED || github == null) return@LaunchedEffect
        installUrl = try { github.integration().installUrl } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }
    }
    fun retry() {
        retrying = true
        scope.launch {
            try {
                onRetry()
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (e: Exception) {
                OrbitToasts.show(MachineSetupCopy.CLONE_RETRY_FAILED, detail = githubWhy(e), tone = ToastTone.ERROR)
            } finally {
                retrying = false
            }
        }
    }
    fun reconnect() {
        val source = github ?: return
        scope.launch {
            try {
                uri.openUri(source.start())
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (e: Exception) {
                OrbitToasts.show(MachineSetupCopy.setupGithubConnectFailed(githubWhy(e)), tone = ToastTone.ERROR)
            }
        }
    }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    @Composable
    fun sep() = Text("·", style = MaterialTheme.typography.labelSmall, color = muted)

    FlowRow(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 6.dp)
            .testTag("created-workspace-clone")
            .semantics { stateDescription = failure?.name ?: clone.state.wire },
        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
        verticalArrangement = Arrangement.spacedBy(4.dp),
        itemVerticalAlignment = Alignment.CenterVertically,
    ) {
        if (failure != null) {
            val reason = when (failure) {
                CloneFailure.APP_REMOVED -> MachineSetupCopy.cloneAppRemoved(repository)
                CloneFailure.SIGN_IN_EXPIRED -> MachineSetupCopy.CLONE_SIGN_IN_EXPIRED
                else -> MachineSetupCopy.cloneCouldNot(repository, WorkspaceClone.reason(line.cloneError))
            }
            Text(
                buildAnnotatedString {
                    append("⚠ ")
                    append(reason)
                },
                style = MaterialTheme.typography.labelSmall,
                color = Ink.red,
                textAlign = TextAlign.Center,
                modifier = Modifier.testTag("created-workspace-clone-reason"),
            )
            when (failure) {
                CloneFailure.APP_REMOVED -> installUrl?.let { url ->
                    ChangeLink("${MachineSetupCopy.CLONE_INSTALL_ON_GITHUB} ↗", enabled = true, tag = "clone-install") { uri.openUri(url) }
                    sep()
                }
                CloneFailure.SIGN_IN_EXPIRED -> {
                    ChangeLink(MachineSetupCopy.CLONE_RECONNECT, enabled = github != null, tag = "clone-reconnect", onClick = ::reconnect)
                    sep()
                }
                else -> Unit
            }
            ChangeLink(MachineSetupCopy.CLONE_RETRY, enabled = !retrying, tag = "clone-retry", onClick = ::retry)
            if (failure != CloneFailure.APP_REMOVED && failure != CloneFailure.SIGN_IN_EXPIRED) {
                sep()
                ChangeLink(MachineSetupCopy.CREATED_SETTINGS, enabled = settingsEnabled, tag = "clone-settings", onClick = onOpenSettings)
            }
        } else {
            CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp)
            Text(
                buildAnnotatedString {
                    append(if (clone.state == CloneState.CLONING) MachineSetupCopy.CLONE_CLONING else MachineSetupCopy.CLONE_WAITING)
                    append(" ")
                    withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface)) { append(repository) }
                    append(" ${MachineSetupCopy.CREATED_ON} ")
                    withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface)) { append(line.machine) }
                },
                style = MaterialTheme.typography.labelSmall,
                color = muted,
            )
            clone.progress?.let { progress ->
                LinearProgressIndicator(
                    progress = { progress / 100f },
                    modifier = Modifier
                        .width(72.dp)
                        .height(4.dp)
                        .semantics { contentDescription = "${MachineSetupCopy.CLONE_CLONING} $repository" }
                        .testTag("created-workspace-clone-bar"),
                    drawStopIndicator = {},
                    gapSize = 0.dp,
                )
                Text("$progress%", style = MaterialTheme.typography.labelSmall, color = muted)
            }
        }
    }
}
