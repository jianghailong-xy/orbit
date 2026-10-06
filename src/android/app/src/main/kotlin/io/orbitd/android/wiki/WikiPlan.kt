package io.orbitd.android.wiki

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import io.orbitd.android.cards.BusinessCard
import io.orbitd.android.core.cards.*
import io.orbitd.android.navigation.*
import kotlinx.serialization.json.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable internal fun WikiPlan(ui: WikiUi) {
    val state = ui.page.content
    val job = state.obj("job")
    val stored = ui.page.extras["shown"]
    val failed = job?.takeIf { it.text("state") == "failed" && it.text("kind") != "build" }?.obj("draft")
    val shown = stored ?: failed
    var redrafting by rememberSaveable { mutableStateOf(false) }
    var editing by rememberSaveable { mutableStateOf(false) }
    var proposalEdit by remember { mutableStateOf<JsonObject?>(null) }
    var proposalVersion by remember { mutableIntStateOf(0) }
    val doc = shown?.objects("docs")?.firstOrNull { it.text("slug") == ui.route.id }
    val section = if (ui.route.destination == Destination.WIKI_PLAN_SECTION) doc?.objects("sections")?.withIndex()?.firstOrNull { (index, value) -> (value.text("key") ?: "index:$index") == ui.route.wikiSection }?.value else null
    val newest = state.obj("draft") ?: state.obj("confirmed")
    val canEdit = stored != null && shown?.number("version") == newest?.number("version") && shown?.text("status") in setOf("draft", "confirmed")
    WikiPageColumn {
        WikiContents(ui)
        if (ui.route.destination == Destination.WIKI_PLAN) {
            WikiHeading("Wiki plan")
            val savedVersions = ui.page.extras["versions"]?.objects("versions").orEmpty()
            val versions = if (shown?.text("status") == "failed") listOf(shown) + savedVersions else savedVersions
            if (versions.isNotEmpty()) WikiChoice("Version", shown?.number("version")?.toString(), versions.mapNotNull { version -> version.number("version")?.let { it.toString() to "v$it · ${version.text("status")}" } }) {
                ui.go(Destination.WIKI_PLAN, version = it.toIntOrNull())
            }
            job?.let { WikiPlanJob(it, ui) }
            if (shown == null) {
                Text("No plan yet. A draft proposes the documents this wiki needs; you review it before any documents are written.")
                Button(onClick = { ui.write { ui.api.write(listOf("wiki", "spaces", ui.spaceId!!, "plan", "redraft")) } }, enabled = ui.fresh && !ui.busy && job?.text("state") !in setOf("queued", "held", "running")) { Text("Draft plan") }
            } else {
                Text(if (stored == null) "Draft failed its checks" else "Version ${shown.number("version")} · ${shown.text("status")}")
                WikiPlanGate(shown, job, ui)
                if (stored != null && stored.number("version") == state.obj("draft")?.number("version")) {
                    wikiPlanCards(state).filter { it.actions.contains(CardVerb.PLAN_CONFIRM) }.forEach { WikiInteraction(it, ui) }
                }
                TextButton(onClick = { redrafting = true }, enabled = ui.fresh && !ui.busy && job?.text("state") !in setOf("queued", "held", "running")) { Text("Redraft…") }
                shown.objects("categories").forEach { category ->
                    WikiHeading(category.label())
                    WikiWords(category.text("question"), ui)
                    if (category.flag("forAgents")) Text("For agents", style = MaterialTheme.typography.labelMedium)
                    shown.objects("docs").filter { it.text("category") == category.text("key") }.forEach { planDoc ->
                        WikiRow(planDoc.label(), "${planDoc.objects("sections").size} sections · ${planDoc.obj("length")?.number("min") ?: 0}–${planDoc.obj("length")?.number("max") ?: 0} characters", "wiki-plan-doc:${planDoc.text("slug")}") {
                            ui.go(Destination.WIKI_PLAN_DOC, planDoc.text("slug"), version = shown.number("version"))
                        }
                    }
                }
                val directory = ui.page.extras["docs"]
                directory?.obj("docs")?.let { counts -> Text("${counts.number("written") ?: 0} of ${counts.number("total") ?: 0} documents written") }
            }
            val proposals = state.objects("proposals").filter { it.text("status") == "pending" }
            if (proposals.isNotEmpty()) WikiHeading("Proposed changes")
            proposals.forEach { proposal ->
                WikiHeading(proposal.obj("change")?.obj("doc")?.label() ?: "Plan change")
                WikiWords(proposal.text("reason"), ui)
                proposal.obj("change")?.obj("doc")?.let { change -> WikiPlanDocumentFields(change, ui) }
                proposal.objects("facts").forEach { fact ->
                    val destination = when (fact.text("kind")) { "task" -> Destination.TASK; "session" -> Destination.SESSION; "entry", "wiki_entry" -> Destination.WIKI_ENTRY; else -> null }
                    if (destination != null) WikiRow("${fact.text("kind")} · ${fact.text("id")}") { ui.open(OrbitRoute(destination, fact.text("id"))) }
                }
                val card = wikiPlanCards(state).firstOrNull { it.objectId == proposal.text("id") }
                card?.let {
                    BusinessCard(card, ui.fresh && !ui.busy, open = ui.link) { verb, input -> ui.write {
                        val response = ui.api.cardAction(card, verb, input)
                        if (verb == CardVerb.PLAN_ACCEPT && state.obj("draft") == null) {
                            val draft = response.obj("draft") ?: error("The proposal was accepted, but no draft was returned. Refresh the plan.")
                            ui.api.write(listOf("wiki", "spaces", ui.spaceId!!, "plan", "versions", requireNotNull(draft.text("version")), "confirm"))
                        }
                    } }
                    Text(if (state.obj("draft") == null) "Accept confirms the new plan after its checks pass." else "Accept adds this change to a new draft.", style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = { ui.write {
                        val response = ui.api.cardAction(card, CardVerb.PLAN_ACCEPT, CardInput())
                        val draft = response.obj("draft") ?: error("The proposal was accepted. Refresh to open its draft.")
                        proposalVersion = requireNotNull(draft.number("version"))
                        proposalEdit = draft.objects("docs").firstOrNull { doc -> doc.text("slug") == proposal.obj("change")?.obj("doc")?.text("slug") }
                            ?: error("The draft changed. Open the newest plan to edit it.")
                    } }, enabled = ui.fresh && !ui.busy) { Text("Edit proposed change") }
                }
            }
        } else if (doc == null) {
            Text("That document is not in this version of the plan.")
        } else {
            WikiHeading(if (ui.route.destination == Destination.WIKI_PLAN_SECTION) section?.label() ?: "Section unavailable" else doc.label())
            Text("Plan v${shown?.number("version") ?: "failed draft"}")
            if (canEdit && (ui.route.destination != Destination.WIKI_PLAN_SECTION || section != null)) TextButton(onClick = { editing = true }, enabled = ui.fresh && !ui.busy) { Text("Edit") }
            if (ui.route.destination == Destination.WIKI_PLAN_SECTION) {
                if (section != null) WikiPlanSectionFields(section, ui) else Text("That section is not in this document.")
            } else {
                WikiPlanDocumentFields(doc, ui)
                WikiHeading("Sections")
                doc.objects("sections").forEachIndexed { index, row -> WikiRow(row.label(), "${row.text("kind")} · ${row.number("length") ?: 0} characters") {
                    ui.go(Destination.WIKI_PLAN_SECTION, doc.text("slug"), section = row.text("key") ?: "index:$index", version = shown?.number("version"))
                } }
                if (stored?.text("status") == "confirmed") TextButton(onClick = { ui.go(Destination.WIKI_DOC, doc.text("slug")) }) { Text("Read document") }
            }
        }
    }
    if (redrafting) ModalBottomSheet(onDismissRequest = { if (!ui.busy) redrafting = false }) {
        var words by rememberSaveable { mutableStateOf("") }
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            WikiHeading("Redraft plan")
            Text("Describe what should change. The current plan stays in force while the new draft is prepared.")
            OutlinedTextField(words, { words = it }, Modifier.fillMaxWidth(), label = { Text("Instructions (optional)") })
            Button(onClick = { ui.write {
                ui.api.write(listOf("wiki", "spaces", ui.spaceId!!, "plan", "redraft"), buildJsonObject { if (words.isNotBlank()) put("instructions", words.trim()) }); redrafting = false
            } }, enabled = ui.fresh && !ui.busy) { Text("Redraft") }
        }
    }
    if (editing && doc != null && stored != null) ModalBottomSheet(onDismissRequest = { if (!ui.busy) editing = false }) {
        WikiPlanEdit(doc, section, stored.number("version")!!, ui) { editing = false }
    }
    proposalEdit?.let { edited -> ModalBottomSheet(onDismissRequest = { if (!ui.busy) proposalEdit = null }) {
        WikiPlanEdit(edited, null, proposalVersion, ui) { proposalEdit = null }
    } }
}

