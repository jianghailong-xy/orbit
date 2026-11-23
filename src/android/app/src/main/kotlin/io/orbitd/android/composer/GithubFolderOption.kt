package io.orbitd.android.composer

import androidx.compose.foundation.background
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
import androidx.compose.ui.platform.LocalUriHandler
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import io.orbitd.android.R
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.directory.directoryError
import io.orbitd.android.management.Ink
import io.orbitd.android.management.RunnerPage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/** What a GitHub route's refusal says: the server's own words when it gave any. */
internal fun githubWhy(error: Throwable): String =
    (error as? ApiError)?.messages?.firstOrNull { it.isNotBlank() } ?: directoryError(error)

/** How many times the app has come back to the front since this was first drawn: a GitHub sign-in in the browser ends there. */
@Composable
internal fun rememberResumes(): Int {
    var resumed by remember { mutableIntStateOf(0) }
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner) {
        var first = true
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) { if (first) first = false else resumed++ }
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    return resumed
}

private sealed interface RepositoryList {
    data object Loading : RepositoryList
    data class Failed(val why: String) : RepositoryList
    data class Loaded(val repositories: List<GithubRepository>) : RepositoryList
}

/**
 * The From GitHub option's body (docs/github-workspace-design.md §8, board 01 P1–P3; web `GithubFolderOption.tsx`): Connect GitHub until
 * the account is connected, then a search of the repositories Orbit's App reaches, most recently pushed first; once one is picked, its
 * default branch (Other branch for another) and the folder it is cloned into, which the machine is asked about — a folder already there
 * can't be cloned into. Says what it would pick through [onCandidate]; the card's button sends it.
 */
