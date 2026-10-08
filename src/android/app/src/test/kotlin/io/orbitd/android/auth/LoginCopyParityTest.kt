package io.orbitd.android.auth

import android.app.Application
import io.orbitd.android.R
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File

/** The login page says main's iOS words, read from OrbitKit's `LoginFailure.swift`, so a change on either side fails here. A
 * missing counterpart is a failure, never a skip (the *CopyParityTest rule). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = Application::class)
class LoginCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }
    private val failure = File(root, "src/macos/OrbitKit/Sources/OrbitKit/App/LoginFailure.swift").readText()

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
}
