package io.orbitd.android

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.cards.text
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.EventTransport
import io.orbitd.android.core.realtime.SseFrame
import io.orbitd.android.navigation.ObjectId
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation

/** One controlled Orbit server for the A05d shell tests: the production Activity, AuthSession, RealtimeStore and navigation over
 * these answers. Project Launch's coordinator and a running member are in Alpha, a member waiting on you in Beta, a member in
 * Completed; Alpha also has an ordinary session. A second open project, Quiet, has no sessions at all. Not a deployed backend. */
internal object ProjectShell {
    const val ALPHA = "34A05dWorkspaceAlpha01"
    const val BETA = "34A05dWorkspaceBeta002"
    const val LAUNCH = "34A05dProjectLaunch001"
    const val QUIET = "34A05dProjectQuiet0002"
    const val COORD = "34A05dSessionCoord0001"
    const val WORKER = "34A05dSessionWorker002"
    const val WAITING = "34A05dSessionWaiting03"
    const val PLAIN = "34A05dSessionPlain0004"
    const val DONE = "34A05dSessionDone00005"
    /** A landing session (sessionKind LANDING): never in a list, reached by its link only. Its row may not exist yet — the
     *  pre-generated id answers the landing view either way (contract §2.9 LS1). */
    const val LANDING = "34A05dSessionLanding06"
    /** A task of Launch's, assigned to Alpha (which has a runner): its Run starts [WORKER] as its run (A11k). */
    const val TASK = "34A11kTaskRunsOnce0007"
    private val ids = listOf(ALPHA, BETA, LAUNCH, QUIET, COORD, WORKER, WAITING, PLAIN, DONE, LANDING, TASK)

    /** Every request after the login, as `METHOD path?query`. */
    val calls = CopyOnWriteArrayList<String>()
    /** Whether anyone has started Launch, and what its open items hold (a start request, or nothing). */
    @Volatile var started = true
    @Volatile var startRequest = false
    /** The status the project-scoped session reads answer with, instead of their rows (Quiet's failure case). */
    @Volatile var quietStatus = 200
    // A05-7's ending (docs/mocks/project-done-sessions-page): Launch recorded done. Its sidebar row goes — the rows are the Open
    // projects — its members' membership says DONE, and its document carries the projection the card is drawn from.
    /** Whether Launch has been recorded done. */
    @Volatile var done = false
    /** Who recorded it: "DERIVED" for Orbit itself, "OWNER" for the owner's own press. */
    @Volatile var doneBy = "DERIVED"
    /** Whether the DONE document carries the projection's counts; false is a server before the owner's done door, which draws none. */
    @Volatile var doneCounts = true

    // A11-9: Launch's merge into main. Off by default, which answers as the server does for a project asking nothing.
    /** The candidate `promotions/current` answers, or null for none (an empty body). */
    @Volatile var promotion: String? = null
    /** The merges `promotions/merged` lists. */
    @Volatile var merged = "[]"
    /** Whether the landing in flight is the merge check (CHECK_PROMOTION) rather than a task landing on the branch. */
    @Volatile var mergeCheck = false
    /** Which merge job the line in flight is, while [mergeCheck]: `CHECK_PROMOTION` or `LAND_PROMOTION`. */
    @Volatile var mergeJobKind = "CHECK_PROMOTION"
    /** An open item that holds the candidate, as `open-items` lists it. */
    @Volatile var holder: String? = null
    /** Launch's acceptance criteria, as its document carries them. */
    @Volatile var criteria: String? = null
    /** What the three merge presses answer: 200 moves the candidate on, anything else refuses with the server's sentence. */
    @Volatile var pressStatus = 200
    /** Whether the coordinator's row says a merge into main waits on the owner (its owner item). */
    @Volatile var mergeWaiting = false
    // A11-11 / A11-13: the project's current landings and the plan the start card draws.
    /** `integration.landTasks`, as a JSON array; null leaves the field out, as a server before it does. */
    @Volatile var landTasks: String? = null
    /** The dependency graph `projects/:id/dependency-graph` answers, with a confirmation the start card can seal; null answers `{}`. */
    @Volatile var plan: String? = null
    // A11i: the start sheets read Launch's document afresh as they open.
    /** The status `GET projects/<LAUNCH>` answers with: 200 serves the document, anything else refuses it in the server's sentence. */
    @Volatile var documentStatus = 200
    /** A read of Launch's document waits for this before it answers, with the document as it was when it arrived: a server that has
     * stopped answering, or one still answering a write's read-back (A15 F-22). Only a read (`GET`) is held; a write is not. */
    @Volatile var holdDocument: CompletableDeferred<Unit>? = null
    /** Every write's body, by `METHOD path`. */
    val bodies = java.util.concurrent.ConcurrentHashMap<String, String>()

