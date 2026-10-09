package io.orbitd.android.management

import io.orbitd.android.navigation.ObjectId
import kotlinx.serialization.json.*
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.floor

/**
 * The runner list's and pages' rules and words: a port of OrbitKit RunnerAttention, RunnerPageFormat
 * and RunnerPageCopy (themselves the web's runnerAttention.ts / runnerCopy.ts). Pure — the clock and
 * the latest release are inputs — so RunnerPageTest runs the web's runnerAttention.cases.json on it.
 */
internal object RunnerCopy {
    const val ONLINE = "Online"
    const val OFFLINE = "Offline"
    const val SEP = " · "
    fun offlineLastSeen(whenText: String) = "Offline · last seen $whenText"
    fun versionTag(version: String) = "v$version"
    fun runningOf(active: Int, max: Int) = "$active of $max running"
    fun slots(active: Int, max: Int) = "$active/$max"
    const val ADD = "Add Runner"
    const val ADD_FOOTER = "Run one command on the new machine — it installs Orbit, then asks you to confirm it’s yours."
    const val NEEDS_ATTENTION = "Needs Attention"
    const val CAPACITY = "Capacity"
    const val ENGINES = "Engines"
    const val WORKSPACES = "Workspaces"
    const val ABOUT = "About This Runner"
    const val MAX_CONCURRENT = "Max Concurrent"
    const val DISK = "Disk"
    const val KEEP_FREE = "Keep Free"
    const val CAPACITY_FOOTER = "Max Concurrent applies to the next session it picks up — no restart. Below Keep Free, task " +
        "runs stop being sent here and finished worktrees are cleaned up sooner."
    fun gb(amount: String) = "$amount GB"
    fun diskUsed(used: String, total: String) = "$used of $total GB used"
    const val SIGNED_IN = "Signed in"
    const val SIGNED_OUT = "Signed out"
    const val NOT_INSTALLED = "Not installed"
    const val NO_QUOTA = "No quota reported"
    /** A Kimi login whose plan carries no quota limit: its quota was read and held no window at all — not a read that
     * failed or never ran (NO_QUOTA). Web RUNNER_ENGINE_NO_QUOTA_LIMIT. */
    const val NO_QUOTA_LIMIT = "No quota limit"
    const val SIGN_IN = "Sign In"
    const val UPDATE_ENGINES_NOW = "Update Engines Now"
    const val REFRESH_MODEL_LISTS = "Refresh Model Lists"
    const val ENGINES_FOOTER = "Orbit keeps these CLIs updated every 30 min. Sign-ins live on this machine — a session spends " +
        "that subscription, nothing to paste."
    const val ENGINES_OFFLINE_FOOTER = "Signing in and updating need the runner online."
    fun enginesChecked(whenText: String) = "Checked $whenText"
    fun enginesReported(whenText: String) = "Reported $whenText"
    fun accountsSignedIn(count: Int) = "$count accounts signed in"
    fun updateFailed(version: String, whenText: String) = "Update to $version failed $whenText"
    const val WORKTREES = "Worktrees"
    const val WORKSPACES_FOOTER = "Tap a workspace to open its sessions. Add or change workspaces on the web."
    fun workspaceRunning(count: Int) = "$count running"
    const val ABOUT_NAME = "Name"
    const val ABOUT_HOSTNAME = "Hostname"
    const val ABOUT_VERSION = "Version"
    const val ABOUT_RUNS_AS = "Runs As"
    const val ABOUT_REPOS_FOLDER = "Repos Folder"
    const val ABOUT_LAST_CHECK_IN = "Last Check-in"
    const val ABOUT_REGISTERED = "Registered"
    const val ABOUT_LAST_UPDATE = "Last Update"
    const val UPDATE_RUNNER_NOW = "Update Runner Now"
    const val UPDATE_RUNNER_REQUESTED = "Checking for a runner release now — a new one installs once no turn is running."
    const val ROOT_NO_BYPASS = "Runs as root, so sessions here can’t use Bypass permissions."
    const val ROTATE_TOKEN = "Rotate Token…"
    const val ROTATE_TOKEN_FOOTER = "Replaces this runner’s credential. It stays offline until the new token is in its " +
        "~/.orbit/config.json and it restarts."
    const val REMOVE = "Remove Runner"
    const val REMOVE_FOOTER = "Removes it and its workspaces from your account. Register the machine again to add it back."
    const val ADD_LEAD = "Run this on the machine you want to add. It installs Orbit, then asks you to confirm the machine is yours."
    const val COPY = "Copy"
    const val SHARE = "Share"
    const val WAITING_FOR_NEW = "Waiting for a new runner to check in…"
    const val NO_BROWSER = "No browser on that machine?"
    const val DEVICE_CODE = "Code"
    const val DEVICE_CODE_PLACEHOLDER = "ABCD-1234"
    const val DEVICE_CODE_FOOTER = "orbit register prints a code there. Enter it to approve the machine from this phone — its " +
        "name and hostname show before you confirm."
    const val APPROVE = "Approve"
    fun installCommandUnix(origin: String) = "curl -fsSL $origin/install.sh | bash"
    fun installCommandWindows(origin: String) = "irm $origin/install.ps1 | iex"
    const val REPAIR = "Repair"
    const val SET_A_RESERVE = "Set a Reserve…"
    const val COPY_COMMAND = "Copy Command"
    const val UPGRADE_COMMAND = "sudo orbit upgrade"
    const val UPDATES_TURN_ON = "To turn them back on, remove ORBIT_NO_SELFUPDATE from the runner’s environment and restart it — " +
        "on a Mac, opening the latest Orbit app does this."
}

/** An engine's accounts and Antigravity's Google sign-in in iOS's words (RunnerPageCopy, EngineAuth, RunnerEnginePage,
 * RunnerSignInView); AccountCopyParityTest finds each one in those Swift sources. */
internal object AccountCopy {
    const val SIGN_IN_AGAIN = "Sign In Again"
    const val SIGN_IN_WITH_GOOGLE = "Sign in with Google"
    const val RENEW = "Renew"
    const val ACCOUNT_SIGNED_OUT_NOTE = "Sessions can’t use this account until you sign in again."
    const val UNIT_DAY = "day"
    const val UNIT_DAYS = "days"
    const val ENV_KEY = "env key"
    const val ENV_KEY_LINE = "env key · runs on your Gemini key"
    const val NOT_SUPPORTED_YET = "Not supported yet"
    const val UPDATE_RUNNER = "Update runner"
    const val HINT_UNSUPPORTED = "Google sign-in is not supported on macOS runners yet. Use a Gemini API key."
    const val HINT_UPDATE = "Update this runner to sign in with Google."
    const val GOOGLE_TERMS_WARNING = "Google terms restrict personal account sign-in through third-party tools; your account may be suspended."
    const val GOOGLE_TERMS = "Google terms"
    const val GOOGLE_TERMS_URL = "https://antigravity.google/terms"
    const val RENAME = "Rename…"
    const val PAUSE = "Pause…"
    const val RESUME_NOW = "Resume Now"
    const val CHANGE_DURATION = "Change Duration…"
    const val REMOVE = "Remove…"
    const val ADD_ACCOUNT = "Add Account"
    const val CANCEL = "Cancel"
    const val CLOSE = "Close"
    const val ENTER_CODE = "Enter this one-time code on the sign-in page:"
    const val COPY_CODE_AND_OPEN = "Copy Code & Open Sign-In Page"
    const val OPEN_PAGE = "Open the sign-in page"
    const val PASTE_THE_CODE = "Paste the code"
    const val APPROVE_THEN_PASTE = "Approve it there, then paste the code the page gives you:"
    const val SUBMIT = "Submit"
    const val WAITING_FOR_APPROVAL = "Waiting for you to approve it…"
    fun loginExpires(count: Int, unit: String) = "Login expires in $count $unit"
    fun signedOutAlone(engine: String) = "Sessions on this runner can’t use $engine until you sign in again."
    fun next(account: String) = "Next: $account"
}

/**
 * CodexAccounts: a runner's accounts of an engine that keeps several (Claude Code, Codex, Antigravity, Kimi Code) — whose
 * quota each one reads, which one a new session starts on, and what moves a session between them. Shared by the runner
 * pages and the composer's account rows.
 */
internal object EngineAccounts {
    const val DEFAULT = "default"
    const val AUTOMATIC = "automatic"
    /** What a runner declares once it signs an Antigravity account Orbit names into that account's own Gemini directory. */
    const val ANTIGRAVITY_ACCOUNT_LOGIN = "antigravity-account-login/v1"
    /** The same for Kimi Code: an account Orbit names signs in, on the site the sign-in names, into a KIMI_CODE_HOME of its
     * own rather than Default's. */
    const val KIMI_ACCOUNT_LOGIN = "kimi-account-login/v1"
    private const val NEAR_LIMIT = 90.0
    private const val SHORT_WINDOW_NEAR_LIMIT = 80.0
    private const val SHORT_WINDOW_MINS = 5 * 60
    private const val WEEK_MINS = 7 * 24 * 60
    /** How long a Kimi Code monthly window is, for weighing it against the others (shared MONTH_MINS): longer than any
     * week, which is all its length decides here. */
    private const val MONTH_MINS = 30 * 24 * 60
    /** How long an Antigravity bucket's window is, from agy's own name for it (shared BUCKET_WINDOW_MINS). */
    private val bucketWindowMins = mapOf("5h" to 5 * 60, "weekly" to WEEK_MINS)

