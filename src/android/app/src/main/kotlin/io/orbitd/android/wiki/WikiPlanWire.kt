package io.orbitd.android.wiki

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

// The plan's wire types, transcribed from OrbitKit `Models/WikiPlan.swift` (contract `plan`). The draft
// shapes a failed job keeps and an edit is sent in are read leniently there, field by field: the model
// wrote them and the gate may have refused their very shape, so they are parsed by hand here too.

@Serializable
data class WikiPlanCategory(val key: String, val title: String? = null, val question: String? = null, val forAgents: Boolean? = null)

@Serializable
data class WikiPlanSessionCondition(val projects: List<Project>? = null, val since: String? = null, val until: String? = null,
    val keywords: List<String>? = null, val anchorPaths: List<String>? = null, val entryKinds: List<String>? = null,
    val topics: List<String>? = null, val evidence: String? = null) {
    @Serializable
    data class Project(val id: String, val title: String? = null)
}

@Serializable
data class WikiPlanSources(val docs: List<DocSource>? = null, val code: List<CodeSource>? = null,
    val contracts: List<ContractSource>? = null, val sessions: WikiPlanSessionCondition? = null) {
    @Serializable data class DocSource(val path: String, val section: String? = null)
    @Serializable data class CodeSource(val path: String, val symbols: List<String>? = null)
    @Serializable data class ContractSource(val path: String)
}

@Serializable
data class WikiPlanSection(val id: String, val key: String, val position: Int? = null, val title: String, val kind: String,
    val covers: String? = null, val length: Int? = null, val sources: WikiPlanSources? = null, val extra: JsonObject? = null)

@Serializable
data class WikiPlanDoc(val id: String, val position: Int? = null, val category: String, val slug: String, val title: String,
    val question: String? = null, val audience: List<String>? = null, val scopeIn: List<String>? = null,
    val scopeOut: List<ScopeOut>? = null, val length: WikiPlanRange? = null, val protected: Boolean? = null,
    val sections: List<WikiPlanSection>? = null, val extra: JsonObject? = null) {
    @Serializable data class ScopeOut(val text: String, val docs: List<String>? = null)
}

@Serializable
data class WikiPlanNewField(val at: String, val name: String, val why: String? = null, val values: Int? = null)

@Serializable
data class WikiPlanGateReport(val checkedAt: String? = null, val checks: Map<String, String>? = null, val docs: Int? = null,
    val target: WikiPlanRange? = null, val needsNewFields: List<WikiPlanNewField>? = null)

@Serializable
data class WikiPlanRepoCheck(val sha: String, val checked: Int? = null, val missing: List<Miss>? = null) {
    @Serializable data class Miss(val kind: String, val ref: String, val at: String? = null)
}

@Serializable
data class WikiPlanVersion(val id: String, val spaceId: String? = null, val version: Int, val status: String,
    val origin: String? = null, val baseVersion: Int? = null, val proposalId: String? = null,
    val categories: List<WikiPlanCategory>? = null, val target: WikiPlanRange? = null, val gate: WikiPlanGateReport? = null,
    val repoCheck: WikiPlanRepoCheck? = null, val model: String? = null, val confirmedAt: String? = null,
    val supersededAt: String? = null, val createdAt: String? = null, val docs: List<WikiPlanDoc>? = null)

@Serializable
data class WikiPlanVersionSummary(val id: String, val version: Int, val status: String, val origin: String? = null,
    val baseVersion: Int? = null, val proposalId: String? = null, val docCount: Int? = null, val createdAt: String? = null,
    val confirmedAt: String? = null, val supersededAt: String? = null)

@Serializable
data class WikiPlanVersions(val spaceId: String? = null, val versions: List<WikiPlanVersionSummary>)

