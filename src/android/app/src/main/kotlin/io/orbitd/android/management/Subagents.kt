package io.orbitd.android.management

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.util.Locale

/** One model of GET providers/subagent-tiers (shared ProviderModelTier). */
internal data class SubagentTierModel(val model: String, val levels: List<String>, val source: String?, val editable: Boolean,
                                      val outputPricePerMTok: Double?, val supersededBy: String? = null,
                                      val quality: SubagentQuality = SubagentQuality.NONE)

/** Who rated a model's SubAgent runs (shared ModelQualityRater): a parent's own model and how many ratings it gave. */
internal data class SubagentQualityRater(val provider: String, val label: String?, val count: Int)

/** A model's Quality (shared ModelQuality, docs/subagent-design.md §7.1): shown beside its tier, never read by routing. The
 *  average is null below 5 ratings and the rate below 10 done tasks. */
internal data class SubagentQuality(val averageRating: Double?, val ratedCount: Int, val runCount: Int, val raters: List<SubagentQualityRater>,
                                    val firstPassRate: Double?, val firstPassTaskCount: Int, val completedTaskCount: Int) {
    companion object {
        val NONE = SubagentQuality(null, 0, 0, emptyList(), null, 0, 0)

        fun of(quality: JsonObject?): SubagentQuality {
            val subagent = quality?.obj("subagent")
            val tasks = quality?.obj("tasks")
            return SubagentQuality(
                subagent?.dbl("averageRating"), subagent?.int("ratedCount") ?: 0, subagent?.int("runCount") ?: 0,
                subagent?.list("raters").orEmpty().map { SubagentQualityRater(it.str("provider").orEmpty(), it.str("label"), it.int("count") ?: 0) },
                tasks?.dbl("firstPassRate"), tasks?.int("firstPassTaskCount") ?: 0, tasks?.int("completedTaskCount") ?: 0,
            )
        }
    }
}

/** One line of the Quality cell: its figure, or why there is none (muted). */
internal data class QualityLine(val text: String, val muted: Boolean)

/** The Quality cell (board docs/mocks/model-quality/01-board.png, owner's A1·B1·C1), as iOS and web read it: a SubAgents line and a
 *  Tasks line, or "No runs yet" alone; `raters` is what a tap on the SubAgents line shows. */
internal data class QualityLines(val empty: Boolean, val subagents: QualityLine, val raters: String?, val tasks: QualityLine)

/** One provider of GET providers/subagent-tiers (shared ProviderTierRow), in the owner's provider order. */
internal data class SubagentProvider(val slug: String, val label: String, val kind: String, val providerId: String?, val billing: String,
                                     val models: List<SubagentTierModel>)

/** An Agent's SubAgents fields as GET workspaces/:id carries them, each with its default when absent (docs/subagent-design.md §7),
 * and its Workflows switch (docs/subagent-workflow-design.md §6). */
internal data class SubagentSettings(val enabled: Boolean, val maxRunning: Int, val workflowsEnabled: Boolean) {
    companion object {
        fun of(workspace: JsonObject) = SubagentSettings(
            workspace.bool("subagentsEnabled") ?: true,
            (workspace.int("subagentsMaxRunning") ?: 4).coerceIn(1, Subagents.MAX_RUNNING),
            workspace.bool("workflowsEnabled") ?: true,
        )
    }
}