@Composable
internal fun GithubFolderOption(
    runner: JsonObject,
    integration: GithubIntegration,
    github: GithubSource,
    disabled: Boolean,
    probeDir: suspend (path: String, ask: Boolean) -> DirProbeRelay.Outcome,
    onCandidate: (PickedFolder?) -> Unit,
    onEnter: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val runnerId = runner.text("id").orEmpty()
    val machine = RunnerPage.displayName(runner)
    val uri = LocalUriHandler.current
    val scope = rememberCoroutineScope()
    var connecting by remember(runnerId) { mutableStateOf(false) }
    var connectError by remember(runnerId) { mutableStateOf<String?>(null) }
    // Back from the browser, the button is a button again; the card reads the connection again itself.
    val resumes = rememberResumes()
    LaunchedEffect(resumes) { connecting = false }

    val clones = MachineSetup.clonesRepositories(runner)
    // Where the server clones it (MachineSetup.cloneRootFor): home on a clone-workdir/v2 runner.
    val cloneRoot = MachineSetup.cloneRootOf(runner).orEmpty()
    var search by remember(runnerId) { mutableStateOf("") }
    var q by remember(runnerId) { mutableStateOf("") }
    LaunchedEffect(search) { delay(300); q = search.trim() }
    var repo by remember(runnerId) { mutableStateOf<GithubRepository?>(null) }
    var folder by remember(runnerId) { mutableStateOf("") }
    var branchOpen by remember(runnerId) { mutableStateOf(false) }
    var branch by remember(runnerId) { mutableStateOf("") }
    val connected = integration.usable

    var list by remember(runnerId) { mutableStateOf<RepositoryList>(RepositoryList.Loading) }
    val listing = connected && repo == null && clones
    LaunchedEffect(q, listing) {
        if (!listing) return@LaunchedEffect
        list = RepositoryList.Loading
        list = try {
            RepositoryList.Loaded(github.repositories(q))
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (e: Exception) {
            RepositoryList.Failed(githubWhy(e))
        }
    }
    var branchNames by remember(runnerId) { mutableStateOf<List<String>>(emptyList()) }
    LaunchedEffect(repo?.id, branchOpen) {
        val picked = repo
        branchNames = emptyList()
        if (picked == null || !branchOpen) return@LaunchedEffect
        branchNames = try { github.branches(picked.id).branches } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { emptyList() }
    }

    val name = folder.trim()
    var settledName by remember(runnerId) { mutableStateOf("") }
    LaunchedEffect(name) { delay(400); settledName = name }
    var attempt by remember(runnerId) { mutableIntStateOf(0) }
    val query = if (repo != null && !disabled && MachineSetup.isValidNewFolder(settledName)) MachineSetup.newFolderPath(cloneRoot, settledName) else null
    // The answer, with the path it is about: one about the name before is no answer about this one.
    var answer by remember(runnerId) { mutableStateOf<Pair<String, DirProbeRelay.Outcome>?>(null) }
    LaunchedEffect(query, attempt) {
        answer = null
        if (query == null) return@LaunchedEffect
        val outcome = try {
            probeDir(query, true)
        } catch (cancel: CancellationException) {
            throw cancel
        } catch (e: Exception) {
            DirProbeRelay.Outcome.Answered(DirProbe(path = query, exists = false, isDir = false, isGit = false, isHome = false, error = githubWhy(e)))
        }
        answer = query to outcome
    }
    val settled = settledName == name && query != null && answer?.first == query
    val found = (answer?.second as? DirProbeRelay.Outcome.Answered)?.probe?.takeIf { settled }
    val ref = if (branchOpen) MachineSetup.cloneRef(branch, repo?.defaultBranch.orEmpty()) else null
    val candidate = repo?.takeIf { clones }?.let { MachineSetup.githubPick(it, name, ref, cloneRoot, found) }
    LaunchedEffect(candidate) { onCandidate(candidate) }

    fun pick(picked: GithubRepository) {
        repo = picked
        folder = MachineSetup.repositoryFolder(picked.fullName)
        settledName = folder
        branchOpen = false
        branch = ""
    }
    fun connect() {
        connecting = true
        connectError = null
        scope.launch {
            try {
                uri.openUri(github.start())
            } catch (cancel: CancellationException) {
                throw cancel
            } catch (e: Exception) {
                connecting = false
                connectError = githubWhy(e)
            }
        }
    }

    Column(
        Modifier.fillMaxWidth().padding(top = 6.dp).testTag("setup-github-option"),
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        @Composable
        fun tooOld() {
            if (!clones) VerdictText(
                if (MachineSetup.updatesItself(runner)) MachineSetupCopy.setupCloneUpdating(machine) else MachineSetupCopy.setupCloneNeedsUpdate(machine),
                FolderVerdict.Tone.WARN,
            )
        }

        val picked = repo
        when {
            !connected -> {
                MetaText(MachineSetupCopy.SETUP_GITHUB_META)
                if (integration.needsReconnect) VerdictText(MachineSetupCopy.setupGithubSignInAgain(integration.login.orEmpty()), FolderVerdict.Tone.WARN)
                connectError?.let { VerdictText(MachineSetupCopy.setupGithubConnectFailed(it), FolderVerdict.Tone.BAD) }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        onClick = ::connect,
                        enabled = !disabled && !connecting,
                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                        modifier = Modifier.heightIn(min = 32.dp).testTag("setup-github-connect"),
                    ) {
                        if (connecting) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                        else Icon(painterResource(R.drawable.ic_github), null, Modifier.size(16.dp))
                        Spacer(Modifier.width(6.dp))
                        Text(
                            if (integration.needsReconnect) MachineSetupCopy.SETUP_RECONNECT_GITHUB else MachineSetupCopy.SETUP_CONNECT_GITHUB,
                            style = MaterialTheme.typography.labelLarge,
                        )
                    }
                    Box(Modifier.weight(1f)) { MetaText(MachineSetupCopy.SETUP_CONNECT_GITHUB_META) }
                }
                tooOld()
            }
            picked == null -> {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    MetaText(MachineSetupCopy.setupGithubAccount(integration.login.orEmpty(), integration.repositoryCount) + " ·")
                    ChangeLink(MachineSetupCopy.SETUP_CHANGE, enabled = true, tag = "setup-github-settings", onClick = onOpenSettings)
                }
                tooOld()
                if (clones) {
                    val repositories = (list as? RepositoryList.Loaded)?.repositories.orEmpty()
                    val shown = if (q.isNotEmpty()) repositories else repositories.take(MachineSetup.FIRST_REPOSITORIES)
                    OutlinedTextField(
                        value = search,
                        onValueChange = { search = it },
                        placeholder = { Text(MachineSetupCopy.SETUP_GITHUB_SEARCH) },
                        leadingIcon = { Icon(painterResource(R.drawable.ic_search), null, Modifier.size(16.dp)) },
                        singleLine = true,
                        enabled = !disabled,
                        textStyle = MaterialTheme.typography.bodyMedium,
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.None,
                            autoCorrectEnabled = false,
                            imeAction = ImeAction.Search,
                        ),
                        keyboardActions = KeyboardActions(onSearch = { shown.firstOrNull()?.let(::pick) }),
                        modifier = Modifier.fillMaxWidth().semantics { contentDescription = MachineSetupCopy.SETUP_GITHUB_SEARCH }
                            .testTag("setup-github-search"),
                    )
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(8.dp))
                            .background(MaterialTheme.colorScheme.surface)
                            .testTag("setup-github-list"),
                    ) {
                        when (val now = list) {
                            RepositoryList.Loading -> ListNote(MachineSetupCopy.SETUP_GITHUB_LOADING)
                            is RepositoryList.Failed -> Box(Modifier.padding(horizontal = 10.dp, vertical = 8.dp)) {
                                VerdictText(MachineSetupCopy.setupGithubListFailed(now.why), FolderVerdict.Tone.BAD)
                            }
                            is RepositoryList.Loaded -> if (shown.isEmpty()) ListNote(MachineSetupCopy.SETUP_GITHUB_NONE)
                                else shown.forEach { r -> RepositoryRow(r, enabled = !disabled) { pick(r) } }
                        }
                        integration.installUrl?.let { installUrl ->
                            HorizontalDivider()
                            Row(
                                Modifier.padding(horizontal = 10.dp, vertical = 7.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                MetaText(MachineSetupCopy.SETUP_GITHUB_NOT_LISTED)
                                ChangeLink("${MachineSetupCopy.SETUP_GITHUB_ADD_REPOSITORIES} ↗", enabled = true, tag = "setup-github-add") {
                                    uri.openUri(installUrl)
                                }
                            }
                        }
                    }
                }
            }
            else -> {
                Row(
                    Modifier.fillMaxWidth().testTag("setup-github-picked"),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    RepoMark(picked)
                    Text(
                        picked.fullName,
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    if (!branchOpen) {
                        Icon(
                            painterResource(R.drawable.ic_branch),
                            MachineSetupCopy.SETUP_DEFAULT_BRANCH,
                            Modifier.size(13.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        MetaText(picked.defaultBranch)
                    }
                    ChangeLink(MachineSetupCopy.SETUP_CHANGE, enabled = !disabled, tag = "setup-github-change") {
                        repo = null
                        answer = null
                    }
                }
                if (branchOpen) {
                    OutlinedTextField(
                        value = branch,
                        onValueChange = { branch = it },
                        placeholder = { Text(picked.defaultBranch) },
                        leadingIcon = { Icon(painterResource(R.drawable.ic_branch), null, Modifier.size(16.dp)) },
                        singleLine = true,
                        enabled = !disabled,
                        textStyle = LocalTextStyle.current.copy(fontFamily = FontFamily.Monospace),
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.None,
                            autoCorrectEnabled = false,
                            imeAction = ImeAction.Done,
                        ),
                        keyboardActions = KeyboardActions(onDone = { if (candidate != null) onEnter() }),
                        modifier = Modifier.fillMaxWidth().semantics { contentDescription = MachineSetupCopy.SETUP_BRANCH }
                            .testTag("setup-github-branch"),
                    )
                    // The branches route's names, as the web's field suggests them: those the typing matches, a few at a time.
                    val typed = branch.trim()
                    val suggestions = branchNames.filter { it != typed && (typed.isEmpty() || it.contains(typed, ignoreCase = true)) }.take(6)
                    if (suggestions.isNotEmpty()) FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                        modifier = Modifier.testTag("setup-github-branches"),
                    ) {
                        suggestions.forEach { b ->
                            Text(
                                b,
                                style = MaterialTheme.typography.labelSmall,
                                fontFamily = FontFamily.Monospace,
                                modifier = Modifier
                                    .clip(CircleShape)
                                    .background(MaterialTheme.colorScheme.surface)
                                    .clickable(enabled = !disabled, role = Role.Button) { branch = b }
                                    .padding(horizontal = 8.dp, vertical = 3.dp),
                            )
                        }
                    }
                }
                Row(
                    Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(
                        MachineSetup.newFolderPath(cloneRoot, ""),
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.StartEllipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    OutlinedTextField(
                        value = folder,
                        onValueChange = { folder = it },
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
                        keyboardActions = KeyboardActions(onDone = { if (candidate != null) onEnter() }),
                        modifier = Modifier.weight(1f).semantics { contentDescription = MachineSetupCopy.SETUP_NEW_FOLDER_NAME }
                            .testTag("setup-github-folder"),
                    )
                }
                when {
                    name.isEmpty() -> Unit
                    !MachineSetup.isValidNewFolder(name) -> VerdictText(MachineSetupCopy.SETUP_NEW_FOLDER_INVALID, FolderVerdict.Tone.BAD)
                    found?.exists == true -> VerdictText(MachineSetupCopy.setupGithubFolderExists(machine), FolderVerdict.Tone.BAD)
                    !found?.error.isNullOrEmpty() -> VerdictText(found?.error.orEmpty(), FolderVerdict.Tone.BAD)
                    settled && found == null -> NoAnswerRow(machine) { attempt++ }
                    found == null -> CheckingText(machine)
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    MetaText(MachineSetupCopy.SETUP_GITHUB_CLONED_META)
                    if (!branchOpen) ChangeLink(MachineSetupCopy.SETUP_OTHER_BRANCH, enabled = !disabled, tag = "setup-github-other-branch") {
                        branchOpen = true
                    }
                }
            }
        }
    }
}

