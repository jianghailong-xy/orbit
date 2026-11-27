package io.orbitd.android.navigation

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.foundation.MutatePriority
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.DraggableState
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.ProvideTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import io.orbitd.android.R
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.launch

/** The drawer's spacing rhythm, iOS `DrawerMetrics`: roomy ~44 dp rows, a hair between them, and a rounded selection pill inset
 * from both edges rather than an edge-to-edge tint. */
internal object DrawerMetrics {
    val hInset = 10.dp
    val padH = 12.dp
    val padV = 11.dp
    val corner = 10.dp
    val textLeading = hInset + padH
}

/** Where the drawer is: [isOpen] is where it is going or resting, [progress] how much of it shows (0 closed … 1 open). */
@Stable
class OrbitDrawerState {
    var isOpen by mutableStateOf(false)
        private set
    internal var width by mutableFloatStateOf(0f)
    internal var offset by mutableFloatStateOf(0f)
    internal val drag = DraggableState { delta -> offset = (offset + delta).coerceIn(0f, width) }
    val progress: Float get() = if (width > 0f) offset / width else 0f

    suspend fun open() = settle(true)
    suspend fun close() = settle(false)

    internal suspend fun settle(open: Boolean, velocity: Float = 0f) {
        isOpen = open
        // Default priority: a finger landing mid-animation takes the drawer over.
        drag.drag(MutatePriority.Default) {
            var last = offset
            val target = if (open) width else 0f
            animate(last, target, velocity, tween(250, easing = FastOutSlowInEasing)) { value, _ -> dragBy(value - last); last = value }
            // The deltas' float sum stops a hair off the end (3e-8 seen): land exactly, or a closed drawer still reads as showing.
            offset = target
        }
    }

    internal fun resize(newWidth: Float) {
        width = newWidth
        offset = if (isOpen) newWidth else 0f
    }
}

@Composable
fun rememberOrbitDrawerState(): OrbitDrawerState = remember { OrbitDrawerState() }

/** iOS `CompactShell`: the drawer stays put at the leading edge and the page slides right off it as a card — corners rounding and
 * its shadow growing in with the peek — kept fully bright, with no scrim. A press on the page's peek, a drag back or Back closes it;
 * a horizontal drag anywhere opens it, past halfway or with a fling. Closed, the drawer is moved one width off screen, where
 * Material's closed sheet sat, so it is neither on screen nor in reach for anything reading the screen. */
@Composable
fun OrbitDrawerShell(state: OrbitDrawerState, drawer: @Composable () -> Unit, content: @Composable () -> Unit) {
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    val surface = LocalOrbitColors.current.drawer
    val page = MaterialTheme.colorScheme.background
    val fling = with(density) { 400.dp.toPx() }
    BoxWithConstraints(Modifier.fillMaxSize().background(surface).draggable(state.drag, Orientation.Horizontal,
        onDragStopped = { velocity ->
            state.settle(when {
                velocity > fling -> true
                velocity < -fling -> false
                else -> state.offset > state.width / 2
            }, velocity)
        })) {
        // ChatGPT-style peek, as iOS sizes it: about three quarters of the width, at most 324.
        val drawerWidth = min(324.dp, maxWidth * 0.76f)
        val widthPx = with(density) { drawerWidth.toPx() }
        LaunchedEffect(widthPx) { state.resize(widthPx) }
        val shown by remember { derivedStateOf { state.offset > 0f } }
        Box(Modifier.width(drawerWidth).fillMaxHeight().graphicsLayer { translationX = if (shown) 0f else -size.width }) {
            // What Material's sheet gave its content: the drawer's words in the surface's ink, in either theme.
            CompositionLocalProvider(LocalContentColor provides MaterialTheme.colorScheme.onSurface) { drawer() }
        }
        Box(Modifier.fillMaxSize().graphicsLayer {
            val p = state.progress
            translationX = state.offset
            shape = RoundedCornerShape(36.dp.toPx() * p)
            clip = p > 0f
            shadowElevation = 24.dp.toPx() * p
            ambientShadowColor = Color.Black
            spotShadowColor = Color.Black
        }.background(page)) {
            content()
            if (shown) Box(Modifier.fillMaxSize().testTag("drawer-scrim")
                .semantics { contentDescription = "Close navigation"; onClick { scope.launch { state.close() }; true } }
                .pointerInput(Unit) { detectTapGestures { scope.launch { state.close() } } })
        }
    }
}

