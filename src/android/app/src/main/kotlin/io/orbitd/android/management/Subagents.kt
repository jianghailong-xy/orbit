package io.orbitd.android.management

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
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
                                      val outputPricePerMTok: Double?)

/** One provider of GET providers/subagent-tiers (shared ProviderTierRow), in the owner's provider order. */
internal data class SubagentProvider(val slug: String, val label: String, val kind: String, val providerId: String?, val billing: String,
                                     val models: List<SubagentTierModel>)

/** An Agent's SubAgents fields as GET workspaces/:id carries them, each with its default when absent (docs/subagent-design.md §7). */
internal data class SubagentSettings(val enabled: Boolean, val optimizeFor: String, val maxRunning: Int) {
    companion object {
        fun of(workspace: JsonObject) = SubagentSettings(
            workspace.bool("subagentsEnabled") ?: true,
            workspace.str("modelRoutingOptimizeFor")?.takeIf { it in Subagents.OPTIMIZE_FOR } ?: "cost",
            (workspace.int("subagentsMaxRunning") ?: 4).coerceIn(1, Subagents.MAX_RUNNING),
        )
    }
}

/** The SubAgents settings and the Providers page's Model tiers (docs/subagent-design.md §7, docs/mocks/subagent/05.png). */
internal object Subagents {
    const val GROUP = "SubAgents"
    const val SWITCH = "SubAgents"
    const val SWITCH_DETAIL = "Let this agent hand work to other providers in the same folder"
    const val OPTIMIZE = "Optimize For"
    const val PROVIDERS = "Providers"
    const val PROVIDERS_DETAIL = "All enabled providers. Block one to keep SubAgents off it."
    const val RUNNING = "Running at once"
    const val RUNNING_DETAIL = "Per session, foreground and background together"
    const val TIERS = "Model tiers"
    const val TIERS_FOOTER = "Preset tiers and prices follow the catalogue. A custom endpoint's model stays out of automatic routing until it has a tier."
    const val NOT_SET = "Not set"
    const val SUBSCRIPTION = "Subscription"
    const val CLEAR = "Clear"
    const val EDIT = "Edit"
    const val PROVIDERS_LOAD_FAILED = "Couldn't load providers"
    const val SAVE_BLOCKED_FAILED = "Couldn't save blocked providers"
    const val TIER_SAVE_FAILED = "Couldn't save the tier"
    const val MAX_RUNNING = 16
    val OPTIMIZE_FOR = listOf("cost", "balance", "intelligence")
    val LEVELS = listOf("S", "M", "L", "XL")

    fun optimizeLabel(value: String) = value.replaceFirstChar { it.uppercase() }

    fun decode(body: JsonElement): List<SubagentProvider> = ((body as? JsonObject)?.list("providers")).orEmpty().mapNotNull { row ->
        val slug = row.str("slug")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
        SubagentProvider(slug, row.str("label") ?: slug, row.str("kind").orEmpty(), row.str("providerId"), row.str("billing").orEmpty(),
            row.list("models").mapNotNull { model ->
                val name = model.str("model")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                SubagentTierModel(name, model.strings("levels"), model.str("source"), model.bool("editable") == true, model.dbl("outputPricePerMTok"))
            })
    }

    /** users/me's preferences.subagentBlockedProviders; absent is none blocked. */
    fun blocked(user: JsonElement): List<String> = (user as? JsonObject)?.obj("preferences")?.strings("subagentBlockedProviders").orEmpty()