/** The SubAgents settings and the Providers page's Model tiers (docs/subagent-design.md §7, docs/mocks/subagent/05.png). */
internal object Subagents {
    const val GROUP = "SubAgents"
    const val SWITCH = "SubAgents"
    const val SWITCH_DETAIL = "Let this agent hand work to other providers in the same folder"
    const val WORKFLOWS = "Workflows"
    const val WORKFLOWS_DETAIL = "Let this agent run a script that starts many SubAgents and wakes it once"
    const val PROVIDERS = "Providers"
    const val PROVIDERS_DETAIL = "All enabled providers. Block one to keep SubAgents off it."
    const val RUNNING = "Running at once"
    const val RUNNING_DETAIL = "Per session: delegated SubAgents and workflow calls together"
    const val TIERS = "Model tiers"
    const val TIERS_FOOTER = "Preset tiers and prices follow the catalogue. A model with no tier still runs SubAgents, after every model whose tier fits."
    const val NOT_SET = "Not set"
    const val SUBSCRIPTION = "Subscription"
    const val CLEAR = "Clear"
    /** The tag after a tier the owner set (board 2026-11-20). */
    const val YOURS = "Yours"
    const val EDIT = "Edit"
    const val PROVIDERS_LOAD_FAILED = "Couldn't load providers"
    const val SAVE_BLOCKED_FAILED = "Couldn't save blocked providers"
    const val TIER_SAVE_FAILED = "Couldn't save the tier"
    const val QUALITY = "Quality"
    const val QUALITY_SUBAGENTS = "SubAgents"
    const val QUALITY_TASKS = "Tasks"
    const val NOT_ENOUGH_RATINGS = "Not enough ratings"
    const val NOT_ENOUGH_TASKS = "Not enough tasks"
    const val NO_RUNS_YET = "No runs yet"
    const val QUALITY_FOOTER = "Quality is shown, not used for routing. SubAgents: the parent session's 1–5 rating of each result, last 90 days, " +
        "recent ratings weighed more. Tasks: share of done tasks that passed on their first run; runs that hit a usage limit or a model at " +
        "capacity are left out."
    const val MAX_RUNNING = 16
    val LEVELS = listOf("S", "M", "L", "XL")

    fun decode(body: JsonElement): List<SubagentProvider> = ((body as? JsonObject)?.list("providers")).orEmpty().mapNotNull { row ->
        val slug = row.str("slug")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
        SubagentProvider(slug, row.str("label") ?: slug, row.str("kind").orEmpty(), row.str("providerId"), row.str("billing").orEmpty(),
            row.list("models").mapNotNull { model ->
                val name = model.str("model")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                SubagentTierModel(name, model.strings("levels"), model.str("source"), model.bool("editable") == true, model.dbl("outputPricePerMTok"), model.str("supersededBy"),
                    SubagentQuality.of(model.obj("quality")))
            })
    }

    /** users/me's preferences.subagentBlockedProviders; absent is none blocked. */
    fun blocked(user: JsonElement): List<String> = (user as? JsonObject)?.obj("preferences")?.strings("subagentBlockedProviders").orEmpty()

    fun tierText(levels: List<String>) = when {
        levels.isEmpty() -> NOT_SET
        levels.containsAll(LEVELS) -> "S–XL by effort"
        else -> levels.joinToString(" · ")
    }

    /** A model's Tier cell: [tierText], but an older family member reads "Older · uses <newest>" in place of Not set. */
    fun modelTierText(model: SubagentTierModel) =
        if (model.levels.isEmpty() && model.supersededBy != null) "Older · uses ${model.supersededBy}" else tierText(model.levels)

    /** Whether the Tier cell reads Older (muted, not a warning). */
    fun isOlder(model: SubagentTierModel) = model.levels.isEmpty() && model.supersededBy != null

    /** Where a model's tier is written: a built-in engine's catalogue, or a key of the owner's own; null when it is not the owner's to set. */
    fun tierPath(provider: SubagentProvider, model: SubagentTierModel): String? = when {
        !model.editable -> null
        provider.kind == "builtin" -> "providers/builtin/${provider.slug}/model-tier"
        else -> provider.providerId?.let { "providers/mine/$it/model-tier" }
    }

    /** Whether the menu offers Clear: a key's model with a tier, or a built-in engine's model the owner tiered. */
    fun offersClear(provider: SubagentProvider, model: SubagentTierModel) =
        if (provider.kind == "builtin") model.source == "owner" else model.levels.isNotEmpty()

    /** Whether the Tier cell carries the Yours tag: a tier the owner set. */
    fun showsYours(model: SubagentTierModel) = model.source == "owner"