/** The drawer's panel (iOS `NavigationDrawer`): its rows scroll between a header that floats over their top and an action bar that
 * floats over their bottom, each standing on a soft edge of the drawer's own colour, so the rows fade under them rather than being
 * cut at a line. */
@Composable
fun DrawerPanel(header: @Composable () -> Unit, actions: @Composable () -> Unit, rows: @Composable ColumnScope.() -> Unit) {
    val surface = LocalOrbitColors.current.drawer
    val clear = surface.copy(alpha = 0f)
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).imePadding()
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Vertical + WindowInsetsSides.Start))
            .padding(top = HEADER_HEIGHT, bottom = 84.dp)) { rows() }
        Box(Modifier.align(Alignment.TopStart).fillMaxWidth().background(Brush.verticalGradient(0.8f to surface, 1f to clear))
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Start)).padding(bottom = 12.dp)) { header() }
        Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().background(Brush.verticalGradient(0f to clear, 0.3f to surface))
            .padding(top = 16.dp).windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom + WindowInsetsSides.Start))) { actions() }
    }
}

private val HEADER_HEIGHT = 66.dp

/** iOS `drawerHeader`: the title and the search disc. */
@Composable
fun DrawerHeader(onSearch: () -> Unit) {
    Row(Modifier.fillMaxWidth().height(HEADER_HEIGHT).padding(start = DrawerMetrics.textLeading, end = DrawerMetrics.hInset, top = 14.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Text("Orbit", Modifier.weight(1f), style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.Bold))
        DrawerDisc(R.drawable.ic_search, "Search sessions", raised = false, onClick = onSearch)
    }
}

/** iOS `actionBar`: a prominent New session capsule and, trailing it, the round Settings button. */
@Composable
fun DrawerActionBar(onNewSession: () -> Unit, onSettings: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(start = DrawerMetrics.hInset, end = DrawerMetrics.hInset, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Button(onClick = onNewSession, Modifier.shadow(8.dp, CircleShape, clip = false),
            contentPadding = PaddingValues(horizontal = 18.dp, vertical = 11.dp)) {
            Icon(painterResource(R.drawable.ic_compose), null, Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text("New session", fontWeight = FontWeight.SemiBold)
        }
        Spacer(Modifier.weight(1f).widthIn(min = 8.dp))
        DrawerDisc(R.drawable.ic_settings, "Settings", raised = true, onClick = onSettings, modifier = Modifier.testTag("drawer:settings"))
    }
}

/** iOS `DrawerCircleGlyph`: a 44 dp disc — the header's search a flat grey chip, the action bar's Settings a raised one. */
@Composable
private fun DrawerDisc(icon: Int, description: String, raised: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    Surface(onClick = onClick, modifier = modifier.size(44.dp), shape = CircleShape,
        color = if (raised) colors.surface else colors.onSurface.copy(alpha = 0.08f), contentColor = colors.onSurface,
        shadowElevation = if (raised) 4.dp else 0.dp) {
        Box(contentAlignment = Alignment.Center) { Icon(painterResource(icon), description, Modifier.size(22.dp)) }
    }
}

/** iOS `pill` + `drawerRow`: one drawer row — an optional 24 dp icon, its label, and one trailing slot — with the selected row on a
 * rounded tint. Said as a tab, selected or not, as Material's drawer item was. */
@Composable
fun DrawerRow(selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, icon: Int? = null, iconTint: Color? = null,
    trailing: (@Composable () -> Unit)? = null, label: @Composable () -> Unit) {
    val accent = MaterialTheme.colorScheme.primary
    Row(modifier.padding(horizontal = DrawerMetrics.hInset, vertical = 1.dp).fillMaxWidth()
        .background(if (selected) accent.copy(alpha = 0.14f) else Color.Transparent, RoundedCornerShape(DrawerMetrics.corner))
        .selectable(selected, onClick = onClick, role = Role.Tab)
        .padding(horizontal = DrawerMetrics.padH, vertical = DrawerMetrics.padV),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        if (icon != null) Icon(painterResource(icon), null, Modifier.size(24.dp), tint = iconTint ?: if (selected) accent else MaterialTheme.colorScheme.onSurface)
        Box(Modifier.weight(1f)) {
            ProvideTextStyle(MaterialTheme.typography.bodyLarge.copy(fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal)) { label() }
        }
        trailing?.invoke()
    }
}

/** A drawer row's plain label: one line, cut with an ellipsis. */
@Composable
fun DrawerLabel(text: String, color: Color = Color.Unspecified) = Text(text, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis)

/** iOS `workspacesHeader`: the rule and the group label that set the Workspaces apart from the work above them. */
@Composable
fun DrawerWorkspacesHeading(title: String, trailing: (@Composable () -> Unit)? = null) {
    Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
        androidx.compose.material3.HorizontalDivider(Modifier.padding(start = DrawerMetrics.textLeading, end = DrawerMetrics.hInset),
            color = MaterialTheme.colorScheme.outline.copy(alpha = 0.3f))
        // New workspace on any machine (docs/mocks/new-workspace-form/02-apple-entry, owner A): the + at the heading's trailing edge.
        Row(Modifier.fillMaxWidth().padding(start = DrawerMetrics.textLeading, end = DrawerMetrics.textLeading - 4.dp),
            verticalAlignment = Alignment.Bottom) {
            Text(title, Modifier.weight(1f).padding(top = 14.dp, bottom = 4.dp).semantics { heading() },
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold), color = MaterialTheme.colorScheme.onSurfaceVariant)
            trailing?.invoke()
        }
    }
}