@Serializable
data class WikiPlanProposal(val id: String, val status: String, val baseVersion: Int? = null, val reason: String? = null,
    @kotlinx.serialization.SerialName("change") val changeJson: JsonElement? = null, val facts: List<Fact>? = null,
    val decidedAt: String? = null, val decisionNote: String? = null, val resultVersion: Int? = null, val createdAt: String? = null) {
    @Serializable data class Fact(val kind: String, val id: String)
    /** The document as a draft writes one: sections by key, projects by id; the category it opens, if any. */
    data class Change(val doc: WikiPlanDocInput, val category: WikiPlanCategoryInput?)
    val change: Change? get() {
        val c = changeJson as? JsonObject ?: return null
        val doc = c["doc"] as? JsonObject ?: return null
        if (doc["slug"].text() == null) return null
        return Change(WikiPlanDocInput.read(doc), (c["category"] as? JsonObject)?.let(WikiPlanCategoryInput::read))
    }
}

/** A session condition as a draft writes it: projects by id or exact title. Lenient, as the web's `??` reads it. */
data class WikiPlanSessionConditionInput(val projects: List<String>? = null, val since: String? = null, val until: String? = null,
    val keywords: List<String>? = null, val anchorPaths: List<String>? = null, val entryKinds: List<String>? = null,
    val topics: List<String>? = null, val evidence: String? = null) {
    fun json(): JsonObject = buildJsonObject {
        projects?.let { put("projects", JsonArray(it.map(::JsonPrimitive))) }
        since?.let { put("since", it) }; until?.let { put("until", it) }
        keywords?.let { put("keywords", JsonArray(it.map(::JsonPrimitive))) }
        anchorPaths?.let { put("anchorPaths", JsonArray(it.map(::JsonPrimitive))) }
        entryKinds?.let { put("entryKinds", JsonArray(it.map(::JsonPrimitive))) }
        topics?.let { put("topics", JsonArray(it.map(::JsonPrimitive))) }
        evidence?.let { put("evidence", it) }
    }
    companion object {
        fun strings(e: JsonElement?): List<String>? = (e as? JsonArray)?.let { a -> if (a.all { it.text() != null }) a.map { it.text()!! } else null }
        fun read(c: JsonObject) = WikiPlanSessionConditionInput(strings(c["projects"]), c["since"].text(), c["until"].text(),
            strings(c["keywords"]), strings(c["anchorPaths"]), strings(c["entryKinds"]), strings(c["topics"]), c["evidence"].text())
    }
}

data class WikiPlanSourcesInput(val docs: List<WikiPlanSources.DocSource>? = null, val code: List<WikiPlanSources.CodeSource>? = null,
    val contracts: List<WikiPlanSources.ContractSource>? = null, val sessions: WikiPlanSessionConditionInput? = null) {
    /** Swift's synthesized encoding: a nil optional is left out, never sent as null. */
    fun json(): JsonObject = buildJsonObject {
        docs?.let { list -> put("docs", JsonArray(list.map { d -> buildJsonObject { put("path", d.path); d.section?.let { put("section", it) } } })) }
        code?.let { list -> put("code", JsonArray(list.map { c -> buildJsonObject {
            put("path", c.path); c.symbols?.let { put("symbols", JsonArray(it.map(::JsonPrimitive))) } } })) }
        contracts?.let { list -> put("contracts", JsonArray(list.map { c -> buildJsonObject { put("path", c.path) } })) }
        sessions?.let { put("sessions", it.json()) }
    }
    companion object {
        fun read(c: JsonObject?) = WikiPlanSourcesInput(c?.get("docs").lenient(kotlinx.serialization.builtins.ListSerializer(WikiPlanSources.DocSource.serializer())),
            c?.get("code").lenient(kotlinx.serialization.builtins.ListSerializer(WikiPlanSources.CodeSource.serializer())),
            c?.get("contracts").lenient(kotlinx.serialization.builtins.ListSerializer(WikiPlanSources.ContractSource.serializer())),
            (c?.get("sessions") as? JsonObject)?.let(WikiPlanSessionConditionInput::read))
    }
}

/** A section as a draft writes it: its key when the document had it, none for a section added. */
data class WikiPlanSectionInput(val key: String? = null, val title: String, val kind: String, val covers: String, val length: Int,
    val sources: WikiPlanSourcesInput = WikiPlanSourcesInput(), val extra: JsonObject? = null) {
    fun json(): JsonObject = buildJsonObject {
        key?.let { put("key", it) }
        put("title", title); put("kind", kind); put("covers", covers); put("length", length)
        put("sources", sources.json())
        if (!extra.isNullOrEmpty()) put("extra", extra)
    }
    companion object {
        fun read(c: JsonObject) = WikiPlanSectionInput(c["key"].text(), c["title"].text() ?: "", c["kind"].text() ?: "unknown",
            c["covers"].text() ?: "", c["length"].integer() ?: 0, WikiPlanSourcesInput.read(c["sources"] as? JsonObject), c["extra"] as? JsonObject)
    }
}

