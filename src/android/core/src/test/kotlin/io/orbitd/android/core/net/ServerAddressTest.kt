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
        for (input in listOf("", "file:///secret", "http://example.test", "https://user:secret@example.test", "https://example.test?token=secret", "https://example.test/#secret", "https://example.test/\\secret")) {
            val error = runCatching { ServerAddress.parse(input) }.exceptionOrNull()
            assertTrue(error is InvalidServerAddress)
            assertFalse(error!!.toString().contains("secret"))
        }
        assertTrue(runCatching { ServerAddress.parse("http://127.0.0.1:8080") }.isFailure)
        assertEquals("http://127.0.0.1:8080/", ServerAddress.parse("http://127.0.0.1:8080", true).value)
        assertTrue(runCatching { ServerAddress.parse("http://127.0.0.1.attacker.test", true) }.isFailure)
    }

    @Test fun endpointSegmentsCannotEscapeTheInstanceOrBecomeQueries() {
        val server = ServerAddress.parse("https://example.test/prefix")
        assertEquals("/prefix/api/sessions/https:%2F%2Fother.test%2F%3Ftoken=secret", server.endpoint(listOf("sessions", "https://other.test/?token=secret"), emptyList()).encodedPath)
        assertTrue(runCatching { server.endpoint(listOf(".."), emptyList()) }.isFailure)
    }
}
