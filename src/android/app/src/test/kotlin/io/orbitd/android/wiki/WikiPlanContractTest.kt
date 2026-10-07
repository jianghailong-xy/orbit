package io.orbitd.android.wiki

import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.ApiResponse
import java.time.Instant
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** OrbitKit `WikiPlanContractTests` against the Kotlin port: `contracts/wiki.contract.json` `plan` — the closed sets the
 * pages branch on, the user door's routes the owner reads, edits, confirms and decides on — and that what the server
 * answers decodes, with a word this build has never heard of kept as it was sent rather than failing the page (closed
 * sets stay raw words here, where Swift reads them as `.unknown`). */
class WikiPlanContractTest {
    private val contract get() = WikiFixtures.contract
    private val plan get() = contract.obj("plan")
    private val userRoutes get() = contract.obj("agentSurface").obj("doors").obj("user").strings("routes").toSet()
    private val maintenanceRoutes get() = contract.obj("agentSurface").obj("doors").obj("runner").strings("maintenanceRoutes").toSet()

    @Test fun theClosedSetsAreTheContracts() {
        // The section kinds the Edit sheets offer are the contract's, in its order, each with a name of its own.
        assertEquals(plan.obj("sectionKinds").keys.toList(), wikiPlanSectionKinds)
        wikiPlanSectionKinds.filter { it != "other" }.forEach { assertNotEquals(it, "Other", WikiDocCopy.sectionKind(it)) }
        // A version's three statuses are the page's three words; one a later server adds reads as a Draft.
        assertEquals(mapOf("draft" to "Draft", "confirmed" to "Confirmed", "superseded" to "Superseded"),
            plan.obj("statuses").keys.associateWith { WikiPlanLogic.fromVersion(WikiPlanVersion("v", version = 1, status = it)).status.label })
        assertEquals("Draft", WikiPlanLogic.fromVersion(WikiPlanVersion("v", version = 1, status = "archived")).status.label)
        // The origins: the page names the owner's; anything else is a maintenance run's.
        assertEquals(setOf("maintenance", "owner"), plan.obj("origins").keys)
        assertEquals("maintenance", WikiPlanLogic.fromVersion(WikiPlanVersion("v", version = 1, status = "draft")).origin)
        assertEquals(setOf("pending", "accepted", "rejected"), plan.obj("proposals").obj("statuses").keys)
        // The gate's four checks are the report's four rows.
        assertEquals(plan.obj("gate").strings("checks").toSet(), WikiPlanLogic.gateOrder.toSet())
    }

    /** The owner's six routes are the user door's — and the Kotlin client calls exactly those; the runner door has the
     * maintenance run's three, none of which confirms or decides anything. */
    @Test fun theOwnersRoutesAreOnTheUserDoor() {
        val routes = plan.obj("routes")
        listOf("state", "versions", "version", "edit", "confirm", "decide").forEach { name ->
            assertTrue("${routes.str(name)} is not a route the user door declares", routes.str(name) in userRoutes)
        }
        listOf("runnerState", "draft", "propose").forEach { name ->
            val route = routes.str(name)
            assertTrue("$route is not a maintenance route", route in maintenanceRoutes)
            assertFalse(route, route.contains("confirm") || route.contains("decide"))
        }
        assertTrue(plan.obj("who").str("owner").contains("WIKI_OWNER_CHANNEL_ONLY"))
        // What this client sends for each: the same routes, all on the user door.
        val called = clientRoutes { client ->
            client.plan("SP"); client.planVersions("SP"); client.planVersion("SP", 7)
            client.editPlan("SP", buildJsonObject {}); client.confirmPlan("SP", 7); client.decidePlanProposal("PR", accept = true)
            client.redraftPlan("SP", null)
        }
        assertEquals(listOf("state", "versions", "version", "edit", "confirm", "decide").map { routes.str(it) } +
            plan.obj("jobs").obj("routes").str("redraft"), called)
        called.forEach { assertTrue("$it is not a route the user door declares", it in userRoutes) }
        assertFalse(called.toString(), called.any { it.contains("/runner/") })
    }

