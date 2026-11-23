package io.orbitd.android.management

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.cards.SettingChangedLine
import io.orbitd.android.cards.settingRow
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

/**
 * Settings → Providers → Model routing (web `ModelRoutingPage.tsx`): first the account's two routing switches — Route by tier, and
 * Optimize For under it while it is on — then every model with the tier it is routed at, set here, beside how its SubAgent runs went
 * in the period (docs/subagent-design.md §7). The period filters the runs, not the tiers. No Agent filter and no Workflows view here.
 */
@Composable
internal fun ModelRoutingPage(api: ManagementApi, revision: Long) {
    val record = remember(api) { PersonalRecord { api.get("users/me") } }
    PersonalRecordLifecycle(record, revision)
    val preference = rememberPreferenceWrite(api, record)
    val user = record.value as? JsonObject
    val preferences = user?.get("preferences") as? JsonObject ?: JsonObject(emptyMap())
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp)) {
        Text(ModelRouting.DESCRIPTION, Modifier.padding(start = 16.dp, end = 16.dp, top = 4.dp), style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (record.busy || record.stale || record.error != null) PersonalRecordStatus(record)
        SettingsGroup(ModelRouting.ROUTING) {
            // On unless the account turned it off: only turning it off is ever written (iOS 9fb3ae6ee).
            SettingsSwitch(SMART_MODEL_SELECTION, smartModelSelection(preferences), record.ready, Modifier.settingRow("modelRouting"),
                detail = SMART_MODEL_SELECTION_HINT) { preference("modelRouting", JsonPrimitive(it)) }
            SettingChangedLine("modelRouting", user, preference)
            // Account-wide, one answer for every Agent (docs/mocks/routing-mode-account/01-account-wide-optimize-for.png): absent reads
            // as Balance, and a segment writes the preference alone the moment it moves. Only Route by tier reads it, so it shows only
            // while that is on (owner, 2026-11-20); the saved value is kept while it is off.
            if (smartModelSelection(preferences)) {
                HorizontalDivider()
                ListItem(headlineContent = { Text(OPTIMIZE_FOR) }, colors = settingsRowColors(), modifier = Modifier.settingRow("optimizeFor"),
                    supportingContent = { Text(OPTIMIZE_FOR_DETAIL) })
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 12.dp)) {
                    OPTIMIZE_FOR_VALUES.forEachIndexed { index, value ->
                        SegmentedButton(selected = optimizeFor(preferences) == value, onClick = { preference("optimizeFor", JsonPrimitive(value)) },
                            enabled = record.ready, shape = SegmentedButtonDefaults.itemShape(index, OPTIMIZE_FOR_VALUES.size), icon = {},
                            // M3's 12dp a side clips "Intelligence" on a 393dp phone.
                            contentPadding = PaddingValues(horizontal = 4.dp)) {
                            Text(value.replaceFirstChar { it.uppercase() }, maxLines = 1)
                        }
                    }
                }
                SettingChangedLine("optimizeFor", user, preference)
            }
        }
        ModelsGroup(api, revision)
        Spacer(Modifier.height(48.dp))
    }
}