    /** A model's Quality cell: "4.2 · 18 rated of 40" and "82% first pass · 34 tasks", each "Not enough …" below its minimum, and
     *  "Rated by Opus 5.5 (18)" for the SubAgents line where there is an average. */
    fun qualityLines(quality: SubagentQuality): QualityLines {
        val raters = quality.raters.joinToString(" · ") { "${it.label ?: it.provider} (${it.count})" }
        return QualityLines(
            empty = quality.runCount == 0 && quality.completedTaskCount == 0,
            subagents = quality.averageRating?.let {
                QualityLine(String.format(Locale.US, "%.1f · %d rated of %d", it, quality.ratedCount, quality.runCount), false)
            } ?: QualityLine(NOT_ENOUGH_RATINGS, true),
            raters = if (quality.averageRating != null && raters.isNotEmpty()) "Rated by $raters" else null,
            tasks = quality.firstPassRate?.let {
                QualityLine("${Math.round(it * 100)}% first pass · ${quality.completedTaskCount} tasks", false)
            } ?: QualityLine(NOT_ENOUGH_TASKS, true),
        )
    }

    fun priceText(model: SubagentTierModel, billing: String) = when {
        model.outputPricePerMTok != null -> String.format(Locale.US, "$%.2f", model.outputPricePerMTok)
        billing == "subscription" -> SUBSCRIPTION
        else -> "—"
    }

    /** "N of M": the providers SubAgents may use of all of them. */
    fun allowedLine(providers: List<SubagentProvider>, blocked: Collection<String>) =
        "${providers.count { it.slug !in blocked }} of ${providers.size}"

    /** The Providers row's button: "5 of 6 · Edit". */
    fun providersButton(providers: List<SubagentProvider>, blocked: Collection<String>) = "${allowedLine(providers, blocked)} · $EDIT"

    /** The blocked list after one provider's switch moves: on removes it, off adds it (once), at the end (iOS SubagentSettings.blocked). */
    fun blocked(blocked: List<String>, slug: String, allowed: Boolean): List<String> =
        blocked.filter { it != slug }.let { if (allowed) it else it + slug }
}

/**
 * The Agent form's SubAgents group (docs/mocks/subagent/05.png, its Workflows row from docs/mocks/subagent-workflow part 5): the
 * switch, Workflows, the Providers SubAgents may use, and how many run at once. The switches and Running at once are the Agent's
 * and saved with the form's Done; the providers blocked are the account's (users/me/preferences) and saved from their own list.
 * Workflows follows SubAgents: every call of a workflow is a SubAgent, so with SubAgents off it reads off and cannot be turned on.
 */
@Composable
internal fun SubagentsSection(api: ManagementApi, enabled: Boolean, setEnabled: (Boolean) -> Unit,
                              workflowsEnabled: Boolean, setWorkflowsEnabled: (Boolean) -> Unit,
                              maxRunning: Int, setMaxRunning: (Int) -> Unit) {
    var providers by remember(api) { mutableStateOf<List<SubagentProvider>?>(null) }
    var blocked by remember(api) { mutableStateOf<List<String>>(emptyList()) }
    var failure by remember(api) { mutableStateOf<String?>(null) }
    var editing by remember { mutableStateOf(false) }
    LaunchedEffect(api) {
        try {
            blocked = Subagents.blocked(api.get("users/me"))
            providers = Subagents.decode(api.get("providers/subagent-tiers"))
            failure = null
        } catch (e: CancellationException) { throw e } catch (_: Exception) { failure = Subagents.PROVIDERS_LOAD_FAILED }
    }
    FormSection(Subagents.GROUP) {
        Row(Modifier.fillMaxWidth().toggleable(enabled, role = Role.Switch) { setEnabled(it) }.padding(vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(Subagents.SWITCH)
                Text(Subagents.SWITCH_DETAIL, style = MaterialTheme.typography.labelMedium, color = Ink.muted)
            }
            Switch(checked = enabled, onCheckedChange = null)
        }
        HorizontalDivider()
        val workflows = enabled && workflowsEnabled
        Row(Modifier.fillMaxWidth().toggleable(workflows, enabled = enabled, role = Role.Switch) { setWorkflowsEnabled(it) }
            .padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(Subagents.WORKFLOWS)
                Text(Subagents.WORKFLOWS_DETAIL, style = MaterialTheme.typography.labelMedium, color = Ink.muted)
            }
            Switch(checked = workflows, onCheckedChange = null, enabled = enabled)
        }
        HorizontalDivider()
        Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(Subagents.PROVIDERS)
                Text(Subagents.PROVIDERS_DETAIL, style = MaterialTheme.typography.labelMedium, color = Ink.muted)
                failure?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = Ink.red) }
            }
            val listed = providers
            OutlinedButton(onClick = { editing = true }, enabled = listed != null, modifier = Modifier.testTag("subagent-providers")) {
                Text(listed?.let { Subagents.providersButton(it, blocked) } ?: Subagents.EDIT, maxLines = 1)
            }
        }
        HorizontalDivider()
        Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(Subagents.RUNNING)
                Text(Subagents.RUNNING_DETAIL, style = MaterialTheme.typography.labelMedium, color = Ink.muted)
            }
            Stepper(maxRunning, 1..Subagents.MAX_RUNNING, setMaxRunning)
        }
    }
    val listed = providers
    if (editing && listed != null) SubagentProvidersDialog(listed, blocked, onDismiss = { editing = false }) { list ->
        api.patch("users/me/preferences", buildJsonObject { putJsonArray("subagentBlockedProviders") { list.forEach { add(it) } } })
        blocked = list
    }
}

