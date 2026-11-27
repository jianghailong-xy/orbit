package io.orbitd.android.schedule

import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.ApprovalDecision
import io.orbitd.android.core.cards.ApprovalRules
import io.orbitd.android.core.cards.PermissionRule
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.schedule.ConditionView
import io.orbitd.android.core.schedule.ConditionWaitingItem
import io.orbitd.android.core.schedule.ScheduleApi
import io.orbitd.android.core.schedule.ScheduleCard
import io.orbitd.android.core.schedule.ScheduleChangeAnswer
import io.orbitd.android.core.schedule.ScheduleChangeConversationResponse
import io.orbitd.android.core.schedule.ScheduleDecisionOutcome
import io.orbitd.android.core.schedule.ScheduleDetailResponse
import io.orbitd.android.core.schedule.ScheduleDisplay
import io.orbitd.android.core.schedule.ScheduleRunView
import io.orbitd.android.core.schedule.ScheduleView
import io.orbitd.android.core.schedule.ScheduleWaitingTask
import io.orbitd.android.core.schedule.SessionScheduleCardsResponse
import io.orbitd.android.navigation.ObjectId
import java.time.Instant
import java.util.TimeZone
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Scheduled tasks (docs/scheduled-tasks-design.md §9.2; iOS `ScheduledModel`): the account's schedules behind the Scheduled page, its
 * detail sheet, the drafts the quick-add line made, the cards a conversation draws, and the reads the Waiting on you cards need. One
 * store per signed-in handle. What the server answered is what is drawn; every press reads its answer back. The words and the rules
 * are the shared contract's (`ScheduleCopy`, `ScheduleDisplay`).
 */