    /** The snapshot an engine's accounts read their quota from: the runner's own report, but Antigravity's, which travels
     * with its engine health (Default's buckets beside every other account's under `accounts`). */
    fun usage(engine: String, runner: JsonObject): JsonObject? = if (engine == "antigravity")
        runner.list("engines").firstOrNull { it.str("engine") == engine }?.obj("planUsage")
        else planUsageSnapshot(runner.obj("planUsage"), engine)

    /** What a runner declares when a session there can move to another of its accounts of [engine]: Codex, Claude Code and
     * Kimi Code carry the conversation across; Antigravity's lives in the session's own directory, so a runner that keeps
     * its accounts at all moves one. */
    fun moveCapability(engine: String) = when (engine) {
        "claude" -> "claude-account-move/v1"; "antigravity" -> ANTIGRAVITY_ACCOUNT_LOGIN; "kimi" -> "kimi-account-move/v1"
        else -> "codex-account-move/v1"
    }

    /** One Antigravity bucket as the window it names, for weighing quota against quota: what agy says is left, as the
     * share used every other window speaks in. What a page shows stays agy's remaining fraction (usageRows). */
    fun bucketWindow(bucket: JsonObject): JsonObject = buildJsonObject {
        put("utilization", (1 - (bucket.dbl("remainingFraction") ?: 0.0)) * 100)
        bucket.str("resetTime")?.let { put("resetsAt", it) }
        bucketWindowMins[bucket.str("window")]?.let { put("windowDurationMins", it) }
    }

    /** Every window of one snapshot with its length in minutes: Claude's and Kimi Code's named ones by their names — Kimi's
     * monthly pair both weighed, as shared weighs them — Codex's as reported, Antigravity's buckets as the windows they are. */
    fun withLength(snapshot: JsonObject): List<Pair<JsonObject, Int?>> {
        val named = listOf("fiveHour" to 5 * 60, "sevenDay" to WEEK_MINS, "sevenDayOpus" to WEEK_MINS, "sevenDaySonnet" to WEEK_MINS,
            "month" to MONTH_MINS, "monthCode" to MONTH_MINS)
            .mapNotNull { (key, mins) -> snapshot.obj(key)?.let { it to (it.int("windowDurationMins") ?: mins) } }
        val reported = listOfNotNull(snapshot.obj("primary"), snapshot.obj("secondary")) +
            snapshot.list("rateLimits").flatMap { listOfNotNull(it.obj("primary"), it.obj("secondary")) } +
            snapshot.list("buckets").map(::bucketWindow)
        return named + reported.map { it to it.int("windowDurationMins") }
    }

    fun windows(snapshot: JsonObject): List<JsonObject> = withLength(snapshot).map { it.first }

    private fun resetMs(window: JsonObject) = isoMs(window.str("resetsAt"))
    private fun used(window: JsonObject) = window.dbl("utilization") ?: 0.0

    /** Any window nearly spent and not past its reset: 80% of one of five hours or less, 90% of a longer one. */
    fun nearlySpent(snapshot: JsonObject, nowMs: Long) = withLength(snapshot).any { (window, mins) ->
        val open = resetMs(window)?.let { it <= nowMs } != true
        open && used(window) >= (if (mins != null && mins <= SHORT_WINDOW_MINS) SHORT_WINDOW_NEAR_LIMIT else NEAR_LIMIT)
    }

    /** When what an account has left goes to waste: the reset of its longest window — or, when none says how long it
     * is, the latest reset. Infinity when no window names a reset ahead. */
    fun expiresAt(snapshot: JsonObject, nowMs: Long): Double {
        val ahead = withLength(snapshot).mapNotNull { (window, mins) -> resetMs(window)?.takeIf { it > nowMs }?.let { mins to it } }
        val longest = ahead.maxOfOrNull { it.first ?: -1 } ?: return Double.POSITIVE_INFINITY
        val pick = if (longest >= 0) ahead.filter { (it.first ?: -1) == longest } else ahead
        return pick.maxOfOrNull { it.second.toDouble() } ?: Double.POSITIVE_INFINITY
    }

    /**
     * CodexAccounts.toStartOn: which account a new session with none picked starts on — the one whose quota would go to
     * waste first. Signed-out accounts are no candidates; one with a spent window, or paused by hand, waits until it frees
     * up; one nearly spent comes after the rest; then the soonest-expiring, then the roomiest by its tightest window; ties
     * go to Default, then the lower id. Every candidate held: the one that frees up first. Null with fewer than two.
     */
    fun toStartOn(accounts: List<JsonObject>, usage: JsonObject?, nowMs: Long): String? {
        if (accounts.size < 2) return null
        class Candidate(val id: String, val nearLimit: Boolean, val expiresAt: Double, val tightest: Double, val spentUntil: Double?)
        val candidates = accounts.filter { it.str("auth") != "no" }.map { account ->
            val own = accountSnapshot(usage, account.text("id"))
            val windows = own?.let(::windows).orEmpty()
            val spent = windows.filter { window -> resetMs(window)?.let { it <= nowMs } != true && used(window) >= 100 }
            var spentUntil = spent.maxOfOrNull { resetMs(it)?.toDouble() ?: Double.POSITIVE_INFINITY }
            isoMs(account.str("pausedUntil"))?.takeIf { it > nowMs }?.let { pause -> spentUntil = maxOf(pause.toDouble(), spentUntil ?: 0.0) }
            Candidate(account.text("id"), own?.let { nearlySpent(it, nowMs) } ?: false, own?.let { expiresAt(it, nowMs) } ?: Double.POSITIVE_INFINITY,
                windows.maxOfOrNull(::used) ?: Double.POSITIVE_INFINITY, spentUntil)
        }
        val byId = compareBy<Candidate> { it.id != DEFAULT }.thenBy { it.id }
        val usable = candidates.filter { it.spentUntil == null }
        if (usable.isNotEmpty()) return usable.sortedWith(compareBy<Candidate> { it.nearLimit }.thenBy { it.expiresAt }.thenBy { it.tightest }
            .then(byId)).first().id
        return candidates.sortedWith(compareBy<Candidate> { it.spentUntil ?: 0.0 }.then(byId)).firstOrNull()?.id
    }
}

internal data class AttentionAction(val kind: String, val engine: String? = null, val workspaceId: String? = null, val command: String? = null)

/** One RunnerAttentionItem: kind/tone are the case file's raw values; resetsAt and names feed the page's formatting. */
internal data class AttentionItem(val kind: String, val tone: String, val short: String, val title: String, val detail: String,
    val action: AttentionAction? = null, val resetsAt: String? = null, val names: List<String> = emptyList())

internal data class RunnerDisk(val freeBytes: Long, val totalBytes: Long, val usedPercent: Int)

/** One quota window. [remaining]: an Antigravity bucket, whose percent says what is left, as agy says it; `utilization`
 * stays the share used every other window speaks in. */
internal data class UsageRow(val key: String, val label: String, val groupLabel: String?, val window: JsonObject, val remaining: Boolean = false) {
    val utilization get() = window.dbl("utilization") ?: 0.0
    val percent get() = Math.round(if (remaining) 100 - utilization else utilization).toInt().coerceIn(0, 100)
    /** At or past 90% used, judged on the reading rather than its rounding. */
    val nearLimit get() = utilization >= 90
}

