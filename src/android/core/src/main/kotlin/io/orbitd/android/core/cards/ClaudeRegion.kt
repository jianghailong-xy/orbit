package io.orbitd.android.core.cards

import kotlinx.serialization.json.JsonObject
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * The Claude region check's words (docs/claude-region-check-contract.md, "Copy of record"; boards 02–04 of
 * docs/mocks/claude-region-check): the web's src/web/src/lib/claudeRegionCopy.ts as OrbitKit's `ClaudeRegionCopy` ports it, name for
 * name, held to both by ClaudeRegionCopyParityTest. `machine` is the runner's name and `region` is the runner's `region.name`, never a
 * place read out of a sentence.
 */
object ClaudeRegionCopy {
    /** The code every region refusal carries (`CLAUDE_REGION_UNSUPPORTED`, src/shared/src/dto.ts): the start of a held session's
     * `error`, and the session card's subject. */
    const val CLAUDE_REGION_UNSUPPORTED = "CLAUDE_REGION_UNSUPPORTED"

    /** Anthropic's own page (`CLAUDE_REGIONS_SOURCE_URL`, src/shared/src/claude-regions.ts), linked wherever a sentence says Anthropic
     * doesn't offer Claude somewhere. */
    const val CLAUDE_REGION_SUPPORTED_REGIONS = "Supported regions"
    const val CLAUDE_REGION_SUPPORTED_REGIONS_URL = "https://www.anthropic.com/legal/supported-regions"

    /** The session card's why. */
    fun claudeRegionCantUseAnthropicOn(machine: String) = "Claude Code can’t use Anthropic on $machine"

    /** The session card's body: the refusal sentence behind its code (contract §9, the shared `claudeRegionRefusedError`). */
    fun claudeRegionConnectionIsIn(machine: String, region: String) =
        "$machine’s connection to Anthropic is in $region, where Anthropic doesn’t offer Claude."

    /** The session card's subject line: the code and the place's ISO code. */
    fun claudeRegionSubject(code: String?) = code?.let { "$CLAUDE_REGION_UNSUPPORTED · $it" } ?: CLAUDE_REGION_UNSUPPORTED

    /** When the region was last checked, and where Claude's connection came out: the session card's machine words, and the second
     * line under the machine page's note. */
    fun claudeRegionChecked(whenText: String, region: String, viaProxy: Boolean) =
        "Checked $whenText · Claude’s connection: $region (${if (viaProxy) "through a proxy" else "no proxy"})"

    /** The session card's three ways out. */
    const val CLAUDE_REGION_USE_ANOTHER_PROVIDER = "Use another provider"
    const val CLAUDE_REGION_MOVE_TO_ANOTHER_MACHINE = "Move to another machine"
    const val CLAUDE_REGION_CHECK_AGAIN = "Check again"

    /** Check again where a runner page draws it: that page's presses are title case (Sign In, Update Engines Now), and board 03 draws
     * its capsule `Check Again` (OrbitKit's `CLAUDE_REGION_CHECK_AGAIN_TITLE`). */
    const val CLAUDE_REGION_CHECK_AGAIN_TITLE = "Check Again"

    /** A held session's status words, in the session list. */
    fun anthropicUnavailableOn(machine: String) = "Anthropic unavailable on $machine"

    /** The machine page's attention line, and its Needs Attention item's title. */
    const val CLAUDE_REGION_ATTENTION = "Claude Code can’t use Anthropic here"

    /** The Claude Code row's state, and an Anthropic credential's reason in the pickers. */
    const val CLAUDE_REGION_NOT_SUPPORTED = "Region not supported"

    /** The note under the machine page's engines. */
    fun claudeRegionMachineNote(region: String) =
        "Claude’s connection from this machine is in $region, where Anthropic doesn’t offer Claude, so Orbit won’t use Anthropic accounts or keys here, or start a Claude sign-in. Claude Code still runs with other providers’ keys."

    /** The attention item's detail, as a machine page's Needs Attention item says it (board 03). */
    fun claudeRegionAttentionDetail(region: String) = "Anthropic doesn’t offer Claude in $region."

    /** Check again could not be asked for (the runner went offline, or is too old to check). */
    const val CLAUDE_REGION_CHECK_FAILED = "Couldn’t check again"
}

/**
 * The Claude region check as this app reads it (docs/claude-region-check-contract.md): the web's src/web/src/lib/claudeRegion.ts, as
 * OrbitKit's `ClaudeRegion` ports it. The verdict is the runner's (`region` on GET /runners, §6), never an engine's health; a session's
 * own state says only that it is held, by the code its error starts with (§9, §10). A runner that reads no region — one without
 * claude-region/v1, one no check has decided yet, an older control plane — is never gated, and every surface draws what it drew before.
 */
object ClaudeRegion {
    /** The one engine the check gates (owner decision ⑥). */
    const val ENGINE = "claude"

    /** The preset slug of an Anthropic API key (the shared `ANTHROPIC_PRESET`, providerPresets.ts). */
    const val ANTHROPIC_PRESET = "anthropic"

    /** What a region refusal or stop starts with: `CLAUDE_REGION_UNSUPPORTED: `. */
    private const val CODED = "${ClaudeRegionCopy.CLAUDE_REGION_UNSUPPORTED}: "

    /** Whether a runner's Anthropic-bound Claude turns are gated now, read off its `region`: already the effective verdict (§5), which
     * the server answers blocked only for a blocked check under 24 hours old. */
    fun blocked(region: JsonObject?) = region?.text("verdict") == "blocked"

