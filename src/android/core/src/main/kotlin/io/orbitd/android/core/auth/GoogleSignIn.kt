package io.orbitd.android.core.auth

import io.orbitd.android.core.net.ServerAddress
import java.net.URI
import java.net.URISyntaxException
import java.net.URLDecoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/** What an address the app was opened with means for the Google sign-in this process started. */
sealed interface GoogleCallback {
    /** Not `orbit://auth/google`: no answer to a sign-in. */
    data object NotGoogle : GoogleCallback

    /** No sign-in is waiting: the process was restarted while the browser was open, and its verifier is gone. */
    data object Interrupted : GoogleCallback

    /** Another state than the waiting sign-in's: nothing in the answer is used, and the sign-in keeps waiting. */
    data object StateMismatch : GoogleCallback

    /** The server sent the app back with this code (§4.1, §4.2) — or, null, with neither code nor ticket. */
    data class Refused(val code: String?) : GoogleCallback

    /** The ticket to exchange on the instance the sign-in started on, with the verifier only this process holds. */
    class Ticket(val server: ServerAddress, val ticket: String, val codeVerifier: String) : GoogleCallback {
        override fun toString() = "Ticket([redacted])"
    }
}

/**
 * Signing in with Google (docs/google-sign-in-design.md §3.2, §8.3). The server runs the OAuth flow:
 * the app opens the instance's /start in a browser, and the server sends the browser back to
 * `orbit://auth/google?ticket=…&state=…` or `?error=CODE&state=…`. Any app can declare that scheme,
 * so the PKCE verifier lives only here, in this process's memory, and is shown only to the exchange:
 * a ticket another app catches cannot be exchanged without it. When the process dies while the
 * browser is open, the verifier dies with it and the ticket is never exchanged; it expires unused.
 */
class GoogleSignIn {
    private class Started(val server: ServerAddress, val verifier: String, val state: String)

    private val random = SecureRandom()
    private var started: Started? = null

    /** Starts a sign-in on [server], replacing any unfinished one, and answers the /start URL to open (§4.1). */
    @Synchronized
    fun begin(server: ServerAddress): String {
        val next = Started(server, randomToken(), randomToken())
        started = next
        return server.endpoint(listOf("auth", "google", "start"), listOf(
            "client" to "native",
            "code_challenge" to challenge(next.verifier),
            "client_state" to next.state,
        )).toString()
    }

    /** Forgets the unfinished sign-in, as when no browser could open its /start. */
    @Synchronized
    fun abandon() {
        started = null
    }

    /** Reads [uri] (§4.2). Only an answer carrying the waiting sign-in's state ends it, and only once. */
    @Synchronized
    fun complete(uri: String): GoogleCallback {
        val query = callbackQuery(uri) ?: return GoogleCallback.NotGoogle
        val current = started ?: return GoogleCallback.Interrupted
        fun value(name: String) = query.filter { it.first == name }.singleOrNull()?.second?.takeIf { it.isNotEmpty() }
        if (value("state") != current.state) return GoogleCallback.StateMismatch
        started = null
        val ticket = value("ticket")
        return when {
            query.any { it.first == "error" } || ticket == null -> GoogleCallback.Refused(value("error"))
            else -> GoogleCallback.Ticket(current.server, ticket, current.verifier)
        }
    }

    /** 32 random bytes as 43 base64url characters: a PKCE verifier (RFC 7636 §4.1), or a state. */
    private fun randomToken(): String = base64url.encodeToString(ByteArray(32).also(random::nextBytes))

    companion object {
        private val base64url = Base64.getUrlEncoder().withoutPadding()

        /** The S256 challenge of a PKCE verifier (RFC 7636 §4.2): base64url of its SHA-256, unpadded. */
        fun challenge(verifier: String): String =
            base64url.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.encodeToByteArray()))

        /** The decoded query of `orbit://auth/google?…`, or null for any other address. */
        private fun callbackQuery(uri: String): List<Pair<String, String>>? {
            val parsed = try { URI(uri) } catch (_: URISyntaxException) { return null }
            if (!"orbit".equals(parsed.scheme, ignoreCase = true) || !"auth".equals(parsed.host, ignoreCase = true) ||
                parsed.rawUserInfo != null || parsed.port != -1 || parsed.rawPath != "/google") return null
            return parsed.rawQuery.orEmpty().split('&').filter { it.isNotEmpty() }.map { part ->
                // URI has already refused malformed escapes. The Charset overload of decode needs API 33.
                URLDecoder.decode(part.substringBefore('='), "UTF-8") to URLDecoder.decode(part.substringAfter('=', ""), "UTF-8")
            }
        }
    }
}
