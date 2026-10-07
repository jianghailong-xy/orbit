package io.orbitd.android.management

import io.orbitd.android.core.net.ApiError
import io.orbitd.android.navigation.ObjectId
import kotlinx.serialization.json.*
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * The Providers page's rules and words: a port of OrbitKit ProvidersOverview, ProviderPools, SharedPoolPage,
 * CodexLoginPool, SharedPools (adapter), CodexPoolPage, WhoCanUseIt, SharePool, JustMine, AddPoolKey and
 * CodexSignIn. Pure, so PoolLogicTest pins it to the iOS wording and gates.
 */
internal fun providerObjects(element: JsonElement): List<JsonObject> =
    (element as? JsonArray)?.filterIsInstance<JsonObject>() ?: error("The server returned an unreadable list.")

internal data class PoolStatus(val label: String, val tone: String) // success · brand · warning · danger · neutral

internal data class PoolMember(val id: String, val label: String, val state: String, val next: Boolean, val pausedUntil: String?,
                               val resetsAt: String?, val planUsage: JsonObject?, val enabled: Boolean = true,
                               val login: JsonObject? = null, val key: JsonObject? = null)

internal data class Pool(val id: String, val slug: String, val label: String, val engine: String, val members: List<PoolMember>,
                         val unavailable: String?, val resetsAt: String?, val shared: JsonObject? = null,
                         val logins: List<JsonObject>? = null, val login: JsonObject? = null)

private fun paused(until: String?, nowMs: Long) = RunnerPage.isPaused(until, nowMs)
private fun earliest(resets: List<String>) = resets.minByOrNull { isoMs(it) ?: Long.MAX_VALUE }
private fun JsonObject.objects(name: String) = (this[name] as? JsonArray)?.filterIsInstance<JsonObject>().orEmpty()

internal object CodexLogins {
    const val notSignedIn = "Not signed in"
    const val signedOutWords = "Signed out"
    const val noQuota = "No quota reported"
    const val signedOutReason = "OpenAI signed this account out — sign in again to put it back in the pool."
    fun signedOutReasonNotYours(contributor: String?) =
        "OpenAI signed this account out — only ${contributor ?: "the person who signed it in"} can sign it in again."
    const val noAccount = "No account yet — no session can start on this pool until you sign in with ChatGPT."
    const val noAccountOwner = "No account yet — no session can start on this pool until its owner signs in with ChatGPT."

    fun active(login: JsonObject) = login.str("state") == "ACTIVE"
    fun name(login: JsonObject) = login.str("email") ?: "ChatGPT account"
    fun isLoginPool(pool: Pool) = pool.engine == "codex" && pool.shared?.bool("shared") != true
    fun logins(pool: Pool) = pool.logins ?: listOfNotNull(pool.login)

    /** Spent: a window at 100% not yet past its reset. Null when it isn't spent; `until` may itself be unknown. */
    data class Spent(val until: String?)
    fun spentUntil(login: JsonObject, nowMs: Long): Spent? {
        val rows = login.obj("usage")?.let(::usageRows) ?: return null
        val spent = rows.filter { it.utilization >= 100 }
        if (spent.isEmpty()) return null
        val latest = spent.mapNotNull { row -> row.window.str("resetsAt")?.let { iso -> isoMs(iso)?.let { iso to it } } }.maxByOrNull { it.second }
        if (latest != null && latest.second <= nowMs) return null
        return Spent(latest?.first)
    }
    fun state(login: JsonObject, nowMs: Long) = when {
        !active(login) -> "SIGNED_OUT"
        spentUntil(login, nowMs) == null -> "AVAILABLE"
        else -> "SPENT"
    }
    fun line(login: JsonObject, contributor: String? = null): String {
        val plan = login.str("plan")?.takeIf { it.isNotEmpty() }?.replaceFirstChar { it.uppercase() }?.let { "ChatGPT $it" } ?: "ChatGPT"
        return "${contributor?.let { "$it · " }.orEmpty()}$plan · ${login.text("fingerprint")}"
    }
    fun windows(login: JsonObject) = login.obj("usage")?.let(::usageRows).orEmpty()
    fun resets(row: UsageRow, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()) =
        row.window.str("resetsAt")?.let { ProviderPools.formatResetTime(it, nowMs, zone) }?.let { "resets $it" }
    fun showsNext(member: PoolMember, pool: Pool) = member.next && pool.members.size > 1
    fun signOutTitle(login: JsonObject) = "Sign out ${name(login)}?"
    fun signOutNote(pool: Pool): String {
        val others = pool.members.size - 1
        if (others <= 0) return "Its sign-in is deleted from the Orbit server, and no session runs on this pool until you sign in again."
        return "Its sign-in is deleted from the Orbit server, and no session runs on it until you sign in again — " +
            "${pool.label} keeps running on its other account${if (others == 1) "" else "s"}."
    }
    fun signedOut(login: JsonObject) = "${name(login)} is signed out"

    fun member(login: JsonObject, first: Boolean, nowMs: Long): PoolMember {
        val state = state(login, nowMs)
        return PoolMember("login:${login.text("fingerprint")}", name(login), state,
            next = first && state == "AVAILABLE" && !paused(login.str("pausedUntil"), nowMs), pausedUntil = login.str("pausedUntil"),
            resetsAt = if (state == "SPENT") spentUntil(login, nowMs)?.until else null, planUsage = login.obj("usage"), login = login)
    }
}

