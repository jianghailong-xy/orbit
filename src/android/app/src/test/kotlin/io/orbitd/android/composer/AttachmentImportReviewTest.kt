package io.orbitd.android.composer

import android.graphics.BitmapFactory
import android.net.Uri
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.attachments.importAttachment
import io.orbitd.android.attachments.decodeAttachmentImage
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
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.util.concurrent.ConcurrentHashMap

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AttachmentImportReviewTest {
    private suspend fun imported(source: String): List<String> {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val storage = ConcurrentHashMap<String, ByteArray>()
        val auth = AuthSession(HttpTransport { request ->
            ApiResponse(200, (if (request.api.path.first() == "auth")
                """{"accessToken":"a","refreshToken":"r","user":{"id":"u","email":"a@example.test","name":"A"}}"""
            else """{"id":"uploaded"}""").toByteArray())
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
        val model = ComposerModel(auth, (auth.state.value as AuthState.SignedIn).handle, "s", scope)
        try {
            withTimeout(10000) { model.state.first { it.loaded } }
            return (1..8).map { orientation ->
                val input = File("src/androidTest/assets/composer-images/exif-$orientation.jpg").absoluteFile
                assertTrue(input.exists())
                importAttachment(RuntimeEnvironment.getApplication(), model, Uri.fromFile(input), source)
                val state = withTimeout(10000) { model.state.first { it.uploads.isEmpty() && it.draft.attachments.size == orientation } }
                assertTrue(state.failures.toString(), state.failures.isEmpty())
                val data = model.attachmentBytes(state.draft.attachments.last().id)
                val image = BitmapFactory.decodeByteArray(data, 0, data.size)!!
                try {
                    val colors = listOf(1 to 1, 3 to 1, 1 to 3, 3 to 3).joinToString("") { (x, y) ->
                        val pixel = image.getPixel(image.width * x / 4, image.height * y / 4)
                        val r = android.graphics.Color.red(pixel); val g = android.graphics.Color.green(pixel); val b = android.graphics.Color.blue(pixel)
                        when { r > 180 && g > 180 -> "Y"; r > 180 -> "R"; g > 100 -> "G"; b > 180 -> "B"; else -> "?" }
                    }
                    "${image.width}x${image.height}:$colors"
                } finally { image.recycle() }
            }
        } finally { model.close(); scope.cancel() }
    }

    private val expected = listOf("72x48:RGBY", "72x48:GRYB", "72x48:YBGR", "72x48:BYRG",
        "48x72:RBGY", "48x72:BRYG", "48x72:YGBR", "48x72:GYRB")
    @Test fun photoImportNormalizesAllEightExifOrientations() = runBlocking { assertEquals(expected, imported("photo")) }
    @Test fun pastedImageNormalizesAllEightExifOrientations() = runBlocking { assertEquals(expected, imported("paste")) }

    @Test fun largePixelInputIsSampledBeforeAllocatingAndOrdinaryImageKeepsItsSize() {
        val input = File("src/androidTest/assets/composer-images/large-rgba.png")
        assertTrue(input.length() < 1024 * 1024)
        val bitmap = decodeAttachmentImage({ input.inputStream() })
        try {
            assertEquals(1500, bitmap.width); assertEquals(1500, bitmap.height)
            assertEquals(9_000_000, bitmap.allocationByteCount)
        } finally { bitmap.recycle() }
        val normal = decodeAttachmentImage({ File("src/androidTest/assets/composer-images/exif-1.jpg").inputStream() })
        try { assertEquals(72, normal.width); assertEquals(48, normal.height) } finally { normal.recycle() }
    }

    @Test fun originalExifJpegPreviewUsesTheSameOrientationWithoutRewritingTheFile() {
        val input = File("src/androidTest/assets/composer-images/exif-6.jpg")
        val original = input.readBytes()
        val image = decodeAttachmentImage({ original.inputStream() }, maxDimension = 2560)
        try {
            assertEquals(48, image.width); assertEquals(72, image.height)
            assertTrue(android.graphics.Color.blue(image.getPixel(8, 8)) > 180)
            assertTrue(android.graphics.Color.red(image.getPixel(40, 8)) > 180)
            assertArrayEquals(original, input.readBytes())
        } finally { image.recycle() }
    }
}
