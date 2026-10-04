package io.orbitd.android.composer

import android.content.*
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.*
import android.provider.MediaStore
import android.view.*
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.EditorInfo
import androidx.compose.ui.test.*
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.*
import io.orbitd.android.attachments.importAttachment
import io.orbitd.android.attachments.decodeAttachmentImage
import io.orbitd.android.core.auth.AuthState
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

@RunWith(AndroidJUnit4::class)
class ComposerDeviceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrument.targetContext.applicationContext as OrbitApplication
    private val server get() = InstrumentationRegistry.getArguments().getString("a07_server") ?: "http://127.0.0.1:18767"
    private val evidence get() = File(app.filesDir,"a07-composer").apply { mkdirs() }
    private val session = "01a0cca7-8609-70ed-a0e2-d4b55b832b60"
    private val workspace = "01a0cca7-8609-70ed-a0e2-d4b55b832b61"
    private val handle get() = (app.session.state.value as AuthState.SignedIn).handle
    private val model get() = app.composer(handle,session)

    @Test fun chineseCompositionLongDraftRotationKeyboardAndSend() = journey("chinese-draft") {
        login()
        compose.onNodeWithTag("composer-input").performClick()
        fun editor(view: View): View? {
            if (view.onCheckIsTextEditor()) return view
            if (view is ViewGroup) for (i in 0 until view.childCount) editor(view.getChildAt(i))?.let { return it }
            return null
        }
        compose.runOnIdle {
            val connection = editor(compose.activity.window.decorView)!!.onCreateInputConnection(EditorInfo())!!
            assertTrue(connection.setComposingText("nihao", 1))
            assertTrue(connection.setComposingText("你好", 1))
            assertTrue(connection.finishComposingText())
            connection.commitText("，世界🙂",1)
        }
        compose.onNodeWithTag("composer-input").assertTextContains("你好，世界🙂")
        SystemClock.sleep(1200)
        compose.onNodeWithTag("composer-send").assertIsDisplayed()
        val visible = android.graphics.Rect()
        compose.runOnIdle { compose.activity.window.decorView.getWindowVisibleDisplayFrame(visible) }
        assertTrue(compose.onNodeWithTag("composer-send").fetchSemanticsNode().boundsInWindow.bottom <= visible.bottom)
        capture("composing-keyboard")
        // Native EditorInfo/InputConnection above, separate from test semantics text replacement.
        File(evidence,"ime.txt").writeText("setComposingText(nihao) -> setComposingText(你好) -> finishComposingText -> commitText(，世界🙂)\n")
        val long = "中文长草稿🙂\n".repeat(2500)
        compose.onNodeWithTag("composer-input").performTextReplacement(long)
        compose.waitUntil(5000) { model.state.value.draft.text == long }
        compose.activityRule.scenario.recreate()
        compose.onNodeWithTag("composer-input").assertTextContains(long)
        ready()
        clickSendWhenEnabled()
        compose.waitUntil(10000) { !model.state.value.busy && model.state.value.draft.pending == null && model.state.value.draft.text.isEmpty() }
        assertEquals(1, stats()["uniqueTurns"]!!.jsonPrimitive.int)
        capture("long-sent")
    }

    @Test fun hundredHttpGroupsLostAcknowledgementsKeepSavedKeyAcrossRecreation() = journey("hundred-http") {
        login(); control("""{"losses":2}""")
        var active = model
        repeat(100) { i ->
            compose.runOnIdle { active.edit("D09 中文 $i",0,0); active.send(); active.send() }
            compose.waitUntil(10000) { !active.state.value.busy && !active.state.value.waiting && active.state.value.draft.pending != null }
            val saved = active.state.value.draft.pending!!
            // Fresh model reads app-private AuthSession storage, no outbox state is handed to it.
            compose.runOnIdle { active.close(); active = ComposerModel(app.session,handle,session,app.processScope) }
            compose.waitUntil(5000) { active.state.value.loaded }
            assertEquals(saved,active.state.value.draft.pending)
            compose.runOnIdle { active.retrySend(); active.retrySend() }
            compose.waitUntil(10000) { !active.state.value.busy }
            assertEquals(saved,active.state.value.draft.pending)
            compose.runOnIdle { active.retrySend() }
            compose.waitUntil(10000) { !active.state.value.busy && active.state.value.draft.pending == null }
        }
        val result=stats(); assertEquals(100,result["uniqueTurns"]!!.jsonPrimitive.int)
        assertTrue(result["attempts"]!!.jsonObject.values.all { it.jsonPrimitive.int==3 })
        compose.runOnIdle { active.close() }
    }

    @Test fun realModelAccountQueueStopPermissionsAndRefresh() = journey("controls") {
        login()
        compose.onNodeWithText("Context: 0 tokens · Usage").performClick()
        awaitText("Primary: 23%");compose.onNodeWithText("Close").performClick()
        appClick("fixture-model")
        awaitText("Fixture Two"); appClick("Fixture Two")
        compose.waitUntil(5000) { stats()["config"]!!.jsonObject["model"]?.jsonPrimitive?.content == "fixture-model-2" }
        ready()
        compose.onNodeWithText("Second account").performScrollTo().performClick()
        compose.waitUntil(5000) { stats()["config"]!!.jsonObject["account"]?.jsonPrimitive?.content == "1a2b3c4d" }
        compose.onNodeWithText("Expired account · Not signed in").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithText("Close").performClick()
        control("""{"status":"RUNNING"}"""); compose.runOnIdle { app.realtime.refreshSession() }; awaitText("Stop")
        clickSendWhenEnabled(); awaitText("Stop requested.")
        compose.onNodeWithTag("composer-input").performTextInput("queued message")
        clickSendWhenEnabled()
        compose.waitUntil(10000) { model.state.value.draft.pending==null && !model.state.value.busy && !model.state.value.waiting }
        compose.onNodeWithText("+").performClick(); awaitText("Queued messages (1)")
        compose.onNodeWithText("Queued messages (1)").performClick(); appClick("Withdraw")
        compose.waitUntil(5000) { stats()["controls"]!!.jsonArray.any { it.jsonObject["action"]?.jsonPrimitive?.content=="withdraw" } }
        compose.onNodeWithText("Close").performClick()
        control("""{"expired":true}""")
        compose.onNodeWithTag("composer-input").performTextInput("after refresh")
        clickSendWhenEnabled()
        compose.waitUntil(10000) { stats()["rotations"]!!.jsonPrimitive.int>0 && !model.state.value.busy }
        control("""{"denial":403}"""); compose.runOnIdle { app.realtime.refreshSession() }
        awaitText("Session unavailable"); compose.onNodeWithTag("composer-input").assertDoesNotExist()
        capture("permission-withdrawn")
    }

    @Test fun cardDiscussionPreservesDraftAndFocusesWithoutSending() = journey("card-discussion") {
        login()
        compose.onNodeWithTag("composer-input").performTextReplacement("已有草稿")
        shellBytes("input keyevent KEYCODE_BACK")
        control("""{"discussion":true}""")
        compose.runOnIdle { app.realtime.refreshSession() }
        compose.waitUntil(10000) { app.realtime.state.value.session?.snapshot?.standing?.get("acceptanceConfirmation") is JsonObject }
        compose.onNodeWithTag("transcript-list").performScrollToNode(hasText("Chat about this"))
        compose.onNodeWithText("Chat about this").performScrollTo().performClick()
        compose.onNodeWithTag("composer-input").assertIsFocused()
        compose.waitUntil(5000) { model.state.value.draft.text.contains("fixture-criteria-seal") }
        val text = model.state.value.draft.text
        assertTrue(text.startsWith("已有草稿\n\nAbout the acceptance criteria"))
        assertTrue(text.contains("Keep the discussion draft"))
        assertEquals(0, stats()["uniqueTurns"]!!.jsonPrimitive.int)
        assertTrue(stats()["calls"]!!.jsonArray.isEmpty())
        capture("discussion-focused")
        compose.activityRule.scenario.recreate()
        compose.onNodeWithTag("composer-input").assertTextContains(text)
    }

    @Test fun attachmentFailureRetryPreviewCopyAndSystemShare() = journey("attachments") {
        login()
        val bytes="中文附件与真实URI权限\n".repeat(100).toByteArray()
        val resolver=app.contentResolver
        val fileName="a07-中文附件-${java.util.UUID.randomUUID()}.txt"
        val uri=resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI,ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME,fileName); put(MediaStore.Downloads.MIME_TYPE,"text/plain")
            put(MediaStore.Downloads.RELATIVE_PATH,"Download")
        })!!
        resolver.openOutputStream(uri)!!.use { it.write(bytes) }
        try {
            control("""{"uploadFailures":1,"uploadDelay":0.3}""")
            compose.onNodeWithText("+").performClick(); compose.onNodeWithText("File",useUnmergedTree=true).performClick()
            selectFilesRoot("Downloads")
            if (systemNode("List view") != null) systemClick("List view")
            compose.waitUntil(10000) { systemNode(fileName) != null }
            capture("system-files")
            clickNode(systemNode(fileName)!!)
            capture("system-file-selected")
            compose.waitUntil(5000) { model.state.value.draft.attachments.isNotEmpty() || systemNode("Select") != null || systemNode("Open") != null }
            if (model.state.value.draft.attachments.isEmpty()) systemClick(if (systemNode("Select") != null) "Select" else "Open")
            compose.waitUntil(15000) { model.state.value.failures.isNotEmpty() }
            compose.onNodeWithText("Retry upload").performClick()
            compose.waitUntil(15000) { model.state.value.draft.attachments.singleOrNull()?.remoteId!=null }
            val staged=model.state.value.draft.attachments.single()
            assertArrayEquals(bytes,runBlocking { model.attachmentBytes(staged.id) })
            ready();clickSendWhenEnabled()
            compose.waitUntil(10000) { !model.state.value.busy && model.state.value.draft.pending==null && model.state.value.draft.attachments.isEmpty() }
            // The outbox's private copy is now removed: every action below must fetch the
            // transcript attachment through authenticated GET, not reuse the staged bytes.
            awaitText(staged.name)
            compose.onAllNodesWithText("\"attachments\":", substring=true).assertCountEquals(0)
            capture("attachment-only-sent")
            appClick(staged.name)
            val oldClip = app.getSystemService(ClipboardManager::class.java).primaryClip?.getItemAt(0)?.uri
            appClick("Copy")
            compose.waitUntil(5000) { app.getSystemService(ClipboardManager::class.java).primaryClip?.getItemAt(0)?.uri?.let { it != oldClip } == true }
            val clip=app.getSystemService(ClipboardManager::class.java).primaryClip!!.getItemAt(0).uri!!
            assertArrayEquals(bytes,resolver.openInputStream(clip)!!.use { it.readBytes() })
            compose.waitUntil(5000) { compose.onNodeWithText("Share",useUnmergedTree=true).fetchSemanticsNode().config.getOrNull(SemanticsProperties.Disabled)==null }
            appClick("Share")
            capture("system-share")
            compose.waitUntil(10000) { systemNode("A07 receiver")!=null }
            instrument.uiAutomation.waitForIdle(500,5000)
            systemFind(refresh=true) { it.viewIdResourceName?.endsWith(":id/chooser_header")==true }?.let { header ->
                val bounds=android.graphics.Rect();header.getBoundsInScreen(bounds)
                File(evidence,"system-share-gesture.txt").writeText("header=$bounds\n")
                if (!bounds.isEmpty && bounds.top>100) {
                    val time=SystemClock.uptimeMillis()
                    for (step in 0..16) {
                        val action=when(step) { 0->MotionEvent.ACTION_DOWN;16->MotionEvent.ACTION_UP;else->MotionEvent.ACTION_MOVE }
                        val pointer=MotionEvent.PointerProperties().apply { id=0;toolType=MotionEvent.TOOL_TYPE_FINGER }
                        val position=MotionEvent.PointerCoords().apply { x=bounds.exactCenterX();y=bounds.exactCenterY()+(80f-bounds.exactCenterY())*step/16;pressure=1f;size=1f }
                        val event=MotionEvent.obtain(time,SystemClock.uptimeMillis(),action,1,arrayOf(pointer),arrayOf(position),0,0,1f,1f,0,0,InputDevice.SOURCE_TOUCHSCREEN,0)
                        assertTrue(instrument.uiAutomation.injectInputEvent(event,true));event.recycle();SystemClock.sleep(20)
                    }
                }
            }
            instrument.uiAutomation.waitForIdle(1000,10000)
            capture("system-share-expanded")
            compose.waitUntil(20000) {
                systemFind(refresh=true) { node ->
                    val bounds=android.graphics.Rect();node.getBoundsInScreen(bounds)
                    node.viewIdResourceName=="android:id/text1" && node.text.isNullOrBlank() &&
                        node.isVisibleToUser && !bounds.isEmpty
                }==null && systemNode("A07 receiver")!=null
            }
            instrument.uiAutomation.waitForIdle(500,5000)
            capture("system-share-ready")
            systemClick("A07 receiver",touch=true)
            systemClick("Received file")
            assertEquals(sha(bytes),systemNode("Received file")!!.contentDescription.toString())
            capture("share-recipient-read")
            shellBytes("input keyevent KEYCODE_BACK")
            appClick("Open")
            systemClick("A07 receiver")
            if (systemNode("Just once") != null) systemClick("Just once")
            compose.waitUntil(5000) { systemNode("Received file") != null }
            assertEquals(sha(bytes),systemNode("Received file")!!.contentDescription.toString())
            capture("open-recipient-read")
            shellBytes("input keyevent KEYCODE_BACK")
            appClick("Download")
            selectFilesRoot("Downloads")
            var filename:AccessibilityNodeInfo?=null
            compose.waitUntil(5000) { filename=systemFind { it.isEditable };filename!=null }
            val exportName="a07-export-${java.util.UUID.randomUUID()}.txt"
            filename!!.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT,Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,exportName) })
            systemClick("Save")
            compose.waitUntil(5000) { shellBytes("cat /sdcard/Download/$exportName").contentEquals(bytes) }
            File(evidence,"download-sha256.txt").writeText(sha(bytes))
            File(evidence,"download-path.txt").writeText(exportName)
            shellBytes("rm /sdcard/Download/$exportName")
            // A real external process reads the temporary grant and publishes its digest in the UI.
            File(evidence,"attachment-digest.txt").writeText(sha(bytes)+"\n")
            appClick("Close attachment")
            val att=stats()["attachments"]!!.jsonObject.values.single().jsonObject
            assertEquals(sha(bytes),att["sha256"]!!.jsonPrimitive.content)
            assertEquals(1,att["references"]!!.jsonArray.size)
            assertEquals(4,stats()["downloads"]!!.jsonArray.size)
            assertTrue(resolver.persistedUriPermissions.none { it.uri==uri })
        } finally { resolver.delete(uri,null,null) }
    }
    @Test fun nativePhotoPickerPngPreviewSaveAndPaste() = journey("photo-picker") {
        login()
        val resolver=app.contentResolver
        val photoName="a07-picker-${java.util.UUID.randomUUID()}.jpg"
        val uri=resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME,photoName);put(MediaStore.Images.Media.MIME_TYPE,"image/jpeg")
            put(MediaStore.Images.Media.RELATIVE_PATH,"Pictures");put(MediaStore.Images.Media.IS_PENDING,1)
            put(MediaStore.Images.Media.DATE_TAKEN,System.currentTimeMillis())
        })!!
        val original=instrument.context.assets.open("composer-images/exif-6.jpg").use { it.readBytes() }
        resolver.openOutputStream(uri)!!.use { it.write(original) }
        resolver.update(uri,ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING,0) },null,null)
        // API29 DocumentsUI obtains image metadata from the media scan, unlike the new picker.
        val path=resolver.query(uri,arrayOf(MediaStore.Images.Media.DATA),null,null,null)!!.use { it.moveToFirst();it.getString(0) }
        val scanned=java.util.concurrent.CountDownLatch(1)
        android.media.MediaScannerConnection.scanFile(app,arrayOf(path),arrayOf("image/jpeg")) { _,_ -> scanned.countDown() }
        assertTrue(scanned.await(10,java.util.concurrent.TimeUnit.SECONDS))
        try {
            compose.onNodeWithText("+").performClick();compose.onNodeWithText("Image",useUnmergedTree=true).performClick()
            if (Build.VERSION.SDK_INT < 33) {
                selectFilesRoot("Images")
                if (systemNode("List view") != null) systemClick("List view")
                systemClick("Pictures")
            }
            var tile:AccessibilityNodeInfo?=null
            compose.waitUntil(10000) { tile=systemFind { it.contentDescription?.toString()?.let { label -> label.startsWith("Photo taken") || label.startsWith(photoName) } == true || it.text?.toString()==photoName };tile!=null }
            capture("native-photo-picker")
            clickNode(tile!!)
            var add:AccessibilityNodeInfo?=null
            compose.waitUntil(5000) { add=systemFind { it.text?.toString()?.let { text -> text.startsWith("Add",true) || text.equals("Done",true) || text.equals("Open",true) || text.equals("Select",true) } == true };add!=null || model.state.value.draft.attachments.isNotEmpty() }
            add?.let(::clickNode)
            compose.waitUntil(10000) { model.state.value.draft.attachments.singleOrNull()?.remoteId!=null }
            val photo=model.state.value.draft.attachments.single()
            assertEquals("photo",photo.source);assertEquals("image/png",photo.mime)
            val bytes=runBlocking { model.attachmentBytes(photo.id) }
            val converted=BitmapFactory.decodeByteArray(bytes,0,bytes.size)!!
            try { assertEquals("48x72:BRYG",imageSignature(converted)) } finally { converted.recycle() }
            appClick("${photo.name} · ${photo.size/1024} KB")
            compose.waitUntil(5000) { compose.onAllNodesWithContentDescription("photo.png").fetchSemanticsNodes().isNotEmpty() }
            capture("photo-preview")
            fun savedImages():Set<Long> = resolver.query(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,arrayOf("_id"),
                "is_pending=0 AND relative_path IN (?,?)",arrayOf("Pictures/Orbit","Pictures/Orbit/"),null)!!.use { c ->
                buildSet { while(c.moveToNext())add(c.getLong(0)) }
            }
            repeat(2) {
                val savedBefore=savedImages()
                compose.waitUntil(5000) { compose.onNodeWithText("Save image").fetchSemanticsNode().config.getOrNull(SemanticsProperties.Disabled)==null }
                appClick("Save image")
                var saved:Uri?=null
                compose.waitUntil(5000) {
                    (savedImages()-savedBefore).singleOrNull()?.let { saved=ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI,it) }
                    saved!=null
                }
                assertArrayEquals(bytes,resolver.openInputStream(saved!!)!!.use { it.readBytes() })
                resolver.query(saved!!,arrayOf(MediaStore.Images.Media.DISPLAY_NAME),null,null,null)!!.use { c ->
                    assertTrue(c.moveToFirst());File(evidence,"photo-save-retries.txt").appendText("$saved ${c.getString(0)}\n")
                }
                resolver.delete(saved!!,null,null)
            }
            File(evidence,"photo-save-sha256.txt").writeText(sha(bytes))
            appClick("Close attachment")
            app.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newUri(resolver,"test photo",uri))
            compose.onNodeWithText("+").performClick();compose.onNodeWithText("Paste image",useUnmergedTree=true).performClick()
            compose.waitUntil(10000) { model.state.value.draft.attachments.size==2 && model.state.value.draft.attachments.all { it.remoteId!=null } }
            assertTrue(model.state.value.draft.attachments.any { it.source=="paste" })
            val pasted=model.state.value.draft.attachments.single { it.source=="paste" }
            assertArrayEquals(bytes,runBlocking { model.attachmentBytes(pasted.id) })
            appClick("${photo.name} · ${photo.size/1024} KB")
            repeat(6) { round ->
                appClick("Next image")
                compose.waitUntil(5000) { compose.onAllNodesWithContentDescription("pasted.png").fetchSemanticsNodes().isNotEmpty() }
                if (round==0) capture("gallery-next")
                appClick("Previous image")
                compose.waitUntil(5000) { compose.onAllNodesWithContentDescription("photo.png").fetchSemanticsNodes().isNotEmpty() }
            }
            appClick("Close attachment")
            ready();clickSendWhenEnabled()
            compose.waitUntil(10000) { !model.state.value.busy && model.state.value.draft.pending==null && model.state.value.draft.attachments.isEmpty() }
            assertEquals(2,stats()["attachments"]!!.jsonObject.size)
        } finally { resolver.delete(uri,null,null) }
    }
    private fun login() {
        compose.waitUntil(10000) { app.session.state.value !is AuthState.Restoring }
        runBlocking { app.session.logout() }; control("""{"reset":true}""")
        awaitText("Instance address")
        compose.onNodeWithText("Instance address").performTextReplacement(server)
        compose.onNodeWithText("Email").performTextInput("a07@example.test")
        compose.onNodeWithText("Password").performTextInput("a07-fixture-password")
        compose.onAllNodesWithText("Sign in")[1].performScrollTo().performClick()
        compose.waitUntil(15000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
        compose.onNodeWithTag("workspace:$workspace").performClick()
        awaitText("Composer conversation")
        compose.onNodeWithText("Composer conversation").performClick()
        compose.waitUntil(10000) { app.realtime.state.value.session?.fresh==true && model.state.value.loaded }
        awaitText("No messages yet")
    }
    @Test fun newSessionUsesWorkspaceDraftAndNavigatesAfterCreation() = journey("new-session") {
        login()
        compose.onNodeWithContentDescription("Back").performClick()
        awaitText("New session");compose.onAllNodesWithText("New session")[0].performClick()
        compose.onNodeWithTag("composer-input").performTextInput("新会话的首条消息")
        compose.activityRule.scenario.recreate()
        compose.onNodeWithTag("composer-input").assertTextContains("新会话的首条消息")
        appClick("fixture-model"); awaitText("Automatic")
        compose.onNodeWithText("Automatic").performScrollTo().performClick()
        compose.onNodeWithText("Close").performClick()
        compose.waitUntil(10000) { compose.onNodeWithTag("composer-send").fetchSemanticsNode().config.getOrNull(SemanticsProperties.Disabled)==null }
        clickSendWhenEnabled()
        awaitText("Created conversation")
        val request=stats()["creations"]!!.jsonArray.single().jsonObject
        assertEquals(workspace,request["workspaceId"]!!.jsonPrimitive.content)
        assertEquals("新会话的首条消息",request["prompt"]!!.jsonPrimitive.content)
        assertNull(request["clientTurnId"])
        assertNull(request["codexAccount"])
        capture("created-session")
    }

    @Test fun explicitRejectionRestoresMessageAndAttachmentThenResumes() = journey("rejected-send") {
        login()
        compose.runOnIdle { model.importAttachment(StagedAttachment("reject-file","retry.txt","text/plain"),
            { StagedAttachment("reject-file","retry.txt","text/plain",4) to "keep".toByteArray() }, {}) }
        compose.waitUntil(10000) { model.state.value.draft.attachments.singleOrNull()?.remoteId != null }
        compose.onNodeWithTag("composer-input").performTextInput("拒绝后恢复同一草稿")
        control("""{"rejectTurnOnce":true}"""); clickSendWhenEnabled()
        compose.waitUntil(10000) { !model.state.value.busy && model.state.value.error != null }
        assertNull(model.state.value.draft.pending)
        compose.onNodeWithTag("composer-input").assertTextContains("拒绝后恢复同一草稿")
        assertEquals("retry.txt",model.state.value.draft.attachments.single().name)
        assertEquals(0,stats()["uniqueTurns"]!!.jsonPrimitive.int)
        capture("409-restored")
        ready(); clickSendWhenEnabled()
        compose.waitUntil(10000) { !model.state.value.busy && model.state.value.draft.pending == null && model.state.value.draft.text.isEmpty() }
        val sent=stats()["turns"]!!.jsonObject.values.single().jsonObject
        assertTrue(sent["endpoint"]!!.jsonPrimitive.content.endsWith("/resume"))
        assertEquals(1,sent["request"]!!.jsonObject["attachmentIds"]!!.jsonArray.size)
        capture("resume-accepted")
    }

    @Test fun draftAccountUsageAndProviderSwitchMatchAutomaticCreate() = journey("draft-account") {
        login(); compose.onNodeWithContentDescription("Back").performClick()
        awaitText("New session"); compose.onAllNodesWithText("New session")[0].performClick()
        compose.onNodeWithTag("composer-input").performTextInput("账户草稿")
        fun choose(label:String, current:String="fixture-model") {
            appClick(current); awaitText(label)
            compose.onAllNodesWithText(label).onLast().performScrollTo().performClick()
            compose.onNodeWithText("Close").performClick()
        }
        fun quota(label:String) {
            appClick("Context: 0 tokens · Usage"); awaitText(label)
            compose.onNodeWithText(label).assertIsDisplayed(); capture("usage-${label.hashCode()}")
            compose.onNodeWithText("Close").performClick()
        }
        choose("Second account"); quota("Primary: 71%")
        choose("Default"); quota("Primary: 23%")
        choose("Automatic"); quota("No quota reported for this account.")
        choose("claude"); quota("Primary: 11%")
        choose("Claude account","claude-model"); quota("No quota reported for this account.")
        choose("Automatic","claude-model"); clickSendWhenEnabled()
        awaitText("Created conversation")
        val request=stats()["creations"]!!.jsonArray.single().jsonObject
        assertEquals("claude",request["provider"]!!.jsonPrimitive.content)
        assertNull(request["claudeAccount"]); assertNull(request["codexAccount"])
    }

    @Test fun boundedConcurrentPhotosAndAllExifPreviews() = journey("image-bounds-exif") {
        login()
        val input=File(app.cacheDir,"large-rgba.png")
        instrument.context.assets.open("composer-images/large-rgba.png").use { from -> input.outputStream().use { from.copyTo(it) } }
        try {
            val pid=Process.myPid()
            compose.runOnIdle { for (source in listOf("photo","paste")) importAttachment(app,model,Uri.fromFile(input),source) }
            compose.waitUntil(30000) { model.state.value.uploads.isEmpty() && model.state.value.draft.attachments.size==2 }
            assertTrue(model.state.value.failures.toString(),model.state.value.failures.isEmpty())
            for (attachment in model.state.value.draft.attachments) {
                assertNotNull(attachment.remoteId)
                val bytes=runBlocking { model.attachmentBytes(attachment.id) }
                val bitmap=decodeAttachmentImage({ bytes.inputStream() })
                try {
                    assertEquals(1500,bitmap.width); assertEquals(1500,bitmap.height)
                    assertEquals(9_000_000,bitmap.allocationByteCount)
                    File(evidence,"large-image.txt").appendText("${attachment.source} pid=$pid input=${input.length()} converted=${bytes.size} pixels=${bitmap.width}x${bitmap.height} allocation=${bitmap.allocationByteCount} sha256=${sha(bytes)}\n")
                } finally { bitmap.recycle() }
            }
            assertEquals(pid,Process.myPid())
            assertEquals(2,stats()["attachments"]!!.jsonObject.size)
            capture("large-images-uploaded")
            for (attachment in model.state.value.draft.attachments.toList()) compose.runOnIdle { model.removeAttachment(attachment.id) }
            val expected=listOf("72x48:RGBY","72x48:GRYB","72x48:YBGR","72x48:BYRG","48x72:RBGY","48x72:BRYG","48x72:YGBR","48x72:GYRB")
            for (orientation in 1..8) {
                val bytes=instrument.context.assets.open("composer-images/exif-$orientation.jpg").use { it.readBytes() }
                val bitmap=decodeAttachmentImage({ bytes.inputStream() },maxDimension=2560)
                try {
                    assertEquals(expected[orientation-1],imageSignature(bitmap))
                    File(evidence,"exif-previews.txt").appendText("EXIF=$orientation ${imageSignature(bitmap)} source=${sha(bytes)}\n")
                } finally { bitmap.recycle() }
                val file=StagedAttachment("exif-$orientation","EXIF-$orientation.jpg","image/jpeg",bytes.size)
                compose.runOnIdle { model.importAttachment(file,{file to bytes},{}) }
                compose.waitUntil(10000) { model.state.value.draft.attachments.singleOrNull()?.remoteId != null }
                assertArrayEquals(bytes,runBlocking { model.attachmentBytes(file.id) })
                appClick("${file.name} · ${file.size/1024} KB")
                compose.waitUntil(5000) { compose.onAllNodesWithContentDescription(file.name).fetchSemanticsNodes().isNotEmpty() }
                capture("exif-$orientation-preview")
                appClick("Close attachment"); compose.runOnIdle { model.removeAttachment(file.id) }
            }
        } finally { input.delete() }
    }

    private fun imageSignature(image:Bitmap):String {
        val colors=listOf(1 to 1,3 to 1,1 to 3,3 to 3).joinToString("") { (x,y) ->
            val pixel=image.getPixel(image.width*x/4,image.height*y/4)
            val r=android.graphics.Color.red(pixel);val g=android.graphics.Color.green(pixel);val b=android.graphics.Color.blue(pixel)
            when { r>180 && g>180 -> "Y"; r>180 -> "R"; g>100 -> "G"; b>180 -> "B"; else -> "?" }
        }
        return "${image.width}x${image.height}:$colors"
    }
    private fun clickSendWhenEnabled() {
        compose.waitUntil(10000) { compose.onNodeWithTag("composer-send").fetchSemanticsNode().config.getOrNull(SemanticsProperties.Disabled)==null }
        compose.onNodeWithTag("composer-send").performSemanticsAction(SemanticsActions.OnClick) { assertTrue(it()) }
    }
    private fun appClick(label:String) {
        compose.onNode((hasText(label) or hasContentDescription(label)) and hasClickAction()).performSemanticsAction(SemanticsActions.OnClick) { assertTrue(it()) }
    }
    private fun ready() { compose.waitUntil(10000) { app.realtime.state.value.session?.fresh==true && !model.state.value.busy };compose.waitForIdle() }
    private fun awaitText(text:String) { compose.waitUntil(15000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() } }
    private fun request(path:String,body:String?=null):String = (URL(server+path).openConnection() as HttpURLConnection).run {
        connectTimeout=5000;readTimeout=5000
        if(body!=null) { requestMethod="POST";doOutput=true;outputStream.use { it.write(body.toByteArray()) } }
        check(responseCode==200); inputStream.bufferedReader().use { it.readText() }.also { disconnect() }
    }
    private fun control(body:String) { request("/__control",body) }
    private fun stats()=Json.parseToJsonElement(request("/__stats")).jsonObject
    private fun systemNode(text:String)=systemFind { it.text?.toString()?.equals(text,ignoreCase=true)==true || it.contentDescription?.toString()==text }
    private fun systemRoot():AccessibilityNodeInfo? {
        val automation=instrument.uiAutomation
        val info=automation.serviceInfo
        if (info.flags and android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS==0) {
            info.flags=info.flags or android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
            automation.serviceInfo=info
        }
        return automation.rootInActiveWindow ?: automation.windows
            .filter { it.type==android.view.accessibility.AccessibilityWindowInfo.TYPE_APPLICATION }
            .maxByOrNull { it.layer }?.root
    }
    private fun systemFind(refresh:Boolean=false,last:Boolean=false,predicate:(AccessibilityNodeInfo)->Boolean):AccessibilityNodeInfo? {
        fun find(n:AccessibilityNodeInfo?):AccessibilityNodeInfo? {
            if(n==null)return null
            if(refresh && !n.refresh())return null
            var found=if(predicate(n)) n else null
            if(found!=null && !last)return found
            for(i in 0 until n.childCount)find(n.getChild(i))?.let { if(!last)return it;found=it }
            return found
        }
        return find(systemRoot())
    }
    private fun selectFilesRoot(name:String) {
        fun visibleRoot()=systemFind(refresh=true) { node ->
            val bounds=android.graphics.Rect();node.getBoundsInScreen(bounds)
            node.isVisibleToUser && !bounds.isEmpty && node.text?.toString()?.equals(name,true)==true &&
                generateSequence(node.parent) { it.parent }.any { it.viewIdResourceName?.endsWith(":id/roots_list")==true }
        }
        compose.waitUntil(10000) { systemNode("Show roots")!=null || visibleRoot()!=null }
        instrument.uiAutomation.waitForIdle(500,5000)
        if (visibleRoot()==null) {
            val alreadySelected=systemFind(refresh=true) { node -> node.isVisibleToUser && node.text?.toString()?.equals(name,true)==true &&
                generateSequence(node.parent) { it.parent }.any { it.viewIdResourceName?.endsWith(":id/toolbar")==true } }
            if (alreadySelected!=null) return
            systemClick("Show roots",touch=true)
        }
        instrument.uiAutomation.waitForIdle(500,5000)
        var root:AccessibilityNodeInfo?=null
        compose.waitUntil(5000) {
            root=visibleRoot()
            root!=null
        }
        clickNode(root!!,touch=true)
    }
    private fun systemClick(text:String,touch:Boolean=false) {
        var found:AccessibilityNodeInfo?=null
        compose.waitUntil(10000) { found=systemNode(text); found!=null }
        if (!touch) found!!.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id)
        SystemClock.sleep(300)
        compose.waitUntil(10000) {
            // Prefer the installed-app entry after live Sharesheet suggestions.
            found=systemFind(refresh=touch,last=touch) { node ->
                val bounds=android.graphics.Rect();node.getBoundsInScreen(bounds)
                node.isVisibleToUser && !bounds.isEmpty &&
                    (node.text?.toString()?.equals(text,ignoreCase=true)==true || node.contentDescription?.toString()==text)
            }
            found!=null
        }
        clickNode(found!!,touch)
    }
    private fun clickNode(node:AccessibilityNodeInfo,touch:Boolean=false) {
        var n=node
        while(!n.isClickable && n.parent!=null)n=n.parent
        if (n.isClickable && !touch) assertTrue(n.performAction(AccessibilityNodeInfo.ACTION_CLICK))
        else {
            val target=if(touch && n.isClickable) n else generateSequence(node) { it.parent }.firstOrNull { it.viewIdResourceName?.endsWith(":id/item_root")==true } ?: node
            val bounds=android.graphics.Rect();target.getBoundsInScreen(bounds)
            if (touch) {
                File(evidence,"system-touches.txt").appendText("${node.text} ${target.viewIdResourceName} $bounds\n")
                shellBytes("input touchscreen tap ${bounds.centerX()} ${bounds.centerY()}")
                SystemClock.sleep(300)
                return
            }
            val time=SystemClock.uptimeMillis()
            for (action in listOf(MotionEvent.ACTION_DOWN,MotionEvent.ACTION_UP)) {
                val pointer=MotionEvent.PointerProperties().apply { id=0;toolType=MotionEvent.TOOL_TYPE_FINGER }
                val position=MotionEvent.PointerCoords().apply { x=bounds.exactCenterX();y=bounds.exactCenterY();pressure=1f;size=1f }
                val event=MotionEvent.obtain(time,SystemClock.uptimeMillis(),action,1,arrayOf(pointer),arrayOf(position),0,0,1f,1f,0,0,InputDevice.SOURCE_TOUCHSCREEN,0)
                assertTrue(instrument.uiAutomation.injectInputEvent(event,true));event.recycle()
                SystemClock.sleep(100)
            }
        }
        SystemClock.sleep(300)
    }
    private fun shellBytes(command:String)=ParcelFileDescriptor.AutoCloseInputStream(instrument.uiAutomation.executeShellCommand(command)).use { it.readBytes() }
    private fun sha(data:ByteArray)=MessageDigest.getInstance("SHA-256").digest(data).joinToString(""){"%02x".format(it)}
    private fun capture(name:String) {
        SystemClock.sleep(300)
        val tree=StringBuilder()
        fun visit(node:AccessibilityNodeInfo?,depth:Int) {
            if(node==null || depth>20)return
            val bounds=android.graphics.Rect();node.getBoundsInScreen(bounds)
            tree.appendLine("${" ".repeat(depth)}${node.className} ${node.viewIdResourceName} text=${node.text} desc=${node.contentDescription} click=${node.isClickable} enabled=${node.isEnabled} $bounds")
            for(i in 0 until node.childCount)visit(node.getChild(i),depth+1)
        }
        visit(systemRoot(),0);File(evidence,"$name-ui.txt").writeText(tree.toString())
        instrument.uiAutomation.takeScreenshot().let { b->File(evidence,"$name.png").outputStream().use { b.compress(Bitmap.CompressFormat.PNG,100,it) };b.recycle() }
    }
    private fun journey(name:String,block:()->Unit) {
        instrument.sendStatus(0,Bundle().apply { putString("a07_pid",Process.myPid().toString()) })
        File(evidence,"identity.txt").writeText("sha=${BuildConfig.SOURCE_SHA}\ndirty=${BuildConfig.SOURCE_DIRTY}\napi=${Build.VERSION.SDK_INT}\n")
        try { block();File(evidence,"$name-result.txt").writeText("PASS\n") }
        catch(e:Throwable) { capture("$name-failure");File(evidence,"$name-result.txt").writeText(e.stackTraceToString());throw e }
        finally { File(evidence,"$name-server.json").writeText(request("/__stats"));control("""{"denial":0,"expired":false}""");runBlocking { app.session.logout() } }
    }
}