internal object PoolPage { // SharedPoolPage
    const val allAtCapWords = "All at cap"
    const val allOutOfBudgetWords = "All out of budget"
    const val noKeys = "No keys yet — no session can start on this pool until one is added."
    const val removeKeyNote = "It is deleted from the Orbit server, and no session runs on it again."
    const val removePersonNote = "Their keys leave with them."

    fun people(pool: JsonObject) = pool.objects("people")
    fun keys(pool: JsonObject) = pool.objects("keys")
    fun contributor(key: JsonObject) = key.obj("contributor") ?: JsonObject(emptyMap())
    fun keyLine(key: JsonObject) = "${contributor(key).text("name")} · ${key.text("fingerprint")}"
    fun keyState(key: JsonObject) = when {
        key.str("state") == "INVALID" -> "invalid"
        key.bool("enabled") != true || key.str("state") == "DISABLED" -> "disabled"
        key.str("spentUntil") != null || atCap(key) -> "spent"
        key.bool("running") == true -> "running"
        else -> "available"
    }
    fun status(key: JsonObject, pool: JsonObject): PoolStatus = when (keyState(key)) {
        "invalid" -> PoolStatus("Invalid", "danger")
        "disabled" -> PoolStatus("Disabled", "neutral")
        "spent" -> key.str("spentUntil")?.let { until -> capReset(until)?.let { PoolStatus("Out of budget · resets $it", "warning") } ?: PoolStatus("Out of budget", "warning") }
            ?: pool.obj("window")?.str("end")?.let(::capReset)?.let { PoolStatus("At cap · resets $it", "warning") } ?: PoolStatus("At cap", "warning")
        "running" -> PoolStatus("Running now", "brand")
        else -> PoolStatus("Available", "success")
    }
    fun invalidReason(key: JsonObject, pool: JsonObject): String? {
        if (key.str("state") != "INVALID") return null
        return if (canReplace(key, pool)) "Rejected by OpenAI — replace it with a working key to put it back in the pool."
        else "Rejected by OpenAI — only ${contributor(key).text("name")} or the pool’s admins can replace it."
    }
    fun othersCost(key: JsonObject) = key.obj("usage")?.dbl("othersCostUsd") ?: 0.0
    fun atCap(key: JsonObject): Boolean {
        if (contributor(key).bool("you") == true) return false
        val cap = key.int("shareCap") ?: return false
        return othersCost(key) >= cap
    }
    fun allOutOfBudget(pool: JsonObject): Boolean {
        val stopped = keys(pool).filter { keyState(it) == "spent" }
        return stopped.isNotEmpty() && stopped.all { it.str("spentUntil") != null }
    }
    fun money(key: JsonObject): String {
        val spent = String.format(Locale.US, "$%.2f", othersCost(key))
        return key.int("shareCap")?.let { "$spent of $$it" } ?: spent
    }
    fun capPercent(key: JsonObject): Int? {
        val cap = key.int("shareCap") ?: return null
        if (cap <= 0) return 100
        return Math.round(othersCost(key) / cap * 100).toInt().coerceIn(0, 100)
    }
    fun personLine(person: JsonObject): String {
        val keys = person.int("keys") ?: 0
        return "${if (keys == 0) "No key" else plural(keys, "key")} · ${plural(person.int("sessions") ?: 0, "session")}"
    }
    fun share(person: JsonObject, pool: JsonObject): Int {
        val total = people(pool).sumOf { it.obj("usage")?.dbl("costUsd") ?: 0.0 }
        if (total <= 0) return 0
        return Math.round((person.obj("usage")?.dbl("costUsd") ?: 0.0) / total * 100).toInt().coerceIn(0, 100)
    }
    fun owner(pool: JsonObject) = people(pool).firstOrNull { it.bool("creator") == true }
    fun ownsPool(pool: JsonObject) = people(pool).any { it.bool("you") == true && it.bool("creator") == true }
    fun hasPeople(pool: JsonObject) = people(pool).size > 1
    fun isAdmin(pool: JsonObject) = pool.str("viewerRole") == "ADMIN"
    fun canAddKey(pool: JsonObject) = isAdmin(pool) || pool.bool("membersCanAdd") == true
    fun canAddAccount(pool: JsonObject) = isAdmin(pool) || pool.bool("membersCanAddAccounts") == true
    fun viewerId(pool: JsonObject) = people(pool).firstOrNull { it.bool("you") == true }?.str("userId")
    fun signedIn(login: JsonObject, pool: JsonObject): Boolean {
        val viewer = viewerId(pool) ?: return false
        val userId = login.str("userId") ?: return false
        return ObjectId.same(viewer, userId)
    }
    fun canSignOut(login: JsonObject, pool: JsonObject) = signedIn(login, pool) || isAdmin(pool)
    fun canSignInAgain(login: JsonObject, pool: JsonObject) = signedIn(login, pool)
    fun canRemove(key: JsonObject, pool: JsonObject) = contributor(key).bool("you") == true || isAdmin(pool)
    fun canReplace(key: JsonObject, pool: JsonObject) = canRemove(key, pool)
    fun canSwitch(key: JsonObject) = contributor(key).bool("you") == true
    private val avatarPalette = listOf(0xFF3370FF, 0xFF16A34A, 0xFFDB2777, 0xFFEA580C, 0xFF7C3AED, 0xFF0D9488, 0xFFCA8A04, 0xFF475569)
    fun avatarColor(userId: String, pool: JsonObject): Long {
        val at = people(pool).indexOfFirst { ObjectId.same(it.str("userId"), userId) }.takeIf { it >= 0 } ?: people(pool).size
        return avatarPalette[at % avatarPalette.size]
    }
    fun initial(name: String) = name.trim().firstOrNull()?.uppercase() ?: "?"
    /** A month's reset, as a day in UTC: `Nov 1`. */
    fun capReset(iso: String): String? = isoMs(iso)?.let { DateTimeFormatter.ofPattern("MMM d", Locale.US).withZone(ZoneOffset.UTC).format(Instant.ofEpochMilli(it)) }
    fun plural(n: Int, one: String, many: String? = null) = "$n ${if (n == 1) one else many ?: "${one}s"}"
    fun listOf(items: List<String>): String = if (items.size > 1) "${items.dropLast(1).joinToString(", ")} and ${items.last()}" else items.firstOrNull().orEmpty()

