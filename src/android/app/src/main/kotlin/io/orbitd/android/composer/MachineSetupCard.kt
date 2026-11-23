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
import io.orbitd.android.cards.conversationCard
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
import io.orbitd.android.management.RunnerPage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonObject

/**
 * A machine with no workspace, on its new session page, which it fills alone (owner 2026-11-16,
 * docs/mocks/new-folder-in-home/workspace-card-with-name): the card makes the machine's first workspace and asks only what that needs.
 * The folder is one name in the machine's home (its Repos Folder on an older runner), which the machine checks as it is typed: a folder
 * there is used, one that isn't is made with the workspace. The workspace's name follows the folder's until it is edited. Signing in a
 * coding CLI is not asked here: the new workspace's sessions ask for it where they need it.
 *
 * From GitHub (docs/github-workspace-design.md §8, board 04 A): under the folder and its Name, an "or" rule and a row that swaps the
 * folder field for the repository picker; "Type a folder name instead" swaps it back. A picked repository is cloned into the Repos
 * Folder (`repo → ~/orbit-repos/<name>`), and the Name follows its folder as it follows a typed one.
 */
@Composable
internal fun MachineSetupCard(
    runner: JsonObject,
    online: Boolean,
    probeDir: suspend (path: String, ask: Boolean) -> DirProbeRelay.Outcome,
    /** Make the workspace in this folder, under this name (trimmed). */
    onCreate: (PickedFolder, String) -> Unit,
    /** The workspace is being made: the fields and the button wait. */
    creating: Boolean,
    /** Why the last Create workspace was refused, said on the card until the next try. */
    createError: String?,
    onOpenMachine: () -> Unit,
    /** A new account's first machine (docs/mocks/new-user-onboarding): the card greets it. */
    welcome: Boolean = false,
    welcomeName: String? = null,
    /** The GitHub routes From GitHub asks; null offers no From GitHub. */
    github: GithubSource? = null,
    /** From GitHub's Change: Settings → GitHub. */
    onOpenGithubSettings: () -> Unit = {},
    managedSetup: String? = null,
    /** New workspace on a machine that has one (docs/mocks/new-workspace-form/02-apple-entry, owner A): the folder hint says a full path
     *  is taken too, and the card draws no head under the page's title bar, which names the machine (iOS's phone card). */
    addsWorkspace: Boolean = false,
) {
    val runnerId = runner.text("id").orEmpty()
    val machine = RunnerPage.displayName(runner)
    val offline = !online
    val usable = MachineSetup.answersDirProbe(runner) && MachineSetup.makesNewFolders(runner)
    val disabled = managedSetup == null && (offline || !usable)
    val root = MachineSetup.setupFolderRoot(runner, managedSetup != null)

    var typed by remember(runnerId) { mutableStateOf("") }
    // The answer, with the path it is about: an answer about a name since changed says nothing.
    var answer by remember(runnerId) { mutableStateOf<Pair<String, DirProbeRelay.Outcome>?>(null) }
    // Check again.
    var attempt by remember(runnerId) { mutableIntStateOf(0) }
    // The workspace's name once edited: from then on what was typed, empty included.
    var editedName by remember(runnerId) { mutableStateOf<String?>(null) }

    val folder = typed.trim()
    // A full path is asked about as typed; a name where it would go, as it is typed: a folder, or a file, may be there already
    // (docs/mocks/new-workspace-form, decision 2 A).
    val query = MachineSetup.folderQuestion(folder, root, canAsk = managedSetup == null && !disabled)
    // The folder field holds a whole path: no home prefix before it.
    val fullPath = MachineSetup.isFolderPath(folder)
    LaunchedEffect(runnerId, query, attempt) {
        if (query == null) return@LaunchedEffect
        delay(300)
        val outcome = try {
            probeDir(query, true)
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (e: Exception) {
            DirProbeRelay.Outcome.Answered(DirProbe(path = query, exists = false, isDir = false, isGit = false, isHome = false, error = e.message ?: "Request failed"))
        }
        answer = query to outcome
    }
    val current = answer?.takeIf { query != null && it.first == query }?.second
    val found = (current as? DirProbeRelay.Outcome.Answered)?.probe
    // A managed runner that isn't up takes a name unchecked, but a full path only once it is checked.
    val typedPick = MachineSetup.typedPick(folder, found, root, machine, managedSetup)

    // From GitHub: offered only where the deployment has a GitHub App. Read again each time the app comes back to the front, which is
    // where a sign-in in the browser ends; the last answer stands while it is read.
    var integration by remember(runnerId, github) { mutableStateOf<GithubIntegration?>(null) }
    val resumes = rememberResumes()
    LaunchedEffect(runnerId, github, resumes) {
        val source = github ?: return@LaunchedEffect
        integration = try { source.integration() } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { integration }
    }
    val offered = integration?.takeIf { it.available }
    // Kept across the page being made again, which is where a sign-in in the browser comes back to: the card opens on the picker.
    var githubOpen by rememberSaveable(runnerId) { mutableStateOf(false) }
    var repository by remember(runnerId) { mutableStateOf<PickedFolder?>(null) }
    val fromGithub = offered != null && githubOpen
    val candidate = if (fromGithub) repository else typedPick
    // Not the folder field's lock: a machine too old to make folders may clone, and the picker says when it can't.
    val locked = if (fromGithub) offline else disabled

    val followed = if (fromGithub) (repository as? PickedFolder.Github)?.pick?.name.orEmpty() else MachineSetup.followedName(folder)
    val shownName = MachineSetup.shownName(editedName, followed)
    val (nameLine, nameBad) = MachineSetup.nameLine(editedName)
    val canCreate = MachineSetup.canCreate(candidate, shownName, usable = !locked, creating = creating)
    val create = { if (canCreate && candidate != null) onCreate(candidate, shownName.trim()) }

    val notice = when {
        managedSetup != null -> ManagedRunner.Setup.NOTICE.getValue(managedSetup)
        // Never heard from is a machine still coming up, not one gone away, nor one too old to check folders.
        offline -> if (MachineSetup.isConnecting(runner)) MachineSetupCopy.setupConnectingCreate(machine) else MachineSetupCopy.setupOfflineCreate(machine)
        !usable -> if (MachineSetup.updatesItself(runner)) MachineSetupCopy.setupUpdatingCreate(machine)
            else MachineSetupCopy.setupNeedsUpdate(machine)
        else -> null
    }

    Surface(
        modifier = Modifier.conversationCard().testTag("machine-setup-card"),
        shape = RoundedCornerShape(18.dp),
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 1.dp,
        shadowElevation = 2.dp,
        border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp)) {
            if (welcome) WelcomeHead(welcomeName)
            else if (!addsWorkspace) Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
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
                        MachineSetupCopy.setupNewWorkspaceTitle(machine),
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        MachineSetupCopy.setupNewWorkspaceLead(machine),
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
                    if (managedSetup == null && !offline && !usable && !MachineSetup.updatesItself(runner)) {
                        Text(
                            MachineSetupCopy.SETUP_OPEN_MACHINE,
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.clickable(role = Role.Button, onClick = onOpenMachine),
                        )
                    }
                }
            }

            if (!addsWorkspace) HorizontalDivider(Modifier.padding(top = 12.dp))

            if (fromGithub && offered != null && github != null) {
                GithubFolderStep(
                    runner = runner,
                    integration = offered,
                    github = github,
                    disabled = offline || creating,
                    creating = creating,
                    createError = createError,
                    repository = repository,
                    probeDir = probeDir,
                    onCandidate = { repository = it },
                    onEnter = create,
                    onOpenSettings = onOpenGithubSettings,
                    onBack = {
                        githubOpen = false
                        repository = null
                    },
                )
            } else Column(Modifier.fillMaxWidth().padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(MachineSetupCopy.SETUP_FOLDER, fontWeight = FontWeight.SemiBold)
                OutlinedTextField(
                    value = typed,
                    onValueChange = { typed = it },
                    // The folder it goes in is fixed; on a phone a long one is cut from its start, so the field keeps room to type in.
                    prefix = if (fullPath) null else ({
                        Text(
                            MachineSetup.newFolderPath(root, ""),
                            fontFamily = FontFamily.Monospace,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.StartEllipsis,
                            modifier = Modifier.widthIn(max = 160.dp),
                        )
                    }),
                    placeholder = { Text(MachineSetupCopy.SETUP_NEW_FOLDER_NAME) },
                    singleLine = true,
                    enabled = !disabled && !creating,
                    isError = folder.isNotEmpty() && !fullPath && !MachineSetup.isValidNewFolder(folder),
                    textStyle = LocalTextStyle.current.copy(fontFamily = FontFamily.Monospace),
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        imeAction = ImeAction.Done,
                    ),
                    keyboardActions = KeyboardActions(onDone = { create() }),
                    modifier = Modifier
                        .fillMaxWidth()
                        .semantics { contentDescription = MachineSetupCopy.SETUP_FOLDER }
                        .testTag("setup-new-folder-name"),
                )
                when (val line = MachineSetup.folderLine(folder, createError, found, unanswered = current != null && found == null, machine,
                    managedSetup, pathHintRoot = root.takeIf { addsWorkspace })) {
                    is MachineSetup.FolderLine.Meta -> MetaText(line.text)
                    is MachineSetup.FolderLine.Verdict -> VerdictText(line.text, line.tone)
                    MachineSetup.FolderLine.NoAnswer -> NoAnswerRow(machine) { attempt++ }
                    MachineSetup.FolderLine.Checking -> CheckingText(machine)
                }
            }

            Column(Modifier.fillMaxWidth().padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(MachineSetupCopy.SETUP_NAME, fontWeight = FontWeight.SemiBold)
                OutlinedTextField(
                    value = shownName,
                    onValueChange = { editedName = it },
                    placeholder = { Text(followed.ifEmpty { MachineSetupCopy.SETUP_NAME_PLACEHOLDER }) },
                    singleLine = true,
                    enabled = !locked && !creating,
                    isError = nameBad,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { create() }),
                    modifier = Modifier
                        .fillMaxWidth()
                        .semantics { contentDescription = MachineSetupCopy.SETUP_NAME }
                        .testTag("setup-workspace-name"),
                )
                if (nameBad) VerdictText(nameLine, FolderVerdict.Tone.BAD) else MetaText(nameLine)
            }

            Button(
                onClick = create,
                enabled = canCreate,
                shape = CircleShape,
                modifier = Modifier.padding(top = 12.dp).testTag("setup-create"),
            ) {
                if (creating) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = LocalContentColor.current)
                    Spacer(Modifier.width(8.dp))
                }
                Text(MachineSetupCopy.SETUP_CREATE)
            }

            if (offered != null && !fromGithub) GithubRow(enabled = online && !creating) { githubOpen = true }
        }
    }
}

