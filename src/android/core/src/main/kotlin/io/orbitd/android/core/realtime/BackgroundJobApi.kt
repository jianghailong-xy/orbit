package io.orbitd.android.core.realtime

import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.ProtocolException
import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * The owner's two routes on one session's bg_run jobs (web `getBackgroundJobTail` and `stopBackgroundJob`), which a job's card and the
 * Background list act through. A refusal arrives as the transport's ApiError, its status intact: 404 or 409 from the tail read means the
 * runner is too old to read it, or the output is gone.
 */
class BackgroundJobApi(private val api: OrbitApi, private val handle: SessionHandle, private val sessionId: String) {
    /** The newest lines of one job's output (GET /sessions/:id/background/jobs/:jobId/tail, at most 40): `status`, `exitCode`, `lines`. */
    suspend fun tail(jobId: String): JsonObject =
        Wire.decode(api.request(handle, ApiRequest(path(jobId, "tail"))).body, JsonElement.serializer()) as? JsonObject
            ?: throw ProtocolException()

    /** The owner's stop of one running job (POST …/stop): its end arrives as the job's terminal report. */
    suspend fun stop(jobId: String) {
        api.request(handle, ApiRequest(path(jobId, "stop"), HttpMethod.POST))
    }

    private fun path(jobId: String, route: String) = listOf("sessions", sessionId, "background", "jobs", jobId, route)
}
