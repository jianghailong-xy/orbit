package io.orbitd.android.reader

import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.text.*
import java.net.InetAddress
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.*
import okio.Buffer
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * A06e: a Markdown image on the open web loads over http as well as https, on any host, because iOS's
 * `MarkdownImageView.remoteURL` (MarkdownView.swift:736-738 at M2 9530c051f) takes both and the account owner
 * chose "any http host" on 2026-10-15 (card 34g6JcZwpKTUcwc5WvuVx). Every other source stays what it is on iOS:
 * no picture from the web.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class ExternalImageTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun httpIsAnExternalImageLikeHttpsOnAnyHost() {
        listOf("https://example.com/shot.png", "http://example.com/shot.png", "http://192.168.1.5:2086/shot.png",
            "http://[2001:db8::5]:2086/shot.png", "http://orbit.lan:8080/a/shot.png?size=2#top", "http://example.com/截图.png")
            .forEach { assertTrue(it, externalImage(it)) }
    }

    @Test fun otherSchemesAndMalformedAddressesStayRefused() {
        // iOS's prefix check is case-sensitive, so a capitalised scheme is no web image there either.
        listOf("HTTP://example.com/shot.png", "Https://example.com/shot.png", "ftp://example.com/shot.png",
            "file:///sdcard/shot.png", "content://media/external/images/1", "javascript:alert(1)",
            "http:example.com/shot.png", "//example.com/shot.png", "/shot.png",
            // No host, or no address at all: iOS may parse these, but nothing loads from them.
            "http:///shot.png", "http://", "http://[2001:db8::5/shot.png", "http://exa mple.com/shot.png")
            .forEach { assertFalse(it, externalImage(it)) }
        // Kept from A06, stricter than iOS (where URLSession would try them): an address that carries credentials.
        assertFalse(externalImage("https://reader:secret@example.com/shot.png"))
        assertFalse(externalImage("http://reader@192.168.1.5:2086/shot.png"))
    }

    @Test @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun theReaderDrawsAnHttpImageWithoutTheAccountsBearer() {
        val requested = CopyOnWriteArrayList<String>()
        val web = MockWebServer().apply {
            dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    requested += "${request.path} ${request.getHeader("Authorization") ?: "without a bearer"}"
                    return MockResponse().setBody(Buffer().write(FakeReaderServer.png))
                }
            }
            start(InetAddress.getByName("127.0.0.1"), 0)
        }
        try {
            val server = FakeReaderServer()
            val handle = runBlocking { server.signIn() }
            val resources = ReaderResources(server.auth, handle)
            val instanceCalls = server.calls.size
            val at = "127.0.0.1:${web.port}"
            compose.runOnUiThread { compose.activity.setContent { MaterialTheme {
                CompositionLocalProvider(LocalReaderResources provides resources) {
                    MarkdownText("![LAN screenshot](http://$at/shot.png)\n\n![Shouted](HTTP://$at/loud.png)", open = {})
                }
            } } }
            compose.waitUntil(20_000) { compose.onAllNodesWithContentDescription("LAN screenshot").fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithContentDescription("LAN screenshot").assertIsDisplayed()
            compose.waitUntil(20_000) { compose.onAllNodesWithText("Image unavailable · Retry").fetchSemanticsNodes().isNotEmpty() }
            assertEquals("one request, from the bare client; the capitalised scheme never left",
                listOf("/shot.png without a bearer"), requested)
            assertEquals("the instance was not asked for a web image", instanceCalls, server.calls.size)
        } finally { web.shutdown() }
    }
}