    /** The plan's jobs (contract `plan.jobs`): what the pages branch on is the contract's, and the owner's redraft is the
     * user door's route; the run's five are the runner door's maintenance routes. */
    @Test fun theJobsClosedSetsAndRoutesAreTheContracts() {
        val jobs = plan.obj("jobs")
        assertEquals(setOf("draft", "revise", "build"), jobs.obj("kinds").keys)
        assertEquals(setOf("space_created", "owner"), jobs.obj("triggers").keys)
        val states = jobs.obj("states").keys
        assertEquals(setOf("queued", "held", "running", "succeeded", "failed"), states)
        // A draft is on its way while it is queued, held or running — never once it ended.
        assertEquals(setOf("queued", "held", "running"), states.filter { state ->
            WikiPlanLogic.openJob(WikiPlanState("sp", null, null, emptyList(), job("draft", state))) != null }.toSet())
        assertEquals(setOf("queued", "held", "running"), states.filter { state ->
            WikiPlanLogic.buildJob(WikiPlanState("sp", null, null, emptyList(), job("build", state))) != null }.toSet())
        // The server's two held reasons, and the runner offline, which only a client can see.
        assertEquals(jobs.obj("held").strings("reasons"), WikiPlanLogic.Held.entries.filter { it != WikiPlanLogic.Held.RUNNER_OFFLINE }.map { it.name.lowercase() })
        assertEquals(WikiPlanLogic.Held.MAINTENANCE_PROVIDER_UNUSABLE, WikiPlanLogic.held(job("draft", "held", """{"reason":"maintenance_provider_unusable"}"""), true))
        assertEquals(WikiPlanLogic.Held.NO_MAINTENANCE_WORKSPACE, WikiPlanLogic.held(job("draft", "held", """{"reason":"no_maintenance_workspace"}"""), true))
        // The rounds a draft gets: the card counts against the contract's three when a job does not say.
        assertEquals(3, jobs.obj("rules").int("attemptsMax"))
        val running = WikiPlanLogic.jobCard(WikiPlanJob.read(Json.parseToJsonElement(
            """{"id":"j","kind":"draft","state":"running","provider":"local-vllm","startedAt":"2026-09-29T07:00:00Z"}""")),
            Instant.parse("2026-09-29T08:00:00Z"), true, null, false, null)
        assertEquals("local-vllm · attempt 1 of 3 · started 1h ago", running?.text)
        val routes = jobs.obj("routes")
        assertTrue("the redraft is not a route of the user door", routes.str("redraft") in userRoutes)
        listOf("context", "progress", "finish", "check", "materials").forEach { assertTrue("$it is not a maintenance route", routes.str(it) in maintenanceRoutes) }
        val refusals = contract["refusals"] as JsonArray
        assertEquals(409, refusals.map { it.jsonObject }.first { it["code"].text() == "WIKI_PLAN_NO_JOB" }.int("httpStatus"))
    }

    /** The plan as the server answers it: the version in force, the draft, the pending proposals. */
    @Test fun theStateDecodes() {
        val state = WikiPlanState.decode(Json.parseToJsonElement(STATE))
        val confirmed = state.confirmed!!
        assertEquals("confirmed", confirmed.status)
        assertEquals("maintenance", confirmed.origin)
        assertEquals(true, confirmed.categories?.last()?.forAgents)
        assertEquals("passed", confirmed.gate?.checks?.get("protected"))
        assertEquals("evidenceWeight", confirmed.gate?.needsNewFields?.first()?.name)
        assertEquals("symbol", confirmed.repoCheck?.missing?.first()?.kind)
        val doc = confirmed.docs!!.first()
        assertEquals(true, doc.protected)
        assertEquals(listOf("session-state"), doc.scopeOut?.first()?.docs)
        assertEquals(listOf("s1", "s2"), doc.sections?.map { it.key })
        assertEquals(listOf("overview", "pitfalls"), doc.sections?.map { it.kind })
        val sessions = doc.sections!!.last().sources!!.sessions!!
        assertEquals(listOf("Orbit Wiki · 阶段 2", null), sessions.projects?.map { it.title })
        // An entry kind this build has not heard of is kept as it was sent, and the page still decodes.
        assertEquals(listOf("pitfall", "rumour"), sessions.entryKinds)
        assertNull(state.draft)
        val proposal = state.proposals!!.first()
        assertEquals("pending", proposal.status)
        assertEquals("backups", proposal.change?.doc?.slug)
        assertEquals("ops", proposal.change?.category?.key)
        assertEquals("flow", proposal.change?.doc?.sections?.first()?.kind)
        // A status, an origin and a section kind a later server adds still decode, and the page reads them as a Draft,
        // a maintenance run's version and an Other section.
        val later = STATE.replace("\"status\":\"confirmed\"", "\"status\":\"archived\"").replace("\"origin\":\"maintenance\"", "\"origin\":\"import\"")
            .replace("\"kind\":\"overview\"", "\"kind\":\"glossary\"")
        val decoded = WikiPlanState.decode(Json.parseToJsonElement(later))
        assertEquals("archived", decoded.confirmed?.status)
        assertEquals("glossary", decoded.confirmed?.docs?.first()?.sections?.first()?.kind)
        val shown = WikiPlanLogic.fromVersion(decoded.confirmed!!)
        assertEquals(WikiPlanLogic.ShownStatus.DRAFT, shown.status)
        assertEquals("Other", WikiDocCopy.sectionKind(shown.docs.first().sections.first().kind))
    }

