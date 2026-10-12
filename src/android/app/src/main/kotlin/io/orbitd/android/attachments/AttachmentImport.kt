package io.orbitd.android.attachments

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.provider.OpenableColumns
import io.orbitd.android.composer.ComposerModel
import io.orbitd.android.composer.StagedAttachment
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.util.UUID

object AttachmentLimits {
    const val MAX_FILE = 25 * 1024 * 1024
    const val MAX_IMAGE = 5 * 1024 * 1024
    val inlineTypes = setOf("image/png", "image/jpeg", "image/webp", "image/gif")
    fun rejection(source: String, mime: String, size: Int): String? = when {
        size == 0 -> "File is empty"
        source == "file" && mime in inlineTypes && size > MAX_IMAGE -> "Image exceeds the 5MB limit"
        size > MAX_FILE -> "File exceeds the 25MB limit"
        else -> null
    }
}

/** Grants left by an interrupted import must not survive signing out of its account. */
fun clearAttachmentImports(context: Context) {
    context.contentResolver.persistedUriPermissions.filter { it.isReadPermission }.forEach {
        runCatching { context.contentResolver.releasePersistableUriPermission(it.uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    }
}

/** SAF/Photo Picker grants last until a private durable copy exists, including process recreation. */
fun importAttachment(context: Context, model: ComposerModel, uri: Uri, source: String, existing: StagedAttachment? = null) {
    val resolver = context.contentResolver
    var persisted = false
    try { resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION); persisted = true }
    catch (_: SecurityException) { /* Clipboard and some providers grant only temporary read access. */ }
    val id = existing?.id ?: UUID.randomUUID().toString()
    val placeholder = existing ?: StagedAttachment(id, if (source == "photo") "photo.png" else if (source == "paste") "pasted.png" else "File", "application/octet-stream", uri = uri.toString(), source = source)
    model.importAttachment(placeholder, read = {
        withContext(Dispatchers.IO) {
            var name = placeholder.name
            if (source == "file") resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
                if (it.moveToFirst()) name = it.getString(0) ?: name
            }
            val mime = if (source == "file") resolver.getType(uri) ?: "application/octet-stream" else "image/png"
            val output = object : ByteArrayOutputStream() {
                override fun write(b: ByteArray, off: Int, len: Int) {
                    require(count.toLong() + len <= AttachmentLimits.MAX_FILE) { "File exceeds the 25MB limit" }; super.write(b, off, len)
                }
                override fun write(b: Int) { require(count < AttachmentLimits.MAX_FILE) { "File exceeds the 25MB limit" }; super.write(b) }
            }
            fun open() = resolver.openInputStream(uri) ?: error("File permission expired. Select the file again.")
            if (source == "file") open().use { it.copyTo(output) }
            else {
                val bitmap = decodeAttachmentImage(::open)
                try { check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) { "Couldn't convert this image." } }
                finally { bitmap.recycle() }
            }
            val bytes = output.toByteArray()
            AttachmentLimits.rejection(source, mime, bytes.size)?.let { error(it) }
            placeholder.copy(name = name, mime = mime, size = bytes.size) to bytes
        }
    }, release = {
        if (persisted) runCatching { resolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    })
}