    /** Whether an error is a region refusal or stop: `CLAUDE_REGION_UNSUPPORTED: <sentence>`. */
    fun isRegionError(error: String?) = error?.trim()?.startsWith(CODED) == true

    /** The stopped sentence's words around the machine and the place (the shared `claudeRegionStoppedError`, owner decision ④): matched
     * by its whole shape, so a refusal from a machine whose name starts like it is still a refusal. */
    internal const val STOPPED_LEAD = CODED + "Claude Code stopped on "
    internal const val STOPPED_MIDDLE = ": its connection to Anthropic is now in "
    internal const val STOPPED_TAIL = ", where Anthropic doesn’t offer Claude."
    private val stoppedShape =
        Regex("^${Regex.escape(STOPPED_LEAD)}[\\s\\S]+${Regex.escape(STOPPED_MIDDLE)}[\\s\\S]+${Regex.escape(STOPPED_TAIL)}$")

    fun isStoppedSentence(text: String) = stoppedShape.matches(text)

    /** What the transcript draws for an error event the runner wrote (the web's `claudeRegionErrorLine`). */
    sealed interface ErrorLine {
        /** No region error: drawn as ever. */
        data object NotRegion : ErrorLine
        /** A refusal: the held session's card says it, with its ways out, so a red line with the raw code would only repeat it. */
        data object Refusal : ErrorLine
        /** A turn stopped by a confirmed flip, which has no card: its sentence, without its code. */
        data class Stopped(val sentence: String) : ErrorLine
    }

    fun errorLine(message: String): ErrorLine {
        val text = message.trim()
        if (!text.startsWith(CODED)) return ErrorLine.NotRegion
        return if (isStoppedSentence(text)) ErrorLine.Stopped(text.removePrefix(CODED)) else ErrorLine.Refusal
    }

    /** The run states the server names (`SessionRunState`); a state this build does not know is read off the run's status instead. */
    private val RUN_STATES = setOf("QUEUED", "RUNNING", "AWAITING_INPUT", "INTERRUPTED", "SUCCEEDED", "FAILED", "ENDED")

    /** A session the control plane holds for the region (§10, §11): in the queue, with a region error. Its message waits, and nothing is
     * working on it. [runState] is the server's; [status] the run's (`runStatus`, else `status`). */
    fun held(runState: String?, status: String?, error: String?): Boolean {
        val queued = if (runState in RUN_STATES) runState == "QUEUED" else status == "PENDING"
        return queued && isRegionError(error)
    }

    /** The same, read off a session's row (GET /sessions/:id). */
    fun held(session: JsonObject) = held(session.text("runState"), session.text("runStatus") ?: session.text("status"), session.text("error"))

    /** A held session's status words — `Anthropic unavailable on {machine}` — or null for any other session, and where the machine is
     * not known. */
    fun heldWords(held: Boolean, machine: String?) = if (held && !machine.isNullOrEmpty()) ClaudeRegionCopy.anthropicUnavailableOn(machine) else null

    /** A credential as the shared `credentialIsAnthropicBound` reads it: an engine's own sign-in or an account pool by the engine it runs
     * on, a key by its preset — a picker row knows a key's preset, not its endpoint (GET /providers leaves the URL out) — and OpenCode's
     * own configuration. */
    sealed interface Credential {
        data class Login(val engine: String) : Credential
        data class Pool(val engine: String) : Credential
        data class Key(val presetSlug: String?) : Credential
        data object OpenCode : Credential
    }

    /** Whether a credential talks to Anthropic (owner decision ①, contract §8): Claude Code's own sign-in, a Claude pool, or a key on the
     * Anthropic preset. A DeepSeek, Moonshot or local vLLM key is not, even under Claude Code; nor is another engine's sign-in or pool,
     * or OpenCode's own configuration. */
    fun credentialIsAnthropicBound(credential: Credential) = when (credential) {
        is Credential.Login -> credential.engine == ENGINE
        is Credential.Pool -> credential.engine == ENGINE
        is Credential.Key -> credential.presetSlug == ANTHROPIC_PRESET
        Credential.OpenCode -> false
    }

    /** How often Check again reads the runner while its check is on the way, and for how long (§7): the answer lands in the runner's
     * `region` like any other check's. */
    const val CHECK_POLL_MS = 2_000L
    const val CHECK_WAIT_MS = 30_000L

    /** Whether the runner's region reflects a check made at or after the one Check again asked for. */
    fun checkAnswered(checkedAt: String?, askedAt: String): Boolean {
        val checked = isoMs(checkedAt) ?: return false
        val asked = isoMs(askedAt) ?: return false
        return checked >= asked
    }

    /** When a check was, as the session card says it: `14:30` today, `Thu 14:30` on any other day (the web's and OrbitKit's
     * `formatResetTime`, which the app's ProviderPools ports). */
    fun checkTime(iso: String, nowMs: Long, zone: ZoneId): String? {
        val at = isoMs(iso) ?: return null
        val today = Instant.ofEpochMilli(at).atZone(zone).toLocalDate() == Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
        return DateTimeFormatter.ofPattern(if (today) "HH:mm" else "EEE HH:mm", Locale.US).withZone(zone).format(Instant.ofEpochMilli(at))
    }

    private fun isoMs(iso: String?): Long? {
        if (iso.isNullOrBlank()) return null
        return runCatching { Instant.parse(iso).toEpochMilli() }.getOrNull()
            ?: runCatching { OffsetDateTime.parse(iso).toInstant().toEpochMilli() }.getOrNull()
    }
}
