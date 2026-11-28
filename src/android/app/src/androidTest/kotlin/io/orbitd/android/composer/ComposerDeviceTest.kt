package io.orbitd.android.composer

import io.orbitd.android.startNewSession
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
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.auth.chooseServer
import io.orbitd.android.auth.pressSignIn
import io.orbitd.android.*
import io.orbitd.android.attachments.importAttachment
import io.orbitd.android.attachments.decodeAttachmentImage
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.cards.CardPreviews
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
        compose.onNodeWithTag("composer-context").performClick()
        awaitText("Primary: 23%"); closeSheet()
        modelChip()
        awaitText("Fixture Two"); appClick("Fixture Two")
        compose.waitUntil(5000) { stats()["config"]!!.jsonObject["model"]?.jsonPrimitive?.content == "fixture-model-2" }
        ready()
        // Pressed through its click action once pressable, as appClick does: the menu re-lays out when the model change is read back
        // (Fixture Two has no Effort section), and a touch injected meanwhile can land between rows.
        val second = hasText("Second account") and hasClickAction()
        compose.waitUntil(10000) { compose.onAllNodes(second and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(second).performScrollTo().performSemanticsAction(SemanticsActions.OnClick)
        compose.waitUntil(10000) { stats()["config"]!!.jsonObject["account"]?.jsonPrimitive?.content == "1a2b3c4d" }
        // The menu's rows are pressable again once the move the fixture just took is settled in the app and the session read again.
        // A signed-out account is not one the runner can run, so it has no row.
        compose.waitUntil(10000) { compose.onAllNodes(second and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(second).performScrollTo().assertIsEnabled()
        assertTrue(compose.onAllNodes(hasText("Expired account")).fetchSemanticsNodes().isEmpty())
        compose.onNodeWithText("Close").performClick()
        control("""{"status":"RUNNING"}"""); compose.runOnIdle { app.realtime.refreshSession() }
        // Send turns into Stop: an icon, said aloud as "Stop" (the composer toolbar as iOS draws it).
        compose.waitUntil(15000) { compose.onAllNodesWithContentDescription("Stop").fetchSemanticsNodes().isNotEmpty() }
        // Queued for the next turn while this one runs — Send held offers it — the message waits in the tray above the composer
        // (A07-22/23, b0f32ebbd), no longer in the + menu's "Queued messages"; withdrawn there, its words come back to the composer.
        compose.onNodeWithTag("composer-input").performTextInput("queued message")
        compose.waitUntil(10000) { compose.onAllNodes(hasTestTag("composer-send") and isEnabled() and hasContentDescription("Send")).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("composer-send").performTouchInput { longClick() }
        compose.waitUntil(10000) { compose.onAllNodesWithTag("composer-queue-next-turn").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("composer-queue-next-turn").performClick()
        compose.waitUntil(10000) { model.state.value.draft.pending==null && !model.state.value.busy && !model.state.value.waiting }
        assertEquals("NEXT_TURN", stats()["turns"]!!.jsonObject.values.single().jsonObject["request"]!!.jsonObject["intent"]!!.jsonPrimitive.content)
        val tray = hasAnyAncestor(hasTestTag("pending-tray"))
        compose.waitUntil(15000) { compose.onAllNodes(hasText("queued message") and tray).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(hasText("Queued for next turn") and tray).assertExists()
        capture("queued-tray")
        // Pressed through its click action once enabled, as the account row above is: on API 29 a touch on the tray's trash icon
        // once reached nothing (no withdraw sent, the row still there 5 s on, A15b's API 29 round).
        val withdraw = hasTestTag("pending-tray-withdraw") and isEnabled()
        compose.waitUntil(10000) { compose.onAllNodes(withdraw).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(withdraw).performSemanticsAction(SemanticsActions.OnClick)
        compose.waitUntil(10000) { stats()["controls"]!!.jsonArray.any { it.jsonObject["action"]?.jsonPrimitive?.content=="withdraw" } }
        compose.waitUntil(10000) { model.state.value.draft.text=="queued message" && compose.onAllNodesWithTag("pending-tray").fetchSemanticsNodes().isEmpty() }
        // With nothing typed, Send is Stop.
        compose.onNodeWithTag("composer-input").performTextClearance()
        clickSendWhenEnabled(); awaitText("Stop requested.")
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
        // A08-2: the criteria card is a preview in the conversation; "Chat about this" is in the review it opens, which closes
        // as it hands the question to the composer.
        compose.onNodeWithTag("transcript-list").performScrollToNode(hasText(CardPreviews.viewDetailsAndAct))
        compose.onNodeWithText(CardPreviews.viewDetailsAndAct).performClick()
        compose.waitUntil(10000) { compose.onAllNodesWithTag("card-review").fetchSemanticsNodes().isNotEmpty() }
        // The review reads the session again as it opens and holds its buttons, "Chat about this" among them, until that read is
        // in (`fresh`): a press before then lands on a disabled button and does nothing, and the review stays. Pressed once pressable.
        compose.waitUntil(10000) { compose.onAllNodes(hasText("Chat about this") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Chat about this").performScrollTo().performClick()
        compose.waitUntil(10000) { compose.onAllNodesWithTag("card-review").fetchSemanticsNodes().isEmpty() }
        // A08i: the composer asks for the focus once the page's window has it back from the review's sheet, and its keyboard comes up
        // with it. Asked for in the step that closed the review, both were lost while the sheet still held the window (A15b, API 36).
        compose.waitUntil(10000) { compose.onAllNodes(hasTestTag("composer-input") and isFocused()).fetchSemanticsNodes().isNotEmpty() }
        // Whether the soft keyboard shows is the device's call: with a hardware keyboard exposed (the API 36 AVD's "qwerty,
        // keysexposed") Android may keep it down, so there its state is recorded and not asserted; without one it must come up
        // (the coordinator's ruling on A15b's 360x640 round). The request itself is CardDiscussionFocusTest's to pin.
        fun keyboardShown() = ViewCompat.getRootWindowInsets(compose.activity.window.decorView)?.isVisible(WindowInsetsCompat.Type.ime()) == true
        val config = compose.activity.resources.configuration
        if (config.keyboard != android.content.res.Configuration.KEYBOARD_NOKEYS &&
            config.hardKeyboardHidden == android.content.res.Configuration.HARDKEYBOARDHIDDEN_NO) {
            val shown = runCatching { compose.waitUntil(10000) { keyboardShown() }; true }.getOrDefault(false)
            capture("card-discussion-keyboard")
            File(evidence, "card-discussion-keyboard.txt").writeText("hardware keyboard: yes (keyboard=${config.keyboard}, " +
                "hardKeyboardHidden=${config.hardKeyboardHidden}); show_ime_with_hard_keyboard=" +
                "${String(shellBytes("settings get secure show_ime_with_hard_keyboard")).trim()}; soft keyboard shown within 10 s: $shown\n")
        } else compose.waitUntil(10000) { keyboardShown() }
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
            fun pick(shots: Boolean) {
                compose.onNodeWithTag("composer-plus").performClick(); compose.onNodeWithText("File",useUnmergedTree=true).performClick()
                selectFilesRoot("Downloads")
                if (systemNode("List view") != null) systemClick("List view")
                compose.waitUntil(10000) { systemNode(fileName) != null }
                if (shots) capture("system-files")
                clickNode(systemNode(fileName)!!)
                if (shots) capture("system-file-selected")
                compose.waitUntil(5000) { model.state.value.draft.attachments.isNotEmpty() || systemNode("Select") != null || systemNode("Open") != null }
                if (model.state.value.draft.attachments.isEmpty()) systemClick(if (systemNode("Select") != null) "Select" else "Open")
            }
            pick(shots = true)
            // As iOS: the failed upload's chip goes and the error line above the box says why; picking the file again is the retry.
            compose.waitUntil(15000) { model.state.value.error?.startsWith("Upload failed — $fileName: ") == true && model.state.value.draft.attachments.isEmpty() }
            capture("upload-failed")
            pick(shots = false)
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
            // The in-app reader reads the text file as it opens (A07-1); Copy, Share, Open and Download each fetch it again.
            assertEquals(5,stats()["downloads"]!!.jsonArray.size)
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
        // API29 DriveUI obtains image metadata from the media scan, unlike the new picker.
        val path=resolver.query(uri,arrayOf(MediaStore.Images.Media.DATA),null,null,null)!!.use { it.moveToFirst();it.getString(0) }
        val scanned=java.util.concurrent.CountDownLatch(1)
        android.media.MediaScannerConnection.scanFile(app,arrayOf(path),arrayOf("image/jpeg")) { _,_ -> scanned.countDown() }
        assertTrue(scanned.await(10,java.util.concurrent.TimeUnit.SECONDS))
        try {
            compose.onNodeWithTag("composer-plus").performClick();compose.onNodeWithText("Image",useUnmergedTree=true).performClick()
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
            compose.onNodeWithTag("composer-plus").performClick();compose.onNodeWithText("Paste image",useUnmergedTree=true).performClick()
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
    private fun login(setup: String? = null) {
        compose.waitUntil(10000) { app.session.state.value !is AuthState.Restoring }
        runBlocking { app.session.logout() }; control("""{"reset":true}""")
        setup?.let(::control)
        awaitText("Welcome back")
        compose.chooseServer(server)
        compose.onNodeWithText("Email").performTextReplacement("a07@example.test")
        compose.onNodeWithText("Password").performTextReplacement("a07-fixture-password")
        compose.pressSignIn()
        compose.waitUntil(15000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
        awaitText("Composer conversation")
        compose.onNodeWithText("Composer conversation").performClick()
        compose.waitUntil(10000) { app.realtime.state.value.session?.fresh==true && model.state.value.loaded }
        if (setup == null) awaitText("No messages yet")
    }
    /** A new session's first message waits as the bubble in the engine picker's place (docs/mocks/composer-sending-bubble/03-new-session.html):
     * Sending… while the create is out; past 20 s Not sent, and Retry resends the same clientRequestId — one session, never two. */
    @Test fun newSessionFirstMessageSendingBubbleStates() = journey("new-session-bubble") {
        login()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.startNewSession()
        compose.waitUntil(15000) { compose.onAllNodes(hasTestTag("new-session-engine") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        control("""{"createDelay":6}""")
        compose.onNodeWithTag("composer-input").performTextInput("Build me a thing")
        clickSendWhenEnabled()
        compose.waitUntil(10000) { compose.onAllNodesWithTag("pending-send:sending").fetchSemanticsNodes().isNotEmpty() }
        SystemClock.sleep(1500); compose.waitForIdle(); capture("new-session-sending")
        awaitCreatedSession()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.startNewSession()
        compose.waitUntil(15000) { compose.onAllNodes(hasTestTag("new-session-engine") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        control("""{"createDelay":25}""")
        compose.onNodeWithTag("composer-input").performTextInput("Second first message")
        clickSendWhenEnabled()
        compose.waitUntil(24000) { compose.onAllNodesWithTag("pending-send:not-sent").fetchSemanticsNodes().isNotEmpty() }
        compose.waitForIdle(); capture("new-session-not-sent")
        control("""{"createDelay":0}""")
        compose.onNodeWithTag("pending-send:retry").performClick()
        awaitCreatedSession()
        val ids = stats()["creations"]!!.jsonArray.map { it.jsonObject["clientRequestId"]!!.jsonPrimitive.content }
        assertEquals("one create per message, the Retry added none", 2, ids.toSet().size)
        assertEquals(2, ids.size)
    }

    @Test fun newSessionUsesWorkspaceDraftAndNavigatesAfterCreation() = journey("new-session") {
        login()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.startNewSession()
        // The page as it opens: the engine hero over an empty composer (compared against iOS's draft page).
        compose.waitUntil(15000) { compose.onAllNodes(hasTestTag("new-session-engine") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        // The page opens with the box focused, as iOS's draft does. The keyboard with it is the device's call (see the card
        // discussion journey): recorded, not asserted.
        compose.waitUntil(10000) { compose.onAllNodes(hasTestTag("composer-input") and isFocused()).fetchSemanticsNodes().isNotEmpty() }
        val keyboard = runCatching { compose.waitUntil(10000) {
            ViewCompat.getRootWindowInsets(compose.activity.window.decorView)?.isVisible(WindowInsetsCompat.Type.ime()) == true }; true }.getOrDefault(false)
        File(evidence, "new-session-keyboard.txt").writeText("composer focused: yes; soft keyboard shown within 10 s: $keyboard\n")
        capture("new-session-draft")
        compose.onNodeWithTag("composer-input").performTextInput("新会话的首条消息")
        compose.activityRule.scenario.recreate()
        compose.onNodeWithTag("composer-input").assertTextContains("新会话的首条消息")
        // The recreated page names the workspace's model, and lets the chip be pressed, once it is connected again: until then the
        // chip says "Model" and the box "Reconnect to send" (A15 F-20: pressed at once, 3 of 5 API 36 runs found nothing to press).
        compose.waitUntil(15000) { compose.onAllNodes(hasTestTag("composer-model") and hasClickAction() and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        modelChip(); awaitText("Automatic")
        compose.onAllNodesWithText("Automatic").onLast().performScrollTo().performClick()
        compose.onNodeWithText("Close").performClick()
        compose.waitUntil(10000) { compose.onNodeWithTag("composer-send").fetchSemanticsNode().config.getOrNull(SemanticsProperties.Disabled)==null }
        clickSendWhenEnabled()
        awaitCreatedSession()
        val request=stats()["creations"]!!.jsonArray.single().jsonObject
        assertEquals(workspace,request["workspaceId"]!!.jsonPrimitive.content)
        assertEquals("新会话的首条消息",request["prompt"]!!.jsonPrimitive.content)
        assertNull(request["clientTurnId"])
        assertNull(request["codexAccount"])
        capture("created-session")
        // Back from the session it created goes to the page the draft was opened from, not the draft again (iOS `replaceTop`).
        compose.onNodeWithContentDescription("Back").performClick()
        compose.waitUntil(10000) { compose.onAllNodes(hasTestTag("new-session-engine")).fetchSemanticsNodes().isEmpty() }
        compose.waitForIdle()
        capture("after-back")
    }

    /** A full runner holds the reader's next message, accepted but taken by no runner (web e90dc6fb93): its foot row reads
     * `Queued · runner full · Cancel`, and Cancel takes it back to the composer. */
    @Test fun aMessageAFullRunnerHoldsCanBeCancelled() = journey("runner-full-cancel") {
        val held = "01a0cca7-8609-70ed-a0e2-d4b55b832b91"
        login("""{"status":"PENDING","extraDetail":{"runState":"QUEUED","queuedReason":"runner_at_capacity","queuedActive":4,"queuedLimit":4},
            "rows":[{"seq":1,"type":"user","turnId":"t-1","payload":{"text":"Start task 6"}},
            {"seq":2,"type":"assistant","turnId":"t-1","payload":{"text":"Task 6 is filed and waiting for a runner."}},
            {"seq":3,"type":"turn_end","turnId":"t-1","payload":{"subtype":"success"}}],
            "queuedTurns":[{"id":"$held","turnId":"$held","kind":"message","placement":"accepted","content":"Why is task 6 still queued?","attachments":[]}]}""")
        compose.waitUntil(20000) { compose.onAllNodes(hasTestTag("runner-updating-foot:cancel"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        capture("runner-full-cancel")
        compose.onNodeWithTag("runner-updating-foot:cancel", useUnmergedTree = true).performClick()
        compose.waitUntil(10000) { model.state.value.draft.text == "Why is task 6 still queued?" }
        compose.waitUntil(10000) { compose.onAllNodes(hasTestTag("accepted:$held")).fetchSemanticsNodes().isEmpty() }
        assertTrue(stats()["controls"]!!.jsonArray.any { it.jsonObject["turnId"]?.jsonPrimitive?.content == held })
        capture("runner-full-cancelled")
    }

    /** A message a full runner holds, with the session row as `GET /sessions` sends it beside a capacity gate. */
    private fun heldByFullRunner(active: Int, runNow: String) = """{"status":"PENDING",
        "extraDetail":{"runState":"QUEUED","queuedReason":"runner_at_capacity","queuedActive":$active,"queuedLimit":16,"queuedHeldByJobs":0,
        "queuedBurstLimit":2,"runningOverLimit":null,$runNow,
        "lastTurnAt":"${java.time.Instant.now().minusSeconds(5 * 60L)}"},
        "runnerExtra":{"name":"HPC","maxConcurrent":16,"activeSessions":$active,"burstConcurrent":2},
        "rows":[{"seq":1,"type":"user","turnId":"t-1","payload":{"text":"Start task 6"}},
        {"seq":2,"type":"assistant","turnId":"t-1","payload":{"text":"Task 6 is filed and waiting for a runner."}},
        {"seq":3,"type":"turn_end","turnId":"t-1","payload":{"subtype":"success"}}],
        "queuedTurns":[{"id":"01a0cca7-8609-70ed-a0e2-d4b55b832b92","turnId":"01a0cca7-8609-70ed-a0e2-d4b55b832b92","kind":"message",
        "placement":"accepted","content":"Android: draw the session page the way iOS does.","attachments":[]}]}"""

    private fun openRunnerFull() {
        compose.waitUntil(20000) { compose.onAllNodes(hasTestTag("runner-updating-foot:reason"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("runner-updating-foot:reason", useUnmergedTree = true).performClick()
        compose.waitUntil(10000) { compose.onAllNodes(hasTestTag("run-now:note"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
    }

    /** docs/mocks/queued-run-now ① and ②: Run now in the popover, then the turn running over the limit with its tag. */
    @Test fun runNowStartsAHeldMessageOverTheLimit() = journey("run-now") {
        login(heldByFullRunner(16, """"runNowAvailable":true,"runNowRefusal":null"""))
        openRunnerFull()
        compose.onNodeWithTag("run-now").assertIsEnabled()
        capture("run-now-enabled")
        compose.onNodeWithTag("run-now").performClick()
        compose.waitUntil(15000) { compose.onAllNodes(hasTestTag("over-limit"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        assertTrue(stats()["controls"]!!.jsonArray.any { it.jsonObject["action"]?.jsonPrimitive?.content == "run-now" })
        capture("over-limit")
        compose.onNodeWithTag("over-limit", useUnmergedTree = true).performClick()
        compose.waitUntil(5000) { compose.onAllNodes(hasTestTag("over-limit:hint"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        capture("over-limit-hint")
    }

    /** ③: at the extra cap the button explains, it does not run. */
    @Test fun runNowAtTheCapExplainsInsteadOfRunning() = journey("run-now-refused") {
        login(heldByFullRunner(18, """"runNowAvailable":false,"runNowRefusal":"HPC is already 2 over its limit, the most it can take. Wait, or stop another session.""""))
        openRunnerFull()
        compose.onNodeWithTag("run-now").assertIsNotEnabled()
        capture("run-now-disabled")
    }

    @Test fun explicitRejectionRestoresMessageAndAttachmentThenResumes() = journey("rejected-send") {
        login()
        compose.runOnIdle { model.importAttachment(StagedAttachment("reject-file","retry.txt","text/plain"),
            { StagedAttachment("reject-file","retry.txt","text/plain",4) to "keep".toByteArray() }, {}) }
        compose.waitUntil(10000) { model.state.value.draft.attachments.singleOrNull()?.remoteId != null }
        compose.onNodeWithTag("composer-input").performTextInput("拒绝后恢复同一草稿")
        control("""{"rejectTurnOnce":true}"""); clickSendWhenEnabled()
        // Refused: the bubble reads Not sent, the words come back only with Put back (docs/mocks/composer-sending-bubble).
        compose.waitUntil(10000) { !model.state.value.busy && model.state.value.notSentReason != null }
        compose.onNodeWithTag("pending-send:put-back").performClick()
        compose.waitUntil(10000) { model.state.value.draft.pending == null }
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

    // The Sending… / Not sent bubble, each state photographed for docs/mocks/composer-sending-bubble (04-native-parity.html).
    @Test fun sendingBubbleStates() = journey("sending-bubble") {
        login()
        control("""{"postDelay":6}"""); ready()
        compose.onNodeWithTag("composer-input").performTextInput("Ship the quarterly report")
        clickSendWhenEnabled()
        compose.waitUntil(10000) { model.state.value.draft.pending != null && model.state.value.sending }
        compose.waitUntil(10000) { compose.onAllNodesWithTag("pending-send:sending").fetchSemanticsNodes().isNotEmpty() }
        SystemClock.sleep(1500); compose.waitForIdle(); capture("bubble-sending")
        compose.waitUntil(20000) { !model.state.value.busy && model.state.value.draft.pending == null }
        control("""{"postDelay":0}"""); SystemClock.sleep(2500); compose.waitForIdle(); capture("bubble-sent")
        assertEquals(1, compose.onAllNodesWithText("Ship the quarterly report").fetchSemanticsNodes().size)
        // Held past 20 s: the device ends the request and the bubble reads Not sent with why. The fixture takes it at 25 s, and its echo
        // then replaces the bubble.
        control("""{"postDelay":25}"""); ready()
        compose.onNodeWithTag("composer-input").performTextInput("Second message that never gets an answer")
        clickSendWhenEnabled()
        compose.waitUntil(24000) { model.state.value.notSentReason == PendingSendCopy.NOT_ANSWERED }
        compose.waitUntil(3000) { compose.onAllNodesWithTag("pending-send:not-sent").fetchSemanticsNodes().isNotEmpty() }
        compose.waitForIdle(); capture("bubble-not-sent-unanswered")
        compose.waitUntil(30000) { model.state.value.draft.pending == null }
        compose.waitUntil(10000) { compose.onAllNodesWithTag("pending-send:not-sent").fetchSemanticsNodes().isEmpty() }
        control("""{"postDelay":0}"""); SystemClock.sleep(1500); compose.waitForIdle(); capture("bubble-echo-replaced")
        assertEquals(1, compose.onAllNodesWithText("Second message that never gets an answer").fetchSemanticsNodes().size)
        // Refused (409, the session has ended): Not sent, the server's reason one red line under the foot.
        ready()
        compose.onNodeWithTag("composer-input").performTextInput("Ship the quarterly report again")
        control("""{"rejectTurnOnce":true}"""); clickSendWhenEnabled()
        compose.waitUntil(10000) { model.state.value.notSentReason == "the session has ended" }
        compose.waitUntil(3000) { compose.onAllNodesWithText("the session has ended").fetchSemanticsNodes().isNotEmpty() }
        SystemClock.sleep(800); compose.waitForIdle(); capture("bubble-refused")
        compose.onNodeWithTag("pending-send:put-back").performClick()
        compose.waitUntil(10000) { model.state.value.draft.pending == null }
        compose.onNodeWithTag("composer-input").assertTextContains("Ship the quarterly report again")
        SystemClock.sleep(800); compose.waitForIdle(); capture("bubble-put-back")
    }

    @Test fun explicit413RestoresEditableMessageAndAttachment() = journey("oversize-rejection") {
        login()
        compose.runOnIdle { model.importAttachment(StagedAttachment("oversize-file","retained.txt","text/plain"),
            { StagedAttachment("oversize-file","retained.txt","text/plain",4) to "keep".toByteArray() }, {}) }
        compose.waitUntil(10000) { model.state.value.draft.attachments.singleOrNull()?.remoteId != null }
        val attachment = model.state.value.draft.attachments.single()
        // HTTP response injection exercises the UI. The unit regression uses the actual 10 MiB + 1 text.
        compose.onNodeWithTag("composer-input").performTextInput("正文过大，拒绝后可以缩短")
        control("""{"rejectTurnOnce":true,"rejectTurnStatus":413}"""); clickSendWhenEnabled()
        compose.waitUntil(10000) { !model.state.value.busy && model.state.value.notSentReason != null }
        compose.onNodeWithTag("pending-send:put-back").performClick()
        compose.waitUntil(10000) { model.state.value.draft.pending == null }
        compose.onNodeWithTag("composer-input").assertTextContains("正文过大，拒绝后可以缩短")
        assertEquals(attachment,model.state.value.draft.attachments.single())
        assertEquals(0,stats()["uniqueTurns"]!!.jsonPrimitive.int)
        ready(); compose.onNodeWithTag("composer-input").performScrollTo().assertIsDisplayed()
        capture("413-restored")
        compose.onNodeWithTag("composer-input").performTextReplacement("缩短正文")
        ready(); clickSendWhenEnabled()
        compose.waitUntil(10000) { !model.state.value.busy && model.state.value.draft.pending == null && model.state.value.draft.text.isEmpty() }
        val result = stats()
        val sent = result["turns"]!!.jsonObject.values.single().jsonObject
        assertTrue(sent["endpoint"]!!.jsonPrimitive.content.endsWith("/turns"))
        assertEquals("缩短正文",sent["request"]!!.jsonObject["content"]!!.jsonPrimitive.content)
        assertEquals(attachment.remoteId,sent["request"]!!.jsonObject["attachmentIds"]!!.jsonArray.single().jsonPrimitive.content)
        assertEquals(2,result["calls"]!!.jsonArray.count { it.jsonObject["path"]!!.jsonPrimitive.content.endsWith("/turns") })
        capture("413-corrected-accepted")
    }

    @Test fun draftAccountUsageAndProviderSwitchMatchAutomaticCreate() = journey("draft-account") {
        login(); compose.onNodeWithContentDescription("Back").performClick()
        compose.startNewSession()
        compose.onNodeWithTag("composer-input").performTextInput("账户草稿")
        // The Provider section lists the draft's engine's accounts alone (A07-10 on the provider/engine split): Codex's first, the
        // workspace's engine; Claude Code's once the Engine list moves the draft there. Rows below its heading only: the Effort
        // section above it has a "Default" of its own, and so does the heading's current credential, a line of text that is no row.
        fun inSection(label:String):List<Int> {
            val all=compose.onAllNodes(hasAnyAncestor(isDialog()) and hasText("",substring=true)).fetchSemanticsNodes()
            val heading=all.indexOfFirst { node -> node.config.getOrNull(SemanticsProperties.Text)?.any { it.text=="Provider" }==true }
            if (heading<0) return emptyList()
            val below=all.drop(heading+1).filter { it.config.contains(SemanticsActions.OnClick) }.map { it.id }.toSet()
            return compose.onAllNodesWithText(label).fetchSemanticsNodes().withIndex().filter { it.value.id in below }.map { it.index }
        }
        fun choose(label:String) {
            modelChip(); compose.waitUntil(15000) { inSection(label).isNotEmpty() }
            compose.onAllNodesWithText(label)[inSection(label).single()].performScrollTo().performClick()
            compose.onNodeWithText("Close").performClick()
        }
        fun quota(label:String) {
            compose.onNodeWithTag("composer-context").performClick(); awaitText(label)
            compose.onNodeWithText(label).assertIsDisplayed(); capture("usage-${label.hashCode()}")
            closeSheet()
        }
        choose("Second account"); quota("Primary: 71%")
        choose("Default"); quota("Primary: 23%")
        choose("Automatic"); quota("No quota reported for this account.")
        // Claude Code's accounts are under Claude Code: the engine first, then the account — the draft lands on its Default.
        compose.onNodeWithTag("new-session-engine").performClick()
        compose.waitUntil(15000) { compose.onAllNodesWithTag("engine:claude").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("engine:claude").performClick(); awaitEngine("Claude Code")
        quota("Primary: 11%")
        choose("Claude account"); quota("No quota reported for this account.")
        choose("Automatic"); clickSendWhenEnabled()
        awaitCreatedSession()
        val request=stats()["creations"]!!.jsonArray.single().jsonObject
        assertEquals("claude",request["engine"]!!.jsonPrimitive.content)
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
            assertTrue("no upload failed: ${model.state.value.error}", model.state.value.error?.startsWith("Upload failed") != true)
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

    // A07c (A01b items A07-1/3/4/6/7/8/9/10/12/13, the auto-retry and reset-credit cards): each journey sets the fixture's scenario
    // before the conversation opens, then reads and presses what the composer and the transcript draw.

    private val runner = "01a0cca7-8609-70ed-a0e2-d4b55b832b68"
    private fun now(plusSeconds: Long = 0) = java.time.Instant.now().plusSeconds(plusSeconds).toString()
    private fun dialogTexts() = compose.onAllNodes(hasAnyAncestor(isDialog()) and hasText("", substring = true)).fetchSemanticsNodes()
        .mapNotNull { it.config.getOrNull(SemanticsProperties.Text)?.joinToString(" | ") { t -> t.text } }
    private fun controls() = stats()["controls"]!!.jsonArray.map { it.jsonObject }

    /** A07-13 the engine over the menu, A07-3 the engines in the boards' order, A07-10 each engine's accounts with Automatic first,
     * A07-6 a key under OpenCode and a new session on it, A07-4 Antigravity CLI's sign-in named by its credential — on the
     * provider/engine split: the Engine list first, then only that engine's credentials. */
    @Test fun a07cModelMenuEnginesAccountsAndKeys() = journey("a07c-model-menu") {
        login("""{"runnerExtra":{"capabilities":["codex-account-move/v1"],
            "antigravity":{"supported":true,"installed":true,"version":"1.2.16","envKeyAvailable":true,"authSource":"google","googleLogin":"available"},
            "engines":[{"engine":"kimi","installed":true,"auth":"yes"},{"engine":"opencode","installed":true},
              {"engine":"codex","installed":true,"auth":"yes","accounts":[{"id":"default","name":"Default","auth":"yes"},{"id":"1a2b3c4d","name":"Second account","auth":"yes"},{"id":"deadbeef","name":"Expired account","auth":"no"}]},
              {"engine":"antigravity","installed":true,"auth":"yes","authSource":"google"},
              {"engine":"claude","installed":true,"auth":"yes","accounts":[{"id":"default","name":"Default","auth":"yes"},{"id":"abcd1234","name":"Claude account","auth":"yes"}]}]},
            "providers":[{"slug":"custom-codex","label":"Custom account","runtime":"codex","models":[{"value":"custom-model","label":"Custom model"}]},
              {"slug":"deepseek","label":"DeepSeek","runtime":"claude","presetSlug":"deepseek","runsOnOpenCode":true,"models":[{"value":"deepseek-chat","label":"DeepSeek Chat"}]}]}""")
        modelChip(); compose.waitUntil(15000) { compose.onAllNodesWithTag("composer-engine-title").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("composer-engine-title").assertTextEquals("Codex")
        awaitText("Switches to soonest reset")
        compose.onNodeWithContentDescription("Automatic: starts on the Codex account whose quota resets soonest, and switches when it hits its limit").assertExists()
        File(evidence,"a07c-session-menu.txt").writeText(dialogTexts().joinToString("\n"))
        capture("a07c-session-model-menu")
        compose.onNodeWithText("Close").performClick()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.startNewSession()
        fun engineList(): List<String> {
            compose.onNodeWithTag("new-session-engine").performClick()
            compose.waitUntil(15000) { compose.onAllNodesWithTag("engine:claude").fetchSemanticsNodes().isNotEmpty() }
            return dialogTexts()
        }
        val engines = engineList()
        File(evidence,"a07c-draft-engines.txt").writeText(engines.joinToString("\n"))
        val order = listOf("Claude Code", "Codex", "Kimi Code", "Antigravity CLI", "OpenCode")
        assertEquals("the engines in the boards' order, whatever the runner's", order,
            engines.map { it.substringBefore(" | ").removeSuffix(" | ✓") }.filter { it in order })
        capture("a07c-draft-engine-list")
        compose.onNodeWithTag("engine:antigravity").performClick(); awaitEngine("Antigravity CLI")
        compose.onNodeWithTag("composer-model").performClick(); awaitText("Google account")
        capture("a07c-draft-antigravity-sign-in")
        compose.onNodeWithText("Close").performClick()
        engineList(); compose.onNodeWithTag("engine:opencode").performClick(); awaitEngine("OpenCode")
        // The Provider row says "Own sign-in" for OpenCode's own configuration since A07-19 (d) (A07e, d66ddbc8e); the row under
        // "On Fixture runner" keeps the full name.
        compose.onNodeWithTag("composer-model").performClick(); awaitText("Own sign-in")
        val all = dialogTexts()
        File(evidence,"a07c-draft-menu.txt").writeText(all.joinToString("\n"))
        // OpenCode's Provider section: its own sign-in, then the keys it runs — the DeepSeek key, by its own name.
        val rows = all.drop(all.indexOf("Provider") + 2)
        assertEquals(listOf("On Fixture runner", "✓ OpenCode's own sign-in | opencode auth", "API keys", "DeepSeek"), rows.filter { it != "Close" })
        compose.onNode(hasText("DeepSeek") and hasClickAction() and hasAnyAncestor(isDialog())).performScrollTo()
        capture("a07c-draft-opencode-keys")
        compose.onNode(hasText("DeepSeek") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        awaitText("✓ DeepSeek Chat")
        compose.onNodeWithText("Close").performClick()
        compose.onNodeWithTag("composer-input").performTextInput("A07-6 on OpenCode with the DeepSeek key")
        clickSendWhenEnabled(); awaitCreatedSession()
        val created = stats()["creations"]!!.jsonArray.single().jsonObject
        assertEquals("opencode", created["engine"]!!.jsonPrimitive.content)
        assertEquals("deepseek", created["provider"]!!.jsonPrimitive.content)
        assertEquals("deepseek-chat", created["model"]!!.jsonPrimitive.content)
    }

    /** A07-19's open question (iOS 0ae7ec209 found "DeepSeek Harness" cut to "DeepSeek Har…" beside its model and tick on a 402-point
     * phone): the new session's Engine list in this script's narrow window — every engine's name read whole beside its model, DeepSeek
     * Harness's both where a pick of it lands on its key's model and once it is the draft's own engine, ticked. Each name's width and
     * the width it needs whole are read off the device and written out before anything is asserted: a name narrower than it is whole
     * is cut. (The layout's ellipsis and overflow flags are written beside them: the overflow flag also flags a line laid out at
     * exactly its own width, which the captures show whole.) */
    @Test fun a07eEngineListKeepsEveryEnginesNameWhole() = journey("a07e-engine-list") {
        login("""{"runnerExtra":{"capabilities":["codex-account-move/v1","provider:dsh"],"runtimeDefaultModels":{"dsh":"deepseek-v4-pro"},
            "modelCatalog":{"codex":[{"value":"fixture-model","label":"Fixture One"}],"claude":[{"value":"claude-model","label":"Claude model"}],
              "dsh":[{"value":"deepseek-v4-pro","label":"DeepSeek V4 Pro"},{"value":"deepseek-v4-flash","label":"DeepSeek V4 Flash"}]},
            "engines":[{"engine":"codex","installed":true,"auth":"yes"},{"engine":"claude","installed":true,"auth":"yes"},
              {"engine":"opencode","installed":true},{"engine":"dsh","installed":true,"dsh":{"versionCompatible":true}}]},
            "providers":[{"slug":"deepseek","label":"DeepSeek","runtime":"claude","presetSlug":"deepseek","engines":["claude","opencode","dsh"],
              "models":[{"value":"deepseek-v4-pro","label":"DeepSeek V4 Pro"}]}]}""")
        compose.onNodeWithContentDescription("Back").performClick()
        compose.startNewSession()
        fun engineList() {
            compose.onNodeWithTag("new-session-engine").performClick()
            compose.waitUntil(15000) { compose.onAllNodesWithTag("engine:dsh").fetchSemanticsNodes().isNotEmpty() }
            compose.waitForIdle()
        }
        val names = listOf("claude" to "Claude Code", "codex" to "Codex", "opencode" to "OpenCode", "dsh" to "DeepSeek Harness")
        val report = StringBuilder("screenWidthDp=${app.resources.configuration.screenWidthDp} densityDpi=${app.resources.configuration.densityDpi} " +
            "fontScale=${app.resources.configuration.fontScale}\n")
        /** Whether each engine's name is cut, as its own text layout says. */
        fun read(step: String): Map<String, Boolean> = names.associate { (engine, name) ->
            val row = compose.onNodeWithTag("engine:$engine").fetchSemanticsNode()
            val text = compose.onNode(hasText(name) and hasAnyAncestor(hasTestTag("engine:$engine")), useUnmergedTree = true).fetchSemanticsNode()
            val layouts = mutableListOf<androidx.compose.ui.text.TextLayoutResult>()
            text.config[SemanticsActions.GetTextLayoutResult].action!!.invoke(layouts)
            val layout = layouts.single()
            val whole = kotlin.math.ceil(layout.multiParagraph.intrinsics.maxIntrinsicWidth).toInt()
            val cut = text.size.width < whole
            val texts = row.config.getOrNull(SemanticsProperties.Text)?.joinToString(" | ") { it.text }
            report.appendLine("$step $engine: cut=$cut nameWidthPx=${text.size.width} wholeNamePx=$whole rowWidthPx=${row.size.width} " +
                "layoutEllipsized=${layout.isLineEllipsized(layout.lineCount - 1)} layoutOverflow=${layout.hasVisualOverflow} row=[$texts]")
            engine to cut
        }
        engineList()
        val landing = read("landing")
        capture("a07e-engine-list")
        compose.onNodeWithTag("engine:dsh").performClick(); awaitEngine("DeepSeek Harness")
        engineList()
        val ticked = read("ticked")
        capture("a07e-engine-list-dsh-ticked")
        File(evidence, "a07e-engine-list.txt").writeText(report.toString())
        assertEquals("no engine's name is cut where a pick of it lands: $report", emptyList<String>(), landing.filterValues { it }.keys.toList())
        assertEquals("no engine's name is cut with Harness ticked: $report", emptyList<String>(), ticked.filterValues { it }.keys.toList())
    }

    /** The session page with one finished exchange, to set beside iOS's (compare-android-ios: the iOS probe's S2, same words). */
    @Test fun sessionPageWithOneFinishedExchange() = journey("session-page") {
        login("""{"rows":[{"seq":1,"type":"user","turnId":"t1","payload":{"text":"Highlight the matches in wiki search results."}},
              {"seq":2,"type":"assistant","turnId":"t1","payload":{"text":"Done — matches are highlighted in titles and in the body excerpt.","messageId":"m2"}},
              {"seq":3,"type":"result","turnId":"t1","payload":{"subtype":"success","result":"done"}}]}""")
        awaitText("Done — matches are highlighted in titles and in the body excerpt.")
        // The page as it rests: the composer drawn and the stream connected. Sign-in's keyboard can still be closing as the page
        // opens, and the page folds its composer away while the window reports one; the fixture also drops its stream now and then.
        fun composerShown() = compose.onAllNodes(hasTestTag("composer-input")).fetchSemanticsNodes().any { it.size.height > 0 }
        if (runCatching { compose.waitUntil(5000) { composerShown() } }.isFailure) {
            compose.activityRule.scenario.onActivity { activity ->
                (activity.currentFocus ?: activity.window.decorView).let { view ->
                    activity.getSystemService(android.view.inputmethod.InputMethodManager::class.java)?.hideSoftInputFromWindow(view.windowToken, 0)
                    view.clearFocus()
                }
            }
        }
        compose.waitUntil(15000) { composerShown() && compose.onAllNodes(hasText("Reconnect", substring = true)).fetchSemanticsNodes().isEmpty() }
        compose.waitForIdle()
        capture("session-page")
    }

    /** The main checkout bar and its commits not pushed (board docs/mocks/main-checkout-unpushed-commits/02-native frames E-G). */
    @Test fun mainCheckoutBarTapsIntoItsCommitsNotPushed() = journey("main-checkout-commits") {
        login("""{"mainCheckout":{"files":0},"rows":[{"seq":1,"type":"user","turnId":"t1","payload":{"text":"The Share tray now opens 14 px from the top."}},
              {"seq":2,"type":"assistant","turnId":"t1","payload":{"text":"Done.","messageId":"m2"}},
              {"seq":3,"type":"result","turnId":"t1","payload":{"subtype":"success","result":"done"}}]}""")
        compose.waitUntil(30000) { compose.onAllNodes(hasTestTag("main-checkout-bar")).fetchSemanticsNodes().isNotEmpty() }
        compose.waitForIdle(); capture("bar")
        compose.onNodeWithTag("main-checkout-bar").performClick()
        compose.waitUntil(15000) { compose.onAllNodes(hasTestTag("main-checkout-commit")).fetchSemanticsNodes().size == 4 }
        capture("sheet-clean")
        compose.onAllNodes(hasTestTag("main-checkout-commit"))[0].performClick()
        compose.waitUntil(15000) { compose.onAllNodes(hasTestTag("commit-screen")).fetchSemanticsNodes().isNotEmpty() }
        capture("commit")
        instrument.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
        compose.waitUntil(15000) { compose.onAllNodes(hasTestTag("commit-screen")).fetchSemanticsNodes().isEmpty() }
        compose.onAllNodes(hasTestTag("main-checkout-commit")).assertCountEquals(4)
        // Dirty: the files first, the group folded to one row and "3 more".
        control("""{"mainCheckout":{"files":3}}""")
        instrument.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
        compose.waitUntil(15000) { compose.onAllNodes(hasTestTag("main-checkout-sheet")).fetchSemanticsNodes().isEmpty() }
        compose.waitUntil(30000) { compose.onAllNodesWithText("3 uncommitted files", substring = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("main-checkout-bar").performClick()
        compose.waitUntil(15000) { compose.onAllNodes(hasTestTag("main-checkout-more-commits")).fetchSemanticsNodes().isNotEmpty() }
        capture("sheet-dirty")
    }

    /** The reader's own turn as iOS draws it (OrbitApp `UserBubbleView`): a sent screenshot over the trailing bubble, the Chinese the
     * owner wrote with the English the agent got under it ("Show both languages"), copy · time · the translation foot; the reply under
     * it the document alone. Compared against the iPhone's frame of the same transcript. */
    @Test fun userBubbleImageAndBothLanguages() = journey("user-bubble") {
        val shot = Bitmap.createBitmap(540, 1170, Bitmap.Config.ARGB_8888)
        android.graphics.Canvas(shot).apply {
            drawColor(android.graphics.Color.rgb(248, 248, 250))
            val grey = android.graphics.Paint().apply { color = android.graphics.Color.rgb(200, 200, 206) }
            for (i in 0 until 14) drawRect(40f, 160f + i * 64f, if (i % 3 == 2) 330f else 500f, 184f + i * 64f, grey)
            drawRect(30f, 1060f, 510f, 1130f, android.graphics.Paint().apply { color = android.graphics.Color.rgb(30, 110, 220) })
        }
        val png = java.io.ByteArrayOutputStream().also { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        val image = "01a0cca7-8609-70ed-a0e2-d4b55b832b70"
        login("""{"me":{"id":"a07-user","email":"a07@example.test","name":"A07","translationAvailable":true,
              "preferences":{"translationEnabled":true,"translationLanguage":"zh-Hans","translationBilingual":true}},
            "files":{"$image":{"name":"Screenshot_1259.png","mime":"image/png","base64":"${java.util.Base64.getEncoder().encodeToString(png)}"}},
            "rows":[{"seq":1,"type":"user","turnId":"t-1","ts":"${now(-130)}","payload":{"text":"Please review the rendering of the Android session chat window.",
                "translation":{"state":"DONE","from":"zh-Hans","original":"Android session 聊天窗口的渲染请 review 下"},
                "attachments":[{"id":"$image","name":"Screenshot_1259.png","mime":"image/png"}]}},
              {"seq":2,"type":"assistant","turnId":"t-1","ts":"${now(-100)}","payload":{"text":"I'll compare it with the iPhone frame and send you both.",
                "translation":{"lang":"zh-Hans","text":"我会把它和 iPhone 的画面对比，然后把两张都发给你。"}}},
              {"seq":3,"type":"turn_end","turnId":"t-1","payload":{"subtype":"success"}}]}""")
        awaitText("Hide original")
        compose.waitUntil(15000) { compose.onAllNodes(hasTestTag("user-turn-image"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("user-bubble", useUnmergedTree = true).performScrollTo()
        compose.waitForIdle()
        capture("user-bubble-image-bilingual")
    }

    /** The auto-retry card (baseline): a spent quota counts down to its reset, and its switch turns the armed retry off. */
    @Test fun a07cAutoRetryCardCountsDownAndItsSwitchTurnsItOff() = journey("a07c-auto-retry") {
        login("""{"rows":[{"seq":1,"type":"user","payload":{"text":"Ship the release notes"}},
              {"seq":2,"type":"assistant","payload":{"text":"You've hit your session limit · resets 6:20pm (Europe/Berlin)"}}],
            "extraDetail":{"retryAt":"${now(11 * 60)}","retryAttempts":0,"assignedRunner":{"id":"$runner","name":"Fixture runner"}}}""")
        awaitText("5-hour limit reached"); awaitText("Auto-retry when the quota resets"); awaitText("Retry now anyway")
        capture("a07c-auto-retry-armed")
        compose.onNodeWithTag("auto-retry-switch").performScrollTo().performClick()
        compose.waitUntil(10000) { controls().any { it["action"]?.jsonPrimitive?.content == "auto-retry" && it["method"]?.jsonPrimitive?.content == "DELETE" } }
        awaitText("Off — nothing will re-send until you do.")
        capture("a07c-auto-retry-off")
        appClick("Retry now")
        compose.waitUntil(10000) { controls().any { it["action"]?.jsonPrimitive?.content == "retry-message" } }
    }

    /** A07-12: a limit on a turn nobody sent continues — and the continue goes out as anything typed does, so a response lost on
     * the way is sent again under the same clientTurnId, and the server holds one turn. */
    @Test fun a07cContinueSendsTheContinueSentenceUnderOneKey() = journey("a07c-continue") {
        login("""{"rows":[{"seq":1,"type":"assistant","payload":{"text":"You've hit your session limit · resets 6:20pm (Europe/Berlin)"}}],
            "retryMessage":{"text":"","nothingToResend":true},"losses":1,
            "extraDetail":{"retryAttempts":1,"assignedRunner":{"id":"$runner","name":"Fixture runner"}}}""")
        awaitText("Sends “Continue where you left off.”"); awaitText("Continue when the quota resets")
        capture("a07c-continue-card")
        appClick("Continue")
        compose.waitUntil(15000) { model.state.value.draft.pending != null && !model.state.value.busy }
        capture("a07c-continue-unconfirmed")
        ready(); appClick("Retry saved send")
        compose.waitUntil(15000) { model.state.value.draft.pending == null && !model.state.value.busy }
        val turns = stats()["turns"]!!.jsonObject
        assertEquals(1, turns.size)
        assertEquals("Continue where you left off.", turns.values.single().jsonObject["request"]!!.jsonObject["content"]!!.jsonPrimitive.content)
        assertEquals("the lost attempt and its replay, one key", 2, stats()["attempts"]!!.jsonObject.values.single().jsonPrimitive.int)
        capture("a07c-continue-sent")
    }

    /** The task card over a task's own run (docs/task-run-sidebar-design.md): ⋯ → Open Task in the conversation draws the web
     * column's blocks in its order, in each of its four states (src/android/scripts/task_card_states.py, the iOS probe's data too). */
    @Test fun taskRunCardFollowsTheWebColumn() = journey("task-run-card") {
        for ((state, words) in listOf("failed" to "Why it failed", "running" to "Now", "needs-you" to "Review the evidence", "done" to "Delivered")) {
            login("""{"taskCard":"$state"}""")
            awaitCreatedSession()
            appClick("Session actions")
            awaitText("Open Task")
            appClick("Open Task")
            compose.waitUntil(15000) { compose.onAllNodesWithTag("task-run-card").fetchSemanticsNodes().isNotEmpty() }
            awaitText(words)
            compose.waitUntil(15000) { compose.onAllNodesWithTag("task-card-done-means").fetchSemanticsNodes().isNotEmpty() }
            capture("task-card-$state")
            compose.onNodeWithTag("task-detail").performScrollToNode(hasTestTag("task-card-activity"))
            compose.waitForIdle()
            capture("task-card-$state-end")
        }
    }

    /** A07-4 (and A13-3's composer part): an Antigravity session's failure is its repair card — the CLI's install, said while it
     * runs — and a missing credential offers Google sign-in, a Gemini key, and the switch to one. */
    @Test fun a07cAntigravityRepairCard() = journey("a07c-antigravity") {
        login("""{"extraDetail":{"provider":"antigravity","model":"gemini-3-pro"},
            "runnerExtra":{"version":"0.1.230","antigravity":{"supported":true,"installed":false,"version":null,"envKeyAvailable":true,"authSource":"env_key","googleLogin":"available"},
              "engines":[{"engine":"antigravity","installed":false}]},
            "rows":[{"seq":1,"type":"user","payload":{"text":"Fix the flaky test"}},
              {"seq":2,"type":"error","payload":{"message":"Antigravity CLI (\"agy\") not found on this runner's PATH — run `orbit doctor` on the runner to install it and sign in."}}]}""")
        awaitText("Antigravity CLI isn't installed on Fixture runner")
        capture("a07c-antigravity-not-installed")
        compose.waitUntil(10000) { compose.onNode(hasText("Install") and hasClickAction()).fetchSemanticsNode().config.getOrNull(SemanticsProperties.Disabled) == null }
        appClick("Install")
        compose.waitUntil(10000) { controls().any { it["action"]?.jsonPrimitive?.content == "install" } }
        awaitText("Installing Antigravity CLI…")
        capture("a07c-antigravity-installing")
        login("""{"extraDetail":{"provider":"antigravity","model":"gemini-3-pro"},
            "runnerExtra":{"antigravity":{"supported":true,"installed":true,"version":"1.2.16","envKeyAvailable":false,"authSource":null,"googleLogin":"available"},
              "engines":[{"engine":"antigravity","installed":true,"auth":"no"}]},
            "providers":[{"slug":"gemini","label":"Gemini","runtime":"antigravity","presetSlug":"gemini","models":[{"value":"gemini-3-pro","label":"Gemini 3 Pro"}]}],
            "rows":[{"seq":1,"type":"user","payload":{"text":"Fix the flaky test"}},
              {"seq":2,"type":"error","payload":{"message":"Failed to authenticate: Antigravity runs on an API key (GEMINI_API_KEY), and neither this session nor the runner has one."}}]}""")
        awaitText("Antigravity needs authentication"); awaitText("Sign in with Google")
        capture("a07c-antigravity-needs-credential")
        compose.waitUntil(10000) { compose.onNode(hasText("Switch to Gemini") and hasClickAction()).fetchSemanticsNode().config.getOrNull(SemanticsProperties.Disabled) == null }
        appClick("Switch to Gemini")
        compose.waitUntil(10000) { stats()["config"]!!.jsonObject["provider"]?.jsonPrimitive?.content == "gemini" }
    }

    /** A07-7: a session on a pool of ChatGPT accounts names the one it runs on; the reset-credit card (baseline) spends a credit only
     * once confirmed, and (A07-9) an account with none left draws no reset section. */
    @Test fun a07cPoolAccountAndResetCredit() = journey("a07c-pool-reset") {
        login("""{"extraDetail":{"provider":"codex-pool","model":"fixture-model","poolCodexLogin":{"email":"second@example.test","fingerprint":"…CD34","state":"ACTIVE"}},
            "pools":[{"id":"01a0cca7-8609-70ed-a0e2-d4b55b832b71","slug":"codex-pool","label":"Codex pool","engine":"codex","logins":[
              {"email":"first@example.test","fingerprint":"…AB12","plan":"plus","state":"ACTIVE","usage":{"provider":"codex","primary":{"utilization":100,"windowDurationMins":300,"resetsAt":"${now(3600)}"}}},
              {"email":"second@example.test","fingerprint":"…CD34","plan":"pro","state":"ACTIVE","usage":{"provider":"codex","primary":{"utilization":41,"windowDurationMins":300}}}]}]}""")
        compose.waitUntil(15000) { compose.onAllNodesWithTag("composer-pool-account").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("composer-pool-account").assertTextEquals("second@example.test")
        capture("a07c-pool-account")
        compose.onNodeWithTag("composer-context").performClick(); awaitText("Primary: 41%"); awaitText("Account")
        capture("a07c-pool-usage-sheet")
        closeSheet()
        fun resetRunner(available: Int) = """{"runnerExtra":{"capabilities":["codex-account-move/v1","codex-rate-limit-reset-v1"],
            "heartbeatLeaseOwner":"7c9e6679-7425-40de-944b-e07fc1f90ae7","heartbeatDraining":false,
            "planUsage":{"codex":{"provider":"codex","primary":{"utilization":23},"rateLimitReset":{"protocolVersion":1,"support":"SUPPORTED",
              "accountFingerprint":"cxa1_0123456789abcdef0123456789abcdef","rateLimitResetCredits":{"availableCount":$available,"credits":[
                {"id":"c1","resetType":"weekly","status":"available","grantedAt":"2026-10-01T00:00:00Z","expiresAt":"2026-12-24T09:30:00Z"},
                {"id":"c2","resetType":"weekly","status":"available","grantedAt":"2026-10-02T00:00:00Z","expiresAt":"2027-01-05T09:30:00Z"}]},
              "fetchedAt":"${now(-120)}","generation":"3f2b8c1e-9d4a-4b7e-8c2f-1a2b3c4d5e6f","sequence":3}}}}}"""
        login(resetRunner(2))
        compose.onNodeWithTag("composer-context").performClick(); awaitText("Reset credit"); awaitText("2 available")
        compose.onNodeWithText("Use reset credit").performScrollTo()
        capture("a07c-reset-credit")
        compose.waitUntil(10000) { compose.onNode(hasText("Use reset credit") and hasClickAction()).fetchSemanticsNode().config.getOrNull(SemanticsProperties.Disabled) == null }
        appClick("Use reset credit"); awaitText("Use reset credit?")
        capture("a07c-reset-confirm")
        appClick("Use reset")
        compose.waitUntil(10000) { controls().any { it["action"]?.jsonPrimitive?.content == "codex-rate-limit-reset" } }
        awaitText("Waiting for the runner…")
        capture("a07c-reset-pending")
        compose.onNodeWithText("Close").performClick()
        login(resetRunner(0))
        compose.onNodeWithTag("composer-context").performClick(); awaitText("Primary: 23%")
        assertTrue("A07-9: no reset section for an account with no credit left", compose.onAllNodesWithText("Reset credit").fetchSemanticsNodes().isEmpty())
        capture("a07c-reset-none-left")
    }

    /** A07-8: a Retry pressed after picking a provider in the composer re-sends on it. */
    @Test fun a07cRetryCarriesTheProviderPick() = journey("a07c-retry-provider") {
        login("""{"status":"FAILED"}""")
        modelChip(); awaitText("Custom account"); appClick("Custom account")
        // What the pick will do, and when (A07-19 (a)): the session has ended, so its next message.
        awaitText("Your next message uses Custom account.")
        compose.onNodeWithText("Close").performClick()
        compose.onNodeWithTag("composer-plus").performClick(); awaitText("Retry last failed message"); appClick("Retry last failed message")
        compose.waitUntil(10000) { controls().any { it["action"]?.jsonPrimitive?.content == "retry-message" } }
        val retry = controls().last { it["action"]?.jsonPrimitive?.content == "retry-message" }
        assertEquals("custom-codex", retry["body"]!!.jsonObject["provider"]!!.jsonPrimitive.content)
        assertEquals("the pick travels with the session's engine", "codex", retry["body"]!!.jsonObject["engine"]!!.jsonPrimitive.content)
        capture("a07c-retry-on-pick")
    }

    /** A07-1: a text or Markdown attachment opens in the app — Markdown as Preview or Source — and its lines are counted. */
    @Test fun a07cTextAndMarkdownAttachmentsOpenInTheApp() = journey("a07c-text-preview") {
        val notes = "11111111-1111-4111-8111-111111111111"; val log = "22222222-2222-4222-8222-222222222222"
        login("""{"files":{"$notes":{"name":"release-notes.md","mime":"text/markdown","text":"# Release notes\n\n- **Fixed** the retry door\n- Added the reset card\n"},
              "$log":{"name":"build.log","mime":"text/plain","text":"> Task :app:test\nBUILD SUCCESSFUL in 4m\n3 actionable tasks\n"}},
            "rows":[{"seq":1,"type":"user","payload":{"text":"Files attached","attachments":[{"id":"$notes","name":"release-notes.md","mime":"text/markdown"},
              {"id":"$log","name":"build.log","mime":"text/plain"}]}}]}""")
        awaitText("release-notes.md"); appClick("release-notes.md")
        awaitText("4 lines"); awaitText("Release notes")
        capture("a07c-markdown-preview")
        appClick("Source"); awaitText("# Release notes")
        capture("a07c-markdown-source")
        appClick("Close attachment")
        appClick("build.log"); awaitText("3 lines"); awaitText("BUILD SUCCESSFUL in 4m")
        capture("a07c-text-file")
        appClick("Close attachment")
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
    /** The usage sheet the toolbar's ring opens goes with the system back, as a bottom sheet does. */
    private fun closeSheet() { InstrumentationRegistry.getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK); compose.waitForIdle() }
    /** The composer's model chip, by its tag: it reads the model's id until the catalogue is in, then the catalogue's name. */
    private fun modelChip() {
        compose.onNode(hasTestTag("composer-model") and hasClickAction()).performSemanticsAction(SemanticsActions.OnClick) { assertTrue(it()) }
    }
    private fun appClick(label:String) {
        compose.onNode((hasText(label) or hasContentDescription(label)) and hasClickAction()).performSemanticsAction(SemanticsActions.OnClick) { assertTrue(it()) }
    }
    private fun ready() { compose.waitUntil(10000) { app.realtime.state.value.session?.fresh==true && !model.state.value.busy };compose.waitForIdle() }
    private fun awaitText(text:String) { compose.waitUntil(15000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() } }
    /** The new session hero names [engine] (the chevron beside it is an icon). */
    private fun awaitEngine(engine: String) { compose.waitUntil(15000) { compose.onAllNodes(hasTestTag("new-session-engine") and hasText(engine)).fetchSemanticsNodes().isNotEmpty() } }
    /** The created session's page is up: its ⋯ in the bar has the session to act on — the page draws no title since A06-18. */
    private fun awaitCreatedSession() {
        compose.waitUntil(15000) { compose.onAllNodes(hasContentDescription("Session actions") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
    }
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
        // Under host load the system can hand back no screenshot at all: try again, and count one still missing rather than fail.
        val shot=(1..3).firstNotNullOfOrNull { instrument.uiAutomation.takeScreenshot() ?: run { SystemClock.sleep(1000); null } }
        if (shot==null) { File(evidence,"missing-captures.txt").appendText("$name\n"); return }
        File(evidence,"$name.png").outputStream().use { shot.compress(Bitmap.CompressFormat.PNG,100,it) };shot.recycle()
    }
    private fun journey(name:String,block:()->Unit) {
        instrument.sendStatus(0,Bundle().apply { putString("a07_pid",Process.myPid().toString()) })
        File(evidence,"identity.txt").writeText("sha=${BuildConfig.SOURCE_SHA}\ndirty=${BuildConfig.SOURCE_DIRTY}\napi=${Build.VERSION.SDK_INT}\n")
        try { block();File(evidence,"$name-result.txt").writeText("PASS\n") }
        catch(e:Throwable) { capture("$name-failure");File(evidence,"$name-result.txt").writeText(e.stackTraceToString());throw e }
        finally { File(evidence,"$name-server.json").writeText(request("/__stats"));control("""{"denial":0,"expired":false}""");runBlocking { app.session.logout() } }
    }
}