    fun keyWindow(key: JsonObject, pool: JsonObject): JsonObject? {
        val percent = capPercent(key) ?: return null
        return buildJsonObject {
            put("provider", "codex")
            put("primary", buildJsonObject {
                put("utilization", percent); pool.obj("window")?.str("end")?.let { put("resetsAt", it) }; put("windowDurationMins", 30 * 24 * 60)
            })
        }
    }
    private fun memberState(state: String) = when (state) { "invalid" -> "REFUSED"; "disabled" -> "DISABLED"; "spent" -> "SPENT"; "running" -> "RUNNING"; else -> "AVAILABLE" }
    fun keyMembers(pool: JsonObject, nowMs: Long): List<PoolMember> {
        val keys = keys(pool).let { all -> if (pool.bool("ownKeyFirst") == true) all.filter { contributor(it).bool("you") == true } + all.filter { contributor(it).bool("you") != true } else all }
        return keys.map { key ->
            val state = keyState(key)
            PoolMember(key.text("id"), key.text("label"), memberState(state), next = key.bool("next") == true && !paused(key.str("pausedUntil"), nowMs),
                pausedUntil = key.str("pausedUntil"), resetsAt = if (state == "spent") key.str("spentUntil") ?: pool.obj("window")?.str("end") else null,
                planUsage = keyWindow(key, pool), enabled = key.bool("enabled") == true, key = key)
        }
    }
}

internal object ProviderPools {
    const val accountsFooter = "Each session starts on the account whose quota resets soonest, so none of it goes unused, and stays on it until that one runs out."
    const val noLimit = "No limit"

    /** A Codex pool of one's own: each ChatGPT account it holds is one of its members. */
    fun own(json: JsonObject, nowMs: Long): Pool {
        val id = json.text("id"); val slug = json.text("slug"); val label = json.str("label") ?: slug
        val engine = json.str("engine") ?: "claude"
        val logins = (json["logins"] as? JsonArray)?.filterIsInstance<JsonObject>()
        val login = json.obj("login")
        if (engine == "codex") {
            val all = logins ?: listOfNotNull(login)
            if (all.isEmpty()) return Pool(id, slug, label, engine, emptyList(), CodexLogins.notSignedIn, null, logins = logins, login = login)
            val members = all.mapIndexed { index, it -> CodexLogins.member(it, index == 0, nowMs) }
            return Pool(id, slug, label, engine, members, if (members[0].state == "SIGNED_OUT") CodexLogins.signedOutWords else null,
                earliest(members.mapNotNull { it.resetsAt }), logins = logins, login = login)
        }
        val members = json.objects("members").map { member ->
            PoolMember(member.text("id"), member.text("label"), member.str("state") ?: "UNKNOWN", member.bool("next") == true,
                member.str("pausedUntil"), member.str("resetsAt"), member.obj("planUsage"), member.bool("enabled") ?: true)
        }
        return Pool(id, slug, label, engine, members, json.str("unavailable")?.takeIf { it.isNotEmpty() }, json.str("resetsAt"))
    }

    /** SharedPools.asProviderPool: a pool read from GET /providers/shared-pools. */
    fun shared(pool: JsonObject, nowMs: Long): Pool {
        val logins = pool.objects("logins")
        val members = logins.map { login ->
            val state = CodexLogins.state(login, nowMs)
            PoolMember("login:${login.text("fingerprint")}", CodexLogins.name(login), state,
                next = login.bool("next") == true && !paused(login.str("pausedUntil"), nowMs), pausedUntil = login.str("pausedUntil"),
                resetsAt = if (state == "SPENT") CodexLogins.spentUntil(login, nowMs)?.until else null, planUsage = login.obj("usage"), login = login)
        } + PoolPage.keyMembers(pool, nowMs)
        val free = members.any { !paused(it.pausedUntil, nowMs) && it.state in setOf("AVAILABLE", "RUNNING") }
        val revives = logins.any { it.str("state") != "SIGNED_OUT" } || PoolPage.keys(pool).any { it.bool("enabled") == true && it.str("state") == "ACTIVE" }
        val stops = members.filter { it.state == "SPENT" }.mapNotNull { it.resetsAt }
        return Pool(pool.text("id"), pool.text("slug"), pool.text("label"), pool.str("engine") ?: "codex", members,
            when { revives -> null; logins.isNotEmpty() -> CodexLogins.signedOutWords
                PoolPage.keys(pool).isEmpty() -> if (pool.bool("shared") == true) "No keys" else CodexLogins.notSignedIn; else -> "No key can run" },
            if (free || stops.isEmpty()) null else earliest(stops), shared = pool)
    }

