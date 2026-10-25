package io.orbitd.android.auth

import android.app.Application
import io.orbitd.android.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File

/** The login page says main's iOS words, read from OrbitKit's `LoginFailure.swift` and OrbitApp's `LoginView.swift`, so a change
 * on either side fails here. A missing counterpart is a failure, never a skip (the *CopyParityTest rule). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = Application::class)
class LoginCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }
    private val failure = File(root, "src/macos/OrbitKit/Sources/OrbitKit/App/LoginFailure.swift").readText()
    private val view = File(root, "src/macos/OrbitApp/Sources/OrbitApp/Views/LoginView.swift").readText()
    private val model = File(root, "src/macos/OrbitApp/Sources/OrbitApp/AppModel.swift").readText()

    private fun text(id: Int) = RuntimeEnvironment.getApplication().getString(id)

    /** LoginFailure's `static let name = "…"`. */
    private fun swift(name: String) = Regex("""static let $name = "((?:[^"\\]|\\.)*)"""").find(failure)?.groupValues?.get(1)
        ?: throw AssertionError("LoginFailure.swift no longer declares $name")

    @Test fun aFailedPasswordSignInSaysWhatIosSays() {
        assertEquals(swift("rejected"), text(R.string.auth_credentials_error))
        assertEquals(swift("unreachable"), text(R.string.auth_network_error))
        assertEquals(swift("serverError"), text(R.string.auth_server_error))
        assertEquals(swift("unexpected"), text(R.string.auth_unexpected_error))
    }

    /** fdeb033ad: every word of the page and of the Server sheet is a literal in LoginView.swift; orbitd.io is AppModel's default. */
    @Test fun theLoginPageSaysWhatIosLoginViewSays() {
        assertTrue(model.contains("static let defaultInstance = \"$DEFAULT_INSTANCE\""))
        listOf(R.string.orbit_logo, R.string.change_server, R.string.welcome_back, R.string.sign_in_subtitle, R.string.email,
            R.string.password, R.string.password_placeholder, R.string.show_password, R.string.hide_password, R.string.sign_in_button,
            R.string.signing_in, R.string.or, R.string.continue_with_google, R.string.google_signup_hint, R.string.server_title,
            R.string.server_address, R.string.server_invalid, R.string.cancel, R.string.save,
        ).map(::text).forEach { words -> assertTrue("LoginView.swift no longer says \"$words\"", view.contains("\"$words\"")) }
        // Verbatim there, so the address isn't drawn as a link.
        assertTrue(view.contains("prompt: Text(verbatim: \"${text(R.string.email_placeholder)}\")"))
        // The sentences that name the default server: Android's %1${'$'}s is Swift's interpolation of it.
        for (id in listOf(R.string.server_hint, R.string.server_reset)) {
            val sentence = text(id).replace("%1${'$'}s", "\\(AppModel.defaultInstance)")
            assertTrue("LoginView.swift no longer says \"$sentence\"", view.contains("\"$sentence\""))
        }
    }

    /** LoginFailure.refusals: each code the server names, with iOS's sentence (a literal, or one of the static lets). */
    private fun refusals(): Map<String, String> {
        val block = failure.substringAfter("public static let refusals: [String: String] = [").substringBefore("\n    ]")
        return Regex("""^\s*"([A-Z_]+)": (?:"((?:[^"\\]|\\.)*)"|(\w+)),$""", RegexOption.MULTILINE).findAll(block)
            .associate { it.groupValues[1] to it.groupValues[2].ifEmpty { swift(it.groupValues[3]) } }
    }

    /** 56a2c8024: /start's GOOGLE_SIGN_IN_BUSY and GOOGLE_BAD_REQUEST say what to do, as every other refusal already did. */
    @Test fun everyCodeTheServerNamesSaysWhatIosSays() {
        val refusals = refusals()
        assertTrue("LoginFailure.swift's refusals could not be read", refusals.keys.containsAll(listOf("GOOGLE_SIGN_IN_BUSY", "GOOGLE_BAD_REQUEST")))
        for ((code, sentence) in refusals) {
            val message = refusalMessage(code) ?: throw AssertionError("Android has no sentence for $code")
            assertEquals(code, sentence, text(message.sentence()))
        }
        assertEquals(swift("googleFailed"), text(R.string.auth_google_failed))
        assertEquals(swift("googleCancelled"), text(R.string.auth_google_cancelled))
        assertEquals(swift("googleStateMismatch"), text(R.string.auth_google_state_mismatch))
        assertEquals(swift("googleTooMany"), text(R.string.auth_google_rate_limited))
    }
}
