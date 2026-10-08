package io.orbitd.android.composer

import android.content.ContentValues
import android.os.Bundle
import android.os.Process
import android.provider.MediaStore
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.*
import io.orbitd.android.attachments.importAttachment
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.core.protocol.Wire
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** Run prepare then kill the app process, then restore; composer-device-test.sh owns the lock. */
@RunWith(AndroidJUnit4::class)
class ColdComposerDeviceTest {
    @get:Rule val compose=createAndroidComposeRule<MainActivity>()
    private val instrument get()=InstrumentationRegistry.getInstrumentation()
    private val app get()=instrument.targetContext.applicationContext as OrbitApplication
    private val server get()=InstrumentationRegistry.getArguments().getString("a07_server") ?: "http://127.0.0.1:18767"
    private val session="01a0cca7-8609-70ed-a0e2-d4b55b832b60"
    private val evidence get()=File(app.filesDir,"a07-composer").apply { mkdirs() }
    private val draft="进程重建后保留的新草稿🙂".repeat(1500)
    private fun control(body:String) { (URL("$server/__control").openConnection() as HttpURLConnection).run {
        requestMethod="POST";doOutput=true;outputStream.use { it.write(body.toByteArray()) };check(responseCode==200);inputStream.close();disconnect()
    } }
    @Test fun prepare() {
        compose.waitUntil(10000) { app.session.state.value !is AuthState.Restoring }
        runBlocking { app.session.logout() };control("""{"reset":true,"losses":2,"status":"FAILED"}""")
        val handle=runBlocking { app.session.login(ServerAddress.parse(server,true),"a07@example.test","a07-fixture-password") }
        lateinit var model:ComposerModel
        compose.runOnIdle { model=app.composer(handle,session) }
        compose.waitUntil(10000) { model.state.value.loaded }
        val uri=app.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI,ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME,"a07-cold.txt");put(MediaStore.Downloads.MIME_TYPE,"text/plain");put(MediaStore.Downloads.RELATIVE_PATH,"Download")
        })!!
        app.contentResolver.openOutputStream(uri)!!.use { it.write("冷进程附件".toByteArray()) }
        compose.runOnIdle { importAttachment(app,model,uri,"file") }
        compose.waitUntil(10000) { model.state.value.draft.attachments.singleOrNull()?.remoteId!=null }
        app.contentResolver.delete(uri,null,null)
        compose.runOnIdle { model.edit("响应丢失的同一发送",3,3);model.send() }
        compose.waitUntil(10000) { !model.state.value.busy && model.state.value.draft.pending!=null }
        File(evidence,"cold-pending.json").writeText(Wire.json.encodeToString(PendingSend.serializer(),model.state.value.draft.pending!!))
        compose.runOnIdle { model.edit(draft,7,9) }
        // Ensure the last draft write is committed, not just present in the StateFlow.
        compose.waitUntil(5000) { runBlocking { app.session.readData(handle,DataKind.DRAFT,"composer-v1:$session") }?.decodeToString()?.contains(draft)==true }
        File(evidence,"cold-before.txt").writeText("pid=${Process.myPid()}\nsha=${BuildConfig.SOURCE_SHA}\n")
        instrument.sendStatus(0,Bundle().apply { putString("a07_pid",Process.myPid().toString()) })
        control("""{"status":"RUNNING"}""")
    }
    @Test fun restore() {
        compose.waitUntil(10000) { app.session.state.value is AuthState.SignedIn }
        val handle=(app.session.state.value as AuthState.SignedIn).handle
        lateinit var model:ComposerModel
        compose.runOnIdle { model=app.composer(handle,session) }
        compose.waitUntil(10000) { model.state.value.loaded }
        val pending=Wire.json.decodeFromString(PendingSend.serializer(),File(evidence,"cold-pending.json").readText())
        assertEquals(pending,model.state.value.draft.pending);assertEquals("resume",pending.endpoint)
        assertEquals(draft,model.state.value.draft.text);assertEquals(7,model.state.value.draft.selectionStart)
        assertArrayEquals("冷进程附件".toByteArray(),runBlocking { model.attachmentBytes(pending.attachments.single().id) })
        repeat(2) { compose.runOnIdle { model.retrySend() };compose.waitUntil(10000) { !model.state.value.busy } }
        assertNull(model.state.value.draft.pending);assertEquals(draft,model.state.value.draft.text)
        File(evidence,"cold-after.txt").writeText("pid=${Process.myPid()}\nsha=${BuildConfig.SOURCE_SHA}\npending endpoint/body/clientTurnId and attachment bytes identical; new draft/cursor retained; PASS\n")
        instrument.sendStatus(0,Bundle().apply { putString("a07_pid",Process.myPid().toString()) })
        runBlocking { app.session.logout() }
    }
}