/** A document as a draft writes it — what an owner's edit is sent as (`POST …/plan/edits`), never the read. */
data class WikiPlanDocInput(val category: String, val slug: String, val title: String, val question: String,
    val audience: List<String>, val scopeIn: List<String>, val scopeOut: List<WikiPlanDoc.ScopeOut>, val length: WikiPlanRange,
    val protected: Boolean? = null, val sections: List<WikiPlanSectionInput>, val extra: JsonObject? = null) {
    fun json(): JsonObject = buildJsonObject {
        put("category", category); put("slug", slug); put("title", title); put("question", question)
        put("audience", JsonArray(audience.map(::JsonPrimitive))); put("scopeIn", JsonArray(scopeIn.map(::JsonPrimitive)))
        put("scopeOut", JsonArray(scopeOut.map { o -> buildJsonObject { put("text", o.text); o.docs?.let { put("docs", JsonArray(it.map(::JsonPrimitive))) } } }))
        put("length", buildJsonObject { put("min", length.min); put("max", length.max) })
        protected?.let { put("protected", it) }
        put("sections", JsonArray(sections.map { it.json() }))
        if (!extra.isNullOrEmpty()) put("extra", extra)
    }
    companion object {
        fun read(c: JsonObject) = WikiPlanDocInput(c["category"].text() ?: "", c["slug"].text() ?: "", c["title"].text() ?: "",
            c["question"].text() ?: "", WikiPlanSessionConditionInput.strings(c["audience"]) ?: emptyList(),
            WikiPlanSessionConditionInput.strings(c["scopeIn"]) ?: emptyList(),
            c["scopeOut"].lenient(kotlinx.serialization.builtins.ListSerializer(WikiPlanDoc.ScopeOut.serializer())) ?: emptyList(),
            c["length"].lenient(WikiPlanRange.serializer()) ?: WikiPlanRange(0, 0), c["protected"].bool(),
            (c["sections"] as? JsonArray)?.filterIsInstance<JsonObject>()?.map(WikiPlanSectionInput::read) ?: emptyList(),
            c["extra"] as? JsonObject)
    }
}

data class WikiPlanCategoryInput(val key: String, val title: String?, val question: String?, val forAgents: Boolean?) {
    companion object {
        fun read(c: JsonObject) = WikiPlanCategoryInput(c["key"].text() ?: "", c["title"].text(), c["question"].text(), c["forAgents"].bool())
    }
}

/** A whole draft as it was sent to the gate: what a failed job keeps. */
data class WikiPlanDraftInput(val categories: List<WikiPlanCategoryInput>, val docs: List<WikiPlanDocInput>) {
    companion object {
        fun read(element: JsonElement?): WikiPlanDraftInput? {
            val c = element as? JsonObject ?: return null
            val categories = (c["categories"] as? JsonArray)?.filterIsInstance<JsonObject>()?.map(WikiPlanCategoryInput::read) ?: return null
            val docs = (c["docs"] as? JsonArray)?.filterIsInstance<JsonObject>()?.map(WikiPlanDocInput::read) ?: return null
            return WikiPlanDraftInput(categories, docs)
        }
    }
}

@Serializable
data class WikiPlanGateError(val check: String, val path: String, val message: String)