    /** The job on the plan's read, as each card of the plan page draws it: queued behind a run, held with why, running on
     * a round, and failed with the gate's errors. */
    @Test fun theJobDecodes() {
        val running = WikiPlanState.decode(Json.parseToJsonElement("""
            {"spaceId":"34WSpace","confirmed":null,"draft":null,"proposals":[],
             "job":{"id":"34WJob","spaceId":"34WSpace","kind":"draft","trigger":"space_created","state":"running","instructions":null,
                    "requestedAt":"2026-09-29T00:41:00.000Z","held":null,"waitingFor":null,"taskId":"34WTask","provider":"local-vllm",
                    "sessionId":"34WSession","madeAt":"2026-09-29T00:41:00.000Z","startedAt":"2026-09-29T00:42:00.000Z","endedAt":null,
                    "attempt":1,"attemptsMax":3,"version":null,"errors":[],"error":null,"report":null,"draft":null}}""")).job!!
        assertEquals(listOf("draft", "space_created", "running", "local-vllm"), listOf(running.kind, running.trigger, running.state, running.provider))
        assertEquals(1, running.attempt); assertEquals(3, running.attemptsMax)

        val waiting = WikiPlanJob.read(Json.parseToJsonElement("""
            {"id":"34WJob","kind":"revise","trigger":"owner","state":"queued","instructions":"合并到 30 篇左右",
             "waitingFor":{"taskId":"34WMaint","title":"Wiki maintenance: orbit","sessionId":"34WRun","startedAt":"2026-09-29T00:37:00.000Z"}}"""))!!
        assertEquals(listOf("queued", "revise", "合并到 30 篇左右", "34WRun"), listOf(waiting.state, waiting.kind, waiting.instructions, waiting.waitingFor?.sessionId))

        val held = WikiPlanJob.read(Json.parseToJsonElement(
            """{"id":"34WJob","kind":"draft","state":"held","held":{"reason":"no_maintenance_workspace","at":"2026-09-29T00:41:00.000Z"}}"""))!!
        assertEquals("no_maintenance_workspace", held.held?.reason)

        val answer = Json.parseToJsonElement("""
            {"created":false,"job":{"id":"34WJob","kind":"draft","state":"failed","attempt":3,"attemptsMax":3,
             "errors":[{"check":"docCount","path":"plan.docs","message":"the plan has 40 documents; it must have 20 to 35"}],
             "error":"the draft did not pass the plan's gate in 3 rounds",
             "report":{"categories":11,"docs":40,"sections":321,"attempts":[{"attempt":1,"local":12,"server":0,"checks":{"references":11,"docCount":1}}],
                       "tokens":{"input":1300000,"output":150000,"calls":70},"seconds":6400,"model":"qwen3.8-27b-fp8"}}}""")
        assertEquals(false, answer["created"].bool())
        val failed = WikiPlanJob.read(answer["job"])!!
        assertEquals("failed", failed.state)
        assertEquals("docCount", failed.errors?.first()?.check)
        assertEquals(11, failed.report?.attempts?.first()?.checks?.get("references"))
        assertEquals(70, failed.report?.tokens?.calls)

        // Words a later server adds are kept as they were sent; such a job is neither on its way nor held.
        val later = WikiPlanJob.read(Json.parseToJsonElement("""{"id":"34WJob","kind":"index","trigger":"schedule","state":"paused","held":{"reason":"gpu_busy"}}"""))!!
        assertEquals(listOf("index", "schedule", "paused", "gpu_busy"), listOf(later.kind, later.trigger, later.state, later.held?.reason))
        assertNull(WikiPlanLogic.openJob(WikiPlanState("sp", null, null, emptyList(), later)))
        assertNull(WikiPlanLogic.held(later, true))
    }

