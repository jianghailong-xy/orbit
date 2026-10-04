package io.orbitd.android.core.protocol

import io.orbitd.android.core.auth.StoredSession
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpRequest
import io.orbitd.android.core.net.ServerAddress
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

class WireTest {
    private fun fixture(name: String) = javaClass.getResourceAsStream("/wire/$name.json")!!.use { it.readBytes() }

    @Test fun authAcceptsUnknownFieldsButRequiresACompleteCurrentServerTokenPair() {
        val tokens = Wire.decode(fixture("auth"), LoginResponse.serializer())
        assertEquals("u1", tokens.user.id)
        assertEquals("ADMIN", tokens.user.role)
        // Old OrbitKit's pre-refresh login fixture is intentionally rejected for the fixed server contract.
        val old = """{"accessToken":"jwt.abc.def","user":{"id":"u1","email":"a@b.com","name":"A","role":"ADMIN"}}"""
        assertTrue(runCatching { Wire.decode(old.encodeToByteArray(), LoginResponse.serializer()) }.exceptionOrNull() is ProtocolException)
        val optional = Wire.decode("""{"id":"u1","email":"a@example.test","name":"A"}""".encodeToByteArray(), User.serializer())
        assertNull(optional.role)
    }

    @Test fun sessionsKeepUnknownEnumsAndNeverInventActionsFromStatus() {
        val rows = Wire.decode(fixture("sessions"), ListSerializer(SessionSummary.serializer()))
        assertEquals(4, rows.size)
        assertTrue(rows[0].allows(SessionAction.COMPLETE))
        assertFalse(rows[0].allows(SessionAction.RESUME))
        assertNull(rows[1].capabilities)
        assertNull(rows[1].title)
        assertTrue(SessionAction.entries.none(rows[1]::allows))
        assertEquals("FUTURE_STATUS", rows[2].status)
        assertEquals("FUTURE_REASON", rows[2].capabilities!!.resumeBlockedReason)
        assertTrue(rows[2].allows(SessionAction.COMPLETE))
        assertFalse(rows[3].allows(SessionAction.COMPLETE))
        assertFalse(rows[3].allows(SessionAction.SEND))
    }

    @Test fun errorsRetainTheCodeAndWholeBodyWithoutPuttingServerDataInExceptionText() {
        val error = ApiError.parse(409, fixture("error"))
        assertEquals("STALE_CONFIG_REVISION", error.code)
        assertEquals(2, error.messages.size)
        assertTrue(error.body!!.jsonObject.containsKey("futureAdvisory"))
        assertEquals("Request failed (HTTP 409)", error.message)
        assertNull(ApiError.parse(502, "<html>gateway</html>".encodeToByteArray()).body)
        assertEquals(emptyList<String>(), ApiError.parse(500, byteArrayOf()).messages)
        assertEquals(listOf("one"), ApiError.parse(400, """{"message":"one"}""".encodeToByteArray()).messages)
    }

    @Test fun credentialBearingObjectsAndDecodeErrorsAreRedacted() {
        val tokens = Wire.decode(fixture("auth"), LoginResponse.serializer())
        val objects = listOf(tokens, LoginRequest("a@example.test", "fixture-password"),
            RefreshRequest(tokens.refreshToken), StoredSession("https://example.test/", tokens),
            HttpRequest(ServerAddress.parse("https://example.test"), ApiRequest(listOf("auth", "login"), body = fixture("auth")), "test", tokens.accessToken))
        for (obj in objects) {
            assertFalse(obj.toString().contains("fixture-access"))
            assertFalse(obj.toString().contains("fixture-refresh"))
            assertFalse(obj.toString().contains("fixture-password"))
        }
        val malformed = """{"accessToken":"fixture-secret", "refreshToken": broken}"""
        val error = runCatching { Wire.decode(malformed.encodeToByteArray(), LoginResponse.serializer()) }.exceptionOrNull()!!
        assertFalse(error.stackTraceToString().contains("fixture-secret"))
        val apiError = ApiError.parse(400, """{"message":"fixture-secret", "code":"fixture-secret"}""".encodeToByteArray())
        assertFalse(apiError.stackTraceToString().contains("fixture-secret"))
        val badHeader = """{"accessToken":"fixture-secret\ninvalid","refreshToken":"fixture-refresh","user":{"id":"u1","email":"a@example.test","name":"A"}}"""
        val invalid = runCatching { Wire.decode(badHeader.encodeToByteArray(), LoginResponse.serializer()) }.exceptionOrNull()!!
        assertTrue(invalid is ProtocolException)
        assertFalse(invalid.stackTraceToString().contains("fixture-secret"))
    }
}