    /** SharedPools.ownPoolWithAccess: one's own Codex pool, its people and keys read beside its accounts. */
    fun withAccess(own: Pool, access: JsonObject, nowMs: Long): Pool {
        val accounts = own.members
        val anyPaused = accounts.any { paused(it.pausedUntil, nowMs) }
        val serverNext = access.objects("logins").firstOrNull { it.bool("next") == true }
        val nextAccount = if (anyPaused) accounts.firstOrNull { it.login?.str("fingerprint") == serverNext?.str("fingerprint") && !paused(it.pausedUntil, nowMs) }
            else accounts.firstOrNull { it.next } ?: accounts.firstOrNull { it.state == "AVAILABLE" }
        val members = accounts.map { it.copy(next = it.id == nextAccount?.id) } +
            PoolPage.keyMembers(access, nowMs).map { if (nextAccount == null) it else it.copy(next = false) }
        val working = members.any { !paused(it.pausedUntil, nowMs) && it.state in setOf("AVAILABLE", "RUNNING") }
        val stops = members.filter { it.state == "SPENT" }.mapNotNull { it.resetsAt }
        val revives = accounts.any { it.state != "SIGNED_OUT" } || PoolPage.keys(access).any { it.bool("enabled") == true && it.str("state") == "ACTIVE" }
        return own.copy(members = members, shared = access, resetsAt = if (!working && stops.isNotEmpty()) earliest(stops) else null,
            unavailable = when { revives -> null; accounts.isNotEmpty() -> CodexLogins.signedOutWords
                PoolPage.keys(access).isNotEmpty() -> "No key can run"; else -> CodexLogins.notSignedIn })
    }

    fun runsCodex(pool: Pool) = pool.shared != null || pool.engine == "codex"
    fun readByMember(pool: Pool) = pool.shared?.let { !PoolPage.ownsPool(it) } ?: false
    private fun keysOnly(pool: Pool) = pool.shared != null && pool.members.none { it.login != null }
    fun readyCount(pool: Pool, nowMs: Long) = pool.members.count {
        !paused(it.pausedUntil, nowMs) && it.state in setOf("AVAILABLE", "RUNNING", "NO_QUOTA", "USAGE_UNKNOWN")
    }
    fun memberNoun(pool: Pool, n: Int): String {
        val s = if (n == 1) "" else "s"
        if (!readByMember(pool)) return "account$s"
        val accounts = pool.members.any { it.login != null }
        val keys = pool.members.any { it.key != null }
        if (accounts && keys) return "account$s and key$s you can run on"
        return (if (keys) "key$s" else "account$s") + " you can run on"
    }
    fun availability(pool: Pool, nowMs: Long) = "${readyCount(pool, nowMs)} of ${pool.members.size} ${memberNoun(pool, pool.members.size)} available"

    private fun spentHead(pool: Pool): String {
        val shared = pool.shared
        if (!keysOnly(pool) || shared == null) return "All spent"
        return if (PoolPage.allOutOfBudget(shared)) PoolPage.allOutOfBudgetWords else PoolPage.allAtCapWords
    }
    fun spentNote(pool: Pool, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): String? {
        if (pool.members.any { it.next } || pool.unavailable != null || pool.members.none { it.state == "SPENT" }) return null
        val resetsAt = pool.resetsAt ?: return spentHead(pool)
        if (keysOnly(pool)) return PoolPage.capReset(resetsAt)?.let { "${spentHead(pool)} · resets $it" } ?: spentHead(pool)
        return formatResetTime(resetsAt, nowMs, zone)?.let { "${spentHead(pool)} · resets $it" } ?: spentHead(pool)
    }
    fun headline(pool: Pool, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): String {
        pool.members.firstOrNull { it.next && !paused(it.pausedUntil, nowMs) }?.let { next ->
            if (pool.shared?.let(PoolPage::hasPeople) == true) return "Next for you: ${next.label}"
            return if (next.login != null && pool.members.size == 1) next.label else "Next: ${next.label}"
        }
        pool.unavailable?.let { return it }
        val pausedCount = pool.members.count { paused(it.pausedUntil, nowMs) }
        if (pausedCount > 0) return "$pausedCount paused"
        if (pool.members.any { it.state == "SPENT" }) return spentNote(pool, nowMs, zone) ?: "All spent"
        return if (keysOnly(pool)) "No key can run" else "No account can run"
    }
    fun memberStatus(member: PoolMember, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): PoolStatus = when (member.state) {
        "RUNNING" -> PoolStatus("Running now", "brand")
        "AVAILABLE" -> PoolStatus("Available", "success")
        "SPENT" -> member.resetsAt?.let { formatResetTime(it, nowMs, zone) }?.let { PoolStatus("Spent · resets $it", "warning") } ?: PoolStatus("Spent", "warning")
        "REFUSED" -> PoolStatus("Unavailable · key refused", "danger")
        "SIGNED_OUT" -> PoolStatus("Signed out", "danger")
        "USAGE_UNKNOWN" -> PoolStatus("Unavailable · usage unreadable", "neutral")
        "DISABLED" -> PoolStatus("Disabled", "neutral")
        else -> PoolStatus("No quota reported", "neutral")
    }
    fun memberQuota(member: PoolMember): UsageRow? {
        val rows = member.planUsage?.let(::usageRows).orEmpty().ifEmpty { return null }
        if (member.state == "SPENT") rows.firstOrNull { it.utilization >= 100 }?.let { return it }
        return rows.reduce { tightest, row -> if (row.utilization > tightest.utilization) row else tightest }
    }
    fun headGauge(pool: Pool): PoolStatus? {
        val next = pool.members.firstOrNull { it.next } ?: return null
        val quota = memberQuota(next) ?: return PoolStatus(if (next.key != null) noLimit else CodexLogins.noQuota, "neutral")
        return PoolStatus(quotaReading(quota), if (quota.nearLimit) "warning" else "neutral")
    }
    fun compactWindowLabel(label: String): String {
        var short = if (label.endsWith(" limit")) label.removeSuffix(" limit") else label
        if (short == "5-hour") short = "5h"
        if (short.endsWith(" · all models")) short = short.removeSuffix(" · all models")
        return short.replace(" · ", " ")
    }
    fun quotaReading(row: UsageRow) = "${compactWindowLabel(row.label)} ${row.percent}%"
    /** `14:30` within a day, `Thu 14:30` beyond it. */
    fun formatResetTime(iso: String, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): String? {
        val at = isoMs(iso) ?: return null
        val pattern = if (at - nowMs < 24 * 60 * 60 * 1000L) "HH:mm" else "EEE HH:mm"
        return DateTimeFormatter.ofPattern(pattern, Locale.US).withZone(zone).format(Instant.ofEpochMilli(at))
    }

