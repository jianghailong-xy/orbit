package io.orbitd.android.share

import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.auth.GoogleSignInRedirectActivity
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowToast

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
class ShareIntentsTest {
    private val app get() = RuntimeEnvironment.getApplication()
    private fun uri(n: Int) = Uri.parse("content://io.example.files/shared/$n")
    private fun send(stream: Uri? = null, text: String? = null, type: String = "*/*") = Intent(Intent.ACTION_SEND).setType(type).also {
        stream?.let { s -> it.putExtra(Intent.EXTRA_STREAM, s) }
        text?.let { t -> it.putExtra(Intent.EXTRA_TEXT, t) }
    }
    private fun sendMultiple(count: Int) = Intent(Intent.ACTION_SEND_MULTIPLE).setType("image/*")
        .putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList((1..count).map(::uri)))

    @After fun reset() { ShareSignIn.waiting = false }

    @Test fun singleFile() {
        val items = ShareIntents.parse(send(stream = uri(1), type = "application/pdf"))
        assertEquals(listOf(uri(1)), items.uris)
        assertNull(items.text)
        assertEquals(0, items.dropped)
    }

    @Test fun singleFileOnlyInClipData() {
        val intent = Intent(Intent.ACTION_SEND).setType("image/png")
        intent.clipData = android.content.ClipData.newRawUri(null, uri(7))
        assertEquals(listOf(uri(7)), ShareIntents.parse(intent).uris)
    }

    @Test fun multipleFiles() {
        val items = ShareIntents.parse(sendMultiple(3))
        assertEquals((1..3).map(::uri), items.uris)
        assertEquals(0, items.dropped)
    }

    @Test fun moreThanTenItemsKeepsTheFirstTen() {
        val items = ShareIntents.parse(sendMultiple(12))
        assertEquals((1..10).map(::uri), items.uris)
        assertEquals(2, items.dropped)
        assertEquals("Only the first 10 of 12 items were added.", ShareCopy.keptFirst(items.count + items.dropped))
    }

    @Test fun tenFilesAndTextDropTheText() {
        val intent = sendMultiple(10).putExtra(Intent.EXTRA_TEXT, "caption")
        val items = ShareIntents.parse(intent)
        assertEquals(10, items.uris.size)
        assertNull(items.text)
        assertEquals(1, items.dropped)
    }

    @Test fun plainTextGoesIntoTheComposerText() {
        val items = ShareIntents.parse(send(text = "  Remember the release notes  ", type = "text/plain"))
        assertTrue(items.uris.isEmpty())
        assertEquals("Remember the release notes", items.text)
        assertEquals(SharedText.Inline("Remember the release notes"), ShareIntents.route(items.text!!))
    }

    @Test fun linkGoesIntoTheComposerText() {
        val link = "https://example.com/articles/42?ref=share"
        val items = ShareIntents.parse(send(text = link, type = "text/plain"))
        assertTrue(ShareIntents.isLink(items.text!!))
        assertEquals(SharedText.Inline(link), ShareIntents.route(items.text!!))
        // A link stays a link however long it is.
        val long = "https://example.com/" + "a".repeat(2_500)
        assertEquals(SharedText.Inline(long), ShareIntents.route(long))
    }

    @Test fun aLinksPreviewThumbnailIsNotAnItem() {
        // Chrome shares a page as EXTRA_TEXT with its thumbnail in the clip, for the share sheet's preview.
        val intent = send(text = "https://example.com/release-notes", type = "text/plain")
        intent.clipData = android.content.ClipData.newRawUri(null, uri(9))
        val items = ShareIntents.parse(intent)
        assertTrue(items.uris.isEmpty())
        assertEquals("https://example.com/release-notes", items.text)
    }

    @Test fun textUpToTwoThousandCharactersStaysInline() {
        val exactly = "x".repeat(2_000)
        assertEquals(SharedText.Inline(exactly), ShareIntents.route(exactly))
    }

    @Test fun textOverTwoThousandCharactersBecomesSharedTextTxt() {
        val long = "word ".repeat(401).trim() + "!"  // 2,005 characters
        assertTrue(long.length > 2_000)
        val routed = ShareIntents.route(ShareIntents.parse(send(text = long, type = "text/plain")).text!!)
        routed as SharedText.File
        assertEquals("shared-text.txt", routed.name)
        assertEquals(long, routed.bytes.decodeToString())
    }

    @Test fun anyOtherIntentSharesNothing() {
        assertTrue(ShareIntents.parse(Intent(Intent.ACTION_VIEW, uri(1))).isEmpty)
        assertNull(ShareIntents.receive(Intent(Intent.ACTION_VIEW, uri(1))))
    }

    @Test fun handoffCarriesTheTargetTextAndUrisWithAReadGrant() {
        val items = ShareIntents.parse(sendMultiple(2).putExtra(Intent.EXTRA_TEXT, "see these"))
        val intent = ShareIntents.handoff(app, ShareTarget.Session("s1", "w1"), items)
        assertEquals(ComponentName(app, MainActivity::class.java), intent.component)
        assertTrue(intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
        val back = ShareIntents.receive(intent)!!
        assertEquals(ShareTarget.Session("s1", "w1"), back.target)
        assertEquals((1..2).map(::uri), back.uris)
        assertEquals("see these", back.text)
        val draft = ShareIntents.receive(ShareIntents.handoff(app, ShareTarget.NewSession("w2"), ShareIntents.parse(send(text = "hi"))))!!
        assertEquals(ShareTarget.NewSession("w2"), draft.target)
        assertTrue(draft.uris.isEmpty())
    }

    @Test fun anEndedSessionGivesWayToANewSessionDraftInItsWorkspace() {
        val handoff = ShareHandoff(ShareTarget.Session("s1", "w1"), emptyList(), null)
        assertEquals(ShareTarget.Session("s1", "w1"), handoff.landing { it == "s1" })
        assertEquals(ShareTarget.NewSession("w1"), handoff.landing { false })
        assertEquals(ShareTarget.NewSession("w3"), ShareHandoff(ShareTarget.NewSession("w3"), emptyList(), null).landing { false })
    }

    @Test fun manifestOffersOrbitForFilesImagesTextAndMultiples() {
        val pm = app.packageManager
        listOf(send(stream = uri(1), type = "application/pdf"), send(stream = uri(1), type = "image/png"),
            send(text = "https://example.com", type = "text/plain"), sendMultiple(2)).forEach { intent ->
            val found = pm.queryIntentActivities(intent.addCategory(Intent.CATEGORY_DEFAULT), 0).map { it.activityInfo.name }
            assertTrue("${intent.action} ${intent.type}: $found", ShareActivity::class.java.name in found)
        }
        val info = pm.getActivityInfo(ComponentName(app, ShareActivity::class.java), 0)
        assertTrue(info.exported)
    }

    @Test fun moreThanTenItemsToastsWhenTheShareOpens() {
        Robolectric.buildActivity(ShareActivity::class.java, sendMultiple(11)).setup().use {
            assertEquals("Only the first 10 of 11 items were added.", ShadowToast.getTextOfLatestToast())
        }
    }

    @Test fun googleSignInStartedFromTheShareComesBackToIt() {
        val callback = "orbit://auth/google?ticket=t&state=s"
        ShareSignIn.waiting = true
        val redirect = Robolectric.buildActivity(GoogleSignInRedirectActivity::class.java,
            Intent(Intent.ACTION_VIEW, Uri.parse(callback))).create().get()
        val forwarded = shadowOf(redirect).nextStartedActivity
        assertEquals(ComponentName(app, ShareActivity::class.java), forwarded.component)
        assertEquals(callback, forwarded.dataString)
    }
}