    // A-1 / A-2: the landing session's view, and the inFlightJobs shape that names it. `landing` is the view
    // `GET sessions/<LANDING>` answers with `sessionKind: LANDING`; null leaves that id a conversation row (an older server).
    @Volatile var landing: String? = null
    /** A view of its own for a landing id, where one landing must read differently from the rest; the others answer [landing]. */
    @Volatile var landingById: Map<String, String> = emptyMap()
    /** The landing session row's title; null for a row not inserted yet, which the pre-generated id answers without one. */
    @Volatile var landingTitle: String? = null
    /** `integration.inFlightJobs`, as a JSON array — each item carries its `landingSessionId` (A-2 reads the same shape). */
    @Volatile var inFlightJobs: String? = null
    /** The project-scoped session reads' LANDING rows (`includeLanding=1`), as a JSON array; null for a server that lists none. */
    @Volatile var landings: String? = null
    /** The owner's open items on Launch, as `open-items.needsYou` lists them (A-2's X-E5 card and the Landings group's holders). */
    @Volatile var needsYouItems: String? = null
    /** The code session's derived `sourceLanding` (A-2's label at its bottom); null for a conversation that produced none. */
    @Volatile var sourceLanding: String? = null
    /** What `GET sessions/<LANDING>/landing/log` answers, one page. */
    @Volatile var landingLog = """{"jobId":"j-1","entries":[],"nextCursor":null}"""
    /** The status `GET sessions/<LANDING>` and its log answer with: 200 serves them, anything else is a server this device cannot
     *  read (A11-20 e and b). */
    @Volatile var landingStatus = 200
    @Volatile var landingLogStatus = 200
    /** The title `GET tasks/t-landing` answers, for a landing whose row does not exist to title itself. */
    @Volatile var taskTitle = "Wire the page"
    /** How many landing details were served as a landing (a diagnostics counter for tests). */
    @Volatile var landingServed = 0
    /** `projects/<LAUNCH>/coordinator/status`, which names the conversation a landing page's Open coordinator opens. */
    @Volatile var coordinatorStatus = "{\"state\":\"NEVER_OPENED\"}"
    /** What the landing doors answer: 200 (the body is read by no page) or a refusal in the server's own sentence. */
    @Volatile var doorStatus = 200
    @Volatile var doorMessage = "The job is no longer running."
    /** A read of the landing's detail waits for this before it answers, with the view as it was when the read arrived: a server still
     *  answering a door's read-back (A11k, A15 F-22's kind). Only that read is held. */
    @Volatile var holdLanding: CompletableDeferred<Unit>? = null
    /** One hold per read, in the order the reads arrive: the next read of the landing's detail waits for the first of these, so a
     *  test can let reads land in an order of its own. A read finding none waits for nothing more. */
    val holdLandingReads = java.util.concurrent.ConcurrentLinkedQueue<CompletableDeferred<Unit>>()
    /** The view a door the server takes moves the landing to, or null to leave it where it was. The job that door was pressed on has
     *  moved on: a door pressed on it again is refused in the server's words ([doorMessage]). */
    @Volatile var landingAfterDoor: String? = null
    private val movedJobs = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    // A11k: the task page's Run. Off by default: [TASK] is open, and nothing runs it.
    /** Whether [TASK]'s Run has started its run: its detail then carries [WORKER], running, and another Run is refused as the server
     *  refuses it (TASK_ALREADY_RUNNING, naming that run). */
    @Volatile var taskRunning = false
    /** A read of [TASK]'s detail waits for this before it answers, with the task as it was when the read arrived: a server still
     *  answering a write's read-back (A15 F-22's kind). Only that read is held. */
    @Volatile var holdTask: CompletableDeferred<Unit>? = null