    // ProvidersOverview
    fun runnerSummary(runner: JsonObject): String {
        val engines = runner["engines"] as? JsonArray ?: return "Engines not reported"
        val ready = RunnerPage.loginEngines.count { engine -> engines.filterIsInstance<JsonObject>().any { it.str("engine") == engine && it.str("auth") == "yes" } }
        val line = if (ready == RunnerPage.loginEngines.size) "All signed in" else "$ready of ${RunnerPage.loginEngines.size} signed in"
        return if (runner.bool("online") == true) line else "Offline · $line"
    }
    fun poolSummary(pool: Pool, nowMs: Long) = pool.unavailable ?: "${readyCount(pool, nowMs)} of ${pool.members.size} available"
    fun isShared(pool: Pool) = pool.shared?.let(PoolPage::hasPeople) ?: false
    fun codexPoolLine(pool: Pool, nowMs: Long): String {
        if (readByMember(pool)) {
            val owner = pool.shared?.let(PoolPage::owner)?.text("name").orEmpty()
            return "${CodexPoolView.whose(owner)} · ${pool.members.size} ${memberNoun(pool, pool.members.size)}"
        }
        if (isShared(pool)) return availability(pool, nowMs)
        return "${CodexPoolView.justMe} · ${availability(pool, nowMs)}"
    }
    fun codexPoolValue(pool: Pool, nowMs: Long): PoolStatus? =
        if (readByMember(pool)) null else headGauge(pool) ?: PoolStatus(headline(pool, nowMs), "neutral")
}

/** CodexPoolPage: what a Codex pool's page says and offers, for its owner or for one of its people. */
internal class CodexPoolView(val own: Pool?, val access: JsonObject?, nowMs: Long) {
    val pool: Pool = own?.let { o -> access?.let { ProviderPools.withAccess(o, it, nowMs) } ?: o }
        ?: access?.let { ProviderPools.shared(it, nowMs) } ?: error("A Codex pool needs its own row or its access")
    val mine = access?.let(PoolPage::ownsPool) ?: true
    val people = access?.let(PoolPage::hasPeople) ?: false
    val logins: List<JsonObject> = own?.let(CodexLogins::logins) ?: access?.objects("logins").orEmpty()
    val accounts: Int? = if (pool.engine == "codex") logins.size else null
    val owner = access?.let(PoolPage::owner)
    val who = when { !mine -> whose(owner?.text("name").orEmpty()); access != null && people -> "Me and ${PoolPage.plural(PoolPage.people(access).size - 1, "person", "people")}"; else -> justMe }
    fun subtitleRest(nowMs: Long) = (if (mine) "" else " · " + PoolPage.plural(access?.let { PoolPage.people(it).size } ?: 0, "person", "people")) +
        " · ${ProviderPools.availability(pool, nowMs)}"
    private val how = when {
        !mine -> if ((accounts ?: 0) > 0) "each session starts on its ChatGPT accounts; the API keys when none of them can run."
            else "your sessions run on the API keys" + (if (access?.bool("ownKeyFirst") == true) ", your own first" else "") + "."
        own == null -> "each session starts on the key with the most room, and stays on it until that one runs out."
        people -> "each session starts on your ChatGPT accounts; the API keys when none of them can run."
        else -> "each session starts on the account whose quota resets soonest, and stays on it until that one runs out."
    }
    val howSentence = how.replaceFirstChar { it.uppercase() }
    val mayAddAccount = mine || (access?.let(PoolPage::canAddAccount) ?: false)
    val mayAddKey = mine || (access?.let(PoolPage::canAddKey) ?: false)
    /** choose · signIn · key, or null when this viewer can add nothing. */
    val adding: String? = when {
        !mayAddAccount && !mayAddKey -> null
        !mayAddAccount -> "key"
        !mine -> "choose"
        access == null -> "signIn"
        else -> "choose"
    }
    val addLabel = if (mayAddAccount) "Add account" else "Add a key"
    val accountsCount = if (mine) pool.members.size else null
    val tagged = mine && people
    val emptyNote: String? = when {
        pool.members.isNotEmpty() -> null
        !CodexLogins.isLoginPool(pool) -> PoolPage.noKeys
        mayAddAccount -> CodexLogins.noAccount
        else -> CodexLogins.noAccountOwner
    }
    val exitLabel = if (mine) "Delete pool" else "Leave pool"
    val exitConfirm = if (mine) "Delete" else "Leave"
    val exitTitle = if (mine) "Delete ${pool.label}?" else "Leave ${pool.label}?"
    val outNote: String = if (!mine) "Your keys leave with you." else {
        val keys = access?.let(PoolPage::keys).orEmpty()
        val gone = buildList {
            if (own != null && (logins.isNotEmpty() || keys.isEmpty())) add(if (logins.size == 1) "ChatGPT sign-in" else "ChatGPT sign-ins")
            if (own == null || keys.isNotEmpty()) add("API keys")
        }
        "Its ${gone.joinToString(" and ")} ${if (gone == listOf("ChatGPT sign-in")) "is" else "are"} deleted from the Orbit server" +
            if (people) ", and nobody can run on it." else " with it."
    }
    companion object {
        const val justMe = "Just me"
        fun whose(owner: String) = "$owner’s"
        data class Kind(val id: String, val title: String, val lead: String, val bold: String, val rest: String)
        fun kinds(accounts: Int, mine: Boolean) = listOf(
            Kind("chatGPT", CodexSignInText.title, if (accounts > 0) "Another ChatGPT account of yours." else "A ChatGPT account of yours.",
                "Everyone in the pool runs on it", if (mine) " once you share the pool — until then, your sessions alone." else ", you included."),
            Kind("key", "Paste an OpenAI API key", "An organization or project key.", "Everyone who can use this pool runs on it", ", up to a monthly limit you set."))
    }
}

