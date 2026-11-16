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
    managedSetup: String? = null,
) {
    val runnerId = runner.text("id").orEmpty()
    val machine = RunnerPage.displayName(runner)
    val offline = !online
    val usable = MachineSetup.answersDirProbe(runner) && MachineSetup.makesNewFolders(runner)
    val disabled = managedSetup == null && (offline || !usable)
    val root = if (managedSetup != null && runner.text("reposRoot").isNullOrBlank()) ManagedRunner.REPOS_ROOT else MachineSetup.newFolderRootOf(runner)

    var typed by remember(runnerId) { mutableStateOf("") }
    // The answer, with the path it is about: an answer about a name since changed says nothing.
    var answer by remember(runnerId) { mutableStateOf<Pair<String, DirProbeRelay.Outcome>?>(null) }
    // Check again.
    var attempt by remember(runnerId) { mutableIntStateOf(0) }
    // The workspace's name once edited: from then on what was typed, empty included.
    var editedName by remember(runnerId) { mutableStateOf<String?>(null) }

    val folder = typed.trim()
    // The name is asked about where it would go, as it is typed: a folder, or a file, may be there already.
    val query = if (managedSetup == null && !disabled && MachineSetup.isValidNewFolder(folder)) MachineSetup.newFolderPath(root, folder) else null
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
    val candidate = if (managedSetup != null && MachineSetup.isValidNewFolder(folder)) PickedFolder.New(folder, MachineSetup.newFolderPath(root, folder))
        else if (found != null && MachineSetup.isValidNewFolder(folder)) MachineSetup.newFolderPick(found, folder, root, machine) else null

    val shownName = MachineSetup.shownName(editedName, folder)
    val (nameLine, nameBad) = MachineSetup.nameLine(editedName)
    val canCreate = MachineSetup.canCreate(candidate, shownName, usable = !disabled, creating = creating)
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
        modifier = Modifier.fillMaxWidth().testTag("machine-setup-card"),
        shape = RoundedCornerShape(18.dp),
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 1.dp,
        shadowElevation = 2.dp,
        border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp)) {
            if (welcome) WelcomeHead(welcomeName)
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

            HorizontalDivider(Modifier.padding(top = 12.dp))

            Column(Modifier.fillMaxWidth().padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(MachineSetupCopy.SETUP_FOLDER, fontWeight = FontWeight.SemiBold)
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
                    enabled = !disabled && !creating,
                    isError = folder.isNotEmpty() && !MachineSetup.isValidNewFolder(folder),
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
                when {
                    createError != null -> VerdictText(MachineSetupCopy.setupCreateFailed(createError), FolderVerdict.Tone.BAD)
                    folder.isEmpty() -> MetaText(MachineSetupCopy.SETUP_FOLDER_HINT)
                    !MachineSetup.isValidNewFolder(folder) -> VerdictText(MachineSetupCopy.SETUP_NEW_FOLDER_INVALID, FolderVerdict.Tone.BAD)
                    managedSetup != null -> MetaText(ManagedRunner.Setup.FOLDER_UNCHECKED.getValue(managedSetup))
                    found != null -> {
                        val verdict = MachineSetup.newFolderVerdict(found, machine)
                        // Nothing there yet reads as a note; anything there, or a check that failed, says what it is.
                        if (found.exists || !verdict.usable) VerdictText(verdict.text, verdict.tone)
                        else MetaText(MachineSetupCopy.SETUP_NEW_FOLDER_WITH_WORKSPACE)
                    }
                    current != null -> NoAnswerRow(machine) { attempt++ }
                    else -> CheckingText(machine)
                }
            }

            Column(Modifier.fillMaxWidth().padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(MachineSetupCopy.SETUP_NAME, fontWeight = FontWeight.SemiBold)
                OutlinedTextField(
                    value = shownName,
                    onValueChange = { editedName = it },
                    placeholder = { Text(folder.ifEmpty { MachineSetupCopy.SETUP_NAME_PLACEHOLDER }) },
                    singleLine = true,
                    enabled = !disabled && !creating,
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
