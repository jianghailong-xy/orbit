package io.orbitd.android.wiki

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.ui.LocalOrbitColors

// A document of the plan and a section of it (iOS `WikiPlanView.swift` § a document of the plan, and a section of it).

/** A plan document's own page (mock 22 ③): its number, title and lock; its version, errors and length; its fields —
 * question, readers, what it covers and leaves out, length, protection, what it draws on — and its sections, a protected
 * document's lost ones in red where they were — `WikiPlanLogic.DocSection`'s order. Edit in the bar when [canEdit]. */
@Composable
internal fun WikiPlanDocPage(route: OrbitRoute, shown: WikiPlanLogic.Shown, doc: WikiPlanLogic.ShownDoc, base: WikiPlanLogic.Shown?,
    canEdit: Boolean = false, actions: WikiPlanActions = WikiPlanActions()) {
    var allCovers by rememberSaveable { mutableStateOf(false) }
    PageBar.Bind(route, title = "", actions = if (!canEdit) null else ({
        TextButton(onClick = { actions.editDoc(doc.slug) }, modifier = Modifier.testTag("wiki-plan-doc-edit")) { Text(WikiPlanCopy.edit) }
    }))
    val error = MaterialTheme.colorScheme.error
    val lost = WikiPlanLogic.lostSections(shown, base, doc.slug)
    LazyColumn(Modifier.fillMaxSize().testTag("wiki-plan-doc-page"), contentPadding = PaddingValues(bottom = 24.dp)) {
        WikiPlanLogic.DocSection.entries.forEach { section ->
            when (section) {
                WikiPlanLogic.DocSection.CRUMB -> Unit
                WikiPlanLogic.DocSection.TITLE -> item(key = "title") {
                    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 12.dp).semantics(mergeDescendants = true) { heading() }
                        .testTag("wiki-plan-doc-title"), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("${doc.number} ${doc.title}", Modifier.weight(1f, fill = false).alignByBaseline(),
                            style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold))
                        if (doc.protected) Icon(painterResource(R.drawable.ic_lock), WikiPlanCopy.protected, Modifier.size(16.dp).align(Alignment.CenterVertically),
                            tint = WikiPalette.secondary)
                    }
                }
                WikiPlanLogic.DocSection.META -> item(key = "meta") {
                    val errors = WikiPlanLogic.docErrors(shown, doc).size
                    Text(buildAnnotatedString {
                        append("${WikiPlanCopy.versionLabel(shown.version)} · ${shown.status.label} · ")
                        if (errors > 0) {
                            withStyle(SpanStyle(color = error, fontWeight = FontWeight.Bold)) { append(WikiPlanCopy.errorCount(errors)) }
                            append(" · ")
                        }
                        append(WikiPlanLogic.docLine(doc))
                    }, Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp).testTag("wiki-plan-doc-meta"), style = WikiType.label,
                        color = WikiPalette.secondary)
                }
                WikiPlanLogic.DocSection.FIELDS -> item(key = "fields") {
                    WikiCard(Modifier.padding(top = 12.dp).testTag("wiki-plan-doc-fields")) {
                        PlanDocField(WikiPlanCopy.question, "question") {
                            Text(doc.question, style = WikiType.subtext.copy(fontWeight = FontWeight.SemiBold))
                        }
                        PlanDocField(WikiPlanCopy.writtenFor, "written-for") { PlanBullets(doc.audience) }
                        PlanDocField(WikiPlanCopy.covers, "covers") {
                            val shownCovers = if (allCovers) doc.scopeIn else doc.scopeIn.take(4)
                            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                PlanBullets(shownCovers)
                                if (doc.scopeIn.size > shownCovers.size) TextButton(onClick = { allCovers = true },
                                    contentPadding = PaddingValues(horizontal = 0.dp, vertical = 4.dp), modifier = Modifier.testTag("wiki-plan-covers-more")) {
                                    Text(WikiArticleCopy.moreArticles(doc.scopeIn.size - shownCovers.size), style = WikiType.subtext)
                                }
                            }
                        }
                        if (doc.scopeOut.isNotEmpty()) PlanDocField(WikiPlanCopy.notCovered, "not-covered") {
                            val numbers = LinkedHashMap<String, String>().apply { shown.docs.forEach { putIfAbsent(it.slug, it.number) } }
                            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                doc.scopeOut.forEach { out ->
                                    Text(buildAnnotatedString {
                                        append("• ${out.text}")
                                        withStyle(SpanStyle(color = MaterialTheme.colorScheme.primary)) { append(out.docs.joinToString("") { " → ${numbers[it] ?: it}" }) }
                                    }, style = WikiType.subtext)
                                }
                            }
                        }
                        PlanDocField(WikiPlanCopy.length, "length") { Text(WikiPlanCopy.chars(doc.length), style = WikiType.subtext) }
                        PlanDocField(WikiPlanCopy.protected, "protected") {
                            if (doc.protected) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                Icon(painterResource(R.drawable.ic_lock), null, Modifier.size(14.dp))
                                Text(WikiPlanCopy.protectedNote, style = WikiType.subtext)
                            } else Text(WikiPlanCopy.notProtectedNote, style = WikiType.subtext, color = WikiPalette.secondary)
                        }
                        PlanDocField(WikiPlanCopy.drawsOn, "draws-on", divider = false) { Text(WikiPlanLogic.drawsOn(doc), style = WikiType.subtext) }
                    }
                }
                WikiPlanLogic.DocSection.SECTIONS -> {
                    item(key = "sections-header") { WikiPlanSectionHead(WikiPlanCopy.sections, "${doc.sections.size}") }
                    item(key = "sections") {
                        // Each section, a lost one in red where it was, and those lost past the end after them.
                        val rows: List<Pair<WikiPlanLogic.Lost?, Int>> = buildList {
                            doc.sections.indices.forEach { index -> lost.filter { it.number - 1 == index }.forEach { add(it to -1) }; add(null to index) }
                            lost.filter { it.number - 1 >= doc.sections.size }.forEach { add(it to -1) }
                        }
                        WikiCard(Modifier.testTag("wiki-plan-sections")) {
                            rows.forEachIndexed { i, (gone, index) ->
                                if (i > 0) HorizontalDivider(Modifier.padding(start = 16.dp))
                                if (gone != null) PlanLostRow(gone, base, doc)
                                else PlanSectionRow(index, doc.sections[index]) { actions.openSection(doc.slug, index) }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** A field of a document: its name over what it says, each a row of the fields' card. */
@Composable
private fun PlanDocField(title: String, tag: String, divider: Boolean = true, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp).testTag("wiki-plan-field:$tag"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(title, style = WikiType.label, color = WikiPalette.secondary)
        content()
    }
    if (divider) HorizontalDivider(Modifier.padding(start = 16.dp))
}

@Composable
private fun PlanBullets(lines: List<String>) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) { lines.forEach { Text("• $it", style = WikiType.subtext) } }
}

/** A section a protected document lost in the draft, in red where it was: `v1 §7 已知的坑`. */
@Composable
private fun PlanLostRow(row: WikiPlanLogic.Lost, base: WikiPlanLogic.Shown?, doc: WikiPlanLogic.ShownDoc) {
    val error = MaterialTheme.colorScheme.error
    Column(Modifier.fillMaxWidth().background(error.copy(alpha = 0.08f)).padding(horizontal = 16.dp, vertical = 10.dp).testTag("wiki-plan-lost:${row.number}"),
        verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text("− ${WikiPlanCopy.lostLabel(base?.version ?: 0, row.number, row.title)}", style = WikiType.prose,
            textDecoration = TextDecoration.LineThrough, color = WikiPalette.secondary)
        Text(WikiPlanCopy.protectedMovePhone(row.movedTo, doc.number), style = WikiType.label, color = error)
    }
}

@Composable
private fun PlanSectionRow(index: Int, section: WikiPlanLogic.ShownSection, open: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = open).heightIn(min = 48.dp).padding(horizontal = 16.dp, vertical = 10.dp)
        .testTag("wiki-plan-section:$index"), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("${index + 1}", Modifier.alignByBaseline(), style = WikiType.subtext.copy(fontFeatureSettings = "tnum"), color = WikiPalette.secondary)
        Column(Modifier.weight(1f).alignByBaseline(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(section.title, style = WikiType.prose)
            Text(WikiPlanLogic.sectionLine(section), style = WikiType.subtext, color = WikiPalette.secondary)
        }
        Icon(painterResource(R.drawable.ic_chevron_forward), null, Modifier.size(14.dp).align(Alignment.CenterVertically), tint = WikiPalette.secondary)
    }
}

