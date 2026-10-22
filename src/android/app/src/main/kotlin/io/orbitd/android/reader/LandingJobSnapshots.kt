package io.orbitd.android.reader

import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.number
import io.orbitd.android.core.cards.text
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.projects.ProjectPage
import io.orbitd.android.projects.RunSettings
import java.time.Instant
import kotlinx.serialization.json.JsonObject

/** One landing job as an integration read last described it, when that read answered, and the V6 facts it carried beside it. */
internal data class LandingJobSnapshot(val job: JsonObject, val readAt: Instant, val facts: LandingFacts)

/**
 * Each landing session's job as the last integration read described it (iOS `AppModel.landingInFlightCache` and
 * `rememberLandingJobs`): what a landing page whose first read fails draws its frozen head from, and what still opens a link as the
 * landing page when the read that would say its `sessionKind` fails. Work overview, the project sessions page's poll and the landing
 * page's own read fill it. In memory only, and one sign-in's at a time: a read under another sign-in starts it afresh, and nothing
 * kept under one is answered under another.
 */
internal class LandingJobSnapshots {
    private var owner: SessionHandle? = null
    private val jobs = mutableMapOf<String, LandingJobSnapshot>()

    /** Keep every listed job that names its landing session, from an integration read that answered at [readAt]. */
    @Synchronized
    fun remember(handle: SessionHandle, integration: JsonObject, readAt: Instant = Instant.now()) {
        if (owner !== handle) { jobs.clear(); owner = handle }
        val main = RunSettings.mainBranchName(integration.text("upstreamRef"))
        ProjectPage.inFlightJobs(integration)?.forEach { job ->
            val id = job.text("landingSessionId")?.takeIf { it.isNotEmpty() } ?: return@forEach
            jobs[key(id)] = LandingJobSnapshot(job, readAt, LandingFacts(job.text("stepStartedAt"), job.number("typicalMs"), main))
        }
    }

    /** The last description of [sessionId]'s job read under [handle], in either spelling of the id; null when it read none. */
    @Synchronized
    fun snapshot(handle: SessionHandle, sessionId: String): LandingJobSnapshot? = if (owner === handle) jobs[key(sessionId)] else null

    private fun key(id: String) = ObjectId.canonical(id) ?: id
}
