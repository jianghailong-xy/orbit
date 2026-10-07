package io.orbitd.android.management

import android.graphics.Bitmap
import android.graphics.Color
import android.content.Context
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
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

    /** OrbitKit SettingsHomeTests: the crop starts with the photo just covering the circle, and never lets it uncover. */
    @Test fun theCropStartsCoveringTheCircleAndKeepsItCovered() {
        assertEquals(Size(400f, 300f), AvatarCrop.fitted(Size(4000f, 3000f), 300f))
        assertEquals(Size(300f, 400f), AvatarCrop.fitted(Size(3000f, 4000f), 300f))
        assertEquals(1f, AvatarCrop.clampedZoom(.5f)); assertEquals(2f, AvatarCrop.clampedZoom(2f)); assertEquals(AvatarCrop.maxZoom, AvatarCrop.clampedZoom(9f))
        val fitted = Size(400f, 300f)
        assertEquals("a landscape photo slides sideways only, and only 50px", Offset(50f, 0f), AvatarCrop.clampedOffset(Offset(80f, 30f), fitted, 300f, 1f))
        assertEquals(Offset(-50f, 0f), AvatarCrop.clampedOffset(Offset(-80f, -30f), fitted, 300f, 1f))
        assertEquals("zoomed in, there is room to move both ways", Offset(200f, -100f), AvatarCrop.clampedOffset(Offset(200f, -100f), fitted, 300f, 2f))
    }

    /** OrbitKit SettingsHomeTests: what is kept is the square the circle covers, in the photo's own pixels. */
    @Test fun theCropKeepsTheSquareTheCircleCovers() {
        val photo = Size(4000f, 3000f)
        assertEquals("the middle square", Rect(500f, 0f, 3500f, 3000f), AvatarCrop.cropRect(photo, 300f, 1f, Offset.Zero))
        assertEquals("photo moved right: its left edge", Rect(0f, 0f, 3000f, 3000f), AvatarCrop.cropRect(photo, 300f, 1f, Offset(50f, 0f)))
        assertEquals("photo moved left: its right edge", Rect(1000f, 0f, 4000f, 3000f), AvatarCrop.cropRect(photo, 300f, 1f, Offset(-50f, 0f)))
        assertEquals("zoomed in twice: half the side, same centre", Rect(1250f, 750f, 2750f, 2250f), AvatarCrop.cropRect(photo, 300f, 2f, Offset.Zero))
    }

    @Test fun theSquareIsCutInsideThePhotoAndNeverUpscaled() {
        val source = Bitmap.createBitmap(100, 60, Bitmap.Config.ARGB_8888)
        source.eraseColor(Color.RED)
        for (zoom in listOf(1f, 2f, 5f)) for (dx in listOf(-500f, 0f, 500f)) for (dy in listOf(-500f, 0f, 500f)) {
            val fitted = AvatarCrop.fitted(Size(100f, 60f), 300f)
            val offset = AvatarCrop.clampedOffset(Offset(dx, dy), fitted, 300f, zoom)
            val cropped = personalCropPhoto(source, AvatarCrop.cropRect(Size(100f, 60f), 300f, zoom, offset))
            val side = (60 / zoom).toInt()
            assertEquals(side, cropped.width); assertEquals(side, cropped.height)
            assertEquals(Color.RED, cropped.getPixel(0, 0)); assertEquals(Color.RED, cropped.getPixel(side - 1, side - 1))
        }
        val large = Bitmap.createBitmap(1024, 900, Bitmap.Config.ARGB_8888)
        assertEquals(512, personalCropPhoto(large, AvatarCrop.cropRect(Size(1024f, 900f), 300f, 1f, Offset.Zero)).width)
    }

    @Test fun transparentPhotoIsDrawnOnWhiteAsOrbitAvatarJpegDoes() {
        val source = Bitmap.createBitmap(40, 40, Bitmap.Config.ARGB_8888)
        source.eraseColor(Color.TRANSPARENT)
        assertEquals(Color.WHITE, personalCropPhoto(source, Rect(0f, 0f, 40f, 40f)).getPixel(10, 10))
    }
}