/** − value +, kept within [range]. */
@Composable
private fun Stepper(value: Int, range: IntRange, set: (Int) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        OutlinedButton(onClick = { set(value - 1) }, enabled = value > range.first, contentPadding = PaddingValues(0.dp),
            modifier = Modifier.size(40.dp).semantics { contentDescription = "Fewer" }) { Text("−") }
        Text("$value", Modifier.widthIn(min = 32.dp).testTag("subagents-running"), style = MaterialTheme.typography.titleMedium,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        OutlinedButton(onClick = { set(value + 1) }, enabled = value < range.last, contentPadding = PaddingValues(0.dp),
            modifier = Modifier.size(40.dp).semantics { contentDescription = "More" }) { Text("+") }
    }
}

/** Every provider with a switch, on while SubAgents may use it. Each switch writes the account's whole blocked list at once (iOS
 * SubagentProvidersSheet); one that could not be saved goes back. */
@Composable
internal fun SubagentProvidersDialog(providers: List<SubagentProvider>, blocked: List<String>, onDismiss: () -> Unit,
                                     save: suspend (List<String>) -> Unit) {
    var list by remember { mutableStateOf(blocked) }
    var saving by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    fun move(slug: String, allowed: Boolean) {
        val before = list
        val after = Subagents.blocked(before, slug, allowed)
        list = after; saving = true; failure = null
        scope.launch {
            try { save(after) }
            catch (e: CancellationException) { throw e } catch (_: Exception) { list = before; failure = Subagents.SAVE_BLOCKED_FAILED }
            finally { saving = false }
        }
    }
    AlertDialog(onDismissRequest = onDismiss, title = { Text(Subagents.PROVIDERS) }, text = {
        Column(Modifier.verticalScroll(rememberScrollState())) {
            providers.forEach { provider ->
                val allowed = provider.slug !in list
                Row(Modifier.fillMaxWidth().toggleable(allowed, enabled = !saving, role = Role.Switch) { move(provider.slug, it) }
                    .padding(vertical = 8.dp).testTag("subagent-provider:${provider.slug}"), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                        Text(provider.label)
                        if (provider.label != provider.slug) Text(provider.slug, style = MaterialTheme.typography.bodySmall, color = Ink.muted)
                    }
                    Switch(checked = allowed, onCheckedChange = null)
                }
            }
            failure?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = Ink.red) }
            Text(Subagents.PROVIDERS_DETAIL, Modifier.padding(top = 8.dp), style = MaterialTheme.typography.bodySmall, color = Ink.muted)
        }
    }, confirmButton = { TextButton(onClick = onDismiss) { Text("Done") } })
}

/**
 * The Providers page's Model tiers (docs/subagent-design.md §7): each provider's models with the tiers routing reads for them and their
 * price per million output tokens. A model the owner may tier (a key's own, or any of a built-in engine's catalogue) opens a menu of the
 * four, and Clear where the owner's tier can be cleared; a tier the owner set carries a Yours tag. On a phone the provider sits above its
 * model in one cell.
 */
