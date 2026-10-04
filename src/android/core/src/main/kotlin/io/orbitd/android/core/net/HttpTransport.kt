package io.orbitd.android.core.net

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okio.BufferedSink

enum class HttpMethod { GET, POST, PUT, PATCH, DELETE }

/** Paths are segments relative to /api, never an arbitrary URL that could receive a bearer. */
class ApiRequest(
    path: List<String>,
    val method: HttpMethod = HttpMethod.GET,
    query: List<Pair<String, String>> = emptyList(),
    body: ByteArray? = null,
    val contentType: String = "application/json; charset=utf-8",
) {
    val path = path.toList()
    val query = query.toList()
    val body = body?.copyOf()
    override fun toString() = "ApiRequest($method, [redacted])"
}

class HttpRequest(
    val server: ServerAddress,
    val api: ApiRequest,
    val clientVersion: String,
    val accessToken: String? = null,
) {
    override fun toString() = "HttpRequest([redacted])"
}

class ApiResponse(val status: Int, val body: ByteArray) {
    override fun toString() = "ApiResponse($status, [redacted])"
    fun requireSuccess(): ApiResponse {
        if (status !in 200..299) throw ApiError.parse(status, body)
        return this
    }
}

fun interface HttpTransport {
    suspend fun execute(request: HttpRequest): ApiResponse
}

/** No disk HTTP cache, cookies, logging interceptor, redirects, or implicit credential replay. */
class OkHttpTransport : HttpTransport {
    private val client = OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .retryOnConnectionFailure(false)
        .callTimeout(30, TimeUnit.SECONDS)
        .build()

    override suspend fun execute(request: HttpRequest): ApiResponse {
        val api = request.api
        val bytes = api.body ?: if (api.method in setOf(HttpMethod.POST, HttpMethod.PUT, HttpMethod.PATCH)) ByteArray(0) else null
        val body = bytes?.let {
            object : RequestBody() {
                override fun contentType() = api.contentType.toMediaType()
                override fun contentLength() = it.size.toLong()
                override fun writeTo(sink: BufferedSink) { sink.write(it) }
                // Also disables OkHttp's HTTP 503/408 follow-ups for rotating refresh requests.
                override fun isOneShot() = true
            }
        }
        val wire = Request.Builder()
            .url(request.server.endpoint(api.path, api.query))
            .header("X-Orbit-Client", "android/${request.clientVersion}")
            .header("Accept", "application/json")
            .apply { request.accessToken?.let { header("Authorization", "Bearer $it") } }
            .method(api.method.name, body)
            .build()
        return suspendCancellableCoroutine { continuation ->
            val call = client.newCall(wire)
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    continuation.resumeWithException(NetworkException())
                }
                override fun onResponse(call: Call, response: Response) {
                    response.use {
                        try {
                            continuation.resume(ApiResponse(it.code, it.body?.bytes() ?: ByteArray(0)))
                        } catch (_: IOException) {
                            continuation.resumeWithException(NetworkException())
                        }
                    }
                }
            })
        }
    }
}