@Composable private fun WikiPlanJob(job: JsonObject, ui: WikiUi) {
    Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceVariant) {
        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("${job.text("kind")?.replaceFirstChar(Char::uppercase) ?: "Plan"} · ${job.text("state") ?: "unknown"}", style = MaterialTheme.typography.titleMedium)
            job.obj("held")?.text("reason")?.let { reason ->
                Text(when (reason) { "no_maintenance_workspace" -> "Set up a maintenance workspace."; "maintenance_provider_unusable" -> "The maintenance provider is unavailable."; else -> reason.replace('_', ' ') })
                TextButton(onClick = { ui.go(Destination.WIKI_SETTINGS) }) { Text("Maintenance settings") }
            }
            WikiWords(job.text("error"), ui)
            WikiWords(job.text("instructions"), ui)
            job.obj("progress")?.let { progress -> Text("Writing documents · ${progress.obj("docs")?.number("done") ?: 0}/${progress.obj("docs")?.number("total") ?: 0}"); WikiWords(progress.obj("current")?.text("title"), ui) }
            job.number("attempt")?.let { Text("Attempt $it of ${job.number("attemptsMax") ?: "—"}") }
            job.text("sessionId")?.let { id -> TextButton(onClick = { ui.open(OrbitRoute(Destination.SESSION, id)) }) { Text("View run") } }
            job.text("taskId")?.let { id -> TextButton(onClick = { ui.open(OrbitRoute(Destination.TASK, id)) }) { Text("View task") } }
            job.obj("waitingFor")?.let { waiting -> Text("Waiting for ${waiting.text("title") ?: "maintenance task"}"); waiting.text("taskId")?.let { id -> TextButton(onClick = { ui.open(OrbitRoute(Destination.TASK, id)) }) { Text("Open waiting task") } } }
            job.obj("report")?.let { report ->
                WikiFields(JsonObject(report.filterKeys { it in setOf("docs", "sections", "categories", "seconds", "model", "tokens", "repo") }), ui)
            }
        }
    }
}

