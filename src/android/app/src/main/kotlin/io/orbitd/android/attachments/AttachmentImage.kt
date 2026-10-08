package io.orbitd.android.attachments

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ColorSpace
import android.graphics.Matrix
import android.media.ExifInterface
import java.io.IOException
import java.io.InputStream

/** Fresh streams for metadata, bounds and pixels; no full-resolution allocation before sampling.
 * At most 16 MiB of ARGB pixels, plus one same-sized orientation copy. Imports have two slots.
 * File uploads keep their original bytes; only photo/paste conversion and display use this budget. */
internal fun decodeAttachmentImage(open: () -> InputStream, maxDimension: Int = 4096): Bitmap {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    open().use { BitmapFactory.decodeStream(it, null, bounds) }
    require(bounds.outWidth > 0 && bounds.outHeight > 0) { "Couldn't read this image." }
    var sample = 1
    fun scaled(size: Int) = (size.toLong() + sample - 1) / sample
    while (scaled(bounds.outWidth) * scaled(bounds.outHeight) > 4 * 1024 * 1024 ||
        scaled(bounds.outWidth) > maxDimension || scaled(bounds.outHeight) > maxDimension) sample *= 2
    val orientation = try {
        open().use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }
    } catch (_: IOException) { ExifInterface.ORIENTATION_NORMAL } // E.g. GIF has no EXIF.
    val bitmap = open().use { input ->
        BitmapFactory.decodeStream(input, null, BitmapFactory.Options().apply {
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.ARGB_8888
            inPreferredColorSpace = ColorSpace.get(ColorSpace.Named.SRGB)
        })
    } ?: error("Couldn't read this image.")
    val transform = when (orientation) {
        2 -> floatArrayOf(-1f, 0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f)
        3 -> floatArrayOf(-1f, 0f, 0f, 0f, -1f, 0f, 0f, 0f, 1f)
        4 -> floatArrayOf(1f, 0f, 0f, 0f, -1f, 0f, 0f, 0f, 1f)
        5 -> floatArrayOf(0f, 1f, 0f, 1f, 0f, 0f, 0f, 0f, 1f)
        6 -> floatArrayOf(0f, -1f, 0f, 1f, 0f, 0f, 0f, 0f, 1f)
        7 -> floatArrayOf(0f, -1f, 0f, -1f, 0f, 0f, 0f, 0f, 1f)
        8 -> floatArrayOf(0f, 1f, 0f, -1f, 0f, 0f, 0f, 0f, 1f)
        else -> return bitmap
    }
    return try {
        Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, Matrix().apply { setValues(transform) }, true)
    } finally { bitmap.recycle() }
}