internal data class Fact(val lead: String, val rest: String)

/** WhoCanUseIt, SharePool and JustMine: the people card, the share sheet and making a pool just yours. */
internal class WhoCanUseIt(val pool: JsonObject, val accounts: Int?) {
    val mine = PoolPage.ownsPool(pool)
    val people = PoolPage.hasPeople(pool)
    private val added = PoolPage.people(pool).filter { it.bool("creator") != true }
    val count = if (people) PoolPage.people(pool).size else null
    val note = if (!people) null else if (mine) "Share of this month’s API key use"
        else "Set by ${PoolPage.owner(pool)?.text("name").orEmpty()} · share of this month’s API key use"
    val addsPeople = mine && people
    val showsMode = mine
    val modeHint = if (people) "They see ${pool.text("label")} on their Providers page and in the session picker." else "Nobody else in Orbit sees this pool or its accounts."
    val rows = if (people) PoolPage.people(pool) else emptyList()
    data class PersonLine(val runs: String?, val everything: Boolean, val rest: String)
    fun line(person: JsonObject): PersonLine {
        val sessions = PoolPage.plural(person.int("sessions") ?: 0, "session")
        if (!mine) return PersonLine(null, false, PoolPage.personLine(person))
        if ((accounts ?: 0) > 0) return PersonLine("Runs on everything — your ChatGPT accounts first", true, sessions)
        val keys = (person.int("keys") ?: 0).let { if (it == 0) "no key" else PoolPage.plural(it, "key") }
        return PersonLine("Runs on the API keys", false, "$keys · $sessions")
    }
    val ran = PoolPage.people(pool).any { (it.obj("usage")?.dbl("costUsd") ?: 0.0) > 0 }
    fun manages(person: JsonObject) = mine && person.bool("creator") != true
    val offersRoles = pool.bool("shared") == true
    val showsRule = mine && people
    val showsFoot = mine && people && (accounts ?: 0) > 0
    val warning: Fact? = if (!mine || !people || PoolPage.keys(pool).isNotEmpty() || (accounts ?: 0) != 0) null else
        Fact("${PoolPage.listOf(added.map { it.text("name") })} can’t start a session here yet.",
            " ${pool.text("label")} has no API key${if (accounts == null) "" else " and no ChatGPT account signed in"}.")
    companion object {
        const val header = "Who can use it"
        const val addPeople = "Add people"
        const val withPeopleLabel = "Me and people I add"
        const val ruleTitle = "They can add their own API keys"
        const val ruleHint = "Off: only you put keys in. A key they add runs everyone’s sessions here, theirs first."
        const val ruleAccountsTitle = "They can add their own ChatGPT accounts"
        const val ruleAccountsHint = "Off: only you sign ChatGPT accounts in. An account they sign in runs everyone’s sessions here too, and only they can sign it in again."
        const val footLead = "Your ChatGPT accounts run everyone’s sessions here."
        const val footRest = " The people you add start on them, and fall to the API keys when none can run. OpenAI’s terms treat account sharing as a violation — an account used that way can be suspended."
        const val addAPIKey = "Add an API key"
    }
}