@Composable
internal fun ModelTiersSection(api: ManagementApi, revision: Long) {
    var providers by remember(api) { mutableStateOf<List<SubagentProvider>?>(null) }
    var failure by remember(api) { mutableStateOf<String?>(null) }
    var reads by remember { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(api, revision, reads) {
        try { providers = Subagents.decode(api.get("providers/subagent-tiers")); failure = null }
        catch (e: CancellationException) { throw e } catch (_: Exception) { if (providers == null) failure = Subagents.PROVIDERS_LOAD_FAILED }
    }
    val rows = providers.orEmpty().filter { it.models.isNotEmpty() }
    if (providers != null && rows.isEmpty() && failure == null) return
    FormSection(Subagents.TIERS, footer = Subagents.TIERS_FOOTER + "\n\n" + Subagents.QUALITY_FOOTER) {
        failure?.let { Text(it, Modifier.padding(vertical = 8.dp), style = MaterialTheme.typography.labelMedium, color = Ink.red) }
        if (providers == null && failure == null) Text("Loading…", Modifier.padding(vertical = 8.dp), color = Ink.muted)
        if (rows.isNotEmpty()) BoxWithConstraints {
            val wide = maxWidth >= 520.dp
            Column {
                TierRow(wide, header = true, provider = { Text(if (wide) "Provider" else "Provider / Model", style = it) },
                    model = { Text("Model", style = it) },
                    tier = { Text("Tier", style = it) }, quality = { Text(Subagents.QUALITY, style = it) },
                    price = { Text("Price / M out", style = it) })
                rows.forEach { provider ->
                    provider.models.forEach { model ->
                        HorizontalDivider()
                        TierRow(wide, header = false,
                            provider = { Text(provider.label, style = it, maxLines = 1) },
                            model = { Text(model.model, style = it.copy(fontFamily = FontFamily.Monospace), maxLines = 1) },
                            tier = { style ->
                                TierCell(provider, model, style) { path, tier ->
                                    scope.launch {
                                        try {
                                            api.patch(path, buildJsonObject {
                                                put("model", model.model); put("tier", tier?.let(::JsonPrimitive) ?: JsonNull)
                                            })
                                            reads++; failure = null
                                        } catch (e: CancellationException) { throw e } catch (_: Exception) { failure = Subagents.TIER_SAVE_FAILED }
                                    }
                                }
                            },
                            quality = { QualityCell(provider, model, it) },
                            price = { Text(Subagents.priceText(model, provider.billing), style = it, maxLines = 1,
                                color = if (model.outputPricePerMTok == null) Ink.muted else MaterialTheme.colorScheme.onSurface) })
                    }
                }
            }
        }
    }
}

@Composable
private fun TierRow(wide: Boolean, header: Boolean, provider: @Composable (androidx.compose.ui.text.TextStyle) -> Unit,
                    model: @Composable (androidx.compose.ui.text.TextStyle) -> Unit, tier: @Composable (androidx.compose.ui.text.TextStyle) -> Unit,
                    quality: @Composable (androidx.compose.ui.text.TextStyle) -> Unit,
                    price: @Composable (androidx.compose.ui.text.TextStyle) -> Unit) {
    val style = if (header) MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold, color = Ink.muted)
        else MaterialTheme.typography.bodyMedium
    val small = if (header) style else if (wide) MaterialTheme.typography.bodyMedium else MaterialTheme.typography.bodySmall.copy(color = Ink.muted)
    if (wide) Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        // Quality holds a source word and a figure with its count, so it takes the room the others can spare.
        Box(Modifier.weight(0.75f)) { provider(style) }
        Box(Modifier.weight(1.4f)) { model(small) }
        Box(Modifier.weight(1.1f)) { tier(style) }
        Box(Modifier.weight(2.1f)) { quality(small) }
        Box(Modifier.weight(0.75f), contentAlignment = Alignment.CenterEnd) { price(style) }
    } else Column(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        // A phone, as iOS: provider, tier and price on one line, the model across the full width under them. Tier and price
        // are as wide as their longest values ("S–XL by effort", "Subscription"), so the columns line up.
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.weight(1f)) { provider(style) }
            Box(Modifier.width(112.dp)) { tier(style) }
            Box(Modifier.width(96.dp), contentAlignment = Alignment.CenterEnd) { price(style) }
        }
        if (!header) {
            model(small)
            // The Quality lines under the model name, as iOS draws them (board docs/mocks/model-quality/01-board.png, note E).
            Box(Modifier.padding(top = 2.dp)) { quality(small) }
        }
    }
}

