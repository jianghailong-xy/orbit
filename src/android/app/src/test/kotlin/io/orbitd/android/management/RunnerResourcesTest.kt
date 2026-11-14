package io.orbitd.android.management

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/** The Resources section's rules, as web MachineResources.tsx and its layout tests state them (docs/mocks/runner-resource-monitor). */
class RunnerResourcesTest {
    private val now = Instant.parse("2026-11-14T10:00:00Z").toEpochMilli()
    private val gib = 1024L * 1024 * 1024
    private fun json(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject
    private fun iso(ms: Long) = Instant.ofEpochMilli(ms).toString()
    private fun runner(reports: Boolean, extra: String = "") =
        json("""{"id":"r1","capabilities":[${if (reports) "\"machine-resources/v1\"" else "\"dir-probe/v1\""}]$extra}""")
    private val workspaceDisk = RunnerDisk(10 * gib, 197 * gib, 95)

    @Test fun `a runner that reads no resources says Update runner for CPU and memory, and its workspaces' disk`() {
        val r = runner(reports = false)
        val tiles = RunnerResources.tiles(r, RunnerResources.answerOf(null), workspaceDisk, online = true)
        assertEquals(listOf("CPU", "Memory", "Disk"), tiles.map { it.label })
        assertEquals("This runner predates CPU readings.", tiles[0].update)
        assertEquals("This runner predates memory readings.", tiles[1].update)
        assertNull(tiles[2].update)
        assertEquals(95, tiles[2].percent)
        assertEquals("187 of 197 GB used · 10 GB free", tiles[2].detail)
        assertTrue("95% is amber", tiles[2].warn)
        assertEquals("Disk is read from your workspaces" to null, RunnerResources.header(r, RunnerResources.answerOf(null), true, now))
    }

    @Test fun `a runner that reads its resources shows each figure, memory amber from 90 percent, CPU never`() {
        val r = runner(reports = true)
        val answer = RunnerResources.answerOf(json("""{"at":"${iso(now - 20_000)}","latest":{"cpuPercent":97.6,"cpuCores":8,"load1":3.04,
            "memTotalBytes":${32 * gib},"memAvailableBytes":${2 * gib},"diskTotalBytes":${926 * gib},"diskFreeBytes":${198 * gib}},"samples":[]}"""))
        val tiles = RunnerResources.tiles(r, answer, workspaceDisk, online = true)
        assertEquals(listOf(98, 94, 79), tiles.map { it.percent })
        assertEquals(listOf("8 cores · load 3.0", "30 of 32 GB used", "728 of 926 GB used · 198 GB free"), tiles.map { it.detail })
        assertEquals(listOf(false, true, false), tiles.map { it.warn })
        assertEquals("Nearly full — new sessions may be slow to start.", tiles[1].note)
        assertEquals("Live · every 30 s · last hour" to true, RunnerResources.header(r, answer, true, now))
    }

    @Test fun `offline shows the last reading, when it came, and no note`() {
        val r = runner(reports = true)
        val at = now - 14 * 60_000
        val answer = RunnerResources.answerOf(json("""{"at":"${iso(at)}","latest":{"cpuPercent":12,"cpuCores":1,"memTotalBytes":100,"memAvailableBytes":5},"samples":[]}"""))
        assertEquals("Offline · last reading 14m ago" to false, RunnerResources.header(r, answer, false, now))
        val tiles = RunnerResources.tiles(r, answer, null, online = false)
        assertEquals("1 core", tiles[0].detail)
        assertNull("the note is for a machine at work", tiles[1].note)
        assertEquals("No reading yet", tiles[2].detail)
        assertNull(tiles[2].percent)
        assertEquals(at, RunnerResources.endMs(answer, false, now))
        assertEquals("Offline" to false, RunnerResources.header(r, RunnerResources.answerOf(null), false, now))
    }

    @Test fun `the hour's line breaks where the machine went unheard, and leaves out what is older`() {
        val answer = RunnerResources.answerOf(json("""{"at":"${iso(now)}","latest":{},"samples":[
            {"at":"${iso(now - 70 * 60_000)}","cpu":5,"mem":null,"disk":null},
            {"at":"${iso(now - 50 * 60_000)}","cpu":20,"mem":90,"disk":78},
            {"at":"${iso(now - 49 * 60_000 - 30_000)}","cpu":25,"mem":91,"disk":78},
            {"at":"${iso(now - 50_000)}","cpu":30,"mem":null,"disk":79},
            {"at":"${iso(now - 20_000)}","cpu":40,"mem":94,"disk":79}]}"""))
        val cpu = RunnerResources.runs(answer.samples, RunnerResources.Figure.CPU, now)
        assertEquals(2, cpu.size)
        assertEquals(10f / 60, cpu[0][0].first, 1e-4f)
        assertEquals(.20f, cpu[0][0].second, 1e-4f)
        assertEquals(2, cpu[1].size)
        // A missing figure breaks its own line, not the others'.
        val mem = RunnerResources.runs(answer.samples, RunnerResources.Figure.MEM, now)
        assertEquals(listOf(2, 1), mem.map { it.size })
        assertFalse(RunnerResources.runs(answer.samples, RunnerResources.Figure.DISK, now).isEmpty())
    }
}