internal object SharePool {
    fun title(pool: JsonObject) = "Share ${pool.text("label")}"
    const val emailsLabel = "Emails of their Orbit accounts"
    fun noKey(pool: JsonObject) = PoolPage.keys(pool).isEmpty()
    fun empty(pool: JsonObject, accounts: Int?) = noKey(pool) && (accounts ?: 0) == 0
    fun risk(pool: JsonObject, accounts: Int?) = Fact("${pool.text("label")} has no API key yet.",
        " They’ll see it but can’t start a session until it has one${if (accounts == null) "" else ", and no ChatGPT account is signed in either"}.")
    fun facts(pool: JsonObject, accounts: Int?): List<Fact> {
        val keys = PoolPage.keys(pool).map { it.text("label") }
        val run = when {
            keys.isEmpty() -> Fact("Their sessions start on your ChatGPT accounts", ", and wait when none of them can run — the pool has no API key to fall to yet.")
            (accounts ?: 0) > 0 -> Fact("Their sessions start on your ChatGPT accounts", ", and fall to the pool’s API keys — ${PoolPage.listOf(keys)} — when none of them can run.")
            else -> Fact("Their sessions run on the pool’s API keys", ", which ${if (keys.size == 1) "is" else "are"} ${PoolPage.listOf(keys)} now.")
        }
        return buildList {
            add(Fact("They see ${pool.text("label")}", " on their Providers page and in the session picker, and can start sessions on it."))
            add(run)
            if (pool.bool("membersCanAddAccounts") == true) add(Fact("They can sign in ChatGPT accounts of their own",
                ", which then run everyone’s sessions here too — theirs and yours — until they take them out again."))
            add(Fact("Everyone sees each person’s share", " of this month’s API key use."))
        }
    }
    fun emails(typed: String): List<String> = typed.split(',', ' ', '\n', '\t').filter { it.isNotBlank() }.distinct()
    fun outcome(pool: JsonObject, missed: List<String>) = if (missed.isEmpty()) "Added to ${pool.text("label")}" else "Not added: ${missed.joinToString(", ")}"
}

internal object JustMine {
    fun title(pool: JsonObject) = "Make ${pool.text("label")} just yours?"
    const val confirm = "Make it just mine"
    fun cost(pool: JsonObject, accounts: Int?): String {
        val others = PoolPage.people(pool).filter { it.bool("creator") != true }
        fun keysOf(userId: String?) = PoolPage.keys(pool).filter { ObjectId.same(PoolPage.contributor(it).str("userId"), userId) }.map { it.text("label") }
        val leaving = others.mapNotNull { person -> keysOf(person.str("userId")).takeIf { it.isNotEmpty() }?.let { person to it } }
        val staying = buildList {
            if ((accounts ?: 0) > 0) add(if (accounts == 1) "Your ChatGPT account" else "Your ChatGPT accounts")
            PoolPage.owner(pool)?.let { addAll(keysOf(it.str("userId"))) }
        }
        var text = "${PoolPage.listOf(others.map { it.text("name") })} ${if (others.size == 1) "loses" else "lose"} it at once, and their sessions on it stop."
        if (leaving.isNotEmpty()) {
            text += " " + leaving.mapIndexed { at, (person, keys) ->
                (if (at == 0) "" else if (at == leaving.lastIndex) " and " else ", ") +
                    "${PoolPage.listOf(keys)} ${if (keys.size == 1) "leaves" else "leave"} with ${person.text("name")}"
            }.joinToString("") + ", because a key goes with whoever added it."
        }
        if (staying.isNotEmpty()) text += " ${PoolPage.listOf(staying)} ${if (staying.size > 1 || (accounts ?: 0) > 1) "stay" else "stays"}."
        return text
    }
}

internal object AddPoolKeyText {
    const val title = "Add a key"
    fun facts(pool: JsonObject): List<Fact> {
        val n = PoolPage.people(pool).size
        return listOf(
            Fact("Everyone in ${pool.text("label")} can run sessions on it", " — $n ${if (n == 1) "person" else "people"}. Their sessions spend this key’s budget."),
            Fact("The key stays on the Orbit server.", " It never goes to a runner — runners get a session token, not the key — and nobody in the pool sees it or its full value."),
            Fact("Take it out, or replace it, any time.", " Its usage shows on the pool’s page for everyone in it."))
    }
    val risk = Fact("Keys can’t be resold.", " Everything run with this key is billed to its account, and the person who adds it is responsible for it.")
    const val consentNext = "Next: name it, paste it, and set what the others may spend on it."
    const val formLead = "Name it, paste it, and set what the others may spend on it."
    fun limitHint(pool: JsonObject) = "Others in ${pool.text("label")} can spend up to this on the key each month. Your own sessions aren’t limited by it."
    fun fingerprint(typed: String) = "sk-…" + typed.trim().takeLast(4)
    fun doneTitle(label: String, pool: JsonObject) = "$label is in ${pool.text("label")}"
    const val doneDetail = " · ready for the next session. Only you and the pool’s admins can replace it."
    fun duplicateTitle(pool: JsonObject) = "This key is already in ${pool.text("label")}"
    fun duplicateDetail(name: String?, you: Boolean) = "${if (you) "You" else name ?: "Someone"} added it. The same key twice doesn’t add budget — add a different one."
    fun replaceTitle(key: JsonObject) = "Replace ${key.text("label")}"
    fun replaceLead(key: JsonObject) = "OpenAI rejected ${key.text("fingerprint")}. Paste a working key to put ${key.text("label")} back in the pool."
    fun replaced(key: JsonObject, pool: JsonObject) = "${key.text("label")} is back in ${pool.text("label")}"
    fun replaceDuplicate(name: String?, you: Boolean, pool: JsonObject) = "This key is already in ${pool.text("label")} — ${if (you) "you" else name ?: "Someone"} added it."
    /** POOL_KEY_DUPLICATE carries who added it; anything else is refused in the server's words. */
    fun duplicateBy(error: Throwable): Pair<String?, Boolean>? {
        val api = error as? ApiError ?: return null
        if (api.code != "POOL_KEY_DUPLICATE") return null
        val by = (api.body as? JsonObject)?.obj("addedBy")
        return by?.str("name") to (by?.bool("you") == true)
    }
}