/** A space's plan job (contract `plan.jobs.read`). The report and the kept draft are read leniently. */
data class WikiPlanJob(val id: String, val spaceId: String?, val kind: String, val trigger: String?, val state: String,
    val instructions: String?, val requestedAt: String?, val held: Held?, val waitingFor: WaitingFor?, val taskId: String?,
    val provider: String?, val sessionId: String?, val madeAt: String?, val startedAt: String?, val endedAt: String?,
    val attempt: Int?, val attemptsMax: Int?, val progress: Progress?, val version: Int?, val errors: List<WikiPlanGateError>?,
    val error: String?, val report: Report?, val draft: WikiPlanDraftInput?) {
    @Serializable data class Held(val reason: String, val at: String? = null)
    @Serializable data class WaitingFor(val taskId: String, val title: String? = null, val sessionId: String? = null, val startedAt: String? = null)
    @Serializable data class Progress(val docs: Docs, val current: Current? = null) {
        @Serializable data class Docs(val done: Int, val total: Int)
        @Serializable data class Current(val slug: String, val title: String)
    }
    data class Report(val categories: Int?, val docs: Int?, val sections: Int?, val target: WikiPlanRange?, val repo: Repo?,
        val attempts: List<Attempt>?, val tokens: Tokens?, val seconds: Int?, val model: String?, val planVersion: Int?,
        val repoSha: String?, val builtDocs: BuiltDocs?, val builtSections: BuiltSections?) {
        @Serializable data class Attempt(val attempt: Int, val local: Int? = null, val server: Int? = null, val checks: Map<String, Int>? = null)
        @Serializable data class Tokens(val input: Int? = null, val output: Int? = null, val calls: Int? = null)
        @Serializable data class BuiltDocs(val total: Int? = null, val written: Int? = null)
        @Serializable data class BuiltSections(val written: Int? = null, val unchanged: Int? = null, val failed: Int? = null)
        @Serializable data class Repo(val sha: String, val checked: Int? = null, val missing: Int? = null)
        companion object {
            fun read(c: JsonObject) = Report(c["categories"].integer(), c["docs"].integer(), c["sections"].integer(),
                c["target"].lenient(WikiPlanRange.serializer()), c["repo"].lenient(Repo.serializer()),
                c["attempts"].lenient(kotlinx.serialization.builtins.ListSerializer(Attempt.serializer())),
                c["tokens"].lenient(Tokens.serializer()), c["seconds"].integer(), c["model"].text(), c["planVersion"].integer(),
                c["repoSha"].text(), (c["docs"] as? JsonObject).lenient(BuiltDocs.serializer()),
                (c["sections"] as? JsonObject).lenient(BuiltSections.serializer()))
        }
    }
    companion object {
        fun read(element: JsonElement?): WikiPlanJob? {
            val c = element as? JsonObject ?: return null
            val id = c["id"].text() ?: return null
            return WikiPlanJob(id, c["spaceId"].text(), c["kind"].text() ?: "unknown", c["trigger"].text(), c["state"].text() ?: "unknown",
                c["instructions"].text(), c["requestedAt"].text(), c["held"].lenient(Held.serializer()),
                c["waitingFor"].lenient(WaitingFor.serializer()), c["taskId"].text(), c["provider"].text(), c["sessionId"].text(),
                c["madeAt"].text(), c["startedAt"].text(), c["endedAt"].text(), c["attempt"].integer(), c["attemptsMax"].integer(),
                c["progress"].lenient(Progress.serializer()), c["version"].integer(),
                c["errors"].lenient(kotlinx.serialization.builtins.ListSerializer(WikiPlanGateError.serializer())),
                c["error"].text(), (c["report"] as? JsonObject)?.let(Report::read), WikiPlanDraftInput.read(c["draft"]))
        }
    }
}

/** `GET /api/wiki/spaces/:id/plan`: the version in force, the draft, the pending proposals and the job. */
data class WikiPlanState(val spaceId: String?, val confirmed: WikiPlanVersion?, val draft: WikiPlanVersion?,
    val proposals: List<WikiPlanProposal>?, val job: WikiPlanJob?) {
    companion object {
        fun decode(element: JsonElement): WikiPlanState {
            val c = element.jsonObject
            fun version(key: String) = c[key]?.takeIf { it !is JsonNull }?.let { Wire.json.decodeFromJsonElement(WikiPlanVersion.serializer(), it) }
            return WikiPlanState(c["spaceId"].text(), version("confirmed"), version("draft"),
                c["proposals"]?.takeIf { it !is JsonNull }?.let { Wire.json.decodeFromJsonElement(kotlinx.serialization.builtins.ListSerializer(WikiPlanProposal.serializer()), it) },
                WikiPlanJob.read(c["job"]))
        }
    }
}