/** The Models group: the period, then every model's row in its section, then the two footnotes. */
@Composable
private fun ModelsGroup(api: ManagementApi, revision: Long) {
    var period by rememberSaveable { mutableStateOf(ReportPeriod.DEFAULT) }
    var providers by remember(api) { mutableStateOf<List<SubagentProvider>?>(null) }
    var groups by remember(api) { mutableStateOf<List<SubagentReportGroup>?>(null) }
    var tiersFailure by remember(api) { mutableStateOf<String?>(null) }
    var reportFailure by remember(api) { mutableStateOf<String?>(null) }
    var saveFailure by remember { mutableStateOf<String?>(null) }
    var tierReads by remember { mutableIntStateOf(0) }
    var retries by remember { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(api, revision, tierReads, retries) {
        try { providers = Subagents.decode(api.get("providers/subagent-tiers")); tiersFailure = null }
        catch (e: CancellationException) { throw e } catch (e: Exception) { tiersFailure = ModelRouting.errorMessage(e) }
    }
    LaunchedEffect(api, revision, period, retries) {
        val since = ModelRouting.since(period, System.currentTimeMillis())
        try {
            groups = ModelRouting.decode(api.get("tasks/model-routing/report/subagents", listOfNotNull(since?.let { "since" to it })))
            reportFailure = null
        } catch (e: CancellationException) { throw e } catch (e: Exception) { reportFailure = ModelRouting.errorMessage(e) }
    }
    fun setTier(path: String, model: String, tier: String?) {
        scope.launch {
            try {
                api.patch(path, buildJsonObject { put("model", model); put("tier", tier?.let(::JsonPrimitive) ?: JsonNull) })
                tierReads++; saveFailure = null
            } catch (e: CancellationException) { throw e } catch (_: Exception) { saveFailure = Subagents.TIER_SAVE_FAILED }
        }
    }

    SettingsGroup(ModelRouting.MODELS) {
        SettingsPicker(ModelRouting.PERIOD, null, period.name, ReportPeriod.entries.map { it.name to it.label }, enabled = true) { picked ->
            // A new period's runs are read afresh: the old period's figures are not shown under the new name.
            period = ReportPeriod.valueOf(picked); groups = null; reportFailure = null
        }
        HorizontalDivider()
        Column(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
            val failure = reportFailure ?: tiersFailure
            val listed = providers
            val report = groups
            when {
                failure != null -> Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(ModelRouting.loadFailed(failure), Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    OutlinedButton(onClick = { tiersFailure = null; reportFailure = null; retries++ }) { Text(ModelRouting.RETRY) }
                }
                listed == null || report == null -> Box(Modifier.fillMaxWidth().padding(vertical = 16.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(28.dp).testTag("model-routing-loading"))
                }
                else -> ModelsList(listed, report, period, saveFailure, ::setTier)
            }
        }
    }
    listOf(ModelRouting.SUBAGENTS_FOOT, Subagents.QUALITY_FOOTER).forEach {
        Text(it, Modifier.padding(start = 16.dp, end = 16.dp, top = 6.dp), style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun ModelsList(providers: List<SubagentProvider>, groups: List<SubagentReportGroup>, period: ReportPeriod, saveFailure: String?,
                       setTier: (String, String, String?) -> Unit) {
    val sections = ModelRouting.sections(providers, groups)
    if (groups.isEmpty() && sections.tiered.isEmpty() && sections.idle.isEmpty()) {
        Text(ModelRouting.noneRan(period), Modifier.padding(vertical = 8.dp), color = Ink.muted)
        return
    }
    var showIdle by remember { mutableStateOf(false) }
    val (totals, outside) = ModelRouting.totals(groups, sections, period)
    Text(buildAnnotatedString {
        append(totals)
        outside?.let { append(" · "); withStyle(SpanStyle(color = Ink.amber)) { append(it) } }
    }, Modifier.padding(vertical = 8.dp).testTag("model-routing-totals"), style = MaterialTheme.typography.bodySmall, color = Ink.muted)
    saveFailure?.let { Text(it, Modifier.padding(vertical = 4.dp), style = MaterialTheme.typography.labelMedium, color = Ink.red) }
    BoxWithConstraints {
        val wide = maxWidth >= 520.dp
        Column {
            TierRow(wide, header = true, provider = { Text(if (wide) "Provider" else "Provider / Model", style = it) },
                model = { Text("Model", style = it) },
                tier = { Text("Tier", style = it) }, quality = { Text(Subagents.QUALITY, style = it) },
                price = { Text("Price / M out", style = it) })
            if (sections.tiered.isNotEmpty()) SectionRow(ModelRouting.ROUTED_BY_TIER)
            sections.tiered.forEach { ModelRow(wide, it, RanAt.TIERS, setTier) }
            if (sections.named.isNotEmpty()) SectionRow(ModelRouting.CALLED_BY_NAME, ModelRouting.CALLED_BY_NAME_NOTE)
            sections.named.forEach { ModelRow(wide, it, RanAt.NAMED, setTier) }
            if (sections.notRouted.isNotEmpty()) SectionRow(ModelRouting.NOT_ROUTED)
            sections.notRouted.forEach { ModelRow(wide, it, RanAt.NOT_ROUTED, setTier) }
            if (sections.idle.isNotEmpty()) {
                HorizontalDivider()
                Text(ModelRouting.idleFold(sections.idle.size, showIdle),
                    Modifier.fillMaxWidth().clickable(role = Role.Button) { showIdle = !showIdle }.padding(vertical = 10.dp).testTag("model-routing-idle"),
                    style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold), color = Ink.muted)
                if (showIdle) sections.idle.forEach { ModelRow(wide, it, RanAt.TIERS, setTier) }
            }
        }
    }
}

/** A section's header row: its title, and the note beside it where it has one. */
@Composable
private fun SectionRow(title: String, note: String? = null) {
    HorizontalDivider()
    Column(Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(title, Modifier.semantics { heading() }, style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
            color = MaterialTheme.colorScheme.onSurface)
        note?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Ink.muted) }
    }
}

/** One model: the tier list's row (its tier menu, Yours, Quality and price, as Subagents draws them), the flag under its name when
 *  routing took it outside its tiers, and its figures — Ran at, Runs, Done, Cost — under the row. */
@Composable
private fun ModelRow(wide: Boolean, row: RoutingModelRow, ranAt: RanAt, setTier: (String, String, String?) -> Unit) {
    val provider = row.provider
    val model = row.model
    val tag = row.key.replace('\n', ':')
    HorizontalDivider()
    TierRow(wide, header = false,
        provider = { Text(row.providerLabel ?: "—", style = it, maxLines = 1) },
        model = { Text(row.modelLabel, style = it.copy(fontFamily = FontFamily.Monospace), maxLines = 1) },
        tier = { style ->
            if (provider != null && model != null) TierCell(provider, model, style) { path, tier -> setTier(path, model.model, tier) }
            else Text("—", style = style, color = Ink.muted)
        },
        quality = { style -> if (provider != null && model != null) QualityCell(provider, model, style) else Text("—", style = style, color = Ink.muted) },
        price = { style ->
            if (provider != null && model != null) Text(Subagents.priceText(model, provider.billing), style = style, maxLines = 1,
                color = if (model.outputPricePerMTok == null) Ink.muted else MaterialTheme.colorScheme.onSurface)
            else Text("—", style = style, color = Ink.muted)
        },
        flag = (if (ranAt == RanAt.TIERS) ModelRouting.flag(row) else null)?.let { flag ->
            @Composable { Text(flag, Modifier.testTag("routing-flag:$tag"), style = MaterialTheme.typography.bodySmall, color = Ink.amber) }
        },
        figures = { Figures(row, ranAt, tag) })
}

/** "Ran at S 3 · L 1 ⚑   Runs 4   Done 75%   Cost $0.42": the web's four columns, a phone's width allowing, on one line. A tier the
 *  model is not set to now is in the flag colour and carries the flag mark. */
@Composable
private fun Figures(row: RoutingModelRow, ranAt: RanAt, tag: String) {
    val muted = Ink.muted
    val amber = Ink.amber
    val on = MaterialTheme.colorScheme.onSurface
    val text = buildAnnotatedString {
        fun label(word: String) = withStyle(SpanStyle(color = muted)) { append(word); append(" ") }
        label(ModelRouting.RAN_AT)
        ModelRouting.ranAtSegments(row, ranAt).forEachIndexed { index, (segment, outside) ->
            if (index > 0) withStyle(SpanStyle(color = muted)) { append(" · ") }
            withStyle(SpanStyle(color = if (outside) amber else if (row.runs == 0 || ranAt != RanAt.TIERS) muted else on)) { append(segment) }
        }
        append("   "); label(ModelRouting.RUNS)
        withStyle(SpanStyle(color = if (row.runs == 0) muted else on)) { append("${row.runs}") }
        append("   "); label(ModelRouting.DONE)
        val done = ModelRouting.doneText(row)
        withStyle(SpanStyle(color = if (done == "—") muted else on)) { append(done) }
        append("   "); label(ModelRouting.COST)
        val cost = ModelRouting.costCell(row)
        withStyle(SpanStyle(color = if (cost == "—") muted else on)) { append(cost) }
    }
    Text(text, Modifier.padding(top = 2.dp).testTag("routing-figures:$tag").semantics { contentDescription = ModelRouting.figuresDescription(row, ranAt) },
        style = MaterialTheme.typography.bodySmall)
}
