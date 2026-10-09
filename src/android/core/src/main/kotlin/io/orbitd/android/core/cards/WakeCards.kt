package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*

/** The control-plane writers' marked messages, following OrbitKit BackgroundWake/WatchWake.
 * These projections confer no action; the complete original remains available in the transcript. */
internal fun watchWake(text: String): JsonObject? {
    if (!text.startsWith("Orbit Watch ") || !text.contains("This turn was queued by the watch, not typed by a person.")) return null
    val head = Regex("^Orbit Watch (\\S+) (?:matched at generation (\\d+): (.+)|EXPIRED at \\S+ without its condition ever holding\\.|ended (REVOKED|UNRESOLVABLE): .+)$")
        .matchEntire(text.substringBefore('\n')) ?: return null
    val raw = Regex("```json\\n([\\s\\S]*?)\\n```").find(text)?.groupValues?.get(1) ?: return null
    val payload = runCatching { Wire.json.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: return null
    if (payload.text("watchId") != head.groupValues[1]) return null
    return buildJsonObject {
        put("watchId", head.groupValues[1]); put("generation", head.groupValues[2].toIntOrNull()?.let(::JsonPrimitive) ?: JsonNull)
        put("reason", head.groupValues[3]); put("state", if (head.groupValues[2].isNotEmpty()) "MATCHED" else head.groupValues[4].ifEmpty { "EXPIRED" })
        put("changedTargets", payload["changedTargets"] ?: JsonArray(emptyList()))
    }
}

internal fun backgroundWake(note: String): JsonObject? {
    val jobs = mutableListOf<JsonElement>(); val wakeups = mutableListOf<JsonElement>()
    val trigger = Regex("^ {6}(ended|已结束|new output|有新输出)(?:｜(.*))?$")
    val timing = Regex("^ {4}(\\S+) (?:scheduled (\\d+) seconds out, due (\\S+)|约在 (\\d+) 秒后，(\\S+) 到点)$")
    Regex("<(background-job-wake|scheduled-wakeup)>\\n([\\s\\S]*?)\\n</\\1>").findAll(note).forEach { block ->
        val lines = block.groupValues[2].lines()
        val isJob = block.groupValues[1] == "background-job-wake"
        val heads = lines.indices.filter { if (isJob) Regex("^ {4}bgj_[^｜\\s]*｜").containsMatchIn(lines[it]) else timing.matches(lines[it]) }
        heads.forEachIndexed { index, from ->
            val section = lines.subList(from, heads.getOrNull(index + 1) ?: lines.size)
            if (isJob) {
                val at = section.indexOfFirst { trigger.matches(it) }
                val fields = section.take(if (at < 0) section.size else at).joinToString("\n").removePrefix("    ").split('｜')
                val match = section.getOrNull(at)?.let { trigger.matchEntire(it) }
                val facts = match?.groupValues?.get(2).orEmpty().split('｜')
                val tailAt = section.indexOfFirst { it in setOf("      output tail:", "      输出末尾：") }
                jobs += buildJsonObject {
                    put("id", fields[0]); put("kind", fields.getOrElse(1) { "" })
                    put("command", if (fields.size > 3) fields.subList(2, fields.lastIndex).joinToString("｜") else fields.getOrElse(2) { "" })
                    if (fields.size > 3) put("description", fields.last())
                    put("status", facts[0]); put("ended", match?.groupValues?.get(1) in setOf("ended", "已结束"))
                    val exit = Regex("^(?:exit code|退出码)\\s*(-?\\d+)$").matchEntire(facts.getOrElse(1) { "" })?.groupValues?.get(1)?.toIntOrNull()
                    if (exit != null) put("exitCode", exit)
                    Regex("^(?:reason|原因)\\s*(.+)$").matchEntire(facts.getOrElse(1) { "" })?.groupValues?.get(1)?.let { put("killReason", it.replace(Regex("\\s*[(（].*[)）]\\s*$"), "")) }
                    if (tailAt >= 0) put("outputTail", section.drop(tailAt + 1).takeWhile { it.startsWith("        ") || it.isBlank() }.joinToString("\n") { it.drop(8) }.trimEnd())
                }
            } else {
                val time = timing.matchEntire(section.first())!!.groupValues
                val promptAt = section.indexOfFirst { it in setOf("    what you left for this turn:", "    你留给这一轮的话：") }
                wakeups += buildJsonObject {
                    put("askedAt", time[1]); put("delaySeconds", time[2].ifEmpty { time[4] }.toInt())
                    put("dueAt", time[3].ifEmpty { time[5] })
                    section.firstNotNullOfOrNull { Regex("^ {4}(?:reason: |理由：)(.*)$").matchEntire(it)?.groupValues?.get(1) }?.let { put("reason", it) }
                    if (promptAt >= 0) put("prompt", section.drop(promptAt + 1).filter { it.startsWith("      ") }.joinToString("\n") { it.drop(6) }.trimEnd())
                }
            }
        }
    }
    if (jobs.isEmpty() && wakeups.isEmpty()) return null
    return buildJsonObject { put("jobs", JsonArray(jobs)); put("wakeups", JsonArray(wakeups)) }
}
