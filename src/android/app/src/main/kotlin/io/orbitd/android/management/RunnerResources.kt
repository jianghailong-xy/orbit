package io.orbitd.android.management

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/**
 * A runner page's Resources section: the machine's CPU, memory and disk, and their last hour (web MachineResources.tsx,
 * docs/mocks/runner-resource-monitor). Read from GET /runners/:id/resources while the page is up. A runner that does not
 * declare machine-resources/v1 has only the disk its workspaces' probes measured.
 */
internal object RunnerResources {
    const val CAPABILITY = "machine-resources/v1"
    /** How often the section asks again while the machine is online: its heartbeat's own period. */
    const val POLL_MS = 30_000L
    private const val HOUR_MS = 60 * 60_000L
    /** Samples further apart than this are drawn as a break: the machine was not heard in between. */
    private const val GAP_MS = 90_000L
    /** Memory and disk from here on are drawn amber. CPU is not: an agent at work fills it. */
    private const val FULL_PERCENT = 90

    enum class Figure { CPU, MEM, DISK }

    data class Sample(val atMs: Long, val cpu: Double?, val mem: Double?, val disk: Double?) {
        fun of(figure: Figure) = when (figure) { Figure.CPU -> cpu; Figure.MEM -> mem; Figure.DISK -> disk }
    }

    /** GET /runners/:id/resources, read. `atMs` and `latest` are null when nothing is kept. */
    data class Answer(val atMs: Long?, val latest: JsonObject?, val samples: List<Sample>)

    data class Tile(
        val figure: Figure,
        val label: String,
        val percent: Int?,
        val detail: String,
        val warn: Boolean,
        val note: String? = null,
        /** The runner is too old to report this figure: why, in place of a number. */
        val update: String? = null,
    )

    fun reports(runner: JsonObject) = CAPABILITY in runner.strings("capabilities")

    private fun JsonObject.num(name: String): Double? = (this[name] as? JsonPrimitive)?.doubleOrNull?.takeIf { it.isFinite() }

    fun answerOf(json: JsonObject?): Answer {
        if (json == null) return Answer(null, null, emptyList())
        val samples = (json["samples"] as? JsonArray).orEmpty().mapNotNull { element ->
            val s = element as? JsonObject ?: return@mapNotNull null
            val at = isoMs(s.str("at")) ?: return@mapNotNull null
            Sample(at, s.num("cpu"), s.num("mem"), s.num("disk"))
        }
        return Answer(isoMs(json.str("at")), json.obj("latest"), samples)
    }

    private fun pct(used: Double, total: Double) = Math.round(used / total * 100).toInt().coerceIn(0, 100)

    /** `8 cores · load 3.0`, either part left out when the machine gave none. */
    fun cpuDetail(cores: Int?, load1: Double?): String = listOfNotNull(
        cores?.takeIf { it > 0 }?.let { if (it == 1) RunnerCopy.CPU_ONE_CORE else RunnerCopy.cpuCores("$it") },
        load1?.let { RunnerCopy.cpuLoad(String.format(java.util.Locale.ROOT, "%.1f", it)) },
    ).joinToString(" · ")