@Composable private fun WikiPlanGate(shown: JsonObject, job: JsonObject?, ui: WikiUi) {
    shown.obj("gate")?.let { gate ->
        WikiHeading("Checks")
        gate.obj("checks")?.forEach { (key, value) -> Text("${key.replaceFirstChar(Char::uppercase)} · ${(value as? JsonPrimitive)?.content ?: "—"}") }
        gate.objects("needsNewFields").forEach { field -> Text("${field.text("at")} · ${field.text("name")}: ${field.text("why") ?: ""}") }
    }
    val errors = if (shown.text("status") == "failed" || shown.text("status") == null) job?.objects("errors").orEmpty() else emptyList()
    if (errors.isNotEmpty()) { WikiHeading("Draft checks failed"); errors.forEach { Text(listOfNotNull(it.text("check"), it.text("path"), it.text("message")).joinToString(" · "), color = MaterialTheme.colorScheme.error) } }
    shown.obj("repoCheck")?.let { check ->
        Text("${check.number("checked") ?: 0} references checked at ${check.text("sha")}")
        check.objects("missing").forEach { Text("Missing ${it.text("kind")} · ${it.text("ref")}", color = MaterialTheme.colorScheme.error) }
    }
}

@Composable private fun WikiPlanDocumentFields(doc: JsonObject, ui: WikiUi) {
    WikiWords(doc.text("question"), ui)
    WikiTextList("For", doc.strings("audience"), ui)
    WikiTextList("Covers", doc.strings("scopeIn"), ui)
    if (doc.flag("protected")) Text("Protected · maintenance cannot remove this document.")
    doc.obj("length")?.let { Text("Length · ${it.number("min") ?: 0}–${it.number("max") ?: 0} characters") }
    doc.objects("scopeOut").forEach { outside ->
        WikiWords(outside.text("text"), ui)
        outside.strings("docs").forEach { slug -> TextButton(onClick = { ui.go(Destination.WIKI_PLAN_DOC, slug, version = ui.route.wikiVersion) }) { Text(slug) } }
    }
}

