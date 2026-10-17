package io.orbitd.android.core.net

import org.junit.Assert.*
import org.junit.Test

class ServerAddressTest {
    @Test fun canonicalizationKeepsTheFullInstanceIdentity() {
        assertEquals(ServerAddress.parse(" HTTPS://Example.test:443/team/api/ "), ServerAddress.parse("https://example.test/team"))
        assertEquals("https://example.test/team/api/users/me?q=a%26b", ServerAddress.parse("https://example.test/team/")
            .endpoint(listOf("users", "me"), listOf("q" to "a&b")).toString())
        assertNotEquals(ServerAddress.parse("https://example.test/team-a"), ServerAddress.parse("https://example.test/team-b"))
        assertNotEquals(ServerAddress.parse("https://example.test"), ServerAddress.parse("https://example.test:8443"))
    }

    @Test fun invalidOrCredentialBearingAddressesAreRejectedWithoutEchoingInput() {
        for (input in listOf("", "file:///secret", "ftp://example.test/secret", "https://user:secret@example.test",
            "http://user:secret@192.168.1.5:2086", "https://example.test?token=secret", "http://example.test?token=secret",
            "https://example.test/#secret", "https://example.test/\\secret")) {
            val error = runCatching { ServerAddress.parse(input) }.exceptionOrNull()
            assertTrue(input, error is InvalidServerAddress)
            assertFalse(error!!.toString().contains("secret"))
        }
    }

    /** The account owner's decision of 2026-10-15 (card 34g6JcZwpKTUcwc5WvuVx): http:// on any host and port, as iOS takes it, and in
     * a release build too — the app no longer passes the loopback switch, and false, what a release build used to pass, is ignored. */
    @Test fun httpOnAnyHostAndPortIsAnInstanceInEveryBuild() {
        for ((input, canonical) in listOf(
            "http://192.168.1.5:2086" to "http://192.168.1.5:2086/",
            " HTTP://Orbit.LAN:8080/team/api/ " to "http://orbit.lan:8080/team/",
            "http://[2001:db8::5]:2086" to "http://[2001:db8::5]:2086/",
            "http://example.test" to "http://example.test/",
        )) {
            assertEquals(canonical, ServerAddress.parse(input).value)
            assertEquals(canonical, ServerAddress.parse(input, allowLoopbackHttp = false).value)
        }
        assertEquals(ServerAddress.parse("http://example.test"), ServerAddress.parse("http://example.test:80/api"))
        // The scheme is part of the instance: an http:// address never stands for the https:// one.
        assertNotEquals(ServerAddress.parse("https://example.test"), ServerAddress.parse("http://example.test"))
    }

    @Test fun anAddressTypedWithoutASchemeIsHttps() {
        // The login page starts on orbitd.io and takes a host as iOS ServerURL does (fdeb033ad), but never assumes HTTP.
        assertEquals(ServerAddress.parse("https://orbitd.io"), ServerAddress.parse("orbitd.io"))
        assertEquals("https://example.test/team/", ServerAddress.parse(" example.test/team/api ").value)
        assertEquals("https://localhost:2086/", ServerAddress.parse("localhost:2086").value)
        assertEquals("https://192.168.1.5:2086/", ServerAddress.parse("192.168.1.5:2086").value)
        for (input in listOf("user:secret@example.test", "example.test?token=secret", "example.test/#secret", " ")) {
            val error = runCatching { ServerAddress.parse(input) }.exceptionOrNull()
            assertTrue(input, error is InvalidServerAddress)
            assertFalse(error!!.toString().contains("secret"))
        }
    }

    @Test fun endpointSegmentsCannotEscapeTheInstanceOrBecomeQueries() {
        val server = ServerAddress.parse("https://example.test/prefix")
        assertEquals("/prefix/api/sessions/https:%2F%2Fother.test%2F%3Ftoken=secret", server.endpoint(listOf("sessions", "https://other.test/?token=secret"), emptyList()).encodedPath)
        assertTrue(runCatching { server.endpoint(listOf(".."), emptyList()) }.isFailure)
    }
}