/** A plan section's own page (mock 22 ④⑤): its title, kind and length, what it covers, and its sources — design docs,
 * code and contracts each found or not at the sha, and where to look in sessions for the words —
 * `WikiPlanLogic.SectionSection`'s order. Edit in the bar when [canEdit]. */
@Composable
internal fun WikiPlanSectionPage(route: OrbitRoute, shown: WikiPlanLogic.Shown, doc: WikiPlanLogic.ShownDoc, index: Int,
    canEdit: Boolean = false, actions: WikiPlanActions = WikiPlanActions()) {
    val section = doc.sections[index]
    PageBar.Bind(route, title = "", actions = if (!canEdit) null else ({
        TextButton(onClick = { actions.editSection(doc.slug, index) }, modifier = Modifier.testTag("wiki-plan-section-edit")) { Text(WikiPlanCopy.edit) }
    }))
    LazyColumn(Modifier.fillMaxSize().testTag("wiki-plan-section-page"), contentPadding = PaddingValues(bottom = 24.dp)) {
        WikiPlanLogic.SectionSection.entries.forEach { part ->
            when (part) {
                WikiPlanLogic.SectionSection.CRUMB -> Unit
                WikiPlanLogic.SectionSection.TITLE -> item(key = "title") {
                    Text("§${index + 1} ${section.title}", Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 12.dp).semantics { heading() }
                        .testTag("wiki-plan-section-title"), style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold))
                }
                WikiPlanLogic.SectionSection.META -> item(key = "meta") {
                    Text(WikiPlanLogic.sectionMeta(shown, section), Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp)
                        .testTag("wiki-plan-section-meta"), style = WikiType.label, color = WikiPalette.secondary)
                }
                WikiPlanLogic.SectionSection.COVERS -> {
                    item(key = "covers-header") { WikiPlanSectionHead(WikiPlanCopy.covers) }
                    item(key = "covers") {
                        WikiCard { Text(section.covers, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp).testTag("wiki-plan-covers"), style = WikiType.subtext) }
                    }
                }
                WikiPlanLogic.SectionSection.SOURCES -> planSources(shown, doc, index, section)
            }
        }
    }
}

