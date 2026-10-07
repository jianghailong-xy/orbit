package io.orbitd.android.tasks

import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import io.orbitd.android.OrbitApplication
import io.orbitd.android.attachments.AttachmentLimits
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.taskprojects.canWrite
import io.orbitd.android.taskprojects.FeatureWriteRefused
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.Buffer
import java.io.ByteArrayOutputStream

/** Add file: the picked files become task inputs, one each (`addInputs`), uploaded with A03's
 * multipart transport to `POST /attachments?taskId=` — the server's 25 MB limit applies to every
 * type. A file that fails says why; the others still go. Composer drafts are untouched. */
@Composable
internal fun TaskInputUpload(app: OrbitApplication, handle: SessionHandle, taskId: String, enabled: Boolean, done: (String?) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var uploading by remember { mutableStateOf(false) }
    val finished by rememberUpdatedState(done)
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isEmpty() || uploading) return@rememberLauncherForActivityResult
        uploading = true
        scope.launch {
            val failures = mutableListOf<String>()
            for (uri in uris) {
                try {
                    if (!app.canWrite(handle)) throw FeatureWriteRefused()
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
                                require(output.size() + count <= AttachmentLimits.MAX_FILE) { "$name: File exceeds the 25MB limit" }
                                output.write(buffer, 0, count)
                            }
                            output.toByteArray()
                        } ?: error("$name: File permission expired. Select the file again.")
                        require(bytes.isNotEmpty()) { "$name: File is empty" }
                        val body = MultipartBody.Builder().setType(MultipartBody.FORM).addFormDataPart("file", name, bytes.toRequestBody(mime.toMediaType())).build()
                        val encoded = Buffer().apply { body.writeTo(this) }.readByteArray()
                        app.session.request(handle, ApiRequest(listOf("attachments"), HttpMethod.POST, query = listOf("taskId" to taskId),
                            body = encoded, contentType = body.contentType().toString()))
                    }
                } catch (cancel: CancellationException) { throw cancel }
                catch (failure: Exception) { failures += if (failure is IllegalArgumentException || failure is IllegalStateException) failure.message.orEmpty() else taskError(failure) }
            }
            uploading = false
            finished(failures.takeIf { it.isNotEmpty() }?.joinToString("\n"))
        }
    }
    TextButton(onClick = { picker.launch(arrayOf("*/*")) }, enabled = enabled && !uploading, modifier = Modifier.testTag("task-add-file")) {
        Text(if (uploading) "Uploading…" else "📎 ${TaskDetailCopy.addFile}")
    }
}
