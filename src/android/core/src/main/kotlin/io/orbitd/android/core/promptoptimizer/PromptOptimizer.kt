package io.orbitd.android.core.promptoptimizer

import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.translation.Translation
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

// Prompt optimizer (design docs/prompt-optimizer-design.md, board docs/mocks/prompt-optimizer/01-board.png), as OrbitKit's
// PromptOptimizer.swift has it. The server owns the feature — it calls DeepSeek with its own key — so this file only reads and writes
// the fields of @orbit/shared prompt-optimizer.ts, says them in the board's words, and holds the composer's rules: when ✦ Optimize
// shows, what Use and Undo do to the box, and when a send carries `skipTranslation`. The composer draws what this decides.

// Wire

/** `POST /prompt-optimizations`. A session supplies its own workspace and project; a brand-new draft has no session yet, so it names
 * the workspace (and project) the composer picked. A field left null is left out of the body. */
data class PromptOptimizationRequest(val draft: String, val sessionId: String? = null, val workspaceId: String? = null,
    val projectId: String? = null) {
    fun toJson(): JsonObject = buildJsonObject {
        put("draft", draft)
        sessionId?.let { put("sessionId", it) }
        workspaceId?.let { put("workspaceId", it) }
        projectId?.let { put("projectId", it) }
    }
}

/** One run of the optimized prompt. [added] marks text drawn from context, which the card tints. */
data class PromptOptimizationSegment(val text: String, val added: Boolean)

/** One source of context the optimization read: a "Used: …" chip. */
sealed interface PromptOptimizationContext {
    data class Turns(val count: Int) : PromptOptimizationContext
    data object Recap : PromptOptimizationContext
    data class Project(val title: String) : PromptOptimizationContext
    data class Wiki(val count: Int) : PromptOptimizationContext
    data class Workspace(val name: String) : PromptOptimizationContext
    /** A kind this client does not know yet: decoded rather than failing the whole answer, drawn as nothing. */
    data class Unknown(val kind: String) : PromptOptimizationContext

    /** The chip's words, or null for a kind the card does not draw. */
    val chip: String? get() = when (this) {
        is Turns -> if (count == 1) "this session's last turn" else "this session's last $count turns"
        Recap -> "session recap"
        is Project -> "project \"$title\" goal"
        is Wiki -> if (count == 1) "1 wiki entry" else "$count wiki entries"
        is Workspace -> "workspace \"$name\""
        is Unknown -> null
    }

    companion object {
        fun of(value: JsonElement?): PromptOptimizationContext? {
            val o = value as? JsonObject ?: return null
            val kind = o.string("kind") ?: return null
            return when (kind) {
                "TURNS" -> Turns(o.int("count"))
                "RECAP" -> Recap
                "PROJECT" -> Project(o.string("title").orEmpty())
                "WIKI" -> Wiki(o.int("count"))
                "WORKSPACE" -> Workspace(o.string("name").orEmpty())
                else -> Unknown(kind)
            }
        }
    }
}