internal fun JsonObject.str(name: String): String? = (this[name] as? JsonPrimitive)?.contentOrNull
internal fun JsonObject.int(name: String): Int? = (this[name] as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()?.toInt()
internal fun JsonObject.long(name: String): Long? = (this[name] as? JsonPrimitive)?.contentOrNull?.let { it.toLongOrNull() ?: it.toDoubleOrNull()?.toLong() }
internal fun JsonObject.dbl(name: String): Double? = (this[name] as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull()
internal fun JsonObject.bool(name: String): Boolean? = (this[name] as? JsonPrimitive)?.booleanOrNull
internal fun JsonObject.obj(name: String): JsonObject? = this[name] as? JsonObject
internal fun JsonObject.strings(name: String): List<String> = (this[name] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()

/** An ISO time as epoch milliseconds, as Date.parse reads the server's timestamps. */
internal fun isoMs(iso: String?): Long? {
    if (iso.isNullOrBlank()) return null
    return runCatching { Instant.parse(iso).toEpochMilli() }.getOrNull()
        ?: runCatching { OffsetDateTime.parse(iso).toInstant().toEpochMilli() }.getOrNull()
}

internal object RunnerPage {
    const val OFFLINE_AFTER_MS = 90_000L
    private const val MINUTE = 60_000L
    private const val HOUR = 60 * MINUTE
    private const val DAY = 24 * HOUR
    private const val MIB = 1024L * 1024
    private const val GIB = 1024 * MIB
    private const val STALE_UPDATE_MS = 7 * DAY
    /** Keep Free's choices: what PATCH /runners/:id sends as minFreeDiskMb, and what the picker says. */
    val KEEP_FREE_TIERS = listOf<Pair<Int?, String>>(null to "Off", 10_240 to "10 GB", 20_480 to "20 GB", 51_200 to "50 GB")
    /** The engines a runner reports on, in the page's order, with each CLI's own name. */
    val engineOrder = listOf("claude", "codex", "kimi", "opencode", "antigravity")
    /** The engines Orbit signs in on a runner (LoginEngine), in the Engines list's order. */
    val loginEngines = listOf("claude", "codex", "kimi", "antigravity")
    private val loginNames = mapOf("claude" to "Claude", "codex" to "Codex", "kimi" to "Kimi", "antigravity" to "Antigravity")
    /** Antigravity's buckets by the label usageRows gives the window agy names for each. */
    private val antigravityWindows = mapOf("5-hour" to "5-hour limit", "Weekly" to "weekly limit")
    private val stuckIn = mapOf("unmerged" to "a conflict", "merge" to "a merge", "rebase" to "a rebase",
        "cherry-pick" to "a cherry-pick", "revert" to "a revert")
    private val claudeWindows = mapOf("fiveHour" to "5-hour limit", "sevenDay" to "weekly limit",
        "sevenDayOpus" to "weekly Opus limit", "sevenDaySonnet" to "weekly Sonnet limit")
    private val codexWindows = listOf("5h limit" to "5-hour limit", "Daily limit" to "daily limit",
        "Weekly limit" to "weekly limit", "Monthly limit" to "monthly limit", "Annual limit" to "annual limit")

    fun engineName(engine: String) = when (engine) {
        "claude" -> "Claude Code"; "codex" -> "Codex"; "kimi" -> "Kimi Code"
        "opencode" -> "OpenCode"; "antigravity" -> "Antigravity"; else -> engine
    }
    /** The CLI's name where an update of it is named (runnerEngines.ts ENGINE_CLI_NAME): Antigravity's is still its CLI's. */
    private fun cliName(engine: String) = if (engine == "antigravity") "Antigravity CLI" else engineName(engine)
    /** The engines whose CLI keeps a login per directory, so one machine holds several accounts of them (shared
     * ACCOUNT_ENGINES): an Antigravity account is a Google sign-in in a Gemini directory of its own, a Kimi Code account a
     * KIMI_CODE_HOME of its own. */
    fun keepsAccounts(engine: String) = engine == "claude" || engine == "codex" || engine == "antigravity" || engine == "kimi"
    fun isLoginEngine(engine: String) = engine in loginEngines

    // version
    private fun versionParts(version: String): List<Int> = version.trim().removePrefix("v").removePrefix("V")
        .split('.').map { part -> if (part.isNotEmpty() && part.all { it in '0'..'9' }) part.toIntOrNull() ?: 0 else 0 }

    fun compareRunnerVersions(a: String, b: String): Int {
        val x = versionParts(a); val y = versionParts(b)
        for (index in 0 until maxOf(x.size, y.size)) {
            val difference = x.getOrElse(index) { 0 } - y.getOrElse(index) { 0 }
            if (difference != 0) return if (difference < 0) -1 else 1
        }
        return 0
    }

    /** The newest release anyone can see: <origin>/dl/version.json, or any of the account's runners. */
    fun latestRunnerVersion(published: String?, versions: List<String?>): String? {
        var latest: String? = null
        for (candidate in listOf(published) + versions) {
            val version = candidate?.trim()?.takeIf { it.isNotEmpty() } ?: continue
            if (latest != null && compareRunnerVersions(version, latest) <= 0) continue
            latest = version
        }
        return latest
    }

    // disk
    /** The tightest filesystem its workspaces report, de-duplicated by (free, total). */
    fun runnerDisk(workspaces: List<JsonObject>): RunnerDisk? {
        val seen = mutableSetOf<String>()
        var tightest: RunnerDisk? = null
        for (workspace in workspaces) {
            val free = workspace.long("workDirFreeBytes")?.takeIf { it >= 0 } ?: continue
            val total = workspace.long("workDirTotalBytes")?.takeIf { it > 0 } ?: continue
            if (!seen.add("$free/$total")) continue
            if (tightest != null && tightest.freeBytes <= free) continue
            val used = Math.round((total.toDouble() - free.toDouble()) / total.toDouble() * 100).toInt()
            tightest = RunnerDisk(free, total, used.coerceIn(0, 100))
        }
        return tightest
    }

    /** Bytes in GB the way df -h counts them: whole from 10 GB up, one decimal below. */
    fun formatDiskGb(bytes: Long): String {
        val gb = bytes.toDouble() / GIB
        if (gb >= 10) return Math.round(gb).toString()
        val tenths = Math.round(gb * 10).toInt()
        if (tenths >= 100) return "10"
        return "${tenths / 10}.${tenths % 10}"
    }

    fun keepFreeValue(mb: Int?): Int? = mb?.takeIf { it > 0 }
    fun keepFreeLabel(mb: Int?): String {
        val value = keepFreeValue(mb)
        return KEEP_FREE_TIERS.firstOrNull { it.first == value }?.second ?: RunnerCopy.gb(formatDiskGb((value ?: 0) * MIB))
    }
    fun keepFreeChoices(mb: Int?): List<Pair<Int?, String>> {
        val current = keepFreeValue(mb) ?: return KEEP_FREE_TIERS
        return if (KEEP_FREE_TIERS.any { it.first == current }) KEEP_FREE_TIERS else KEEP_FREE_TIERS + (current to keepFreeLabel(current))
    }
    fun diskUsedLine(disk: RunnerDisk) = RunnerCopy.diskUsed(formatDiskGb(disk.totalBytes - disk.freeBytes), formatDiskGb(disk.totalBytes))
    /** The disk bar turns amber at 90% used, or once what is free is under the Keep Free reserve. */
    fun diskIsTight(disk: RunnerDisk, minFreeDiskMb: Int?): Boolean =
        disk.usedPercent >= 90 || keepFreeValue(minFreeDiskMb)?.let { disk.freeBytes < it * MIB } == true

    // time
    /** `just now`, `5m ago`, `3h ago`, `14d ago`. */
    fun ago(iso: String?, nowMs: Long): String {
        val then = isoMs(iso) ?: return "just now"
        val difference = nowMs - then
        return when {
            difference < MINUTE -> "just now"
            difference < HOUR -> "${difference / MINUTE}m ago"
            difference < DAY -> "${difference / HOUR}h ago"
            else -> "${difference / DAY}d ago"
        }
    }

    /** What an engine row says about being kept current; warn means only a person can say why. */
    fun updateNoteOf(update: JsonObject?, nowMs: Long): Pair<String, String>? {
        update ?: return null
        if (update.str("status") == "skipped") return "quiet" to "not auto-updated"
        val latest = update.str("latest")?.takeIf { it.isNotEmpty() }
        isoMs(update.str("behindSince"))?.let { behindSince ->
            val behind = nowMs - behindSince
            if (behind > STALE_UPDATE_MS) {
                val days = maxOf(1, floor(behind.toDouble() / DAY).toInt())
                return "warn" to "${days}d behind${latest?.let { " $it" }.orEmpty()}"
            }
            return "quiet" to when {
                update.str("status") == "failed" -> "last update failed · retrying every 30 min"
                latest != null -> "updating to $latest"
                else -> "update pending"
            }
        }
        val lastOk = isoMs(update.str("okAt"))
        if (lastOk != null && nowMs - lastOk <= STALE_UPDATE_MS) {
            if (update.str("status") == "failed") return "quiet" to "last update failed · retrying every 30 min"
            val verb = if (update.str("status") == "checked") "checked" else "updated"
            return "quiet" to "$verb ${ago(update.str("at").orEmpty(), nowMs)}"
        }
        lastOk ?: return "warn" to "never updated"
        return "warn" to "not updated in ${maxOf(1, (nowMs - lastOk) / DAY)}d"
    }

    // offline
    fun isOffline(runner: JsonObject, nowMs: Long): Boolean {
        if (runner.bool("online") == false) return true
        val seen = isoMs(runner.str("lastHeartbeatAt")) ?: return runner.bool("online") != true
        return nowMs - seen > OFFLINE_AFTER_MS
    }

    private fun offlineFor(ms: Long): String = when {
        ms >= DAY -> (ms / DAY).let { "Offline for $it ${if (it == 1L) "day" else "days"}" }
        ms >= HOUR -> (ms / HOUR).let { "Offline for $it ${if (it == 1L) "hour" else "hours"}" }
        else -> maxOf(1, ms / MINUTE).let { "Offline for $it ${if (it == 1L) "minute" else "minutes"}" }
    }

    private fun offlineItem(runner: JsonObject, nowMs: Long): AttentionItem {
        val sessions = runner.int("activeSessions") ?: 0
        val waiting = when { sessions == 1 -> "Its 1 session waits until it checks in again."
            sessions > 1 -> "Its $sessions sessions wait until it checks in again."; else -> null }
        val wake = "Start the runner on that machine — it reconnects within 30 seconds."
        return AttentionItem("offline", "idle", RunnerCopy.OFFLINE,
            isoMs(runner.str("lastHeartbeatAt"))?.let { offlineFor(maxOf(0, nowMs - it)) } ?: "Never checked in",
            waiting?.let { "$it $wake" } ?: wake)
    }

    // the rules
    private fun namesPhrase(names: List<String>) = when {
        names.size == 2 -> "${names[0]} and ${names[1]}"
        names.size > 2 -> "${names[0]} and ${names.size - 1} more"
        else -> names.firstOrNull().orEmpty()
    }

    private fun workspacesOn(workspaces: List<JsonObject>, engine: String) =
        workspaces.filter { it.str("lastProvider") == engine }.map { it.text("name") }

    private fun engineHealth(runner: JsonObject, engine: String) =
        (runner["engines"] as? JsonArray)?.filterIsInstance<JsonObject>()?.firstOrNull { it.str("engine") == engine }

    private fun signedOutItems(runner: JsonObject, workspaces: List<JsonObject>) = loginEngines.mapNotNull { engine ->
        val health = engineHealth(runner, engine)?.takeIf { it.bool("installed") == true && it.str("auth") == "no" } ?: return@mapNotNull null
        val users = workspacesOn(workspaces, engine).takeIf { it.isNotEmpty() } ?: return@mapNotNull null
        val name = loginNames.getValue(engine)
        AttentionItem("engineSignedOut", "bad", "$name signed out", "$name is signed out",
            if (users.size == 1) "${users[0]} runs on this machine’s $name login — its sessions fail until you sign in again."
            else "${namesPhrase(users)} run on this machine’s $name login — their sessions fail until you sign in again.",
            AttentionAction("signIn", engine = health.str("engine")), names = users)
    }

    /** One item per stuck checkout, however many workspaces work in it, named after the first. */
    private fun checkoutItems(workspaces: List<JsonObject>): List<AttentionItem> {
        val byRoot = linkedMapOf<String, MutableList<JsonObject>>()
        for (workspace in workspaces) {
            val health = workspace.obj("repoHealth") ?: continue
            if (health.str("state") !in stuckIn) continue
            val root = health.str("root")?.takeIf { it.isNotEmpty() } ?: workspace.text("id")
            byRoot.getOrPut(root) { mutableListOf() }.add(workspace)
        }
        return byRoot.values.map { stuck ->
            val first = stuck.first()
            val summary = "${first.text("name")} checkout stuck in ${stuckIn.getValue(first.obj("repoHealth")!!.str("state")!!)}"
            AttentionItem("checkoutStuck", "bad", summary, summary,
                "Nothing can merge into it until it’s cleaned up. Repair saves everything it holds to an orbit/rescue-… branch, then returns it to its last commit.",
                AttentionAction("repair", workspaceId = first.text("id")), names = stuck.map { it.text("name") })
        }
    }

    private fun quotaWindow(row: UsageRow) = claudeWindows[row.key]
        // An Antigravity bucket, by the window agy names for it.
        ?: (if (row.remaining) antigravityWindows[row.label] ?: "usage limit" else null)
        ?: codexWindows.firstOrNull { row.label.endsWith(it.first) }?.second ?: "usage limit"

    /** How much of a window is used, whichever way its row counts it: an Antigravity bucket's says what is left. */
    private fun usedPercent(row: UsageRow) = if (row.remaining) 100 - row.percent else row.percent

    /** Warn only when every candidate account is near its limit; name the fullest window of the roomiest. An Antigravity
     * Default that runs on the machine's Gemini key (runsOnEnvKey) has no quota to run out of. */
    private fun quotaItems(runner: JsonObject, workspaces: List<JsonObject>, nowMs: Long) = loginEngines.mapNotNull { engine ->
        val users = workspacesOn(workspaces, engine).takeIf { it.isNotEmpty() } ?: return@mapNotNull null
        // Antigravity's quota travels with its engine's health, not in the runner's plan usage.
        val usage = EngineAccounts.usage(engine, runner)
        val health = engineHealth(runner, engine)
        val accounts = health?.list("accounts").orEmpty()
        val snapshots = if (keepsAccounts(engine) && health != null && accounts.isNotEmpty()) {
            fun onKey(account: JsonObject) = runsOnEnvKey(health, account.text("id"), account.str("auth"))
            accounts.filter { it.str("auth") != "no" || onKey(it) }.map { if (onKey(it)) null else accountSnapshot(usage, it.text("id")) }
        } else listOf(usage)
        var fullest: UsageRow? = null
        for (snapshot in snapshots) {
            val near = snapshot?.let(::usageRows).orEmpty().filter { row -> row.nearLimit && isoMs(row.window.str("resetsAt"))?.let { it <= nowMs } != true }
            var accountFullest = near.firstOrNull() ?: return@mapNotNull null
            for (row in near.drop(1)) if (usedPercent(row) > usedPercent(accountFullest)) accountFullest = row
            if (fullest == null || usedPercent(accountFullest) < usedPercent(fullest)) fullest = accountFullest
        }
        val row = fullest ?: return@mapNotNull null
        val name = loginNames.getValue(engine)
        val window = quotaWindow(row)
        val percent = usedPercent(row)
        AttentionItem("quotaNearLimit", "warn", "$name $window $percent%", "$name $window at $percent%",
            if (users.size == 1) "${users[0]} runs on this machine’s $name login — its sessions pause if the limit runs out."
            else "${namesPhrase(users)} run on this machine’s $name login — their sessions pause if the limit runs out.",
            resetsAt = row.window.str("resetsAt"), names = users)
    }

    /** Below Keep Free when one is set; with none, under 10% of the disk free. */
    private fun diskItem(runner: JsonObject, workspaces: List<JsonObject>): AttentionItem? {
        val disk = runnerDisk(workspaces) ?: return null
        val reserve = keepFreeValue(runner.int("minFreeDiskMb"))
        val low = reserve?.let { disk.freeBytes < it * MIB } ?: (disk.freeBytes.toDouble() * 10 < disk.totalBytes.toDouble())
        if (!low) return null
        val free = formatDiskGb(disk.freeBytes); val total = formatDiskGb(disk.totalBytes)
        val summary = "Disk ${disk.usedPercent}% full"
        return AttentionItem("diskLow", "warn", summary, summary,
            reserve?.let { "$free GB free of $total GB, under the ${formatDiskGb(it * MIB)} GB it keeps free — task runs stop being sent here until space frees up." }
                ?: "$free GB free of $total GB. No reserve is set, so task runs keep landing here until the disk fills.",
            AttentionAction("setReserve"))
    }

    /** The runner's own words as the start of a sentence: capitalized, with no closing full stop. */
    private fun runnerSaid(words: String?, otherwise: String): String {
        val said = words?.trim()?.trimEnd('.').orEmpty()
        return if (said.isEmpty()) otherwise else said.replaceFirstChar { it.uppercase() }
    }

    /**
     * Behind the latest release, and not catching up by itself. A runner that reports where its updates stand
     * (`selfUpdate`) is taken at its word: `dirNotWritable` points to sudo orbit upgrade, once; `disabledByEnv` says why,
     * with how to turn it back only for ORBIT_NO_SELFUPDATE; `failed` offers Update Runner Now, so only while online.
     * `enabled`, `waitingForIdle`, `heldByRollout` and a state this client doesn't know raise nothing. One too old to
     * report it is judged by runsAsRoot, as before: a regular user stays on its version until someone runs the command.
     */
    private fun cannotSelfUpdateItem(runner: JsonObject, latest: String?, offline: Boolean): AttentionItem? {
        val version = runner.str("version")?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        if (latest.isNullOrEmpty() || compareRunnerVersions(version, latest) >= 0) return null
        val command = RunnerCopy.UPGRADE_COMMAND
        val report = runner.obj("selfUpdate")
        if (report == null) {
            if (runner.bool("runsAsRoot") != false) return null
            return AttentionItem("cannotSelfUpdate", "warn", "Can’t update itself", "Can’t update itself",
                "It runs as a regular user, so it can’t replace its own binary — still on $version, latest is $latest. On that machine, run $command.",
                AttentionAction("copyCommand", command = command))
        }
        return when (report.str("state")) {
            "dirNotWritable" -> AttentionItem("cannotSelfUpdate", "warn", "Install folder isn’t writable", "Install folder isn’t writable",
                "It can’t write to ${report.str("installDir") ?: "its install folder"}, so it can’t replace its own binary — still on $version, " +
                    "latest is $latest. On that machine, run $command once; after that it updates itself.",
                AttentionAction("copyCommand", command = command))
            "disabledByEnv" -> {
                val detail = "${runnerSaid(report.str("reason"), "Its updater is switched off")}, so it doesn’t update itself — still on $version, latest is $latest."
                AttentionItem("cannotSelfUpdate", "warn", "Updates are turned off", "Updates are turned off",
                    if (report.str("reason")?.contains("ORBIT_NO_SELFUPDATE") == true) "$detail ${RunnerCopy.UPDATES_TURN_ON}" else detail)
            }
            "failed" -> if (offline) null else AttentionItem("cannotSelfUpdate", "warn", "Runner update failed", "Runner update failed",
                "${runnerSaid(report.str("reason"), "Its last update didn’t go through")}. Still on $version, latest is $latest. " +
                    "It retries every 10 min — Update Runner Now tries again right away.",
                AttentionAction("updateRunner"))
            else -> null
        }
    }

    /** Whether Update Runner Now can do anything here: only a runner that reports its updates takes it (the server refuses
     * an older one), only online, and not one whose updater is off or can't write its install folder. */
    fun canUpdateNow(runner: JsonObject, nowMs: Long): Boolean {
        val state = runner.obj("selfUpdate")?.str("state")?.takeIf { it.isNotEmpty() } ?: return false
        return state != "disabledByEnv" && state != "dirNotWritable" && !isOffline(runner, nowMs)
    }

    private fun engineUpdateItems(runner: JsonObject, nowMs: Long) = engineOrder.mapNotNull { engine ->
        val health = engineHealth(runner, engine)?.takeIf { it.bool("installed") == true } ?: return@mapNotNull null
        val note = updateNoteOf(health.obj("update"), nowMs)?.takeIf { it.first == "warn" } ?: return@mapNotNull null
        val summary = "${cliName(engine)} update failed"
        AttentionItem("engineNotUpdating", "warn", summary, summary,
            "${note.second.replaceFirstChar { it.uppercase() }}. Orbit retries every 30 min — Update Engines Now tries again right away.",
            AttentionAction("updateEngines", engine = engine))
    }

    /** Everything about this runner that needs a person, most severe first. */
    fun attention(runner: JsonObject, workspaces: List<JsonObject>, nowMs: Long, latestVersion: String?): List<AttentionItem> {
        val offline = isOffline(runner, nowMs)
        val items = mutableListOf<AttentionItem>()
        if (offline) items += offlineItem(runner, nowMs)
        else {
            items += signedOutItems(runner, workspaces)
            items += checkoutItems(workspaces)
            items += quotaItems(runner, workspaces, nowMs)
            diskItem(runner, workspaces)?.let { items += it }
        }
        cannotSelfUpdateItem(runner, latestVersion, offline)?.let { items += it }
        if (!offline) items += engineUpdateItems(runner, nowMs)
        return items
    }

    /** The list's third line: the first two items' short lines; none for an offline runner. */
    fun listAttentionLine(items: List<AttentionItem>): String? {
        if (items.any { it.kind == "offline" }) return null
        return items.take(2).map { it.short }.takeIf { it.isNotEmpty() }?.joinToString(RunnerCopy.SEP)
    }

    fun displayName(runner: JsonObject) = runner.str("displayName")?.trim()?.takeIf { it.isNotEmpty() } ?: runner.text("name")

    /** Online: `<hostname> · v<version>`; offline: `Offline · last seen 14d ago · v<version>`. */
    fun listSubtitle(runner: JsonObject, nowMs: Long): String {
        val version = runner.str("version")?.trim()?.takeIf { it.isNotEmpty() }?.let(RunnerCopy::versionTag)
        if (isOffline(runner, nowMs)) {
            val status = runner.str("lastHeartbeatAt")?.takeIf { it.isNotEmpty() }?.let { RunnerCopy.offlineLastSeen(ago(it, nowMs)) } ?: RunnerCopy.OFFLINE
            return listOfNotNull(status, version).joinToString(RunnerCopy.SEP)
        }
        return hostLine(runner)
    }

    fun hostLine(runner: JsonObject): String {
        val host = runner.str("hostname")?.trim()?.takeIf { it.isNotEmpty() && it != displayName(runner) }
        val version = runner.str("version")?.trim()?.takeIf { it.isNotEmpty() }?.let(RunnerCopy::versionTag)
        return listOfNotNull(host, version).joinToString(RunnerCopy.SEP)
    }

    /** green online, amber while it drains, grey offline. */
    fun presence(runner: JsonObject, nowMs: Long) = when {
        isOffline(runner, nowMs) -> "offline"
        runner.str("status") == "DRAINING" -> "draining"
        else -> "online"
    }

    /** A list row's `4/12`: none for an offline machine or one with no limit reported. */
    fun slots(runner: JsonObject, nowMs: Long): Pair<Int, Int>? {
        if (isOffline(runner, nowMs)) return null
        val max = runner.int("maxConcurrent")?.takeIf { it > 0 } ?: return null
        return (runner.int("activeSessions") ?: 0) to max
    }

    fun listTone(items: List<AttentionItem>) = if (listAttentionLine(items) == null) null else items.firstOrNull()?.tone

    fun statusLine(runner: JsonObject, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): String {
        if (isOffline(runner, nowMs)) return runner.str("lastHeartbeatAt")?.let { lastSeen(it, zone) }?.let(RunnerCopy::offlineLastSeen) ?: RunnerCopy.OFFLINE
        val max = runner.int("maxConcurrent")?.takeIf { it > 0 } ?: return RunnerCopy.ONLINE
        return RunnerCopy.ONLINE + RunnerCopy.SEP + RunnerCopy.runningOf(runner.int("activeSessions") ?: 0, max)
    }

    /** A nearly spent quota leads with when it resets, in the reader's time zone. */
    fun attentionDetail(item: AttentionItem, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): String {
        if (item.kind != "quotaNearLimit") return item.detail
        val whenText = item.resetsAt?.let { resetsWhen(it, nowMs, zone) } ?: return item.detail
        return "Resets $whenText. ${item.detail}"
    }

    // engines
    /** The engines a runner reports on, in the page's order. A runner predating Antigravity keeps its row too, from what
     * the server says of it (`runner.antigravity`), so the page can say it needs an update. */
    fun engines(runner: JsonObject): List<JsonObject> {
        var reported = runner.list("engines")
        if (reported.none { it.str("engine") == "antigravity" }) reported = reported + buildJsonObject {
            put("engine", "antigravity")
            runner.obj("antigravity")?.let { state -> state.bool("installed")?.let { put("installed", it) }; state.str("version")?.let { put("version", it) } }
        }
        return engineOrder.mapNotNull { engine -> reported.firstOrNull { it.str("engine") == engine } } +
            reported.filter { it.str("engine") !in engineOrder }
    }

    /** Antigravity's Default on a runner that runs agy on its own GEMINI_API_KEY (web runsOnEnvKey): the engine answers yes —
     * on the key, authSource not google — while Default, the runner's Google sign-in alone, does not. Neither signed out nor
     * short of quota. [auth] is Default's own answer, null where the runner lists no accounts. */
    fun runsOnEnvKey(health: JsonObject, account: String, auth: String?) = health.str("engine") == "antigravity" &&
        account == EngineAccounts.DEFAULT && auth != "yes" && health.str("auth") == "yes" && health.str("authSource") != "google"

    /** EngineAuth.antigravityLoginHint: why Google sign-in can't be started on this runner, or null where it can. */
    fun antigravityLoginHint(googleLogin: String?): String? = when (googleLogin) {
        "available" -> null; "unsupported_platform" -> AccountCopy.HINT_UNSUPPORTED; else -> AccountCopy.HINT_UPDATE
    }
    /** Why the engine page cannot sign [engine] in here, where a sentence says it: only Antigravity's Google sign-in. */
    fun signInHint(runner: JsonObject, engine: String) = if (engine == "antigravity") antigravityLoginHint(runner.obj("antigravity")?.str("googleLogin")) else null
    fun antigravityCanSignIn(runner: JsonObject) = runner.obj("antigravity")?.str("googleLogin") == "available" &&
        engineHealth(runner, "antigravity")?.bool("installed") == true
    /** Every engine Orbit signs in, and Antigravity only where the runner offers its Google sign-in. */
    fun canSignIn(runner: JsonObject, engine: String) = engine != "antigravity" || antigravityCanSignIn(runner)
    /** Add Account: an engine that keeps accounts — Antigravity's only on a runner that keeps an added Google account apart
     * from Default's (antigravity-account-login/v1), Kimi's only on one that signs the account it adds into a KIMI_CODE_HOME
     * of its own (kimi-account-login/v1); an older one would sign Default in again in its place. */
    fun canAddAccount(runner: JsonObject, engine: String) = keepsAccounts(engine) && when (engine) {
        "antigravity" -> antigravityCanSignIn(runner) && EngineAccounts.ANTIGRAVITY_ACCOUNT_LOGIN in runner.strings("capabilities")
        "kimi" -> EngineAccounts.KIMI_ACCOUNT_LOGIN in runner.strings("capabilities")
        else -> true
    }
    /** The engine page's name for its section of logins: Accounts where the engine keeps several on this runner, Sign-In
     * where it has the one — as Kimi does on a runner that cannot add a second, whose page reads as it always has. */
    fun accountsTitle(runner: JsonObject, engine: String) =
        if (keepsAccounts(engine) && (engine != "kimi" || canAddAccount(runner, engine))) "Accounts" else "Sign-In"
    /** Which of Kimi's two sites its login is on, said after the version on its Engines row (`2.1.1 · kimi.ai`): the same
     * CLI signs in to either, and a session spends that site's subscription. Null for every other engine, before Kimi's
     * first sign-in — and with several accounts, which can be on different sites: each says its own on the engine page. */
    fun engineSite(health: JsonObject): String? =
        if (health.str("engine") != "kimi" || health.list("accounts").size >= 2) null else KimiSite.of(health.str("kimiRegion"))?.domain
    /** The engines whose quota a runner reads: the ones Orbit signs in. */
    fun reportsQuota(engine: String) = isLoginEngine(engine)

    /** The version a CLI reported without what it printed around it: `2.1.284 (Claude Code)` is `2.1.284`. */
    fun engineVersion(reported: String?): String? {
        val text = reported?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        for (token in text.split(' ', '(', ')').filter { it.isNotEmpty() }) {
            val word = token.removePrefix("v").removePrefix("V")
            val parts = word.split('.')
            if (parts.size >= 2 && parts.all { part -> part.isNotEmpty() && part.all { it in '0'..'9' } }) return word
        }
        return text
    }

    /** Only the CLI's own yes is signed in; a CLI that wouldn't say is shown as neither. */
    fun authStatus(auth: String?): Pair<String, String>? = when (auth) {
        "yes" -> RunnerCopy.SIGNED_IN to "ok"; "no" -> RunnerCopy.SIGNED_OUT to "warn"; else -> null
    }

    /** With several accounts the engine is signed in only when every one of them is. An Antigravity that can't sign in with
     * Google here says why (given its [runner]); one on the machine's Gemini key says "env key", whose Default counts as in. */
    fun engineStatus(health: JsonObject, runner: JsonObject? = null): Pair<String, String>? {
        if (health.text("engine") == "antigravity" && runner != null && health.bool("installed") != false && health.str("auth") != "yes") {
            when (runner.obj("antigravity")?.str("googleLogin")) {
                "unsupported_platform" -> return AccountCopy.NOT_SUPPORTED_YET to "muted"
                "available" -> Unit
                else -> return AccountCopy.UPDATE_RUNNER to "muted"
            }
        }
        if (health.bool("installed") != true) return RunnerCopy.NOT_INSTALLED to "muted"
        if (!isLoginEngine(health.text("engine"))) return null
        val accounts = health.list("accounts")
        if (accounts.size < 2) {
            if (runsOnEnvKey(health, EngineAccounts.DEFAULT, accounts.firstOrNull()?.str("auth"))) return AccountCopy.ENV_KEY to "ok"
            return authStatus(health.str("auth"))
        }
        val auths = accounts.map { if (runsOnEnvKey(health, it.text("id"), it.str("auth"))) "yes" else it.str("auth") }
        if (auths.all { it == "yes" }) return RunnerCopy.accountsSignedIn(accounts.size) to "ok"
        return if (auths.any { it == "no" }) authStatus("no") else null
    }

    /** The Engines row's Sign In: a login it needs is out — never an Antigravity Default on the machine's Gemini key. */
    fun needsSignIn(health: JsonObject): Boolean = health.bool("installed") == true && isLoginEngine(health.text("engine")) &&
        (health.str("auth") == "no" || health.list("accounts").any { it.str("auth") == "no" && !runsOnEnvKey(health, it.text("id"), it.str("auth")) })

    fun updateFailedLine(health: JsonObject, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): String? {
        if (health.bool("installed") != true) return null
        val update = health.obj("update")?.takeIf { it.str("status") == "failed" } ?: return null
        val latest = update.str("latest")?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        if (updateNoteOf(update, nowMs)?.first != "warn") return null
        val whenText = update.str("at")?.let { day(it, nowMs, zone) } ?: return null
        return RunnerCopy.updateFailed(latest, whenText)
    }

    /** `Checked 6m ago`, or for a runner gone quiet the day it last reported (`Reported Sep 14`). */
    fun enginesNote(runner: JsonObject, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): String? {
        if (isOffline(runner, nowMs)) return runner.str("lastHeartbeatAt")?.let { day(it, nowMs, zone) }?.let(RunnerCopy::enginesReported)
        val checked = runner.list("engines").filter { it.bool("installed") == true }
            .mapNotNull { health -> health.obj("update")?.str("at")?.let { at -> isoMs(at)?.let { at to it } } }.maxByOrNull { it.second }
        return checked?.let { RunnerCopy.enginesChecked(ago(it.first, nowMs)) }
    }

    /** The one quota window an Engines row shows: the binding one (bindingRow, the composer gauge's) — Default's while the
     * engine is signed in with one account; with several, that of the account a new session starts on, which the row names
     * above it (engineNextAccount). Every window, and every account's, is the engine page's to list. */
    fun engineWindows(runner: JsonObject, engine: String, nowMs: Long = System.currentTimeMillis()): List<UsageRow> {
        val health = engineHealth(runner, engine)?.takeIf { it.bool("installed") == true } ?: return emptyList()
        val account = when {
            health.list("accounts").size >= 2 -> nextAccount(runner, health, nowMs) ?: return emptyList()
            health.str("auth") == "yes" -> EngineAccounts.DEFAULT
            else -> return emptyList()
        }
        return accountSnapshot(EngineAccounts.usage(engine, runner), account)?.let { bindingRow(it, nowMs) }?.let(::listOf).orEmpty()
    }

    /** The account an Engines row names above its window while the engine has several: the one a new session starts on.
     * Null with one account, none signed in, or no window to show for it. */
    fun engineNextAccount(runner: JsonObject, engine: String, nowMs: Long = System.currentTimeMillis()): String? {
        val health = engineHealth(runner, engine)?.takeIf { it.bool("installed") == true } ?: return null
        val next = nextAccount(runner, health, nowMs) ?: return null
        if (engineWindows(runner, engine, nowMs).isEmpty()) return null
        return accountLabel(next, health.list("accounts"))
    }

    /** Whether the engine page marks [account] NEXT beside its name, as the account pools mark theirs: the account a new
     * session nobody picked one for starts on — so only where the engine has two accounts or more to choose between. */
    fun marksNext(runner: JsonObject, engine: String, account: String, nowMs: Long = System.currentTimeMillis()): Boolean {
        val health = engineHealth(runner, engine) ?: return false
        return nextAccount(runner, health, nowMs) == account
    }

    private fun nextAccount(runner: JsonObject, health: JsonObject, nowMs: Long) =
        EngineAccounts.toStartOn(health.list("accounts"), EngineAccounts.usage(health.text("engine"), runner), nowMs)

    /** One account's own windows, all of them: Default's are the engine snapshot's, another's its entry under `accounts`. */
    fun accountWindows(runner: JsonObject, engine: String, account: String): List<UsageRow> =
        accountSnapshot(EngineAccounts.usage(engine, runner), account)?.let(::usageRows).orEmpty()

    /** Kimi only: [account]'s quota was read and its plan carries no limit — said as "No quota limit" where a read that
     * failed or never ran says "No quota reported" (web kimiNoQuotaLimit). Resolves the engine's usage exactly as
     * accountWindows does, but keeps a windowless snapshot rather than collapsing it (accountSnapshotReported). */
    fun accountNoQuotaLimit(runner: JsonObject, engine: String, account: String): Boolean =
        engine == "kimi" && kimiNoQuotaLimit(accountSnapshotReported(EngineAccounts.usage(engine, runner), account))

    /** CodexAccounts.label: what the user called it, else Default, or `Account <id>`. */
    fun accountLabel(id: String, accounts: List<JsonObject>): String =
        accounts.firstOrNull { it.str("id") == id }?.str("name")?.takeIf { it.isNotEmpty() } ?: if (id == "default") "Default" else "Account $id"

    /** One sign-in on the engine page. [auth] is none for an Antigravity Default on the machine's Gemini key ([envKey]),
     * which has nothing to sign in or pause; its line says what it runs on. [site]: Kimi only, the site its login is on —
     * the account's own, Default's being the engine's. */
    data class AccountLine(val id: String, val name: String, val home: String?, val auth: String?,
                           val signInAccount: String?, val pausedUntil: String?, val envKey: Boolean = false, val loginExpiresAt: String? = null,
                           val site: KimiSite? = null) {
        val isDefault get() = id == "default"
        /** Where its login lives — a Kimi account's after the site it is on (`kimi.com · ~/.orbit/kimi-accounts/5c2e91a0`) —
         * and, for a Default renamed in Orbit, that it is still the machine's own login. */
        val subtitle get() = listOfNotNull(site?.domain, home, "Default".takeIf { isDefault && name != "Default" })
            .takeIf { it.isNotEmpty() }?.joinToString(" · ")
    }

    /** Every account an engine is signed into, Default first; one line when it keeps no others, whose answer is the
     * engine's unless that is a Gemini key's rather than Default's Google sign-in (runsOnEnvKey). */
    fun accountLines(health: JsonObject): List<AccountLine> {
        val accounts = health.list("accounts")
        val kimi = health.str("engine") == "kimi"
        if (accounts.size < 2) {
            val own = accounts.firstOrNull()
            val envKey = runsOnEnvKey(health, EngineAccounts.DEFAULT, own?.str("auth"))
            return listOf(AccountLine("default", accountLabel("default", accounts), (own?.str("home") ?: own?.str("codexHome"))?.let(::tildePath),
                if (envKey) null else health.str("auth"), null, own?.str("pausedUntil"), envKey, own?.str("loginExpiresAt"),
                if (kimi) KimiSite.of(health.str("kimiRegion")) else null))
        }
        return accounts.map { account ->
            val envKey = runsOnEnvKey(health, account.text("id"), account.str("auth"))
            AccountLine(account.text("id"), accountLabel(account.text("id"), accounts), (account.str("home") ?: account.str("codexHome"))?.let(::tildePath),
                if (envKey) null else account.str("auth"), account.text("id"), account.str("pausedUntil"), envKey, account.str("loginExpiresAt"),
                if (kimi) KimiSite.of(account.str("kimiRegion")) else null)
        }
    }

    /** How far ahead of a login lapsing its line warns: Claude Code's own lead. */
    private const val LOGIN_WARNING_LEAD = 3 * DAY

    /** The warning under a signed-in account whose login lapses within three days, in whole days rounded up the way Claude
     * Code counts them. None further off, past it (the runner reports that signed out), not signed in, or with no time read. */
    fun loginExpiresLine(line: AccountLine, nowMs: Long): String? {
        if (line.auth != "yes") return null
        val left = (isoMs(line.loginExpiresAt) ?: return null) - nowMs
        if (left <= 0 || left > LOGIN_WARNING_LEAD) return null
        val days = kotlin.math.ceil(left.toDouble() / DAY).toInt()
        return AccountCopy.loginExpires(days, if (days == 1) AccountCopy.UNIT_DAY else AccountCopy.UNIT_DAYS)
    }

    /** What a signed-out account costs: nothing runs on it — or, the engine's only account there, on the engine at all. */
    fun signedOutNote(line: AccountLine, alone: Boolean, engine: String): String? {
        if (line.auth != "no") return null
        return if (alone) AccountCopy.signedOutAlone(engineName(engine)) else AccountCopy.ACCOUNT_SIGNED_OUT_NOTE
    }

    /** What Add Account calls a new account until the user names it. */
    fun defaultAccountName(accounts: List<JsonObject>): String {
        val taken = accounts.map { accountLabel(it.text("id"), accounts) }.toSet()
        var number = maxOf(accounts.size, 1) + 1
        while ("Account $number" in taken) number++
        return "Account $number"
    }

    /** What became of the last removal asked of this account: under way, or refused in the machine's words. */
    fun removal(state: JsonObject?, engine: String, account: String): Pair<Boolean, String?>? {
        if (state == null || state.str("engine") != engine || state.str("account") != account) return null
        return (state.str("status") == "pending") to (if (state.str("status") == "failed") state.str("message") else null)
    }

    fun engineUpdateInFlight(install: JsonObject?) = install?.str("mode") == "update" && install.str("status") in setOf("pending", "installing")

    fun updateRelayLine(install: JsonObject?): String? {
        if (install?.str("mode") != "update") return null
        return when (install.str("status")) {
            "pending" -> "Queued — the runner picks this up on its next check-in."
            "installing" -> "Updating this machine’s engine CLIs…"
            "done", "failed" -> install.str("message")?.trim()?.takeIf { it.isNotEmpty() } ?: "Nothing to update."
            else -> null
        }
    }

    // workspaces
    /** A path as a terminal spells it, with the machine's home directory as `~`. */
    fun tildePath(path: String): String {
        if (path == "/root" || path.startsWith("/root/")) return "~" + path.removePrefix("/root")
        for (parent in listOf("/home/", "/Users/")) if (path.startsWith(parent)) {
            val rest = path.removePrefix(parent)
            val user = rest.substringBefore('/')
            if (user.isNotEmpty()) return "~" + rest.removePrefix(user)
        }
        return path
    }

    fun workspaceLine(workspace: JsonObject) = listOfNotNull(workspace.str("workDir")?.trim()?.takeIf { it.isNotEmpty() }?.let(::tildePath),
        if (workspace.bool("enableWorktree") == true) RunnerCopy.WORKTREES else null).joinToString(RunnerCopy.SEP)

    fun runningCount(workspace: JsonObject, counts: List<JsonObject>) =
        counts.firstOrNull { ObjectId.same(it.text("workspaceId"), workspace.text("id")) }?.int("running") ?: 0

    // about
    /** `0.1.197 · Latest`; a runner behind that installs the release itself says so, and so does one a staged rollout holds
     * back. One that reports where its updates stand says which it is; an older one is judged by runsAsRoot, as before. */
    fun versionValue(runner: JsonObject, latest: String?): String? {
        val version = runner.str("version")?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val newest = latest?.trim()?.takeIf { it.isNotEmpty() } ?: return version
        if (compareRunnerVersions(version, newest) >= 0) return version + RunnerCopy.SEP + "Latest"
        val note = when (runner.obj("selfUpdate")?.str("state")) {
            null -> if (runner.bool("runsAsRoot") == true) "installs when no turn is running" else null
            "enabled", "waitingForIdle" -> "installs when no turn is running"
            "heldByRollout" -> "not rolled out to it yet"
            else -> null
        } ?: return version
        return "$version${RunnerCopy.SEP}$newest $note"
    }

    /** `Sep 20, 4:00 PM · 0.1.189 → 0.1.190`: when the runner last updated itself, in the reader's time zone, and between
     * which versions; none from a runner that doesn't report its updates, or hasn't updated itself yet. */
    fun lastUpdate(runner: JsonObject, zone: ZoneId = ZoneId.systemDefault()): String? {
        val report = runner.obj("selfUpdate") ?: return null
        val from = report.str("lastUpdatedFrom"); val to = report.str("lastUpdatedTo")
        val versions = if (from != null && to != null) "$from → $to" else to
        return listOfNotNull(report.str("lastUpdatedAt")?.let { lastSeen(it, zone) }, versions).takeIf { it.isNotEmpty() }?.joinToString(RunnerCopy.SEP)
    }

    fun runsAsValue(runner: JsonObject) = when (runner.bool("runsAsRoot")) { true -> "root"; false -> "regular user"; null -> null }

    fun lastCheckIn(runner: JsonObject, nowMs: Long) = runner.str("lastHeartbeatAt")?.takeIf { it.isNotEmpty() }
        ?.let { ago(it, nowMs).replaceFirstChar { c -> c.uppercase() } }

    fun registered(runner: JsonObject, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()) = runner.str("enrolledAt")?.let { day(it, nowMs, zone) }

    // times, in the reader's own time zone; the words are English, so the dates are too
    private fun format(pattern: String, ms: Long, zone: ZoneId) =
        DateTimeFormatter.ofPattern(pattern, Locale.US).withZone(zone).format(Instant.ofEpochMilli(ms))
    private fun sameDay(a: Long, b: Long, zone: ZoneId) = Instant.ofEpochMilli(a).atZone(zone).toLocalDate() == Instant.ofEpochMilli(b).atZone(zone).toLocalDate()
    private fun sameYear(a: Long, b: Long, zone: ZoneId) = Instant.ofEpochMilli(a).atZone(zone).year == Instant.ofEpochMilli(b).atZone(zone).year

    /** `10:59 AM` today, `Thu, Oct 2 at 11:59 AM` on another day. */
    fun resetsWhen(iso: String, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): String? {
        val at = isoMs(iso) ?: return null
        val time = format("h:mm a", at, zone)
        return if (sameDay(at, nowMs, zone)) time else "${format("EEE, MMM d", at, zone)} at $time"
    }
    fun resetsLine(row: UsageRow, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()) =
        row.window.str("resetsAt")?.let { resetsWhen(it, nowMs, zone) }?.let { "Resets $it" }
    /** `Sep 14, 10:25 PM`. */
    fun lastSeen(iso: String, zone: ZoneId = ZoneId.systemDefault()) = isoMs(iso)?.let { format("MMM d, h:mm a", it, zone) }
    /** `Sep 13`, with its year when it isn't this one. */
    fun day(iso: String, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): String? {
        val at = isoMs(iso) ?: return null
        return format(if (sameYear(at, nowMs, zone)) "MMM d" else "MMM d, yyyy", at, zone)
    }

    // Add Runner
    /** The instance's origin, which install.sh and the runner binaries are served from. */
    fun origin(server: String): String = runCatching {
        val uri = java.net.URI(server)
        "${uri.scheme}://${uri.host}${if (uri.port != -1) ":${uri.port}" else ""}"
    }.getOrNull()?.takeIf { !it.contains("null") } ?: server.trimEnd('/')

    fun installCommand(platform: String, origin: String) =
        if (platform == "Windows") RunnerCopy.installCommandWindows(origin) else RunnerCopy.installCommandUnix(origin)

    /** The first runner online now that wasn't when the wait began. */
    fun newlyOnline(runners: List<JsonObject>, baseline: Set<String>) = runners.firstOrNull { it.bool("online") == true && it.text("id") !in baseline }

    /** The code `orbit register` printed, as the server spells it, once all ten characters are in. */
    fun deviceCode(typed: String): String? {
        val characters = typed.uppercase().filter { it.isLetterOrDigit() }
        if (characters.length != 10 || characters.any { it.code > 127 }) return null
        return "${characters.take(5)}-${characters.takeLast(5)}"
    }

    /** AccountPause.minutes: 1 minute to 168 hours, in whole minutes. */
    fun pauseMinutes(hours: String): Int? {
        val value = hours.trim().toDoubleOrNull()?.takeIf { it.isFinite() && it > 0 && it <= 168 } ?: return null
        val minutes = value * 60
        if (minutes < 1 || kotlin.math.abs(Math.round(minutes) - minutes) >= 0.000001) return null
        return Math.round(minutes).toInt()
    }

    fun isPaused(until: String?, nowMs: Long) = isoMs(until)?.let { it > nowMs } == true
}

/** PlanUsage.snapshot(for:): an engine's own quota, nested or a legacy flat one; never another engine's. A flat payload keeps
 * its `accounts`: its own windows are Default's, every other account's snapshot sits beside them (web planUsageSnapshotForProvider). */
internal fun planUsageSnapshot(usage: JsonObject?, provider: String): JsonObject? {
    usage ?: return null
    val flat = JsonObject(usage.filterKeys { it !in setOf("claude", "codex", "kimi") })
    return when (provider) {
        "codex" -> usage.obj("codex") ?: flat.takeIf { it.str("provider") == "codex" || it.obj("primary") != null || it.obj("secondary") != null || it.list("rateLimits").isNotEmpty() }
        "kimi" -> usage.obj("kimi") ?: flat.takeIf { it.str("provider") == "kimi" }
        "claude" -> usage.obj("claude") ?: flat.takeIf { it.str("provider") == null || it.str("provider") == "claude" }
        else -> null
    }
}

/** CodexAccounts.snapshot: Default's windows are the snapshot's own, another account's its entry under `accounts`. */
internal fun accountSnapshot(usage: JsonObject?, account: String): JsonObject? {
    usage ?: return null
    if (account != "default") return usage.obj("accounts")?.obj(account)
    if (usage["accounts"] == null) return usage
    val own = JsonObject(usage - "accounts")
    return own.takeIf { EngineAccounts.windows(it).isNotEmpty() }
}

/** accountSnapshot with the web codexAccountSnapshot's presence rather than its windows: whether the runner reported
 * anything for this account at all. Default counts once the snapshot carries more than its `provider` — a windowless
 * but read Default still has fetchedAt, which accountSnapshot collapses to null, and kimiNoQuotaLimit must tell that
 * from a read never made or failed; any other account counts by its entry under `accounts`, as there. */
internal fun accountSnapshotReported(usage: JsonObject?, account: String): JsonObject? {
    usage ?: return null
    if (account != "default") return usage.obj("accounts")?.obj(account)
    if (usage["accounts"] == null) return usage
    val own = JsonObject(usage - "accounts")
    return own.takeIf { reported -> reported.keys.any { it != "provider" } }
}

/** Web kimiNoQuotaLimit (planUsage.ts): a Kimi login whose plan carries no quota limit — its quota was read and the
 * answer held no window at all. The coding share of the month (monthCode) counts though it is never drawn: a plan
 * that reports it has a limit. */
internal fun kimiNoQuotaLimit(snapshot: JsonObject?): Boolean =
    snapshot != null && snapshot.str("provider") == "kimi" && EngineAccounts.windows(snapshot).isEmpty()

/** `usageRows` as they stand at [nowMs]: a window whose reset has passed reads as the fresh window it now is — nothing used,
 * no reset to name. An Antigravity bucket stays as agy read it. */
internal fun currentUsageRows(snapshot: JsonObject, nowMs: Long): List<UsageRow> = usageRows(snapshot).map { row ->
    val resets = isoMs(row.window.str("resetsAt"))
    if (row.remaining || resets == null || resets > nowMs) row
    else row.copy(window = buildJsonObject {
        put("utilization", 0); row.window.str("label")?.let { put("label", it) }; row.window.int("windowDurationMins")?.let { put("windowDurationMins", it) }
    })
}

/** PlanUsageSnapshot.bindingRow: the window that stops this login, or will stop it first — a spent one before any other (of
 * several, the one that resets last), else the one closest to its limit, a tie going to the first. */
internal fun bindingRow(snapshot: JsonObject, nowMs: Long): UsageRow? {
    val current = currentUsageRows(snapshot, nowMs)
    val spent = current.filter { it.utilization >= 100 }
    // A spent window with no reset named holds the login for as long as anyone can tell.
    fun reset(row: UsageRow) = isoMs(row.window.str("resetsAt")) ?: Long.MAX_VALUE
    if (spent.isNotEmpty()) return spent.drop(1).fold(spent.first()) { latest, row -> if (reset(row) > reset(latest)) row else latest }
    return current.drop(1).fold(current.firstOrNull()) { tightest, row -> if (tightest == null || row.utilization > tightest.utilization) row else tightest }
}

private fun codexWindowLabel(window: JsonObject, secondary: Boolean): String {
    window.int("windowDurationMins")?.let { minutes ->
        fun near(expected: Int) = minutes >= expected * 0.95 && minutes <= expected * 1.05
        when {
            near(5 * 60) -> return "5h limit"
            near(24 * 60) -> return "Daily limit"
            near(7 * 24 * 60) -> return "Weekly limit"
            near(30 * 24 * 60) -> return "Monthly limit"
            near(365 * 24 * 60) -> return "Annual limit"
        }
    }
    if (window.str("label") == "5-hour limit") return "5h limit"
    return window.str("label") ?: if (secondary) "Secondary usage limit" else "Usage limit"
}

/** PlanUsageSnapshot.rows: present windows in provider order, every Codex rate-limit bucket kept, each Antigravity bucket
 * by what it has left ("Weekly" / "5-hour", grouped by the bucket's id), and Kimi Code's in the words of its own /usage
 * panel — the month as one row, its total: the coding share of it (`monthCode`) is not a row of its own. */
internal fun usageRows(snapshot: JsonObject): List<UsageRow> {
    if (snapshot.str("provider") == "antigravity") return snapshot.list("buckets").map { bucket ->
        val window = bucket.text("window")
        val label = when (window) { "weekly" -> "Weekly"; "5h" -> "5-hour"; else -> window }
        UsageRow(bucket.text("id"), label, bucket.text("id"), buildJsonObject {
            put("utilization", (1 - (bucket.dbl("remainingFraction") ?: 0.0)) * 100); bucket.str("resetTime")?.let { put("resetsAt", it) }
        }, remaining = true)
    }
    val limits = snapshot.list("rateLimits")
    val codex = snapshot.str("provider") == "codex" || snapshot.obj("primary") != null || snapshot.obj("secondary") != null || limits.isNotEmpty()
    if (codex) {
        val buckets = (limits.ifEmpty {
            listOf(buildJsonObject {
                put("limitId", snapshot.str("limitId") ?: "codex"); snapshot.str("limitName")?.let { put("limitName", it) }
                snapshot.obj("primary")?.let { put("primary", it) }; snapshot.obj("secondary")?.let { put("secondary", it) }
            })
        }).sortedBy { it.str("limitId") ?: "codex" }
        return buckets.flatMapIndexed { bucketIndex, bucket ->
            val windows = listOfNotNull(bucket.obj("primary")?.let { Triple("primary", false, it) }, bucket.obj("secondary")?.let { Triple("secondary", true, it) })
            val bucketLabel = bucket.str("limitName") ?: bucket.str("limitId") ?: "codex"
            val prefixed = !bucketLabel.equals("codex", ignoreCase = true)
            windows.mapIndexed { windowIndex, (field, secondary, window) ->
                val base = codexWindowLabel(window, secondary)
                UsageRow("${bucket.str("limitId") ?: bucketLabel}-$bucketIndex-$field",
                    if (prefixed && windows.size == 1) "$bucketLabel $base" else base,
                    if (prefixed && windows.size > 1 && windowIndex == 0) "$bucketLabel limit" else null, window)
            }
        }
    }
    val named = if (snapshot.str("provider") == "kimi") listOf("fiveHour" to "5h limit", "sevenDay" to "Weekly limit", "month" to "Monthly limit")
        else listOf("fiveHour" to "5-hour limit", "sevenDay" to "Weekly · all models", "sevenDayOpus" to "Weekly · Opus", "sevenDaySonnet" to "Weekly · Sonnet")
    return named.mapNotNull { (key, label) -> snapshot.obj(key)?.let { UsageRow(key, it.str("label") ?: label, null, it) } }
}