@Composable
private fun ListNote(text: String) {
    Box(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp)) { MetaText(text) }
}

/** A lock for a private repository, GitHub's mark for a public one. */
@Composable
private fun RepoMark(repo: GithubRepository) {
    Icon(
        painterResource(if (repo.private) R.drawable.ic_lock else R.drawable.ic_github),
        if (repo.private) MachineSetupCopy.SETUP_GITHUB_PRIVATE else null,
        Modifier.size(14.dp),
        tint = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/** `orbit-labs/` dimmed, then `orbit-web`, and when it was pushed. */
@Composable
private fun RepositoryRow(repo: GithubRepository, enabled: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 7.dp)
            .testTag("setup-github-repo"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        RepoMark(repo)
        Text(
            buildAnnotatedString {
                withStyle(SpanStyle(color = MaterialTheme.colorScheme.onSurfaceVariant)) { append(repo.owner) }
                append(repo.name)
            },
            style = MaterialTheme.typography.bodySmall,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        MetaText(MachineSetupCopy.pushedAgo(repo.pushedAt))
    }
}

/** A link-styled action in the card's small type: Change, Other branch, Retry. */
@Composable
internal fun ChangeLink(text: String, enabled: Boolean, tag: String? = null, onClick: () -> Unit) {
    Text(
        text,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier
            .alpha(if (enabled) 1f else 0.38f)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .let { if (tag != null) it.testTag(tag) else it },
    )
}