@Composable private fun WikiPlanSectionFields(section: JsonObject, ui: WikiUi) {
    Text("${section.text("kind")} · ${section.number("length") ?: 0} characters")
    WikiWords(section.text("covers"), ui)
    val sources = section.obj("sources")
    listOf("docs" to "Design documents", "code" to "Code", "contracts" to "Contracts").forEach { (key, title) ->
        val entries = sources?.objects(key).orEmpty()
        if (entries.isNotEmpty()) {
            WikiHeading(title)
            entries.forEach { source -> Text(listOfNotNull(source.text("path"), source.text("section"), source.strings("symbols").takeIf { it.isNotEmpty() }?.joinToString(", ")).joinToString(" · ")) }
        }
    }
    sources?.obj("sessions")?.let { sessions ->
        WikiHeading("Session sources")
        sessions.objects("projects").forEach { project -> WikiRow(project.label()) { ui.open(OrbitRoute(Destination.PROJECT, project.text("id"))) } }
        WikiFields(JsonObject(sessions.filterKeys { it != "projects" }), ui)
    }
    section.obj("extra")?.let { WikiFields(it, ui) }
}

private val sectionKinds = listOf("overview", "concepts", "flow", "interface", "data", "ops", "pitfalls", "decisions", "conventions", "other")

