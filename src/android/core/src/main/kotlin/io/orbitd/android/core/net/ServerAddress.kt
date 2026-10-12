package io.orbitd.android.core.net

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** Canonical instance root, including scheme, port and any reverse-proxy prefix. */
@ConsistentCopyVisibility
data class ServerAddress private constructor(val value: String) {
    internal fun endpoint(path: List<String>, query: List<Pair<String, String>>): HttpUrl {
        require(path.isNotEmpty() && path.all { it.isNotBlank() && it != "." && it != ".." })
        return value.toHttpUrlOrNull()!!.newBuilder().apply {
            addPathSegment("api")
            path.forEach(::addPathSegment)
            query.forEach { (key, value) -> addQueryParameter(key, value) }
        }.build()
    }

    companion object {
        /**
         * HTTP is only for explicit loopback test fixtures, never a remote credential endpoint. An address typed without a
         * scheme, such as the login page's orbitd.io, is HTTPS (iOS ServerURL takes a bare host too).
         */
        fun parse(input: String, allowLoopbackHttp: Boolean = false): ServerAddress {
            val text = input.trim().let { if (it.isEmpty() || "://" in it) it else "https://$it" }
            val url = text.toHttpUrlOrNull() ?: throw InvalidServerAddress()
            if (text.any { it.isISOControl() } || '\\' in text ||
                url.username.isNotEmpty() || url.password.isNotEmpty() ||
                url.query != null || url.fragment != null ||
                (url.scheme != "https" && !(allowLoopbackHttp &&
                    url.host in setOf("localhost", "127.0.0.1", "::1")))
            ) throw InvalidServerAddress()
            // Both an instance root and a pasted /api URL denote the same instance.
            val segments = url.pathSegments.dropLastWhile { it.isEmpty() }.let {
                if (it.lastOrNull() == "api") it.dropLast(1) else it
            }
            if (segments.any { it.isBlank() || it.contains('/') || it.contains('\\') }) {
                throw InvalidServerAddress()
            }
            val canonical = url.newBuilder().encodedPath("/").apply {
                segments.forEach(::addPathSegment)
                if (segments.isNotEmpty()) addPathSegment("")
            }.build().toString()
            return ServerAddress(canonical)
        }
    }
}

class InvalidServerAddress : IllegalArgumentException("Enter an HTTPS instance address without credentials, query or fragment")
