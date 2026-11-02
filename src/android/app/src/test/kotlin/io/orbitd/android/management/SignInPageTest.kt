package io.orbitd.android.management

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Where a sign-in may send a browser: the card opens what the runner reported only through [signInPage] (web RunnerSignIn). */
class SignInPageTest {
    /** The sign-in link of each engine, in the shape its CLI prints it (runner-go's own login fixtures). */
    private val engineLinks = listOf(
        "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=frcAznfHKdQ3nNYn157q799r9SIaDMeJqq9HqdHD2JQ&code_challenge_method=S256&state=D_hsM6JpU6Uy2Ji8q0WtyOhF_Lq8iTIkuetcNISuRs",
        "https://auth.openai.com/codex/device",
        "https://www.kimi.com/code/authorize_device?user_code=SHG3-0DSI",
        "https://www.kimi.ai/code/authorize_device?user_code=7K06-QP86",
        "https://auth.kimi.com/verify?user_code=WDJB-MJHT",
        "https://accounts.google.com/o/oauth2/auth?response_type=code&state=fixture&code_challenge=fixture",
        "https://cursor.com/loginDeepControl?challenge=Q2hhbGxlbmdl&uuid=7d2e0c1a-0000-4000-8000-000000000001&mode=login&redirectTarget=cli&supportsSelectedTeamLogin=true",
    )

    /** Addresses no sign-in has: other schemes in the spellings a browser reads as them, and no address at all. */
    private val notHttpsLinks = listOf(
        "javascript:void(0)", "JAVASCRIPT:void(0)", "JaVaScRiPt:void(0)", " javascript:void(0)", "  JaVaScRiPt:void(0)",
        "\tjavascript:void(0)", "\njavascript:void(0)", "\u0001javascript:void(0)", "java\tscript:void(0)", "java\nscript:void(0)",
        "java\rscript:void(0)", "javascript\t:void(0)",
        "data:text/html,hello", "DATA:text/html,hello", " data:text/html,hello", "data:text/html;base64,aGVsbG8=", "da\tta:text/html,hello",
        "vbscript:msgbox(0)", "VBScript:msgbox(0)", " vbscript:msgbox(0)",
        "http://claude.com/cai/oauth/authorize?code=true", "HTTP://claude.com/", "http://localhost:1455/auth/callback",
        "file:///etc/hosts", "blob:https://orbit.test/1", "about:blank", "ftp://claude.com/", "mailto:someone@example.test", "orbit-task:1",
        "/runners", "claude.com/cai/oauth/authorize", "//claude.com/cai/oauth/authorize", "https:", "https://", "",
    )

    @Test fun theLinkOfEveryEngineOpensAsItsCliPrintedIt() {
        engineLinks.forEach { assertEquals(it, signInPage(it)) }
    }

    @Test fun aLinkThatIsNotHttpsIsNotAPage() {
        notHttpsLinks.forEach { assertNull(it, signInPage(it)) }
    }

    @Test fun thereIsNothingToOpenBeforeALinkIsReported() {
        assertNull(signInPage(null))
    }
}
