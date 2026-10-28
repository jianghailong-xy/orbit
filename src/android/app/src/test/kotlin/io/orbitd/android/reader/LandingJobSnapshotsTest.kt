package io.orbitd.android.reader

import io.orbitd.android.ProjectShell
import io.orbitd.android.core.cards.text
import io.orbitd.android.navigation.ObjectId
import java.time.Instant
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * A11-20 e: the app's snapshot of each landing job (iOS `AppModel.landingInFlightCache` / `rememberLandingJobs`) keeps what an
 * integration read listed for each landing session — the job, when the read answered, the V6 facts beside it and the project whose
 * read it was (the Landings window a link to it opens) — by either spelling of the session's id, for one sign-in only.
 */
class LandingJobSnapshotsTest {
    private val now = Instant.parse("2026-10-20T17:36:00Z")
    private val landing = ProjectShell.LANDING
    private val project = ProjectShell.LAUNCH
    private fun json(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject
    private fun job(id: String, landingSessionId: String?) = """{"jobId":"$id","kind":"LAND_TASK","state":"RUNNING","phase":"CHECK",
        "taskId":"t-$id","taskTitle":"Wire the page","generation":1,"startedAt":"2026-10-20T17:30:00Z","heartbeatAt":"2026-10-20T17:35:50Z",
        "runnerName":"wikova","stepStartedAt":"2026-10-20T17:31:00Z","typicalMs":1080000${
            landingSessionId?.let { ""","landingSessionId":"$it"""" }.orEmpty()}}"""

    @Test fun eachListedLandingJobIsKeptForTheSignInThatReadIt() = runBlocking {
        val first = ProjectShell.signIn(ProjectShell.session())
        val second = ProjectShell.signIn(ProjectShell.session())
        val snapshots = LandingJobSnapshots()
        snapshots.remember(first, project, json("""{"upstreamRef":"refs/heads/trunk","inFlightJobs":[${job("j-1", landing)},${job("j-2", null)}]}"""), now)

        val kept = snapshots.snapshot(first, landing)!!
        assertEquals("j-1", kept.job.text("jobId"))
        assertEquals(now, kept.readAt)
        assertEquals(LandingFacts("2026-10-20T17:31:00Z", 1080000, "trunk"), kept.facts)
        assertEquals("the project whose window a link to it opens", project, kept.projectId)
        // Either spelling of the id is the same session; a job that names no landing session is not kept.
        assertNotNull(snapshots.snapshot(first, ObjectId.canonical(landing)!!))
        assertNull(snapshots.snapshot(first, "t-j-2"))

        // A later read replaces the description; a read that lists no jobs leaves the last one (the page shows it as stale).
        snapshots.remember(first, project, json("""{"inFlightJobs":[${job("j-3", ObjectId.canonical(landing))}]}"""), now.plusSeconds(60))
        assertEquals("j-3", snapshots.snapshot(first, landing)!!.job.text("jobId"))
        assertEquals("main", snapshots.snapshot(first, landing)!!.facts.mainBranch)
        snapshots.remember(first, project, json("""{"integratingCount":0,"queuedCount":0}"""), now.plusSeconds(120))
        assertEquals(now.plusSeconds(60), snapshots.snapshot(first, landing)!!.readAt)

        // Nothing kept under one sign-in is answered under another, and a read under another starts afresh.
        assertNull(snapshots.snapshot(second, landing))
        snapshots.remember(second, project, json("""{"inFlightJobs":[]}"""), now)
        assertNull(snapshots.snapshot(first, landing))
        assertNull(snapshots.snapshot(second, landing))
    }
}
