package io.orbitd.android.auth

import io.orbitd.android.core.auth.SecureStorageException
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.InvalidServerAddress
import io.orbitd.android.core.net.NetworkException
import io.orbitd.android.core.protocol.ProtocolException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AuthMessagesTest {
    private fun refusal(status: Int, code: String? = null) = ApiError.parse(status,
        (if (code == null) """{"message":"refused"}""" else """{"code":"$code","message":"refused"}""").encodeToByteArray())

    @Test fun everyCodeTheServerSendsHasItsOwnMessage() {
        val codes = mapOf(
            "ACCOUNT_DISABLED" to AuthMessage.ACCOUNT_DISABLED,
            "SETUP_REQUIRED" to AuthMessage.SETUP_REQUIRED,
            "GOOGLE_NOT_CONFIGURED" to AuthMessage.GOOGLE_NOT_CONFIGURED,
            "GOOGLE_RATE_LIMITED" to AuthMessage.GOOGLE_RATE_LIMITED,
            "GOOGLE_SIGN_IN_BUSY" to AuthMessage.GOOGLE_SIGN_IN_BUSY,
            "GOOGLE_BAD_REQUEST" to AuthMessage.GOOGLE_BAD_REQUEST,
            "GOOGLE_FLOW_EXPIRED" to AuthMessage.GOOGLE_FLOW_EXPIRED,
            "GOOGLE_CANCELLED" to AuthMessage.GOOGLE_CANCELLED,
            "GOOGLE_EXCHANGE_FAILED" to AuthMessage.GOOGLE_EXCHANGE_FAILED,
            "GOOGLE_EMAIL_UNVERIFIED" to AuthMessage.GOOGLE_EMAIL_UNVERIFIED,
            "GOOGLE_FLOW_MISMATCH" to AuthMessage.GOOGLE_FLOW_MISMATCH,
            "GOOGLE_EMAIL_AMBIGUOUS" to AuthMessage.GOOGLE_EMAIL_AMBIGUOUS,
            "GOOGLE_ACCOUNT_MISMATCH" to AuthMessage.GOOGLE_ACCOUNT_MISMATCH,
            "GOOGLE_EMAIL_NOT_AUTHORITATIVE" to AuthMessage.GOOGLE_EMAIL_NOT_AUTHORITATIVE,
            "GOOGLE_ACCOUNT_NOT_FOUND" to AuthMessage.GOOGLE_ACCOUNT_NOT_FOUND,
        )
        codes.forEach { (code, message) -> assertEquals(code, message, refusalMessage(code)) }
        assertEquals(codes.size, codes.values.toSet().size)
        // A code arrives in a URL or a body, so anything at all may: only the codes above have a sentence.
        for (other in listOf(null, "", "google_cancelled", "toString", "NETWORK", "INVALID_CREDENTIALS")) {
            assertNull(other, refusalMessage(other))
        }
    }

    @Test fun aPasswordLoginReadsTheCodeBeforeTheStatus() {
        assertEquals(AuthMessage.INVALID_CREDENTIALS, messageFor(refusal(401)))
        assertEquals(AuthMessage.ACCOUNT_DISABLED, messageFor(refusal(401, "ACCOUNT_DISABLED")))
        assertEquals(AuthMessage.ACCOUNT_DISABLED, messageFor(refusal(403, "ACCOUNT_DISABLED")))
        assertEquals(AuthMessage.SERVER, messageFor(refusal(403, "SOMETHING_NEW")))
        assertEquals(AuthMessage.SERVER, messageFor(refusal(500)))
        assertEquals(AuthMessage.INVALID_ADDRESS, messageFor(InvalidServerAddress()))
        assertEquals(AuthMessage.STORAGE, messageFor(SecureStorageException()))
        assertEquals(AuthMessage.NETWORK, messageFor(NetworkException()))
        assertEquals(AuthMessage.SERVER, messageFor(ProtocolException()))
    }

    @Test fun aGoogleExchangeNeverReadsAsAWrongPassword() {
        assertEquals(AuthMessage.GOOGLE_ACCOUNT_NOT_FOUND, googleMessageFor(refusal(403, "GOOGLE_ACCOUNT_NOT_FOUND")))
        assertEquals(AuthMessage.GOOGLE_FLOW_MISMATCH, googleMessageFor(refusal(400, "GOOGLE_FLOW_MISMATCH")))
        assertEquals(AuthMessage.ACCOUNT_DISABLED, googleMessageFor(refusal(403, "ACCOUNT_DISABLED")))
        // The exchange's rate limit answers 429 without a code.
        assertEquals(AuthMessage.GOOGLE_RATE_LIMITED, googleMessageFor(refusal(429)))
        assertEquals(AuthMessage.GOOGLE_FAILED, googleMessageFor(refusal(401)))
        assertEquals(AuthMessage.GOOGLE_FAILED, googleMessageFor(refusal(400, "SOMETHING_NEW")))
        assertEquals(AuthMessage.SERVER, googleMessageFor(refusal(503)))
        assertEquals(AuthMessage.STORAGE, googleMessageFor(SecureStorageException()))
        assertEquals(AuthMessage.NETWORK, googleMessageFor(NetworkException()))
        assertEquals(AuthMessage.SERVER, googleMessageFor(ProtocolException()))
    }
}
