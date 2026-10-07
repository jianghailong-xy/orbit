package io.orbitd.android.core.auth

import io.orbitd.android.core.net.ServerAddress
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test

class GoogleSignInTest {
    private val flows = GoogleSignIn()
    private val base64url = Regex("[A-Za-z0-9_-]{43}")

    private fun start(server: ServerAddress = serverA): HttpUrl = flows.begin(server).toHttpUrl()
    private fun HttpUrl.state() = queryParameter("client_state")!!

    @Test fun challengeIsTheRfc7636S256OfTheVerifier() {
        // RFC 7636 Appendix B.
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            GoogleSignIn.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
    }

    @Test fun beginOpensTheInstancesNativeStartWithAFreshChallengeAndState() {
        val url = start()
        assertEquals("https://orbit.example/team-a/api/auth/google/start", url.newBuilder().query(null).build().toString())
        assertEquals(listOf("client", "code_challenge", "client_state"), url.queryParameterNames.toList())
        assertEquals("native", url.queryParameter("client"))
        assertTrue(url.queryParameter("code_challenge")!!.matches(base64url))
        assertTrue(url.state().matches(base64url))
        val again = start()
        assertNotEquals(url.queryParameter("code_challenge"), again.queryParameter("code_challenge"))
        assertNotEquals(url.state(), again.state())
    }

    @Test fun aTicketWithTheStartedStateIsExchangedOnceWithTheVerifierOfTheChallenge() {
        val url = start(serverB)
        val callback = flows.complete("orbit://auth/google?ticket=fixture-ticket&state=${url.state()}")
        assertTrue(callback is GoogleCallback.Ticket)
        callback as GoogleCallback.Ticket
        assertEquals(serverB, callback.server)
        assertEquals("fixture-ticket", callback.ticket)
        assertTrue(callback.codeVerifier.matches(base64url))
        assertEquals(url.queryParameter("code_challenge"), GoogleSignIn.challenge(callback.codeVerifier))
        assertFalse(callback.toString().contains("fixture-ticket") || callback.toString().contains(callback.codeVerifier))
        // A sign-in has one answer: the same address again finds none waiting.
        assertEquals(GoogleCallback.Interrupted, flows.complete("orbit://auth/google?ticket=fixture-ticket&state=${url.state()}"))
    }

    @Test fun anErrorWithTheStartedStateEndsTheSignInWithItsCode() {
        val state = start().state()
        assertEquals(GoogleCallback.Refused("GOOGLE_ACCOUNT_NOT_FOUND"),
            flows.complete("orbit://auth/google?error=GOOGLE_ACCOUNT_NOT_FOUND&state=$state"))
        assertEquals(GoogleCallback.Interrupted, flows.complete("orbit://auth/google?ticket=fixture-ticket&state=$state"))

        val withTicket = start().state()
        assertEquals("an error beside a ticket still refuses", GoogleCallback.Refused("GOOGLE_CANCELLED"),
            flows.complete("orbit://auth/google?ticket=fixture-ticket&error=GOOGLE_CANCELLED&state=$withTicket"))
        val empty = start().state()
        assertEquals(GoogleCallback.Refused(null), flows.complete("orbit://auth/google?state=$empty"))
        val blank = start().state()
        assertEquals(GoogleCallback.Refused(null), flows.complete("orbit://auth/google?ticket=&error=&state=$blank"))
    }

    @Test fun anotherStateIsNeverUsedAndTheSignInKeepsWaiting() {
        val first = start().state()
        val state = start().state()
        for (other in listOf(
            "orbit://auth/google?ticket=fixture-ticket&state=$first",
            "orbit://auth/google?ticket=fixture-ticket&state=other",
            "orbit://auth/google?ticket=fixture-ticket",
            "orbit://auth/google?error=GOOGLE_CANCELLED&state=other",
            "orbit://auth/google?ticket=fixture-ticket&state=${state.dropLast(1)}",
            "orbit://auth/google?ticket=fixture-ticket&state=$state&state=$state",
        )) {
            assertEquals(other, GoogleCallback.StateMismatch, flows.complete(other))
        }
        assertTrue(flows.complete("orbit://auth/google?ticket=fixture-ticket&state=$state") is GoogleCallback.Ticket)
    }

    @Test fun anAnswerWithNoSignInWaitingIsAnInterruption() {
        // A process restarted while the browser was open starts with nothing: the verifier went with it.
        assertEquals(GoogleCallback.Interrupted, GoogleSignIn().complete("orbit://auth/google?ticket=fixture-ticket&state=s"))
        val state = start().state()
        flows.abandon()
        assertEquals(GoogleCallback.Interrupted, flows.complete("orbit://auth/google?ticket=fixture-ticket&state=$state"))
    }

    @Test fun otherAddressesAreNotGoogleAnswersAndLeaveTheSignInWaiting() {
        val state = start().state()
        for (other in listOf(
            "orbit://session/1",
            "orbit://auth/other?ticket=fixture-ticket&state=$state",
            "orbit://auth/google/?ticket=fixture-ticket&state=$state",
            "orbit://auth/google/extra?ticket=fixture-ticket&state=$state",
            "https://orbit.example/auth/google?ticket=fixture-ticket&state=$state",
            "orbit://user@auth/google?ticket=fixture-ticket&state=$state",
            "orbit://auth:1/google?ticket=fixture-ticket&state=$state",
            "orbit:auth/google?ticket=fixture-ticket&state=$state",
            "orbit://auth/google?ticket=fixture-ticket&state=%zz",
            "not a uri",
            "",
        )) {
            assertEquals(other, GoogleCallback.NotGoogle, flows.complete(other))
        }
        assertTrue(flows.complete("orbit://auth/google?ticket=fixture-ticket&state=$state") is GoogleCallback.Ticket)
    }

    @Test fun percentEncodedValuesAreDecoded() {
        val state = start().state()
        val callback = flows.complete("orbit://auth/google?ticket=a%2Db%5Fc&state=$state") as GoogleCallback.Ticket
        assertEquals("a-b_c", callback.ticket)
        val refused = start().state()
        assertEquals(GoogleCallback.Refused("GOOGLE_FLOW_EXPIRED"),
            flows.complete("orbit://auth/google?error=GOOGLE%5FFLOW%5FEXPIRED&state=$refused"))
    }
}