/** A model's Quality cell (docs/subagent-design.md §7.1): a SubAgents line and a Tasks line, or "No runs yet". A tap on the SubAgents
 *  line shows who rated, as the iOS popover does. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun QualityCell(provider: SubagentProvider, model: SubagentTierModel, style: androidx.compose.ui.text.TextStyle) {
    val lines = Subagents.qualityLines(model.quality)
    val base = style.copy(color = MaterialTheme.colorScheme.onSurface)
    if (lines.empty) {
        Text(Subagents.NO_RUNS_YET, style = base, color = Ink.muted, maxLines = 1,
            modifier = Modifier.testTag("quality:${provider.slug}:${model.model}"))
        return
    }
    Column(Modifier.testTag("quality:${provider.slug}:${model.model}"), verticalArrangement = Arrangement.spacedBy(1.dp)) {
        val subagents = @Composable { modifier: Modifier -> QualityLineRow(Subagents.QUALITY_SUBAGENTS, lines.subagents, base, modifier) }
        val raters = lines.raters
        if (raters == null) subagents(Modifier)
        else {
            val state = rememberTooltipState(isPersistent = true)
            val scope = rememberCoroutineScope()
            TooltipBox(TooltipDefaults.rememberTooltipPositionProvider(TooltipAnchorPosition.Above), tooltip = { PlainTooltip { Text(raters) } },
                state = state) {
                subagents(Modifier.clickable { scope.launch { if (state.isVisible) state.dismiss() else state.show() } }
                    .semantics { contentDescription = raters }
                    .testTag("quality-raters:${provider.slug}:${model.model}"))
            }
        }
        QualityLineRow(Subagents.QUALITY_TASKS, lines.tasks, base, Modifier)
    }
}

@Composable
private fun QualityLineRow(source: String, line: QualityLine, style: androidx.compose.ui.text.TextStyle, modifier: Modifier) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(source, Modifier.width(62.dp), style = MaterialTheme.typography.labelSmall, color = Ink.muted, maxLines = 1)
        // Never cut: a column too narrow for a figure and its count wraps it instead.
        Text(line.text, style = style, color = if (line.muted) Ink.muted else style.color, maxLines = 2)
    }
}

@Composable
private fun TierCell(provider: SubagentProvider, model: SubagentTierModel, style: androidx.compose.ui.text.TextStyle,
                     set: (String, String?) -> Unit) {
    val text = Subagents.modelTierText(model)
    val color = if (Subagents.isOlder(model)) Ink.muted else if (model.levels.isEmpty()) Ink.amber else MaterialTheme.colorScheme.onSurface
    val path = Subagents.tierPath(provider, model)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        // "Older · uses <model>" is longer than the Tier column: it wraps there, every other value stays on one line.
        val lines = if (Subagents.isOlder(model)) 3 else 1
        if (path == null) Text(text, style = style, color = color, maxLines = lines)
        else {
            var open by remember { mutableStateOf(false) }
            Box {
                Text("$text ▾", Modifier.clickable(role = Role.DropdownList) { open = true }.testTag("tier:${provider.slug}:${model.model}"),
                    style = style, color = color, maxLines = lines)
                DropdownMenu(open, { open = false }) {
                    Subagents.LEVELS.forEach { level ->
                        DropdownMenuItem(text = { Text(level) }, trailingIcon = if (model.levels == listOf(level)) { { Text("✓") } } else null,
                            onClick = { open = false; set(path, level) })
                    }
                    if (Subagents.offersClear(provider, model)) {
                        DropdownMenuItem(text = { Text(Subagents.CLEAR) }, onClick = { open = false; set(path, null) })
                    }
                }
            }
        }
        // A tier the owner set (board 2026-11-20), as iOS draws it.
        if (Subagents.showsYours(model)) Text(Subagents.YOURS,
            Modifier.border(1.dp, Ink.muted.copy(alpha = 0.35f), RoundedCornerShape(4.dp)).padding(horizontal = 5.dp)
                .testTag("tier-yours:${provider.slug}:${model.model}"),
            style = MaterialTheme.typography.labelSmall, color = Ink.muted, maxLines = 1)
    }
}