    /** A build's job, as the plan page's «Writing documents» draws it: its version from the start, how far it got while it
     * runs, and its report when it ended — counts by outcome where a draft's report has totals. */
    @Test fun aBuildJobDecodes() {
        val job = WikiPlanJob.read(Json.parseToJsonElement("""
            {"id":"34WJob","kind":"build","trigger":"owner","state":"running","version":3,
             "progress":{"docs":{"done":12,"total":49},"current":{"slug":"session-search","title":"会话搜索"}},"report":null}"""))!!
        assertEquals("build", job.kind)
        assertEquals(3, job.version)
        assertEquals(12, job.progress?.docs?.done); assertEquals(49, job.progress?.docs?.total)
        assertEquals("会话搜索", job.progress?.current?.title)

        val built = WikiPlanJob.read(Json.parseToJsonElement("""
            {"id":"34WJob","kind":"build","state":"succeeded","version":3,"progress":{"docs":{"done":49,"total":49},"current":null},
             "report":{"planVersion":3,"repoSha":"4e4bb4781aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","docs":{"total":49,"written":49},
                       "sections":{"written":12,"unchanged":359,"failed":0},"tokens":{"input":900000,"output":150000,"calls":40},"seconds":5400,"model":"qwen3.8-27b-fp8"}}"""))!!
        assertEquals(3, built.report?.planVersion)
        assertEquals(49, built.report?.builtDocs?.written)
        assertEquals(359, built.report?.builtSections?.unchanged)
        assertNull("a build's documents are counts by outcome, not a draft's total", built.report?.docs)
        assertNull(built.progress?.current)
    }

    /** The history, and a refusal of the gate: every error with its check, where it is and why. */
    @Test fun theHistoryAndTheGatesErrorsDecode() {
        val versions = Json.parseToJsonElement("""
            {"spaceId":"34WSpace","versions":[
              {"id":"34WPlan3","version":3,"status":"draft","origin":"owner","baseVersion":2,"proposalId":null,"docCount":21,
               "createdAt":"2026-09-29T03:00:00.000Z","confirmedAt":null,"supersededAt":null},
              {"id":"34WPlan1","version":1,"status":"confirmed","origin":"maintenance","baseVersion":null,"proposalId":null,"docCount":20,
               "createdAt":"2026-09-29T00:00:00.000Z","confirmedAt":"2026-09-29T01:00:00.000Z","supersededAt":null}]}""").decode(WikiPlanVersions.serializer()).versions
        assertEquals(listOf(3, 1), versions.map { it.version })
        assertEquals(listOf("draft", "confirmed"), versions.map { it.status })
        assertEquals("owner", versions.first().origin)
        val errors = Json.parseToJsonElement("""
            [{"check":"protected","path":"plan.docs[3]","message":"session-runtime is protected"},
             {"check":"references","path":"plan.docs[6].sections[2].sources.sessions.topics[1]","message":"engineering is not a topic of this space"},
             {"check":"style","path":"plan.docs[0]","message":"a check a later server runs"}]""").decode(ListSerializer(WikiPlanGateError.serializer()))
        assertEquals(listOf("protected", "references", "style"), errors.map { it.check })
        assertEquals("plan.docs[6].sections[2].sources.sessions.topics[1]", errors[1].path)
    }

    private fun job(kind: String, state: String, held: String? = null) = WikiPlanJob.read(Json.parseToJsonElement(
        """{"id":"j","kind":"$kind","state":"$state"${held?.let { ",\"held\":$it" } ?: ""}}"""))