    // A05-9: sessions moved to Trash. The server takes a move when the DELETE's held answer is let go; from then no list has the row.
    @Volatile var trashed: Set<String> = emptySet()
    @Volatile var holdDelete: CompletableDeferred<Unit>? = null
    /** A read of Launch's own sessions (`projectId`) waits for this before it answers, with the rows as they were when it arrived. */
    @Volatile var holdMembers: CompletableDeferred<Unit>? = null
    /** Launch's `attention` in `GET projects`, which the drawer's count is read from; none by default. */
    @Volatile var attention: String? = null
    // A05f: the drawer's order and running mark.
    /** Quiet's `attention` in `GET projects`; none by default. */
    @Volatile var quietAttention: String? = null
    /** Whether Launch's coordinator has a turn under way (`engineTurnActive`), which the Open list draws as its spinner. */
    @Volatile var coordinatorWorking = false

    // A15 F-22: How it runs' authorization set, fenced on its revision as `PATCH projects/:id` fences it. Off by default, which
    // leaves the set out of Launch's document as before.
    /** Launch's `configRevision`; null leaves Automatic and At most out of its document, so neither can be pressed. */
    @Volatile var configRevision: Int? = null
    @Volatile var automatic = true
    @Volatile var maxConcurrentTasks = 2
    /** The crossings `projects/:id/handoffs` lists, as a JSON array; null answers as before, which the page cannot read. */
    @Volatile var crossings: String? = null
    /** Launch's task rows (`projects/:id/tasks/page`), as a JSON array; null answers as before, with none. */
    @Volatile var tasks: String? = null

    fun reset() {
        calls.clear(); started = true; startRequest = false; quietStatus = 200
        done = false; doneBy = "DERIVED"; doneCounts = true
        promotion = null; merged = "[]"; mergeCheck = false; mergeJobKind = "CHECK_PROMOTION"; holder = null; criteria = null; pressStatus = 200; mergeWaiting = false; bodies.clear()
        landTasks = null; plan = null; documentStatus = 200; holdDocument = null; landing = null; landingById = emptyMap(); landingTitle = null; inFlightJobs = null
        landings = null; needsYouItems = null; sourceLanding = null
        landingLog = """{"jobId":"j-1","entries":[],"nextCursor":null}"""; taskTitle = "Wire the page"
        landingStatus = 200; landingLogStatus = 200
        coordinatorStatus = "{\"state\":\"NEVER_OPENED\"}"; doorStatus = 200; doorMessage = "The job is no longer running."
        landingServed = 0; holdLanding = null; holdLandingReads.clear(); landingAfterDoor = null; movedJobs.clear()
        taskRunning = false; holdTask = null
        // An earlier test's held request is dropped, never answered: answered now, it would write into this test's server state.
        trashed = emptySet(); holdDelete = null; holdMembers = null; attention = null
        quietAttention = null; coordinatorWorking = false
        configRevision = null; automatic = true; maxConcurrentTasks = 2; crossings = null; tasks = null
    }

    private fun ago(minutes: Long) = Instant.now().minusSeconds(minutes * 60).toString()
    private val workspaces = """[
        {"id":"$ALPHA","name":"Alpha","runnerId":"r1","enabled":true,"position":0,"createdAt":"2026-10-01T01:00:00.000Z"},
        {"id":"$BETA","name":"Beta","runnerId":"r1","enabled":true,"position":1,"createdAt":"2026-10-01T02:00:00.000Z"}]"""