    /** The three tiles, in order. `workspaceDisk` is the disk the workspaces' probes measured (RunnerPage.runnerDisk). */
    fun tiles(runner: JsonObject, answer: Answer, workspaceDisk: RunnerDisk?, online: Boolean): List<Tile> {
        val reports = reports(runner)
        val latest = if (reports) answer.latest else null
        val noReading = if (reports) RunnerCopy.RESOURCES_NO_READING else ""
        val cpu = latest?.num("cpuPercent")
        val memTotal = latest?.num("memTotalBytes")?.takeIf { it > 0 }
        val memAvail = latest?.num("memAvailableBytes")
        val mem = if (memTotal != null && memAvail != null) pct(memTotal - memAvail, memTotal) else null
        val diskTotal = latest?.num("diskTotalBytes")?.takeIf { it > 0 }
        val diskFree = latest?.num("diskFreeBytes")
        // The machine's own reading of the disk when it gives one; the workspaces' probes otherwise.
        val disk = if (diskTotal != null && diskFree != null) {
            RunnerDisk(diskFree.toLong(), diskTotal.toLong(), pct(diskTotal - diskFree, diskTotal))
        } else workspaceDisk
        val memFull = mem != null && mem >= FULL_PERCENT
        return listOf(
            Tile(
                Figure.CPU, RunnerCopy.RESOURCES_CPU, cpu?.let { Math.round(it).toInt() },
                latest?.let { cpuDetail(it.num("cpuCores")?.toInt(), it.num("load1")) }?.ifEmpty { null } ?: noReading,
                warn = false, update = if (reports) null else RunnerCopy.resourcesPredates("CPU"),
            ),
            Tile(
                Figure.MEM, RunnerCopy.RESOURCES_MEMORY, mem,
                if (memTotal != null && memAvail != null) {
                    RunnerCopy.diskUsed(RunnerPage.formatDiskGb((memTotal - memAvail).toLong()), RunnerPage.formatDiskGb(memTotal.toLong()))
                } else noReading,
                warn = memFull, note = if (memFull && online) RunnerCopy.RESOURCES_MEMORY_FULL else null,
                update = if (reports) null else RunnerCopy.resourcesPredates("memory"),
            ),
            Tile(
                Figure.DISK, RunnerCopy.DISK, disk?.usedPercent,
                disk?.let { "${RunnerPage.diskUsedLine(it)}${RunnerCopy.SEP}${RunnerCopy.diskFree(RunnerPage.formatDiskGb(it.freeBytes))}" } ?: noReading,
                warn = disk != null && RunnerPage.diskIsTight(disk, runner.int("minFreeDiskMb")),
            ),
        )
    }

    /** The section's trailing note, and whether it carries a dot: green online, grey offline, none for a runner that reads only disk. */
    fun header(runner: JsonObject, answer: Answer, online: Boolean, nowMs: Long): Pair<String, Boolean?> = when {
        !online -> (if (reports(runner) && answer.atMs != null) {
            RunnerCopy.resourcesLastReading(RunnerPage.ago(java.time.Instant.ofEpochMilli(answer.atMs).toString(), nowMs))
        } else RunnerCopy.RESOURCES_OFFLINE) to false
        reports(runner) -> RunnerCopy.RESOURCES_LIVE to true
        else -> RunnerCopy.RESOURCES_DISK_ONLY to null
    }

    /**
     * The line under a tile: runs of points (x, y) in 0..1 — x across the hour ending at `endMs`, y the share in use, 0 at the
     * bottom — broken where the machine went unheard for longer than GAP_MS.
     */
    fun runs(samples: List<Sample>, figure: Figure, endMs: Long): List<List<Pair<Float, Float>>> {
        val startMs = endMs - HOUR_MS
        val runs = mutableListOf<MutableList<Pair<Float, Float>>>()
        var prevAt = Long.MIN_VALUE
        for (s in samples) {
            val v = s.of(figure)
            if (s.atMs < startMs || v == null) { prevAt = Long.MIN_VALUE; continue }
            val point = ((s.atMs - startMs).toFloat() / HOUR_MS) to (v.coerceIn(0.0, 100.0) / 100).toFloat()
            if (runs.isEmpty() || prevAt == Long.MIN_VALUE || s.atMs - prevAt > GAP_MS) runs.add(mutableListOf(point)) else runs.last().add(point)
            prevAt = s.atMs
        }
        return runs
    }

    /** Where the hour ends: now while the machine is heard, else at its last reading. */
    fun endMs(answer: Answer, online: Boolean, nowMs: Long) = if (online || answer.atMs == null) nowMs else answer.atMs
}