    /** The routes a Kotlin client's calls go to, as the contract writes them: `POST /api/wiki/plan-proposals/:id/decide`. */
    private fun clientRoutes(calls: suspend (WikiClient) -> Unit): List<String> {
        val seen = mutableListOf<String>()
        val rig = WikiTestRig { null }
        val client = WikiClient(object : OrbitApi {
            override suspend fun request(handle: SessionHandle, request: ApiRequest): ApiResponse {
                seen += "${request.method} /api/" + request.path.joinToString("/") { when (it) { "SP", "PR" -> ":id"; "7" -> ":version"; else -> it } }
                val body = when {
                    request.path.last() == "versions" -> """{"versions":[]}"""
                    request.path.last() == "decide" -> """{"draft":null}"""
                    request.path.last() == "redraft" -> """{"created":true}"""
                    request.path.last() == "plan" -> """{"spaceId":"SP","confirmed":null,"draft":null,"proposals":[],"job":null}"""
                    else -> """{"id":"v","version":7,"status":"draft"}"""
                }
                return ApiResponse(200, body.encodeToByteArray())
            }
        }, rig.handle)
        runBlocking { calls(client) }
        return seen
    }

    private companion object {
        const val STATE = """
            {"spaceId":"34WSpace",
             "confirmed":{"id":"34WPlan1","spaceId":"34WSpace","version":1,"status":"confirmed","origin":"maintenance","baseVersion":null,
               "proposalId":null,"categories":[{"key":"product","title":"Product","question":"What Orbit is","forAgents":false},
                                               {"key":"dev","title":"Development conventions","question":"","forAgents":true}],
               "newFields":[],"target":{"min":20,"max":35},
               "gate":{"checkedAt":"2026-09-29T00:00:00.000Z","checks":{"schema":"passed","docCount":"passed","protected":"passed","references":"passed"},
                       "docs":20,"target":{"min":20,"max":35},"needsNewFields":[{"at":"section","name":"evidenceWeight","why":"merging","values":1}]},
               "repoCheck":{"sha":"0123456789abcdef0123456789abcdef01234567","checked":42,"missing":[{"kind":"symbol","ref":"claudeRuntime.setPhase","at":"docs[3].sections[1].code[0]"}]},
               "model":"qwen3.8-27b-fp8","confirmedAt":"2026-09-29T01:00:00.000Z","supersededAt":null,"createdAt":"2026-09-29T00:00:00.000Z",
               "docs":[{"id":"34WDoc1","position":0,"category":"product","slug":"session-runtime","title":"会话运行模型与长连接",
                        "question":"How does a session run?","audience":["A new developer"],"scopeIn":["Delivery"],
                        "scopeOut":[{"text":"The state model","docs":["session-state"]}],"length":{"min":3000,"max":4500},"protected":true,
                        "sections":[{"id":"34WSec1","key":"s1","position":0,"title":"Overview","kind":"overview","covers":"What it is.","length":300,
                                     "sources":{"docs":[],"code":[],"contracts":[],"sessions":null}},
                                    {"id":"34WSec2","key":"s2","position":1,"title":"Known pitfalls","kind":"pitfalls","covers":"What went wrong.","length":400,
                                     "sources":{"docs":[{"path":"docs/architecture.md","section":"Execution model"}],"code":[{"path":"src/runner-go/runloop.go","symbols":["runLoop()"]}],
                                                "contracts":[{"path":"contracts/wiki.contract.json"}],
                                                "sessions":{"projects":[{"id":"34WProject","title":"Orbit Wiki · 阶段 2"},{"id":"34WGone","title":null}],
                                                            "since":"2026-09-01","until":null,"keywords":["plan"],"anchorPaths":["src/apiserver/src/wiki/"],
                                                            "entryKinds":["pitfall","rumour"],"topics":["wiki"],"evidence":"the owner's words"}}}]}]},
             "draft":null,
             "proposals":[{"id":"34WProposal","spaceId":"34WSpace","status":"pending","baseVersion":1,"reason":"Backups fit no section.",
                           "change":{"doc":{"category":"ops","slug":"backups","title":"Backups","question":"How do I back up?",
                                            "sections":[{"title":"How it runs","kind":"flow","covers":"The steps.","length":800,"sources":{}}]},
                                     "category":{"key":"ops","title":"Operations"}},
                           "facts":[{"kind":"entry","id":"34WEntry"}],"decidedAt":null,"decisionNote":null,"resultVersion":null,
                           "createdAt":"2026-09-29T02:00:00.000Z"}]}"""
    }
}