/** iOS `WorkspaceNavigationRow` in its drawer pill: the folder (Orbit Cloud's cloud for a workspace there, board
 * docs/mocks/workspace-machine-icon B), "name · runner" on one line (a disabled workspace says so after its
 * name), and one trailing slot for its state — how many wait on you, else the running spinner while the drawer shows, else its
 * runner's state (Offline, or a managed runner's Asleep…). An offline runner's folder is dimmed. */
@Composable
fun DrawerWorkspaceRow(name: String, runner: String?, cloud: Boolean = false, disabled: Boolean, stateLabel: String?, waiting: Int, running: Int, live: Boolean,
    selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    // How many run is said whether or not the spinner is drawn: the drawer stays composed while closed.
    DrawerRow(selected, onClick, modifier.semantics { if (running > 0) stateDescription = "$running running" },
        icon = if (cloud) R.drawable.ic_cloud else R.drawable.ic_workspace,
        iconTint = if (stateLabel != null && !selected) secondary.copy(alpha = 0.6f) else null,
        trailing = when {
            waiting > 0 -> ({ NeedsYouCount(waiting) })
            running > 0 && live -> ({ RunningMark() })
            stateLabel != null -> ({ Text(stateLabel, style = MaterialTheme.typography.labelMedium, color = secondary, maxLines = 1) })
            else -> null
        }) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            // The name wins the width (iOS layoutPriority 2); the runner takes what is left.
            Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (disabled) Text("disabled", Modifier.padding(start = 6.dp)
                .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.1f), CircleShape).padding(horizontal = 5.dp, vertical = 1.dp),
                style = MaterialTheme.typography.labelSmall, maxLines = 1)
            if (!runner.isNullOrEmpty()) Text(" · $runner", Modifier.weight(1f, fill = false), color = secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** A drawer group's label and how many rows it heads (iOS `CompactShell.drawerGroupLabel`). */
@Composable
internal fun DrawerGroupLabel(title: String, count: Int) {
    val color = MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.padding(start = DrawerMetrics.textLeading, top = 14.dp, bottom = 4.dp)
        .semantics(mergeDescendants = true) { heading() }.testTag("drawer-group:$title"),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold), color = color)
        Text("$count", style = MaterialTheme.typography.labelSmall, color = color)
    }
}

/** The amber count in a drawer row's trailing slot (iOS `NeedsYouCountCapsule`): how many things under the row wait on you. */
@Composable
internal fun NeedsYouCount(count: Int, modifier: Modifier = Modifier) {
    val amber = LocalOrbitColors.current.needsYou
    Text("$count", modifier.background(amber.copy(alpha = 0.15f), RoundedCornerShape(50)).padding(horizontal = 7.dp, vertical = 2.dp)
        .clearAndSetSemantics { contentDescription = DrawerCopy.waitingForYou(count) },
        color = amber, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
}

/** The running spinner in a drawer row's trailing slot (iOS `SpinnerGlyph(color: .secondary)`, said "Running"). */
@Composable
internal fun RunningMark(modifier: Modifier = Modifier, size: Dp = 12.dp) {
    Box(modifier.clearAndSetSemantics { contentDescription = DrawerCopy.running }) {
        androidx.compose.material3.CircularProgressIndicator(Modifier.size(size), color = MaterialTheme.colorScheme.onSurfaceVariant, strokeWidth = 1.5.dp)
    }
}
