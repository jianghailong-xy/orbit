package io.orbitd.android.share

import android.net.Uri
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.composer.ComposerModel
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.ContinuationInterceptor

/** The hand-off's far end: what was shared lands in the target composer as staged attachments and words, and nothing is sent. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
class ShareDeliveryTest {
    private val paths: MutableList<String> = Collections.synchronizedList(mutableListOf())

    private suspend fun composer(scope: CoroutineScope): ComposerModel {
        val storage = ConcurrentHashMap<String, ByteArray>()
        val auth = AuthSession(HttpTransport { request ->
            paths += "${request.api.method} ${request.api.path.joinToString("/")}"
            ApiResponse(200, (if (request.api.path.first() == "auth")
                """{"accessToken":"a","refreshToken":"r","user":{"id":"u","email":"a@example.test","name":"A"}}"""
            else """{"id":"uploaded-${paths.size}"}""").toByteArray())
        }, object : CredentialStore {
            override suspend fun load(): StoredSession? = null
            override suspend fun save(session: StoredSession) = Unit
            override suspend fun clear() = Unit
        }, object : InstanceStore {
            override suspend fun load(): String? = null
            override suspend fun save(server: String) = Unit
        }, object : SessionDataStore {
            override suspend fun read(account: AccountKey, kind: DataKind, key: String) = storage[key]
            override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) { storage[key] = bytes }
            override suspend fun clearAll() { storage.clear() }
        }, "test")
        auth.login(ServerAddress.parse("https://one.example"), "a@example.test", "password")
        return ComposerModel(auth, (auth.state.value as AuthState.SignedIn).handle, "s1", scope)
    }

    /** The model on the test's own thread, as the app keeps it on the main one (OrbitApplication.processScope). Its uploads map has
     * no lock, and neither has the list Robolectric's ContentResolver keeps URI grants in: on a pool, one upload releasing its grant
     * while the next file took one threw ConcurrentModificationException. */
    private fun CoroutineScope.modelScope() = CoroutineScope(SupervisorJob() + coroutineContext[ContinuationInterceptor]!!)

    private fun file(name: String, bytes: ByteArray): Uri =
        Uri.fromFile(File(RuntimeEnvironment.getApplication().cacheDir, name).apply { writeBytes(bytes) })

    @Test fun filesAndAShortLinkAreStagedAndNothingIsSent() = runBlocking {
        val scope = modelScope()
        val model = composer(scope)
        try {
            withTimeout(60_000) { model.state.first { it.loaded } }
            model.edit("My notes", 8, 8)
            val handoff = ShareHandoff(ShareTarget.Session("s1", "w1"),
                listOf(file("report.pdf", "%PDF-1.4 fixture".toByteArray()), file("diagram.png", ByteArray(64) { it.toByte() })),
                "https://example.com/a")
            assertTrue(deliverShare(RuntimeEnvironment.getApplication(), model, handoff))
            val state = withTimeout(60_000) { model.state.first { s -> s.uploads.isEmpty() && s.draft.attachments.size == 2 && s.draft.attachments.all { it.remoteId != null } } }
            assertEquals("My notes\n\nhttps://example.com/a", state.draft.text)
            assertEquals(setOf(16, 64), state.draft.attachments.map { it.size }.toSet())
            assertNull("no upload failed", state.error)
            // Uploads only: no message, no session created.
            // A snapshot under the list's lock: the transport may still be appending from another thread.
            val sent = synchronized(paths) { paths.toList() }.filterNot { it.contains("auth/") || it.endsWith("attachments") }
            assertEquals(emptyList<String>(), sent)
        } finally { model.close(); scope.cancel() }
    }

    @Test fun longTextBecomesASharedTextAttachment() = runBlocking {
        val scope = modelScope()
        val model = composer(scope)
        try {
            withTimeout(60_000) { model.state.first { it.loaded } }
            val long = "a".repeat(2_001)
            assertTrue(deliverShare(RuntimeEnvironment.getApplication(), model, ShareHandoff(ShareTarget.NewSession("w1"), emptyList(), long)))
            val state = withTimeout(60_000) { model.state.first { s -> s.uploads.isEmpty() && s.draft.attachments.singleOrNull()?.remoteId != null } }
            assertEquals("", state.draft.text)
            val staged = state.draft.attachments.single()
            assertEquals("shared-text.txt", staged.name)
            assertEquals("text/plain", staged.mime)
            assertEquals(long, model.attachmentBytes(staged.id).decodeToString())
        } finally { model.close(); scope.cancel() }
    }

    @Test fun anOversizedFileFollowsTheExistingRejectPath() = runBlocking {
        val scope = modelScope()
        val model = composer(scope)
        try {
            withTimeout(60_000) { model.state.first { it.loaded } }
            val big = file("huge.bin", ByteArray(25 * 1024 * 1024 + 1))
            deliverShare(RuntimeEnvironment.getApplication(), model, ShareHandoff(ShareTarget.Session("s1", "w1"), listOf(big), null))
            // Refused as iOS refuses it (Attachments.rejectReason): the chip goes and the error line above the box gives the reason.
            val state = withTimeout(60_000) { model.state.first { it.uploads.isEmpty() && it.error != null } }
            assertEquals("File exceeds the 25MB limit", state.error)
            assertTrue(state.draft.attachments.isEmpty())
        } finally { model.close(); scope.cancel() }
    }
}
