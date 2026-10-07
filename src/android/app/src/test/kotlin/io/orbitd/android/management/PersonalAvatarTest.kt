package io.orbitd.android.management

import android.graphics.Bitmap
import android.graphics.Color
import android.content.Context
import androidx.activity.result.contract.ActivityResultContracts
import androidx.test.core.app.ApplicationProvider
import android.provider.MediaStore
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class PersonalAvatarTest {
    @Test fun fullResolutionCameraUsesScopedTemporaryOutputAndCleanupRemovesIt() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val capture = personalPrepareCamera(context)
        assertTrue(capture.file.exists())
        assertTrue(capture.file.canonicalPath.startsWith(context.cacheDir.canonicalPath + "/handoff/avatar-"))
        assertEquals("${context.packageName}.attachments", capture.uri.authority)
        val intent = ActivityResultContracts.TakePicture().createIntent(context, capture.uri)
        assertEquals(MediaStore.ACTION_IMAGE_CAPTURE, intent.action)
        @Suppress("DEPRECATION")
        assertEquals(capture.uri, intent.getParcelableExtra<android.net.Uri>(MediaStore.EXTRA_OUTPUT))
        capture.close(context)
        assertFalse(capture.file.exists())
        assertFalse(capture.file.parentFile!!.exists())
    }

    @Test fun cropStaysSquareWithinImageAtEveryEdgeAndZoomAndNeverUpscales() {
        val source = Bitmap.createBitmap(100, 60, Bitmap.Config.ARGB_8888)
        source.eraseColor(Color.RED)
        for (x in listOf(-1f, 0f, .5f, 1f, 2f)) for (y in listOf(-1f, 0f, 1f, 2f)) for (zoom in listOf(0f, 1f, 5f, 9f)) {
            val cropped = personalCropPhoto(source, zoom, x, y)
            val side = (60 / zoom.coerceIn(1f, 5f)).toInt()
            assertEquals(side, cropped.width); assertEquals(side, cropped.height)
            assertEquals(Color.RED, cropped.getPixel(0, 0))
            assertEquals(Color.RED, cropped.getPixel(side - 1, side - 1))
        }
        val large = Bitmap.createBitmap(1024, 900, Bitmap.Config.ARGB_8888)
        assertEquals(512, personalCropPhoto(large, 1f, .5f, .5f).width)
    }

    @Test fun transparentPhotoIsDrawnOnWhiteAsOrbitAvatarJpegDoes() {
        val source = Bitmap.createBitmap(40, 40, Bitmap.Config.ARGB_8888)
        source.eraseColor(Color.TRANSPARENT)
        assertEquals(Color.WHITE, personalCropPhoto(source, 1f, .5f, .5f).getPixel(10, 10))
    }
}