    fun tierText(levels: List<String>) = when {
        levels.isEmpty() -> NOT_SET
        levels.containsAll(LEVELS) -> "S–XL by effort"
        else -> levels.joinToString(" · ")
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
 * The Agent form's SubAgents group (docs/mocks/subagent/05.png): the switch, Optimize For, the Providers SubAgents may use, and how many
 * run at once. The switch, Optimize For and Running at once are the Agent's and saved with the form's Done; the providers blocked are the
 * account's (users/me/preferences) and saved from their own list.
 */
@Composable
internal fun SubagentsSection(api: ManagementApi, enabled: Boolean, setEnabled: (Boolean) -> Unit, optimizeFor: String,
                              setOptimizeFor: (String) -> Unit, maxRunning: Int, setMaxRunning: (Int) -> Unit) {
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
        // Beside its label where there is room (the mock); on a phone the three segments take the row's width under it (iOS ViewThatFits).
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val segments = @Composable { modifier: Modifier ->
                SingleChoiceSegmentedButtonRow(modifier) {
                    Subagents.OPTIMIZE_FOR.forEachIndexed { index, value ->
                        SegmentedButton(selected = optimizeFor == value, onClick = { setOptimizeFor(value) },
                            shape = SegmentedButtonDefaults.itemShape(index, Subagents.OPTIMIZE_FOR.size), icon = {},
                            // M3's 12dp a side clips "Intelligence" on a 393dp phone.
                            contentPadding = PaddingValues(horizontal = 4.dp)) {
                            Text(Subagents.optimizeLabel(value), maxLines = 1)
                        }
                    }
                }
            }
            if (maxWidth >= 520.dp) Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(Subagents.OPTIMIZE, Modifier.weight(1f)); segments(Modifier.width(360.dp))
            } else Column(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(Subagents.OPTIMIZE); segments(Modifier.fillMaxWidth())
            }
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
 * price per million output tokens. A model the owner may tier opens a menu of the four, and Clear once set. On a phone the provider sits
 * above its model in one cell.
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
    FormSection(Subagents.TIERS, footer = Subagents.TIERS_FOOTER) {
        failure?.let { Text(it, Modifier.padding(vertical = 8.dp), style = MaterialTheme.typography.labelMedium, color = Ink.red) }
        if (providers == null && failure == null) Text("Loading…", Modifier.padding(vertical = 8.dp), color = Ink.muted)
        if (rows.isNotEmpty()) BoxWithConstraints {
            val wide = maxWidth >= 520.dp
            Column {
                TierRow(wide, header = true, provider = { Text(if (wide) "Provider" else "Provider / Model", style = it) },
                    model = { Text("Model", style = it) },
                    tier = { Text("Tier", style = it) }, price = { Text("Price / M out", style = it) })
                rows.forEach { provider ->
                    provider.models.forEach { model ->
                        HorizontalDivider()
                        TierRow(wide, header = false,
                            provider = { Text(provider.label, style = it, maxLines = 1) },
                            model = { Text(model.model, style = it.copy(fontFamily = FontFamily.Monospace), maxLines = 1) },
                            tier = { style ->
                                TierCell(model, provider.providerId, style) { tier ->
                                    scope.launch {
                                        try {
                                            api.patch("providers/mine/${provider.providerId}/model-tier", buildJsonObject {
                                                put("model", model.model); put("tier", tier?.let(::JsonPrimitive) ?: JsonNull)
                                            })
                                            reads++; failure = null
                                        } catch (e: CancellationException) { throw e } catch (_: Exception) { failure = Subagents.TIER_SAVE_FAILED }
                                    }
                                }
                            },
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
                    price: @Composable (androidx.compose.ui.text.TextStyle) -> Unit) {
    val style = if (header) MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold, color = Ink.muted)
        else MaterialTheme.typography.bodyMedium
    val small = if (header) style else if (wide) MaterialTheme.typography.bodyMedium else MaterialTheme.typography.bodySmall.copy(color = Ink.muted)
    if (wide) Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.weight(1f)) { provider(style) }
        Box(Modifier.weight(1.4f)) { model(small) }
        Box(Modifier.weight(1.1f)) { tier(style) }
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterEnd) { price(style) }
    } else Column(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        // A phone, as iOS: provider, tier and price on one line, the model across the full width under them. Tier and price
        // are as wide as their longest values ("S–XL by effort", "Subscription"), so the columns line up.
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.weight(1f)) { provider(style) }
            Box(Modifier.width(112.dp)) { tier(style) }
            Box(Modifier.width(96.dp), contentAlignment = Alignment.CenterEnd) { price(style) }
        }
        if (!header) model(small)
    }
}

@Composable
private fun TierCell(model: SubagentTierModel, providerId: String?, style: androidx.compose.ui.text.TextStyle, set: (String?) -> Unit) {
    val text = Subagents.tierText(model.levels)
    val color = if (model.levels.isEmpty()) Ink.amber else MaterialTheme.colorScheme.onSurface
    if (!model.editable || providerId == null) { Text(text, style = style, color = color, maxLines = 1); return }
    var open by remember { mutableStateOf(false) }
    Box {
        Text("$text ▾", Modifier.clickable(role = Role.DropdownList) { open = true }.testTag("tier:${model.model}"), style = style,
            color = color, maxLines = 1)
        DropdownMenu(open, { open = false }) {
            Subagents.LEVELS.forEach { level ->
                DropdownMenuItem(text = { Text(level) }, trailingIcon = if (model.levels == listOf(level)) { { Text("✓") } } else null,
                    onClick = { open = false; set(level) })
            }
            if (model.levels.isNotEmpty()) DropdownMenuItem(text = { Text(Subagents.CLEAR) }, onClick = { open = false; set(null) })
        }
    }
}
