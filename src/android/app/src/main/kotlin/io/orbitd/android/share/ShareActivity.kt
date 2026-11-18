package io.orbitd.android.share

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import io.orbitd.android.OrbitApplication
import io.orbitd.android.R
import io.orbitd.android.attachments.AttachmentLimits
import io.orbitd.android.auth.AuthScreen
import io.orbitd.android.auth.AuthViewModel
import io.orbitd.android.auth.loginBackground
import io.orbitd.android.auth.openInSignInBrowser
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.directory.*
import io.orbitd.android.management.AccountAppearance
import io.orbitd.android.navigation.LastWorkspace
import io.orbitd.android.navigation.ObjectId
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Orbit in the system share sheet (docs/share-to-orbit-design.md §3.2, board 2): "Add to session" lists what was shared, a New session
 * row in a workspace, and the open sessions, the session list's rows. A tap picks; MainActivity then stages the items in that composer.
 * Signed out, the sign-in page comes first, and this page after it.
 */
class ShareActivity : ComponentActivity() {
    private lateinit var auth: AuthViewModel
    private var items by mutableStateOf(SharedItems(emptyList(), null, 0))

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        auth = ViewModelProvider(this, ViewModelProvider.AndroidViewModelFactory(application))[AuthViewModel::class.java]
        accept(intent, announce = savedInstanceState == null)
        val app = application as OrbitApplication
        setContent {
            AccountAppearance(app) {
                SharePage(app, auth, items, close = ::finish, continueWithGoogle = { address ->
                    auth.continueWithGoogle(address) { url -> ShareSignIn.waiting = true; openInSignInBrowser(this, url) }
                }) { target ->
                    startActivity(ShareIntents.handoff(this, target, items))
                    finish()
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (ShareIntents.isShare(intent)) { setIntent(intent); accept(intent, announce = true) }
        // Google's answer to a sign-in started here (GoogleSignInRedirectActivity sends it back while a share waits on it).
        else intent.data?.let { ShareSignIn.waiting = false; auth.handleGoogleCallback(it.toString()) }
    }

    override fun onResume() { super.onResume(); auth.onResumed() }

    private fun accept(intent: Intent, announce: Boolean) {
        items = ShareIntents.parse(intent)
        if (announce && items.dropped > 0)
            Toast.makeText(this, ShareCopy.keptFirst(items.count + items.dropped), Toast.LENGTH_LONG).show()
    }
}

/** A Google sign-in this share page started: its answer comes back to the page rather than to MainActivity. */
object ShareSignIn {
    @Volatile var waiting = false
}

/** A chip at the top of the page: what an item is called and how big it is. */
data class ShareChip(val label: String, val size: Long?, val tooLarge: Boolean)

internal fun formatSize(bytes: Long): String = when {
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> "%.0f KB".format(bytes / 1024.0)
    else -> "%.1f MB".format(bytes / (1024.0 * 1024.0))
}

@Composable
private fun rememberChips(items: SharedItems): List<ShareChip> {
    val context = androidx.compose.ui.platform.LocalContext.current
    val fallback = remember(items) { items.uris.map { ShareChip(it.lastPathSegment ?: "File", null, false) } }
    val chips by produceState(fallback, items) {
        value = withContext(Dispatchers.IO) {
            items.uris.map { uri: Uri ->
                var name: String? = null; var size: Long? = null
                runCatching {
                    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use {
                        if (it.moveToFirst()) {
                            name = it.getString(0)
                            if (!it.isNull(1)) size = it.getLong(1)
                        }
                    }
                }
                ShareChip(name ?: uri.lastPathSegment ?: "File", size, (size ?: 0) > AttachmentLimits.MAX_FILE)
            }
        }
    }
    val text = items.text?.let { text ->
        when (ShareIntents.route(text)) {
            is SharedText.Inline -> ShareChip(if (ShareIntents.isLink(text)) text.trim() else "${ShareCopy.TEXT_ITEM}: ${text.trim()}", null, false)
            is SharedText.File -> ShareChip(ShareIntents.TEXT_FILE_NAME, text.encodeToByteArray().size.toLong(), false)
        }
    }
    return chips + listOfNotNull(text)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SharePage(app: OrbitApplication, auth: AuthViewModel, items: SharedItems, close: () -> Unit,
    continueWithGoogle: (String) -> Unit, pick: (ShareTarget) -> Unit) {
    val authState by auth.state.collectAsState()
    val signedIn = authState as? AuthState.SignedIn
    if (signedIn == null) {
        val message by auth.message.collectAsState()
        val googleBusy by auth.googleBusy.collectAsState()
        Scaffold { padding ->
            Box(Modifier.fillMaxSize().loginBackground(MaterialTheme.colorScheme.primary).padding(padding).consumeWindowInsets(padding).imePadding()) {
                AuthScreen(authState, message, googleBusy, auth::login, auth::logout, auth::signInMethods, auth::rememberedEmail,
                    continueWithGoogle) {}
            }
        }
        return
    }
    key(signedIn.handle) { SessionPicker(app, signedIn.handle, items, close, pick) }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun SessionPicker(app: OrbitApplication, handle: SessionHandle, items: SharedItems, close: () -> Unit, pick: (ShareTarget) -> Unit) {
    val data by rememberDirectoryData(app, handle)
    val chips = rememberChips(items)
    var query by remember { mutableStateOf("") }
    val lastWorkspace = remember(handle) { LastWorkspace(app.session, handle) }
    LaunchedEffect(lastWorkspace) { lastWorkspace.load() }
    val workspaces = orderedWorkspaces(data.workspaces)
    var chosen by remember { mutableStateOf<String?>(null) }
    val workspace = workspaces.firstOrNull { ObjectId.same(it.id, chosen) }
        ?: workspaces.firstOrNull { ObjectId.same(it.id, lastWorkspace.id) } ?: workspaces.firstOrNull()
    val sessions = remember(data.sessions, query) {
        data.sessions["open"].orEmpty()
            .filter { query.isBlank() || it.name.contains(query.trim(), ignoreCase = true) }
            .sortedByDescending { it.lastTurnAt ?: it.createdAt.orEmpty() }
    }
    Scaffold(topBar = {
        CenterAlignedTopAppBar(title = { Text(ShareCopy.TITLE) }, navigationIcon = {
            IconButton(onClick = close) { Icon(painterResource(R.drawable.ic_close), ShareCopy.CLOSE) }
        })
    }) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).imePadding().testTag("share-picker")) {
            item {
                if (items.isEmpty) Text(ShareCopy.NOTHING_SHARED, Modifier.padding(16.dp), color = MaterialTheme.colorScheme.error)
                FlowRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    chips.forEach { ShareItemChip(it) }
                }
            }
            item { BottomSearchField(query, { query = it }) }
            item { NewSessionRow(workspaces, workspace, choose = { chosen = it }) { workspace?.let { pick(ShareTarget.NewSession(it.id)) } } }
            item { ListHeading(ShareCopy.RECENT) }
            if (data.ready && sessions.isEmpty()) item {
                Text(if (query.isBlank()) ShareCopy.NO_SESSIONS else ShareCopy.NO_MATCHES, Modifier.padding(16.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (!data.ready) item { Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() } }
            items(sessions, key = { it.id }) { session ->
                val target = session.workspace
                Box(Modifier.testTag("share-session:${session.id}")) {
                    SessionRow(session, data.machineName(target), onOpen = {
                        pick(ShareTarget.Session(session.id, target ?: workspace?.id.orEmpty()))
                    }) {}
                }
            }
        }
    }
}

@Composable
private fun ShareItemChip(chip: ShareChip) {
    val label = listOfNotNull(chip.label, chip.size?.let(::formatSize)).joinToString(" · ")
    Surface(shape = RoundedCornerShape(10.dp), border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outlineVariant),
        color = MaterialTheme.colorScheme.surfaceContainerLow, modifier = Modifier.widthIn(max = 320.dp).testTag("share-chip")) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
            Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium,
                textDecoration = if (chip.tooLarge) TextDecoration.LineThrough else null)
            if (chip.tooLarge) Text(ShareCopy.TOO_LARGE, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
        }
    }
}

@Composable
private fun NewSessionRow(workspaces: List<DirectoryWorkspace>, workspace: DirectoryWorkspace?, choose: (String) -> Unit, pick: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    ListItem(
        headlineContent = { Text(ShareCopy.NEW_SESSION) },
        leadingContent = { Icon(painterResource(R.drawable.ic_plus), null, tint = MaterialTheme.colorScheme.primary) },
        supportingContent = if (workspace == null) ({ Text(ShareCopy.NO_WORKSPACE) }) else null,
        trailingContent = workspace?.let { shown -> {
            Box {
                TextButton(onClick = { menu = true }, modifier = Modifier.testTag("share-workspace")) {
                    Text(shown.name, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 160.dp))
                    Icon(painterResource(R.drawable.ic_chevron_forward), ShareCopy.CHOOSE_WORKSPACE, Modifier.size(16.dp))
                }
                DropdownMenu(menu, onDismissRequest = { menu = false }) {
                    workspaces.forEach { w -> DropdownMenuItem(text = { Text(w.name) }, onClick = { menu = false; choose(w.id) }) }
                }
            }
        } },
        modifier = Modifier.fillMaxWidth().testTag("share-new-session")
            .clickable(enabled = workspace != null, role = Role.Button, onClick = pick))
}
