package io.orbitd.android.core.realtime

import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.net.HttpRequest
import io.orbitd.android.core.net.NetworkException
import io.orbitd.android.core.protocol.ProtocolException
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request

interface EventTransport {
    /** onOpen follows successful headers; errors (including 401) precede callbacks. */
    suspend fun stream(request: HttpRequest, onOpen: suspend () -> Unit, onFrame: suspend (SseFrame) -> Unit)
}

/** No redirect, cookie jar, logging or background service. Every byte resets the
 * socket read timeout; the server's 20s ping makes 45s without bytes a dead connection. */
class OkHttpEventTransport(readTimeoutMs: Long = 45_000) : EventTransport {
    private val client = OkHttpClient.Builder()
        // Only GET is accepted below. Allow a stale socket / failed address to fall back to
        // another address of this origin. Stream-body replay still belongs to RealtimeStore.
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(true)
        .connectTimeout(10, TimeUnit.SECONDS).readTimeout(readTimeoutMs, TimeUnit.MILLISECONDS)
        .callTimeout(0, TimeUnit.MILLISECONDS).build()

    override suspend fun stream(request: HttpRequest, onOpen: suspend () -> Unit, onFrame: suspend (SseFrame) -> Unit) =
        withContext(Dispatchers.IO) {
            require(request.api.method == HttpMethod.GET && request.api.body == null)
            val call = client.newCall(Request.Builder()
                .url(request.server.endpoint(request.api.path, request.api.query))
                .header("Accept", "text/event-stream")
                .header("X-Orbit-Client", "android/${request.clientVersion}")
                .apply { request.accessToken?.let { header("Authorization", "Bearer $it") } }
                .build())
            coroutineScope {
                // Cancellation must close a blocking read immediately, including during headers.
                val cancellation = launch(start = CoroutineStart.UNDISPATCHED) {
                    try { awaitCancellation() } finally { call.cancel() }
                }
                try {
                    call.execute().use { response ->
                        if (response.code != 200) throw ApiError.parse(response.code, response.peekBody(65_536).bytes())
                        if (response.header("Content-Type")?.substringBefore(';')?.trim() != "text/event-stream") {
                            throw ProtocolException()
                        }
                        onOpen()
                        val parser = SseParser()
                        val source = response.body?.byteStream() ?: throw ProtocolException()
                        val bytes = ByteArray(8192)
                        while (true) {
                            currentCoroutineContext().ensureActive()
                            val count = source.read(bytes)
                            if (count < 0) break
                            for (index in 0 until count) parser.consume(bytes[index])?.let { onFrame(it) }
                        }
                    }
                } catch (_: IOException) {
                    currentCoroutineContext().ensureActive()
                    throw NetworkException()
                } finally { cancellation.cancel(); call.cancel() }
            }
        }
}