@Composable private fun WikiPlanEdit(doc: JsonObject, section: JsonObject?, version: Int, ui: WikiUi, close: () -> Unit) {
    val initial = section ?: doc
    var title by rememberSaveable { mutableStateOf(initial.text("title").orEmpty()) }
    var question by rememberSaveable { mutableStateOf(initial.text(if (section == null) "question" else "covers").orEmpty()) }
    var minimum by rememberSaveable { mutableStateOf((if (section == null) initial.obj("length")?.number("min") else initial.number("length"))?.toString() ?: "0") }
    var maximum by rememberSaveable { mutableStateOf(initial.obj("length")?.number("max")?.toString() ?: "0") }
    var protected by rememberSaveable { mutableStateOf(initial.flag("protected")) }
    var kind by rememberSaveable { mutableStateOf(section?.text("kind") ?: "other") }
    var sectionsRaw by rememberSaveable { mutableStateOf(JsonArray(doc.objects("sections").map(::planSectionInput)).toString()) }
    val sections = Json.parseToJsonElement(sectionsRaw).rows()
    fun replaceSections(value: List<JsonObject>) { sectionsRaw = JsonArray(value).toString() }
    Column(Modifier.padding(16.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        WikiHeading(if (section == null) "Edit document plan" else "Edit section plan")
        OutlinedTextField(title, { title = it }, Modifier.fillMaxWidth(), label = { Text("Title") })
        OutlinedTextField(question, { question = it }, Modifier.fillMaxWidth(), label = { Text(if (section == null) "Question" else "Covers") })
        OutlinedTextField(minimum, { minimum = it }, Modifier.fillMaxWidth(), label = { Text(if (section == null) "Minimum characters" else "Characters") })
        if (section == null) {
            OutlinedTextField(maximum, { maximum = it }, Modifier.fillMaxWidth(), label = { Text("Maximum characters") })
            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) { Switch(protected, { protected = it }); Text("Protected") }
            WikiHeading("Sections")
            sections.forEachIndexed { index, row ->
                OutlinedTextField(row.text("title").orEmpty(), { value -> replaceSections(sections.mapIndexed { n, original -> if (n == index) JsonObject(original + ("title" to JsonPrimitive(value))) else original }) }, Modifier.fillMaxWidth(), label = { Text("Section title") })
                WikiChoice("Kind", row.text("kind"), sectionKinds.map { it to it }) { value -> replaceSections(sections.mapIndexed { n, original -> if (n == index) JsonObject(original + ("kind" to JsonPrimitive(value))) else original }) }
                Row {
                    TextButton(onClick = { replaceSections(sections.toMutableList().apply { add(index - 1, removeAt(index)) }) }, enabled = index > 0) { Text("Move up") }
                    TextButton(onClick = { replaceSections(sections.toMutableList().apply { add(index + 1, removeAt(index)) }) }, enabled = index < sections.lastIndex) { Text("Move down") }
                    TextButton(onClick = { replaceSections(sections.filterIndexed { n, _ -> n != index }) }) { Text("Remove") }
                }
            }
            TextButton(onClick = { replaceSections(sections + buildJsonObject { put("title", ""); put("kind", "other"); put("covers", ""); put("length", 500); putJsonObject("sources") {} }) }) { Text("Add section") }
        } else WikiChoice("Kind", kind, sectionKinds.map { it to it }) { kind = it }
        Text("Saving creates a new draft. It takes effect after you confirm it.")
        Button(onClick = { ui.write {
            val changed = if (section == null) JsonObject(planDocInput(doc) + mapOf("title" to JsonPrimitive(title.trim()), "question" to JsonPrimitive(question.trim()), "protected" to JsonPrimitive(protected),
                "length" to buildJsonObject { put("min", minimum.toInt()); put("max", maximum.toInt()) }, "sections" to JsonArray(sections.map { row -> if (row.text("key") == null) JsonObject(row + ("covers" to JsonPrimitive(row.text("title").orEmpty().trim()))) else row })))
                else JsonObject(planSectionInput(section) + mapOf("title" to JsonPrimitive(title.trim()), "covers" to JsonPrimitive(question.trim()), "length" to JsonPrimitive(minimum.toInt()), "kind" to JsonPrimitive(kind)))
            ui.api.write(listOf("wiki", "spaces", ui.spaceId!!, "plan", "edits"), buildJsonObject {
                put("baseVersion", version); put("docSlug", doc.text("slug")); put(if (section == null) "doc" else "section", changed)
                if (section != null) put("sectionKey", section.text("key"))
            }); close()
        } }, enabled = ui.fresh && !ui.busy && title.isNotBlank() && minimum.toIntOrNull() != null && (section != null || maximum.toIntOrNull() != null), modifier = Modifier.testTag("wiki-plan-edit-save")) { Text("Save draft") }
        TextButton(onClick = close, enabled = !ui.busy) { Text("Cancel") }
    }
}