class ScheduledStore internal constructor(private val auth: AuthSession, val handle: SessionHandle, private val scope: CoroutineScope,
    private val api: ScheduleApi = ScheduleApi(auth, handle)) {

    data class DraftPanel(val sessionId: String, val typed: String)

    /** A run and the schedule it ran for: what a run's session draws at its head and after its end. */
    data class RunContext(val schedule: ScheduleView, val run: ScheduleRunView, val detail: ScheduleDetailResponse?)

    data class State(
        /** Every schedule not ended, each with its last run. */
        val schedules: List<ScheduleView> = emptyList(),
        /** The runs of the page's window the list carried; null from a server that sends none, where the detail reads stand in. */
        val listRuns: List<ScheduleRunView>? = null,
        /** The account's PENDING create cards: the timeline's dashed rows and the draft panel. */
        val drafts: List<ScheduleCard> = emptyList(),
        /** The OPEN tasks waiting for their startWhen condition: the "Waiting for a condition" group's task rows, tagged Can't read
         * at its head when one cannot be read (docs/condition-triggers-design.md §9). */
        val waitingTasks: List<ScheduleWaitingTask> = emptyList(),
        /** Conditions read on their own (the inspector's Condition block, a run's firing, a Waiting on you card), by canonical id. */
        val conditions: Map<String, ConditionView> = emptyMap(),
        /** The detail sheet's reads, by canonical schedule id. */
        val details: Map<String, ScheduleDetailResponse> = emptyMap(),
        /** Cards read on their own (a widen item's), by canonical request id. */
        val cards: Map<String, ScheduleCard> = emptyMap(),
        /** A run's pending approval (a SCHEDULE_APPROVAL item's), by canonical approval id: its tool and input. */
        val approvals: Map<String, JsonObject> = emptyMap(),
        /** What each conversation asked and changed (`GET /sessions/:id/schedule-cards`), by canonical session id. */
        val sessions: Map<String, SessionScheduleCardsResponse> = emptyMap(),
        /** Each schedule's change-conversation read (`GET /schedules/:id/change`), by canonical schedule id. */
        val changes: Map<String, ScheduleChangeConversationResponse> = emptyMap(),
        /** The run a session is, with its schedule, by canonical session id. */
        val runs: Map<String, RunContext> = emptyMap(),
        val loaded: Boolean = false,
        /** The list answered 404: a server before scheduled tasks. The drawer row stays away. */
        val unsupported: Boolean = false,
        /** The ⋯ menu's Show past runs. */
        val showPastRuns: Boolean = false,
        /** All workspaces (null), or one. */
        val workspaceFilter: String? = null,
        /** The schedule whose detail sheet is up. */
        val inspectedId: String? = null,
        val draftPanel: DraftPanel? = null,
        /** The last refusal a press came back with, said once under what was pressed. */
        val errorText: String? = null,
    ) {
        /** The drawer's number: held, failing with no run under way, or a condition that cannot be read; nothing at zero. */
        val needsYouCount get() = ScheduleDisplay.needsYouCount(schedules, waitingTasks, pageRuns)

        /** The runs the page knows of: the list's, or, from a server that sends none, each schedule's last and its detail's recent. */
        val pageRuns: List<ScheduleRunView> get() = listRuns ?: schedules.flatMap { s ->
            listOfNotNull(s.lastRun) + detail(s.id)?.recentRuns.orEmpty()
        }.distinctBy { it.id }

        val shownSchedules get() = schedules.filter { it.state != "ENDED" && (workspaceFilter == null || ObjectId.same(it.workspaceId, workspaceFilter)) }

        val shownWaitingTasks get() = waitingTasks.filter { workspaceFilter == null || ObjectId.same(it.workspaceId, workspaceFilter) }

        /** The count beside the page title (board ②): what the timeline lists. */
        val listedCount get() = shownSchedules.size + drafts.size + shownWaitingTasks.size

        /** The workspaces the filter offers: the ones a schedule, or a waiting task, runs in, by name. */
        val workspaces: List<Pair<String, String>> get() = (schedules.map { it.workspaceId to it.workspaceName } +
            waitingTasks.map { it.workspaceId to it.workspaceName }).distinctBy { key(it.first) }
            .map { (id, name) -> id to (name ?: id) }.sortedBy { it.second }

        fun condition(id: String?): ConditionView? = id?.let { conditions[key(it)] }

        fun detail(id: String): ScheduleDetailResponse? = details[key(id)]
        fun schedule(id: String): ScheduleView? = detail(id)?.schedule ?: schedules.firstOrNull { ObjectId.same(it.id, id) }
        fun card(id: String): ScheduleCard? = cards[key(id)]
        fun session(id: String): SessionScheduleCardsResponse? = sessions[key(id)]
        fun change(id: String): ScheduleChangeConversationResponse? = changes[key(id)]
        fun run(sessionId: String): RunContext? = runs[key(sessionId)]

        /** The draft the panel's conversation produced, once its agent has drafted it. */
        fun draft(forSession: String): ScheduleCard? = drafts.firstOrNull { ObjectId.same(it.askedBySessionId, forSession) }

        fun timeline(now: Instant, timezone: String): List<ScheduleDisplay.TimelineGroup> {
            val shown = shownSchedules
            val ids = shown.map { key(it.id) }.toSet()
            val runs = pageRuns.filter { key(it.scheduleId) in ids }
            val drafts = if (workspaceFilter == null) drafts else drafts.filter { ObjectId.same(it.runsIn?.workspaceId, workspaceFilter) }
            return ScheduleDisplay.timeline(shown, runs, drafts, showPastRuns, now, timezone, shownWaitingTasks)
        }
    }

    private val mutable = MutableStateFlow(State())
    val state: StateFlow<State> = mutable.asStateFlow()

    private fun live() = (auth.state.value as? AuthState.SignedIn)?.handle === handle

    /** The viewer's zone: the timeline's days, and the zone a create card naming none is allowed in. */
    val timezone: String get() = TimeZone.getDefault().id

    // MARK: page state

    fun showPastRuns(on: Boolean) = mutable.update { it.copy(showPastRuns = on) }
    fun filter(workspaceId: String?) = mutable.update { it.copy(workspaceFilter = workspaceId) }
    fun inspect(id: String?) = mutable.update { it.copy(inspectedId = id, errorText = null) }
    fun closeDraftPanel() = mutable.update { it.copy(draftPanel = null) }
    fun openDraftPanel(sessionId: String, typed: String) = mutable.update { it.copy(draftPanel = DraftPanel(sessionId, typed)) }

    // MARK: reads

    /** Read the list and the drafts again, on the store's scope, so leaving a page doesn't strand a read half-done. */
    fun load() { scope.launch { loadNow() } }

    suspend fun loadNow() {
        if (mutable.value.unsupported) return
        try {
            val list = api.list()
            if (!live()) return
            val drafts = try { api.drafts() } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { mutable.value.drafts }
            if (!live()) return
            mutable.update { it.copy(schedules = list.schedules, listRuns = list.runs, drafts = drafts, waitingTasks = list.waitingTasks.orEmpty(),
                loaded = true) }
            // A server that sends no window of runs: each schedule's detail stands in.
            if (list.runs == null) list.schedules.forEach { loadDetailNow(it.id) }
        } catch (cancel: CancellationException) { throw cancel }
        catch (error: ApiError) { if (error.status == 404 && live()) mutable.update { it.copy(unsupported = true) } }
        catch (_: Exception) { /* The next read tries again; what was drawn stays. */ }
    }

    fun loadDetail(id: String) { scope.launch { loadDetailNow(id) } }

    private suspend fun loadDetailNow(id: String) {
        val detail = try { api.detail(id) } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { return }
        if (live()) mutable.update { it.copy(details = it.details + (key(id) to detail)) }
    }

    /** A condition's own read: its state, newest samples and events. */
    fun loadCondition(id: String) { scope.launch { loadConditionNow(id) } }

    suspend fun loadConditionNow(id: String) {
        val condition = try { api.condition(id) } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { return }
        if (live()) mutable.update { it.copy(conditions = it.conditions + (key(id) to condition)) }
    }

    /** The 30-day question answered: Keep waiting (0) or Stop (1). The server's refusal in its own words, or null. */
    suspend fun answerCondition(item: ConditionWaitingItem, option: Int): String? = try {
        api.answerConditionItem(item.id, option)
        null
    } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { ScheduleApi.refusal(error) }

    fun loadCard(id: String) {
        scope.launch {
            val card = try { api.request(id) } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { return@launch }
            if (live()) mutable.update { it.copy(cards = it.cards + (key(id) to card)) }
        }
    }

    /** A SCHEDULE_APPROVAL item's approval, off its run's session's pending approvals: what Always allow would remember. */
    fun loadApproval(sessionId: String, approvalId: String) {
        scope.launch {
            try {
                val list = Wire.decode(auth.request(handle, ApiRequest(listOf("sessions", sessionId, "approvals"), query = listOf("status" to "PENDING")))
                    .requireSuccess().body, JsonElement.serializer())
                val rows = ((list as? JsonObject)?.get("approvals") as? JsonArray ?: list as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
                val found = rows.firstOrNull { ObjectId.same((it["id"] as? JsonPrimitive)?.contentOrNull, approvalId) } ?: return@launch
                if (live()) mutable.update { it.copy(approvals = it.approvals + (key(approvalId) to found)) }
            } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { /* Its card says what it can without it. */ }
        }
    }

    /**
     * A conversation's schedule cards and records, and — for a run's session — the run and its schedule (W2's `run`, else found
     * among the schedules by [scheduleRunId], the session's own read).
     */
    suspend fun loadSessionNow(sessionId: String, scheduleRunId: String? = null) {
        val read = try { api.sessionCards(sessionId) } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }
        if (!live()) return
        if (read != null) mutable.update { it.copy(sessions = it.sessions + (key(sessionId) to read)) }
        val run = read?.run ?: scheduleRunId?.let { findRun(it) }
        if (run != null) {
            val detail = try { api.detail(run.scheduleId) } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }
            val schedule = detail?.schedule ?: mutable.value.schedule(run.scheduleId) ?: return
            if (live()) mutable.update { it.copy(runs = it.runs + (key(sessionId) to RunContext(schedule, run, detail))) }
        }
    }

    /** The run a session's read names, for a server whose schedule-cards read names none. */
    private suspend fun findRun(runId: String): ScheduleRunView? {
        val schedules = try { api.list(state = "all").schedules } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { return null }
        for (s in schedules) {
            s.lastRun?.takeIf { ObjectId.same(it.id, runId) }?.let { return it }
            val runs = try { api.runs(s.id) } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { continue }
            runs.firstOrNull { ObjectId.same(it.id, runId) }?.let { return it }
        }
        return null
    }

    /** Change… (§8.2): the schedule's open change conversation, if any, and the opening a new one would start with. */
    fun loadChange(id: String) { scope.launch {
        // Read afresh each time: an answer kept from an earlier visit may name a conversation since completed.
        mutable.update { it.copy(changes = it.changes - key(id)) }
        val change = try { api.change(id) } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { return@launch }
        if (live()) mutable.update { it.copy(changes = it.changes + (key(id) to change)) }
    } }

    /** The draft change screen's send: opens the conversation with the person's first words — or says them in the one
     * another device opened meanwhile. Null on a refusal, said in [State.errorText]. */
    suspend fun openChange(id: String, text: String): ScheduleChangeAnswer? {
        mutable.update { it.copy(errorText = null) }
        return try {
            api.openChange(id, text)
        } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) {
            mutable.update { it.copy(errorText = ScheduleApi.refusal(error)) }
            null
        }
    }

    // MARK: presses

    /** What a press on a card came to: done, withdrawn by the server (409 SCHEDULE_REQUEST_STALE: shown, not retried), or refused
     * (said, and the card can be pressed again). */
    sealed class PressResult {
        data object Done : PressResult()
        data class Withdrawn(val message: String) : PressResult()
        data class Refused(val message: String) : PressResult()
        val said: String? get() = when (this) { Done -> null; is Withdrawn -> message; is Refused -> message }
        /** The card's buttons go: it was decided, or it can no longer be. */
        val settled: Boolean get() = this !is Refused
    }

    suspend fun runNow(id: String, openRun: (String) -> Unit = {}) = control(id) {
        api.runNow(id)?.run?.sessionId?.let(openRun)
    }

    suspend fun cancelRun(run: ScheduleRunView, sessionId: String): String? {
        val error = control(run.scheduleId) { api.stopRun(run.id) }
        if (error == null) loadSessionNow(sessionId, run.id)
        return error
    }
    suspend fun pause(id: String) = control(id) { api.pause(id) }
    suspend fun resume(id: String) = control(id) { api.resume(id) }
    suspend fun undo(id: String, revision: Int) = control(id) { api.undo(id, revision) }
    /** Rename (§8.4) what the dialog holds, over the name it opened with: nothing is sent while that is empty or unchanged. */
    suspend fun rename(id: String, draft: String, from: String): String? {
        val title = ScheduleDisplay.renameTitle(draft, from) ?: return null
        return control(id) { api.rename(id, title) }
    }
    /** The dialogs' presses, on the store's scope: a dialog is gone once pressed. */
    fun renameNow(id: String, draft: String, from: String) { scope.launch { rename(id, draft, from) } }
    fun deleteNow(id: String) { scope.launch { delete(id) } }
    suspend fun delete(id: String): String? {
        val said = control(id) { api.delete(id) }
        if (said == null && ObjectId.same(mutable.value.inspectedId, id)) inspect(null)
        return said
    }

    /** One press on a schedule's door: null when it was recorded, else what to say. The list and the detail are read again. */
    private suspend fun control(id: String, press: suspend () -> Unit): String? {
        mutable.update { it.copy(errorText = null) }
        val said = try { press(); null } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { ScheduleApi.refusal(error) }
        if (said != null) mutable.update { it.copy(errorText = said) }
        loadNow()
        loadDetailNow(id)
        return said
    }

    /** Allow a card. A create card naming no zone is allowed in this device's zone. */
    suspend fun allow(card: ScheduleCard): PressResult {
        val zone = if (card.isCreate && card.`when`?.timezone == null) timezone else null
        return decide(card) { api.allow(card.id, zone) }
    }

    suspend fun decline(card: ScheduleCard): PressResult = decide(card) { api.decline(card.id) }

    private suspend fun decide(card: ScheduleCard, press: suspend () -> ScheduleDecisionOutcome): PressResult {
        mutable.update { it.copy(errorText = null) }
        val result = try {
            when (val outcome = press()) {
                is ScheduleDecisionOutcome.Decided -> {
                    outcome.card?.let { answered -> mutable.update { it.copy(cards = it.cards + (key(card.id) to answered)) } }
                    PressResult.Done
                }
                is ScheduleDecisionOutcome.Stale -> PressResult.Withdrawn(outcome.message.ifEmpty { ScheduleApi.WITHDRAWN })
            }
        } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { PressResult.Refused(ScheduleApi.refusal(error)) }
        loadNow()
        loadCard(card.id)
        card.askedBySessionId?.let { loadSessionNow(it) }
        return result
    }

    /** The quick-add line: the sentence opens a conversation in the workspace on its right; the draft panel follows the card its
     * agent drafts there. */
    suspend fun ask(text: String, workspaceId: String): Boolean {
        mutable.update { it.copy(errorText = null) }
        return try {
            val session = api.createDraft(workspaceId, text)
            openDraftPanel(session, text)
            true
        } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) {
            mutable.update { it.copy(errorText = ScheduleApi.refusal(error)) }
            false
        }
    }

    /** The approval a run waits on, answered from Waiting on you as it would be on its card. Always allow remembers the rules the
     * card would ([ApprovalRules.remember]). */
    suspend fun decideApproval(sessionId: String, approvalId: String, allow: Boolean, always: Boolean): String? {
        val rules: List<PermissionRule>? = if (always) mutable.value.approvals[key(approvalId)]?.let { approvalRules(it) }?.takeIf { it.isNotEmpty() } else null
        return try {
            val body = ApprovalDecision(if (allow) "allow" else "deny", rememberRules = rules)
            auth.request(handle, ApiRequest(listOf("sessions", sessionId, "approvals", approvalId, "decision"), method = HttpMethod.POST,
                body = Wire.json.encodeToString(ApprovalDecision.serializer(), body).encodeToByteArray())).requireSuccess()
            mutable.update { it.copy(approvals = it.approvals - key(approvalId)) }
            null
        } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { ScheduleApi.refusal(error) }
    }

    /** SCHEDULE_FAILED's Pause schedule: pausing is how the owner answers a failure, so the item is theirs to dismiss with it
     * (web `ScheduleWaitingCard`). */
    suspend fun pauseAndDismiss(scheduleId: String, ownerRequestId: String): String? {
        control(scheduleId) { api.pause(scheduleId) }?.let { return it }
        return try {
            auth.request(handle, ApiRequest(listOf("owner-requests", ownerRequestId, "done"), method = HttpMethod.POST, body = "{}".encodeToByteArray())).requireSuccess()
            null
        } catch (cancel: CancellationException) { throw cancel } catch (error: Exception) { ScheduleApi.refusal(error) }
    }

    companion object {
        private var shared: ScheduledStore? = null

        fun of(auth: AuthSession, handle: SessionHandle, scope: CoroutineScope): ScheduledStore {
            shared?.takeIf { it.handle === handle }?.let { return it }
            return ScheduledStore(auth, handle, scope).also { shared = it }
        }

        internal fun key(id: String?): String = id?.let { ObjectId.canonical(it) ?: it }.orEmpty()

        /** The rules Always allow remembers for an approval row (`toolName` and `input`). */
        fun approvalRules(approval: JsonObject): List<PermissionRule> {
            val tool = (approval["toolName"] as? JsonPrimitive)?.contentOrNull ?: return emptyList()
            val input = approval["input"] as? JsonObject ?: return emptyList()
            return ApprovalRules.remember(tool, input)
        }

        /** "psql:*": a remembered rule as Always allow names it. */
        fun ruleNames(rules: List<PermissionRule>): String = rules.joinToString(", ") { it.ruleContent ?: it.toolName }
    }
}