internal object CodexSignInText {
    const val title = "Sign in with ChatGPT"
    fun lead(pool: Pool, again: JsonObject?): Triple<String, String, String> = when {
        again != null -> Triple("OpenAI signed ${again.str("email") ?: "this account"} out. Sign in with it again to put it back in ", pool.label, ".")
        CodexLogins.logins(pool).isNotEmpty() -> Triple("Sign in with another ChatGPT account of yours to add it to ", pool.label,
            CodexLogins.logins(pool).size.let { ". It runs on $it account${if (it == 1) "" else "s"} now." })
        else -> Triple("Sign in with your own ChatGPT account to run ", pool.label, " on it.")
    }
    fun facts(pool: Pool, mine: Boolean, another: Boolean): List<Fact> = if (another) listOf(
        Fact("Everyone in the pool runs on it.", if (mine) " Once ${pool.label} is shared, the people you add run their sessions on this account too — and see it, with its usage, on the pool’s page."
            else " Everyone here runs their sessions on this account too — you included — and sees it, with its usage, on the pool’s page."),
        Fact("The sign-in stays on the Orbit server.", " It never goes to a runner. Runners get a session token, not your login."),
        Fact("Sign out any time.", " ${pool.label} keeps running on its other accounts.")) else listOf(
        if (mine) Fact("Yours, and whoever you add.", " A pool that is just yours runs your sessions alone; add people and their sessions start on this account too.")
        else Fact("Everyone in this pool runs on it.", " Add it, and everyone here — you included — runs their sessions on this account."),
        Fact("The sign-in stays on the Orbit server.", " It never goes to a runner — runners get a session token, not your login — and nobody sees its tokens."),
        Fact("Sign out any time.", " Its usage, and when it resets, show on this pool’s page."))
    fun risk(mine: Boolean, another: Boolean) = if (another) Fact("Only your own accounts.",
        " Signing in with someone else’s ChatGPT account is sharing it, and so is putting yours in a pool others run on: OpenAI’s terms treat both as a violation, and an account used that way can be suspended.")
        else Fact(if (mine) "Adding people shares your account." else "Everyone here runs on your account.",
        " Their sessions run on it — OpenAI’s terms treat account sharing as a violation, and an account used that way can be suspended.")
    fun expiry(iso: String, nowMs: Long) = ProviderPools.formatResetTime(iso, nowMs)?.let { "The code works until $it." }
    fun doneTitle(account: JsonObject?, pool: Pool) = "${account?.let(CodexLogins::name) ?: "Your ChatGPT account"} is in ${pool.label}"
    fun doneDetail(pool: Pool, logins: Int) = "${pool.label} has $logins account${if (logins == 1) "" else "s"} now. A session moves to this one when the account it’s on runs out."
    fun doneRow(account: JsonObject) = "${CodexLogins.line(account)} · its sign-in stays on the Orbit server"
    fun duplicateTitle(pool: Pool) = "This ChatGPT account is already in ${pool.label}"
    fun duplicateDetail(email: String?) = if (email == null) "It’s one of its accounts, and signing it in twice adds no quota. Sign in with a different account."
        else "$email is one of its accounts, and signing it in twice adds no quota. Sign in with a different account."
    fun sentence(reason: String): String {
        val capital = reason.trim().replaceFirstChar { it.uppercase() }
        return if (capital.isEmpty() || capital.last() in ".!?…") capital else "$capital."
    }

    /** One step of the device sign-in: consent, code, done, expired, failed or duplicate. */
    sealed interface Step {
        data object Consent : Step
        data class Code(val url: String, val code: String, val expiresAt: String) : Step
        data class Done(val account: JsonObject?, val logins: Int) : Step
        data object Expired : Step
        data class Failed(val reason: String) : Step
        data class Duplicate(val email: String?) : Step
    }
    fun after(poll: JsonObject): Step? = when (poll.str("status")) {
        "PENDING" -> null
        "CONFIRMED" -> Step.Done(poll.obj("account"), ((poll["logins"] as? JsonArray)?.size ?: if (poll.obj("account") != null) 1 else 0))
        "EXPIRED" -> Step.Expired
        "CANCELLED" -> Step.Failed("it was cancelled")
        "FAILED" -> Step.Failed(poll.str("error") ?: "the codex CLI stopped without a sign-in")
        else -> poll.obj("account")?.takeIf(CodexLogins::active)?.let { Step.Done(it, (poll["logins"] as? JsonArray)?.size ?: 1) }
            ?: Step.Failed("the Orbit server has no sign-in in progress for this pool")
    }
    fun afterPollFailure(error: Throwable): Step? {
        val api = error as? ApiError ?: return null
        if (api.code == "POOL_CODEX_ACCOUNT_DUPLICATE") return Step.Duplicate((api.body as? JsonObject)?.str("email"))
        if (api.status == 404) return Step.Failed("this pool no longer exists")
        return null
    }
}