/** Board 04 A: an "or" rule, then From GitHub with its NEW tag and what it does. Not the folder field's lock: a machine too old to make
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

/** From GitHub and its NEW tag, as the row and the picker's field both say it. */
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

/** The folder field on From GitHub (board 04 A, P3's picker): the repository and the folder it is cloned into, where it goes once one
 *  is found, and the way back to a folder's name. The card's Create workspace sends it. */
@Composable
private fun GithubFolderStep(
    runner: JsonObject,
    integration: GithubIntegration,
    github: GithubSource,
    disabled: Boolean,
    creating: Boolean,
    createError: String?,
    repository: PickedFolder?,
    probeDir: suspend (path: String, ask: Boolean) -> DirProbeRelay.Outcome,
    onCandidate: (PickedFolder?) -> Unit,
    onEnter: () -> Unit,
    onOpenSettings: () -> Unit,
    onBack: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(MachineSetupCopy.SETUP_FOLDER, fontWeight = FontWeight.SemiBold)
        GithubTitle(mark = true)
        GithubFolderOption(
            runner = runner,
            integration = integration,
            github = github,
            disabled = disabled,
            probeDir = probeDir,
            onCandidate = onCandidate,
            onEnter = onEnter,
            onOpenSettings = onOpenSettings,
        )
        val clone = (repository as? PickedFolder.Github)?.pick
        when {
            createError != null -> VerdictText(MachineSetupCopy.setupCreateFailed(createError), FolderVerdict.Tone.BAD)
            clone != null -> Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    MachineSetupCopy.setupGithubDonePath(clone.repository, MachineSetup.homeShortPath(clone.path)),
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    maxLines = 1,
                    overflow = TextOverflow.MiddleEllipsis,
                )
                MetaText(MachineSetupCopy.SETUP_GITHUB_DONE)
            }
        }
        Box(Modifier.padding(top = 2.dp)) {
            ChangeLink(MachineSetupCopy.SETUP_FOLDER_NAME_INSTEAD, enabled = !creating, tag = "setup-folder-name-instead", onClick = onBack)
        }
    }
}

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
