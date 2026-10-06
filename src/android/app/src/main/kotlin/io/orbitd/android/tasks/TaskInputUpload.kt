package io.orbitd.android.tasks

import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import io.orbitd.android.OrbitApplication
import io.orbitd.android.attachments.AttachmentLimits
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.taskprojects.FeatureWrites
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.Buffer
import java.io.ByteArrayOutputStream
import java.security.MessageDigest

/** Task inputs use A07's picker/size policy and A03's multipart transport; composer drafts are untouched. */
@Composable
internal fun TaskInputUpload(app: OrbitApplication, handle: SessionHandle, taskId: String, enabled: Boolean,
    revision: String, onResult: (String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var uploading by remember { mutableStateOf(false) }
    val currentResult by rememberUpdatedState(onResult)
    val currentEnabled by rememberUpdatedState(enabled)
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null && !uploading && currentEnabled) {
            uploading = true
            scope.launch {
                try {
                    withContext(Dispatchers.IO) {
                        val resolver = context.contentResolver
                        val mime = resolver.getType(uri) ?: "application/octet-stream"
                        val name = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                            if (cursor.moveToFirst()) cursor.getString(0) else null
                        } ?: "input"
                        val bytes = resolver.openInputStream(uri)?.use { input ->
                            val output = ByteArrayOutputStream()
                            val buffer = ByteArray(16 * 1024)
                            while (true) {
                                val count = input.read(buffer)
                                if (count < 0) break
                                require(output.size() + count <= AttachmentLimits.MAX_FILE) { "File exceeds the 25MB limit" }
                                output.write(buffer, 0, count)
                            }
                            output.toByteArray()
                        } ?: error("File permission expired. Select the file again.")
                        AttachmentLimits.rejection("file", mime, bytes.size)?.let { error(it) }
                        val body = MultipartBody.Builder().setType(MultipartBody.FORM).addFormDataPart("file", name, bytes.toRequestBody(mime.toMediaType())).build()
                        val encoded = Buffer().apply { body.writeTo(this) }.readByteArray()
                        val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
                        FeatureWrites(app.session, handle).execute("task-input:$taskId:$revision:$digest", ApiRequest(listOf("attachments"), HttpMethod.POST,
                            query = listOf("taskId" to taskId), body = encoded, contentType = body.contentType().toString()))
                    }
                    currentResult("Input uploaded")
                } catch (cancel: CancellationException) { throw cancel }
                catch (failure: Exception) { currentResult(taskError(failure)) }
                finally { uploading = false }
            }
        }
    }
    TextButton(onClick = { picker.launch(arrayOf("*/*")) }, enabled = enabled && !uploading) { Text(if (uploading) "Uploading input…" else "Add input") }
}