private fun LazyListScope.planSources(shown: WikiPlanLogic.Shown, doc: WikiPlanLogic.ShownDoc, index: Int, section: WikiPlanLogic.ShownSection) {
    val sources = section.sources
    fun found(kind: String, at: Int) = WikiPlanLogic.sourceFound(shown, doc, index, kind, at)
    if (sources.docs.isNotEmpty()) {
        item(key = "docs-header") { WikiPlanSectionHead(WikiPlanCopy.sourceDocs) }
        item(key = "docs") {
            WikiCard { sources.docs.forEachIndexed { k, source ->
                if (k > 0) HorizontalDivider(Modifier.padding(start = 16.dp))
                PlanSourceRow(source.path, source.section?.let { "§ $it" }, found("docs", k), "wiki-plan-source:docs:$k")
            } }
        }
    }
    if (sources.code.isNotEmpty()) {
        item(key = "code-header") { WikiPlanSectionHead(WikiPlanCopy.sourceCode) }
        item(key = "code") {
            WikiCard { sources.code.forEachIndexed { k, source ->
                if (k > 0) HorizontalDivider(Modifier.padding(start = 16.dp))
                PlanSourceRow(source.path, source.symbols.takeIf { it.isNotEmpty() }?.joinToString(" · "), found("code", k), "wiki-plan-source:code:$k")
            } }
        }
    }
    if (sources.contracts.isNotEmpty()) {
        item(key = "contracts-header") { WikiPlanSectionHead(WikiPlanCopy.sourceContracts) }
        item(key = "contracts") {
            WikiCard { sources.contracts.forEachIndexed { k, path ->
                if (k > 0) HorizontalDivider(Modifier.padding(start = 16.dp))
                PlanSourceRow(path, null, found("contracts", k), "wiki-plan-source:contracts:$k")
            } }
        }
    }
    val sessions = sources.sessions ?: return
    item(key = "sessions-header") { WikiPlanSectionHead(WikiPlanCopy.sourceSessions) }
    item(key = "sessions") {
        WikiCard(Modifier.testTag("wiki-plan-sessions")) {
            if (sessions.projects.isNotEmpty()) PlanCondition(WikiPlanCopy.sessionProjects) { PlanChips(sessions.projects.map { it.title }) }
            PlanCondition(WikiPlanCopy.sessionTime) { Text(WikiPlanCopy.time(sessions.since, sessions.until)) }
            if (sessions.keywords.isNotEmpty()) PlanCondition(WikiPlanCopy.sessionKeywords) { PlanChips(sessions.keywords) }
            if (sessions.anchorPaths.isNotEmpty()) PlanCondition(WikiPlanCopy.sessionAnchors) {
                Text(sessions.anchorPaths.joinToString("\n"), style = WikiType.mono)
            }
            if (sessions.entryKinds.isNotEmpty()) PlanCondition(WikiPlanCopy.sessionKinds) { Text(sessions.entryKinds.joinToString(" · ")) }
            if (sessions.topics.isNotEmpty()) PlanCondition(WikiPlanCopy.sessionTopics) { Text(sessions.topics.joinToString(" · ")) }
            if (sessions.evidence.isNotEmpty()) PlanCondition(WikiPlanCopy.sessionEvidence) { Text(sessions.evidence) }
        }
    }
}

/** `docs/architecture.md § Realtime and recovery ✓ found`: the path in full, never cut — a path cut short can't be checked. */
@Composable
private fun PlanSourceRow(path: String, detail: String?, found: Boolean?, tag: String) {
    val green = LocalOrbitColors.current.success
    val red = MaterialTheme.colorScheme.error
    Text(buildAnnotatedString {
        withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(path) }
        detail?.let { withStyle(SpanStyle(color = WikiPalette.secondary)) { append(" $it") } }
        found?.let { withStyle(SpanStyle(color = if (it) green else red, fontWeight = FontWeight.Bold)) { append(" ${if (it) WikiPlanCopy.found else WikiPlanCopy.notFound}") } }
    }, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp).testTag(tag), style = WikiType.subtext)
}

@Composable
private fun PlanCondition(title: String, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(title, style = WikiType.label, color = WikiPalette.secondary)
        ProvideTextStyle(WikiType.subtext) { content() }
    }
}

@Composable
private fun PlanChips(words: List<String>) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        words.forEach { word ->
            Text(word, Modifier.background(WikiPalette.secondary.copy(alpha = 0.12f), CircleShape).padding(horizontal = 8.dp, vertical = 3.dp),
                style = WikiType.label)
        }
    }
}