    private fun member(role: String) =
        """"projectMembership":{"projectId":"$LAUNCH","projectTitle":"Launch","projectStatus":"${if (done) "DONE" else "OPEN"}","role":"$role"}"""
    private fun row(id: String, title: String, workspace: String, run: String, extra: String, lifecycle: String = "OPEN", lastTurnAt: String = ago(5),
        approvals: Int = 0) =
        """{"id":"$id","title":"$title","status":"$run","runState":"$run","lifecycleState":"$lifecycle","agent":{"id":"$workspace","name":"${if (workspace == ALPHA) "Alpha" else "Beta"}"},
            "agentId":"$workspace","createdAt":"${ago(600)}","lastTurnAt":"$lastTurnAt","pendingApprovals":$approvals,"tags":[],
            "capabilities":{"canComplete":${lifecycle == "OPEN"},"canRestore":${lifecycle != "OPEN"}}$extra}"""
    private fun session(id: String) = when (id) {
        COORD -> row(COORD, "Coordinate launch", ALPHA, "AWAITING_INPUT", ""","lastAssistantText":"Planning the release","projectId":"$LAUNCH",${member("COORDINATOR")}${
            if (mergeWaiting) ""","projectTitle":"Launch","waitingKind":"OWNER_ITEM","ownerItems":[{"itemId":"i-merge","kind":"PROMOTION_APPROVAL",
                "title":"Merge 4 tasks into main?","since":"${ago(130)}"}]""" else ""}${if (coordinatorWorking) ""","engineTurnActive":true""" else ""}""",
            lastTurnAt = ago(30))
        WORKER -> row(WORKER, "Wire tests", ALPHA, "RUNNING", ""","lastToolUse":"Bash",${member("TASK")}${
            sourceLanding?.let { ""","sourceLanding":$it""" }.orEmpty()}""", lastTurnAt = ago(2))
        WAITING -> row(WAITING, "Quota retry", BETA, "AWAITING_INPUT", ""","waitingKind":"OWNER_CONFIRMATION",${member("TASK")}""", lastTurnAt = ago(10), approvals = 1)
        PLAIN -> row(PLAIN, "Plain notes", ALPHA, "AWAITING_INPUT", ""","lastAssistantText":"Notes kept"""")
        else -> row(DONE, "Shipped docs", ALPHA, "SUCCEEDED", ""","completedAt":"${ago(2 * 24 * 60)}",${member("TASK")}""", "COMPLETED", ago(2 * 24 * 60))
    }
    private fun list(vararg sessions: String) = sessions.filter { it !in trashed }.joinToString(",", "[", "]") { session(it) }
    /** The same read with the project's LANDING rows beside its conversations (`includeLanding=1`, LS6). */
    private fun landingRows(base: String): String {
        val extra = landings?.removePrefix("[")?.removeSuffix("]") ?: return base
        val inner = base.removePrefix("[").removeSuffix("]")
        return "[" + listOf(inner, extra).filter { it.isNotEmpty() }.joinToString(",") + "]"
    }

    private fun sidebar() = """[${if (done) "" else """{"id":"$LAUNCH","title":"Launch","status":"OPEN","createdAt":"2026-10-01T00:00:00Z","buckets":{"running":2},
        "taskCounts":{"done":3,"failed":1,"total":8},"attention":{},"integration":{"line":"PROJECT_BRANCH","ref":"project/launch","activeJobCount":1},
        "startedAt":${if (started) "\"2026-10-02T00:00:00Z\"" else "null"}},"""}
        {"id":"$QUIET","title":"Quiet","status":"OPEN","createdAt":"2026-10-01T00:00:00Z","buckets":{},"attention":{},"startedAt":"2026-10-02T00:00:00Z"}]"""
    /** The counts a server that lists its jobs counts: what the list says (running, then queued), else one running job. */
    private val listedJobs get() = inFlightJobs?.let { runCatching { Wire.json.parseToJsonElement(it).jsonArray }.getOrNull() }?.filterIsInstance<JsonObject>()
    private val integrating get() = listedJobs?.count { it.text("state") == "RUNNING" } ?: 1
    private val queued get() = listedJobs?.count { it.text("state") == "QUEUED" } ?: 0
    private val integration get() = """{"line":"PROJECT_BRANCH","ref":"project/launch","integratingCount":$integrating,"queuedCount":$queued,
        "inFlight":${if (mergeCheck) """{"kind":"$mergeJobKind","state":"RUNNING","phase":"CHECK","startedAt":"${ago(7)}","heartbeatAt":"${ago(0)}"}"""
            else """{"kind":"LAND_TASK","state":"RUNNING","phase":"CHECK","taskTitle":"Wire the page","startedAt":"${ago(3)}","heartbeatAt":"${ago(0)}"}"""}${
            landTasks?.let { ""","landTasks":$it""" }.orEmpty()}${inFlightJobs?.let { ""","inFlightJobs":$it""" }.orEmpty()}}"""
    private val openItems get() = if (!startRequest) """{"needsYou":${needsYouItems ?: "[]"},"withCoordinator":[${holder.orEmpty()}]}""" else
        """{"needsYou":${needsYouItems ?: "[]"},"withCoordinator":[],
        "startRequest":{"itemId":"start-1","waitingSince":"${ago(130)}","startRequest":{"criteriaDigest":"digest-1","why":"Everything is filed.",
        "settings":{"line":"PROJECT_BRANCH","automatic":true,"maxConcurrentTasks":3,"mergeCheckCommand":null,"projectBranchName":"project/launch"}}}}"""
    /** The projection a current server carries for a done project: six criteria, five on main and one with no code to land — or,
     * with `doneCounts` off, an older server's, which has the criteria but no counts behind them. */
    private val projection get() = """{${if (doneCounts) """"counts":{"criteria":6,"met":6,"landed":6,"onMain":5,"byReason":{"IN_FLIGHT":0,
        "ON_PROJECT_BRANCH":0,"NOTHING_TO_LAND":0,"NO_RECEIPT":0,"CODELESS":1}},""" else ""}"status":"DONE","done":true,"withheld":[],
        "confirmation":"CONFIRMED","criteria":[${(1..5).joinToString(",") { """{"definitionId":"c$it","satisfied":true,"landing":"LANDED","landingReason":null}""" }},
        {"definitionId":"c6","satisfied":true,"landing":"LANDED","landingReason":"CODELESS"}]}"""
    private val project get() = """{"id":"$LAUNCH","title":"Launch","status":"${if (done) "DONE" else "OPEN"}","goal":"Ship it.","createdAt":"2026-10-01T00:00:00Z","_count":{"tasks":8},
        "startedAt":${if (started) "\"2026-10-02T00:00:00Z\"" else "null"}${
        if (done) ""","doneBy":"$doneBy","derivedDone":$projection""" else ""}${criteria?.let { ""","acceptanceCriteriaItems":$it""" }.orEmpty()}${
        attention?.let { ""","attention":$it""" }.orEmpty()}${configRevision?.let {
        ""","configRevision":"$it","coordinatorEnabled":$automatic,"maxConcurrentTasks":$maxConcurrentTasks""" }.orEmpty()}}"""
    /** [TASK] as `GET tasks/:id` reads it: open with no run, or — once its Run has started — in progress, with [WORKER] running it. */
    private val task get() = """{"id":"$TASK","title":"Wire the run","status":"${if (taskRunning) "IN_PROGRESS" else "OPEN"}","priority":0,
        "projectId":"$LAUNCH","project":{"id":"$LAUNCH","title":"Launch","status":"OPEN"},"assignee":{"id":"$ALPHA","name":"Alpha"},
        "creatorType":"USER","createdAt":"2026-10-26T08:00:00.000Z","updatedAt":"2026-10-26T08:0${if (taskRunning) 5 else 0}:00.000Z",
        "comments":[],"dependsOn":[],"dependedOnBy":[],"attachments":[],"sessions":[${if (!taskRunning) "" else
        """{"id":"$WORKER","title":"Wire tests","status":"RUNNING","runState":"RUNNING","agent":{"id":"$ALPHA","name":"Alpha"},
        "createdAt":"2026-10-26T08:05:00.000Z"}"""}]}"""

    /** [TASK]'s Run (`POST tasks/:id/execute`): the first starts its run; while that run goes, another Run — whatever trigger it
     * names — is refused as the server refuses it, naming the run that holds the task. */
    private fun execute(): ApiResponse {
        if (!taskRunning) { taskRunning = true; return ok("{}") }
        return ApiResponse(409, ("""{"statusCode":409,"error":"Conflict","code":"TASK_ALREADY_RUNNING","message":"task $TASK could not be """ +
            """started: session $WORKER (RUNNING) holds its execution claim. Let that run reach a terminal status of its own, then start """ +
            """the task again","taskId":"$TASK","conflictingSessionId":"$WORKER","conflictingSessionStatus":"RUNNING",""" +
            """"conflictingSessionEnding":false}""").encodeToByteArray())
    }

    /** How it runs' write (`PATCH projects/:id`): a revision the project has moved on from is refused with nothing written, as the
     * server refuses it (STALE_CONFIG_REVISION); otherwise its fields are written, and a write of the set moves the revision on by one. */
    private fun authorize(body: String): ApiResponse {
        val sent = Wire.json.parseToJsonElement(body).jsonObject
        val expected = sent.text("expectedConfigRevision")
        if (expected != null && expected != "$configRevision") return ApiResponse(409, ("""{"message":"this project is at configRevision """ +
            """$configRevision, not $expected — its coordination settings changed after you read them, so nothing was written",""" +
            """"code":"STALE_CONFIG_REVISION"}""").encodeToByteArray())
        sent["automatic"]?.jsonPrimitive?.booleanOrNull?.let { automatic = it }
        sent["maxConcurrentTasks"]?.jsonPrimitive?.intOrNull?.let { maxConcurrentTasks = it }
        if ("automatic" in sent || "maxConcurrentTasks" in sent) configRevision = configRevision!! + 1
        return ok(project)
    }

    /** A crossing's answer: a question takes it — a yes to a move is the move — and an answer already given refuses another, in the
     * server's words. */
    private fun decide(handoff: String): ApiResponse {
        val rows = crossings.orEmpty()
        if (!rows.contains("\"state\":\"PENDING\"")) return ApiResponse(409, ("""{"message":"handoff approval $handoff is APPLIED and """ +
            """cannot be APPROVED; a spent approval authorised one crossing and is finished"}""").encodeToByteArray())
        crossings = rows.replace("\"state\":\"PENDING\"", "\"state\":\"APPLIED\"")
        return ok("{}")
    }

    /** A press on Launch's candidate: the door's answer is the candidate in its next state, or the server's refusal. */
    private fun press(door: String): ApiResponse {
        if (pressStatus != 200) return ApiResponse(pressStatus, """{"message":"The candidate moved on","code":"PROMOTION_MOVED_ON"}""".encodeToByteArray())
        val now = promotion ?: return ApiResponse(404, """{"message":"No such candidate"}""".encodeToByteArray())
        val next = when (door) { "confirm" -> "CONFIRMED"; "decline" -> "DECLINED"; else -> "CANCELLED" }
        promotion = now.replace(Regex("\"state\":\"[A-Z]+\""), "\"state\":\"$next\"")
        return ok(promotion!!)
    }

    private fun ok(body: String) = ApiResponse(200, body.encodeToByteArray())

    val transport = HttpTransport { request ->
        val api = request.api
        val path = api.path.joinToString("/") { part -> ids.firstOrNull { ObjectId.same(it, part) } ?: part }
        val method = api.method.name
        if (path == "auth/login") return@HttpTransport ok("""{"accessToken":"a05d-access","refreshToken":"a05d-refresh","user":{"id":"u1","email":"owner@a05d.test","name":"Owner"}}""")
        val query = api.query.joinToString("&") { (k, v) -> "$k=$v" }
        // The body before the call: requests arrive off the test's thread, and a test that has seen a write's call reads its body next.
        api.body?.let { bodies["$method $path"] = it.decodeToString() }
        calls += "$method $path" + if (query.isEmpty()) "" else "?$query"
        val view = api.query.firstOrNull { it.first == "view" }?.second ?: "open"
        val scoped = api.query.firstOrNull { it.first == "projectId" }?.second?.let { id -> ids.firstOrNull { ObjectId.same(it, id) } }
        when {
            path == "users/me" -> ok("""{"id":"u1","email":"owner@a05d.test","name":"Owner"}""")
            path == "workspaces" -> ok(workspaces)
            path == "runners" -> ok("""[{"id":"r1","name":"Fixture runner","online":true}]""")
            path == "sessions" && scoped == QUIET -> if (quietStatus == 200) ok("[]") else ApiResponse(quietStatus, """{"message":"The project's sessions are unavailable"}""".encodeToByteArray())
            path == "sessions" && scoped == LAUNCH -> {
                // The page's own widening (§2.9 LS6): its Landings group's rows ride on this read and no other.
                val answer = ok(landingRows(if (view == "open") list(COORD, WORKER, WAITING) else if (view == "completed") list(DONE) else "[]"))
                holdMembers?.await()
                answer
            }
            path == "sessions" -> ok(when (view) { "open" -> list(COORD, WORKER, WAITING, PLAIN); "completed" -> list(DONE); else -> "[]" })
            path == "sessions/$LANDING" && method == "GET" && landingStatus != 200 ->
                ApiResponse(landingStatus, """{"message":"The server is unavailable"}""".encodeToByteArray())
            // A landing id reached by a link or a row: the detail is a landing's whenever the fixture says this id is one.
            api.path.size == 2 && path.startsWith("sessions/") && method == "GET" && landing != null &&
                landingIds.any { ObjectId.same(it, path.removePrefix("sessions/")) } -> {
                val answer = ok(landingDetail(path.removePrefix("sessions/")))
                holdLanding?.await()
                holdLandingReads.poll()?.await()
                answer
            }
            path == "sessions/$LANDING/landing/log" ->
                if (landingLogStatus == 200) ok(landingLog) else ApiResponse(landingLogStatus, """{"message":"The log is unavailable"}""".encodeToByteArray())
            path == "tasks/t-landing" -> ok("""{"id":"t-landing","title":"$taskTitle"}""")
            path == "tasks/$TASK" && method == "GET" -> {
                val answer = ok(task)
                holdTask?.await()
                answer
            }
            path == "tasks/$TASK/execute" && method == "POST" -> execute()
            api.path.size == 2 && path.startsWith("sessions/") && method == "GET" -> ok(session(path.removePrefix("sessions/")))
            api.path.size == 2 && path.startsWith("sessions/") && method == "DELETE" -> {
                holdDelete?.await()
                trashed = trashed + path.removePrefix("sessions/")
                ok("{}")
            }
            path.startsWith("sessions/") && path.endsWith("/page") -> ok("""{"events":[],"hasMore":false,"lastSeq":0,"latestSeq":0}""")
            path == "projects/sidebar" -> ok(sidebar())
            path == "projects" -> ok("""[$project,{"id":"$QUIET","title":"Quiet","status":"OPEN","createdAt":"2026-10-01T00:00:00Z"${
                quietAttention?.let { ""","attention":$it""" }.orEmpty()}}]""")
            path == "projects/$LAUNCH" && method == "PATCH" && configRevision != null -> authorize(api.body?.decodeToString().orEmpty())
            path == "projects/$LAUNCH" -> {
                val answer = if (documentStatus == 200) ok(project) else ApiResponse(documentStatus, """{"message":"The project is unavailable"}""".encodeToByteArray())
                if (method == "GET") holdDocument?.await()
                answer
            }
            path == "projects/$LAUNCH/handoffs" && crossings != null -> ok(crossings!!)
            path == "projects/$LAUNCH/tasks/page" && tasks != null -> ok("""{"items":$tasks,"nextCursor":null}""")
            method == "POST" && crossings != null && path.startsWith("projects/$LAUNCH/handoffs/") && path.endsWith("/decision") -> decide(api.path[3])
            path == "projects/$LAUNCH/integration" -> ok(integration)
            path == "projects/$LAUNCH/coordinator/status" -> ok(coordinatorStatus)
            path == "projects/$LAUNCH/open-items" -> ok(openItems)
            path == "projects/$LAUNCH/promotions/current" -> promotion?.let(::ok) ?: ApiResponse(200, ByteArray(0))
            path == "projects/$LAUNCH/promotions/merged" -> ok(merged)
            path == "projects/$LAUNCH/dependency-graph" && plan != null -> ok(plan!!)
            path == "projects/$LAUNCH/acceptance/confirmation" && plan != null ->
                ok("""{"state":"UNCONFIRMED","confirmed":false,"currentVersion":{"digest":"digest-1","material":[]}}""")
            // The landing page's doors (J-T8's stop, J-T9's retry and re-check, J-T10's abandon): the answer is the server's.
            method == "POST" && (path.endsWith("/integration/stop") || path.endsWith("/integration/retry") ||
                path.contains("/integration/jobs/") && path.endsWith("/retry") || path.endsWith("/abandon")) -> {
                val job = if (path.contains("/integration/jobs/")) api.path.getOrNull(4) else null
                if (doorStatus != 200) ApiResponse(doorStatus, """{"message":"$doorMessage","code":"DOOR_REFUSED"}""".encodeToByteArray())
                else if (job != null && job in movedJobs) ApiResponse(409, """{"message":"$doorMessage","code":"DOOR_REFUSED"}""".encodeToByteArray())
                else {
                    landingAfterDoor?.let { next -> landing = next; landingAfterDoor = null; job?.let(movedJobs::add) }
                    ok("{}")
                }
            }
            method == "POST" && path.startsWith("projects/$LAUNCH/promotions/") -> press(path.substringAfterLast('/'))
            path.startsWith("projects/") -> ok("{}")
            path.startsWith("wiki/") -> ApiResponse(404, """{"code":"WIKI_DISABLED","message":"The wiki is off."}""".encodeToByteArray())
            method == "GET" -> ok("[]")
            else -> ok("{}")
        }
    }

    /** The LANDING detail: the subject's view with the row's shape around it, or — no row yet — LS1's fallback, which has
     *  no title and no workspace and still draws the page. */
    private fun landingDetail(id: String = LANDING): String {
        val view = landingById[id] ?: landing ?: return session(id)
        landingServed++
        return """{"id":"$id","title":${landingTitle?.let { "\"$it\"" } ?: "null"},"status":"AWAITING_INPUT",
            "sessionKind":"LANDING","workspace":null,"assignedRunner":null,"tags":[],"landing":$view}"""
    }
    /** The ids the fixture's `landings` rows name — a session detail for one is a landing's. */
    private val landingIds get() = listOf(LANDING) + (
        landings?.let { runCatching { Wire.json.parseToJsonElement(it).jsonArray }.getOrNull() }
            ?.filterIsInstance<JsonObject>()?.mapNotNull { it.text("id") }.orEmpty())

    /** The streams open and stay quiet: the account is connected, so writes are offered. */
    private val events = object : EventTransport {
        override suspend fun stream(request: HttpRequest, onOpen: suspend () -> Unit, onFrame: suspend (SseFrame) -> Unit): Unit {
            onOpen()
            awaitCancellation()
        }
    }

    /** Requests answer on the caller's thread, as the other shell fixtures' do (ManagementFixture, WatchFixture, ComposerShell): on
     * Dispatchers.IO a page's LaunchedEffect read resumes on the IO worker under the test's unconfined effect dispatcher and writes
     * its state off the main thread, and a sheet could then stay on its spinner with every read answered. */
    fun session() = AuthSession(transport, object : CredentialStore {
        private var value: StoredSession? = null
        override suspend fun load() = value
        override suspend fun save(session: StoredSession) { value = session }
        override suspend fun clear() { value = null }
    }, object : InstanceStore {
        override suspend fun load(): String? = null
        override suspend fun save(server: String) = Unit
    }, object : SessionDataStore {
        override suspend fun read(account: AccountKey, kind: DataKind, key: String): ByteArray? = null
        override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) = Unit
        override suspend fun clearAll() = Unit
    }, "a05d-shell", dispatcher = Dispatchers.Unconfined, eventTransport = events)

    suspend fun signIn(session: AuthSession) = session.login(ServerAddress.parse("https://a05d.test"), "owner@a05d.test", "fixture")
}

/** The shell's application with the controlled server in place of the network and the device stores. */
class ProjectShellApplication : OrbitApplication() {
    override fun createSession(): AuthSession = ProjectShell.session()
    // Unit tests must not reach GitHub when an Activity starts.
    override fun createUpdates() = io.orbitd.android.update.AppUpdater(this, processScope,
        io.orbitd.android.update.UpdateConfig.forBuild().copy(enabled = false))
}