/** The 200 answer of `POST /prompt-optimizations`. */
data class PromptOptimization(
    /** Concatenated, they are the optimized prompt. */
    val segments: List<PromptOptimizationSegment>,
    /** The account's agent language ("Agents work in", English by default) when the owner's Translation is on; otherwise the draft's
     * own language. A TRANSLATION_LANGUAGES code. */
    val language: String,
    /** Present only when the prompt was written in the agent language for a translating account: the same prompt in the owner's
     * language, for reading. */
    val gloss: String? = null,
    /** Exactly the sources that contributed, in the order the card draws them. */
    val contextUsed: List<PromptOptimizationContext> = emptyList(),
    /** The concatenation of [segments]. */
    val text: String = segments.joinToString("") { it.text },
) {
    /** The prompt's language, or null for a code this client does not know. */
    val promptLanguage: String? get() = language.takeIf(Translation::isLanguage)

    /** Whether the prompt was written in the agent language for a translating account (D2): the server writes a gloss exactly then,
     * and it is the only case a send may skip translation. */
    val isInAgentLanguage: Boolean get() = gloss != null

    /** The "Used: …" chips, in the server's order. */
    val chips: List<String> get() = contextUsed.mapNotNull { it.chip }

    companion object {
        /** Reads the answer. Only `segments` is required (an answer without it throws); a missing `text` is the segments joined, a
         * missing `language` English, an empty `gloss` none, and an unreadable `contextUsed` empty. */
        fun decode(value: JsonElement): PromptOptimization {
            val o = value as? JsonObject ?: error("Prompt optimization is not an object.")
            val segments = (o["segments"] as? JsonArray ?: error("Prompt optimization has no segments.")).map { s ->
                val seg = s as? JsonObject ?: error("A segment is not an object.")
                PromptOptimizationSegment(seg.string("text") ?: error("A segment has no text."),
                    (seg["added"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: false)
            }
            val contextUsed = (o["contextUsed"] as? JsonArray)?.mapNotNull(PromptOptimizationContext::of).orEmpty()
            return PromptOptimization(segments, o.string("language") ?: Translation.DEFAULT_AGENT_LANGUAGE,
                o.string("gloss")?.takeIf { it.isNotEmpty() }, contextUsed,
                o.string("text") ?: segments.joinToString("") { it.text })
        }
    }
}

/** Prompt optimizer: DeepSeek improves a composer draft (docs/prompt-optimizer-design.md). One call per press; 409
 * PROMPT_OPTIMIZER_OFF, 404, 400 and 422 PROMPT_OPTIMIZATION_FAILED throw. The server allows DeepSeek 20 s, longer than the
 * transport's 10 s default wait for an answer, so this call waits [PromptOptimizer.READ_TIMEOUT_SECONDS]. */
suspend fun OrbitApi.optimizePrompt(handle: SessionHandle, request: PromptOptimizationRequest): PromptOptimization =
    PromptOptimization.decode(Wire.json.parseToJsonElement(request(handle, ApiRequest(listOf("prompt-optimizations"), HttpMethod.POST,
        body = request.toJson().toString().encodeToByteArray(), readTimeoutSeconds = PromptOptimizer.READ_TIMEOUT_SECONDS)).body.decodeToString()))

// Copy

/** Every word Android shows about the optimizer (board frames 1–6), OrbitKit's PromptOptimizerCopy. */
object PromptOptimizerCopy {
    // Settings (frames 1 and 1b)
    const val TITLE = "Prompt optimizer"
    const val HINT = "Show an Optimize button in the composer. DeepSeek rewrites your draft with this session's context; you review it before it replaces the draft."
    const val UNAVAILABLE = "This server has no DeepSeek key (DEEPSEEK_API_KEY), so it cannot optimize prompts."

    // Composer (frames 2–3)
    const val OPTIMIZE = "Optimize"
    const val OPTIMIZING = "Optimizing…"
    const val OPTIMIZE_HELP = "Have DeepSeek improve this draft before you send it"
    const val CANCEL_HELP = "Stop optimizing"

    // The suggestion (frame 4)
    const val CARD_TITLE = "Optimized prompt"
    const val BASED_ON_EARLIER_DRAFT = "Based on an earlier draft"
    const val USED = "Used:"
    const val USE = "Use"
    const val EDIT_THEN_USE = "Edit, then use"
    const val TRY_AGAIN = "Try again"
    const val DISMISS = "Dismiss"
    const val SHOW_ORIGINAL = "Show original"

    /** Back from the gloss: the prompt's own language ("Show in English", "Show in Japanese"), or "Show original" for a code this
     * client does not know. Never a hard-coded English. */
    fun showPrompt(language: String?): String = language?.takeIf(Translation::isLanguage)?.let(::showIn) ?: SHOW_ORIGINAL
    /** "Show in Chinese": the language's name without its parenthesis. */
    fun showIn(language: String): String = "Show in ${Translation.shortName(language)}"

    // After Use (frame 5) and failure (frame 6)
    const val REPLACED = "Draft replaced with the optimized prompt"
    const val UNDO = "Undo"
    const val FAILED = "Couldn't optimize this draft."
}

// Rules

object PromptOptimizer {
    /** How long the optimize call waits for its answer: the server's 20 s DeepSeek budget (PROMPT_OPTIMIZER_TIMEOUT_MS) plus its own
     * reads, inside the transport's 30 s call limit. */
    const val READ_TIMEOUT_SECONDS = 30L
    /** The longest draft the server takes (PROMPT_OPTIMIZER_MAX_DRAFT_CHARS); a longer one goes cut, as iOS cuts it. */
    const val MAX_DRAFT_CHARS = 8_000

    /** `preferences.promptOptimizer`: on only for an explicit true. Absent means off. */
    fun enabled(preferences: JsonObject?): Boolean =
        (preferences?.get("promptOptimizer") as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull == true

    /** `GET /users/me`'s `promptOptimizerAvailable`, or null where the payload does not say (a login's user). */
    fun available(user: JsonObject?): Boolean? = (user?.get("promptOptimizerAvailable") as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

    /** Whether the account offers ✦ Optimize: switched on, and the server able to. */
    fun isOn(user: JsonObject?): Boolean = enabled(user?.get("preferences") as? JsonObject) && available(user) == true

    /** Whether Settings draws the switch disabled with frame 1b's notice. Only a `me` that says so: a payload with no field at all is
     * not a server without a key. */
    fun unavailable(user: JsonObject?): Boolean = available(user) == false

    /** Whether the composer shows ✦ Optimize for this draft (frame 2, the web's and iOS's rules): the account has it on, and the box
     * holds words — not empty, not a `!` shell command, and not only a `/command`. */
    fun showsButton(on: Boolean, text: String): Boolean {
        if (!on) return false
        val trimmed = text.trim()
        if (trimmed.isEmpty() || trimmed.startsWith("!")) return false
        if (trimmed.startsWith("/") && trimmed.none { it.isWhitespace() }) return false
        return true
    }

    /** A send body, with `skipTranslation: true` added when [skip]; otherwise exactly as it was, so the key is only ever true or absent. */
    fun withSkipTranslation(body: JsonObject, skip: Boolean): JsonObject =
        if (skip) JsonObject(body + ("skipTranslation" to JsonPrimitive(true))) else body

    /** One drawn run of the card's text: what it says, whether context added it (tinted), and whether it was a `code` span
     * (monospaced, the backticks dropped). */
    data class Run(val text: String, val added: Boolean, val code: Boolean)

    /** The segments cut at their backticks, so `returnTo` draws monospaced as on the board. A segment with an unmatched backtick stays
     * as written. */
    fun runs(segments: List<PromptOptimizationSegment>): List<Run> = segments.flatMap { seg ->
        val parts = seg.text.split("`")
        if (parts.size % 2 == 0) {
            if (seg.text.isEmpty()) emptyList() else listOf(Run(seg.text, seg.added, false))
        } else parts.mapIndexedNotNull { i, part -> if (part.isEmpty()) null else Run(part, seg.added, i % 2 == 1) }
    }
}

/**
 * The composer's optimizer, as a value: what the card shows and what Use, Undo and Send do with the box (OrbitKit's
 * PromptOptimizerState). The composer's model holds one and runs the request; everything that decides is here. Every change answers
 * a new state.
 */
data class PromptOptimizerState(
    val phase: Phase = Phase.Idle,
    /** Frame 4's "Show in <language>": the card shows the gloss instead of the prompt. */
    val showingGloss: Boolean = false,
    /** After Use: the owner's own draft (Undo puts it back). */
    val undoDraft: String? = null,
    /** After Use: the text Use put in the box. */
    val inserted: String? = null,
    /** Whether [inserted] is in the agent language, the one case a send may skip translation. */
    private val insertedInAgentLanguage: Boolean = false,
) {
    sealed interface Phase {
        data object Idle : Phase
        /** The press is out; [draft] is what was sent (frame 3). The box stays editable. */
        data class Optimizing(val draft: String) : Phase
        /** The suggestion (frame 4). [draft] is what it was made from. */
        data class Suggestion(val optimization: PromptOptimization, val draft: String) : Phase
        /** Frame 6: the draft is untouched; Try again sends the box's draft again. */
        data class Failed(val draft: String) : Phase
    }

    val isOptimizing: Boolean get() = phase is Phase.Optimizing
    val suggestion: PromptOptimization? get() = (phase as? Phase.Suggestion)?.optimization
    val failed: Boolean get() = phase is Phase.Failed

    /** The press: the draft goes out. Pressing while busy cancels instead ([cancel]). */
    fun start(draft: String) = copy(phase = Phase.Optimizing(draft), showingGloss = false)

    fun cancel() = if (isOptimizing) copy(phase = Phase.Idle) else this

    /** The answer, kept only for the press still out: one that comes after a cancel is dropped. */
    fun succeeded(result: PromptOptimization): PromptOptimizerState {
        val out = phase as? Phase.Optimizing ?: return this
        return copy(phase = Phase.Suggestion(result, out.draft), showingGloss = false)
    }

    fun failedNow(): PromptOptimizerState {
        val out = phase as? Phase.Optimizing ?: return this
        return copy(phase = Phase.Failed(out.draft))
    }

    /** Frame 4's "Based on an earlier draft": the box changed while the press was out. */
    fun basedOnEarlierDraft(current: String): Boolean = (phase as? Phase.Suggestion)?.let { it.draft != current } ?: false

    /** × / back / swipe down: the card goes, the draft stays; so does the failure line. */
    fun dismiss() = copy(phase = if (phase is Phase.Suggestion || phase is Phase.Failed) Phase.Idle else phase, showingGloss = false)

    fun toggleGloss() = copy(showingGloss = !showingGloss)

    /** Use (and Edit, then use): the state after, with [current] — what the box holds now, the owner's draft — kept for Undo. The text
     * the box takes is [suggestion]'s; with no suggestion nothing changes. */
    fun use(current: String): PromptOptimizerState {
        val s = suggestion ?: return this
        return copy(phase = Phase.Idle, showingGloss = false, undoDraft = current, inserted = s.text,
            insertedInAgentLanguage = s.isInAgentLanguage)
    }

    /** Whether frame 5's Undo is offered: Use happened and the box still holds what it put there. */
    fun offersUndo(current: String): Boolean = undoDraft != null && inserted == current

    /** Undo: the state after; the box takes back [undoDraft], read before this. Nothing changes when there is nothing to undo. */
    fun undo(current: String): PromptOptimizerState =
        if (!offersUndo(current)) this else copy(undoDraft = null, inserted = null, insertedInAgentLanguage = false)

    /** The toast went (timed out, or the box changed): Undo is no longer offered, but a send of the unedited text still skips
     * translation. */
    fun forgetUndo() = copy(undoDraft = null)

    /** D2: a send carries `skipTranslation` only when its text is still exactly the optimized agent-language text Use put in the box.
     * Edited by one character, it is translated as usual. */
    fun skipTranslation(sending: String): Boolean {
        val inserted = inserted ?: return false
        return insertedInAgentLanguage && sending.trim() == inserted.trim()
    }

    /** After a send: the optimized text is spent. */
    fun sent() = copy(undoDraft = null, inserted = null, insertedInAgentLanguage = false)
}

private fun JsonObject.string(key: String): String? = (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content
private fun JsonObject.int(key: String): Int = (get(key) as? JsonPrimitive)?.intOrNull ?: 0
