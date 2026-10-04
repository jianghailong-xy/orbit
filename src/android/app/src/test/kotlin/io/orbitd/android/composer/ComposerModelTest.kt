package io.orbitd.android.composer

import io.orbitd.android.attachments.AttachmentLimits
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.Wire
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ComposerModelTest {
    private class Rig(val test: TestScope) {
        val disk = mutableMapOf<String, ByteArray>()
        var stored: StoredSession? = null
        var server: String? = null
        var failSave = false
        var failPosts = 0
        var detail = """{"id":"s","status":"AWAITING_INPUT","assignedRunnerId":"r","provider":"codex","capabilities":{"canSend":true,"canResume":false}}"""
        val calls = mutableListOf<ApiRequest>()
        val sends = mutableMapOf<String, String>()
        var uploadHeld: CompletableDeferred<Unit>? = null
        val uploadStarts = Channel<Unit>(Channel.UNLIMITED)
        var deny = false
        var createLost = false
        fun auth() = AuthSession(HttpTransport { request ->
            val call = request.api; calls += call
            if (call.path.first() == "auth") return@HttpTransport ApiResponse(200, """{"accessToken":"access","refreshToken":"refresh","user":{"id":"u","email":"a@example.test","name":"A"}}""".toByteArray())
            if (deny) return@HttpTransport ApiResponse(403, "{}".toByteArray())
            val answer = when {
                call.path == listOf("sessions", "s") -> detail
                call.path.first() == "workspaces" -> """{"id":"w","provider":"codex","runnerId":"r","enabled":true}"""
                call.path == listOf("sessions") && call.method == HttpMethod.POST -> {
                    if (createLost) throw NetworkException()
                    """{"id":"created-session"}"""
                }
                call.path.first() == "attachments" -> {
                    uploadStarts.send(Unit)
                    uploadHeld?.await()
                    call.onUploadProgress?.invoke(100, 100)
                    """{"id":"remote-${calls.count { it.path.first() == "attachments" }}"}"""
                }
                call.path.last() in setOf("turns", "resume") && call.method == HttpMethod.POST -> {
                    val raw = call.body!!.decodeToString(); val payload = Wire.json.parseToJsonElement(raw).jsonObject
                    val id = payload.text("clientTurnId")!!
                    // No packet may leave until a recoverable, identical outbox entry exists.
                    assertTrue(disk.values.any { bytes -> bytes.decodeToString().contains(id) })
                    val prior = sends.putIfAbsent(id, raw)
                    if (prior != null) assertEquals(prior, raw)
                    if (failPosts-- > 0) throw NetworkException() // Accepted, then response lost.
                    """{"turnId":"turn-$id","kind":"message","status":"PENDING"}"""
                }
                call.path == listOf("runners") -> """[{"id":"r","modelCatalog":{"codex":[{"value":"live-model","label":"Live","reasoningLevels":["low","high"]}]},"engines":[{"engine":"codex","installed":true,"auth":"yes","accounts":[{"id":"default","auth":"yes"},{"id":"expired","auth":"no"}]}]}]"""
                call.path.first() == "providers" -> "[]"
                else -> "{}"
            }
            ApiResponse(200, answer.toByteArray())
        }, object : CredentialStore {
            override suspend fun load() = stored
            override suspend fun save(session: StoredSession) { stored = session }
            override suspend fun clear() { stored = null }
        }, object : InstanceStore {
            override suspend fun load() = server
            override suspend fun save(server: String) { this@Rig.server = server }
        }, object : SessionDataStore {
            private fun key(a: AccountKey, k: DataKind, id: String) = "${a.server}:${a.userId}:$k:$id"
            override suspend fun read(account: AccountKey, kind: DataKind, key: String) = disk[key(account, kind, key)]
            override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) {
                if (failSave) throw SecureStorageException()
                disk[key(account, kind, key)] = bytes.copyOf()
            }
            override suspend fun clearAll() { disk.clear() }
        }, "test", dispatcher = StandardTestDispatcher(test.testScheduler))
        lateinit var session: AuthSession
        val handle get() = (session.state.value as AuthState.SignedIn).handle
        suspend fun start(): ComposerModel {
            session = auth(); session.login(ServerAddress.parse("https://one.example"), "a@example.test", "password")
            return model()
        }
        fun model(id: String = "s") = ComposerModel(session, handle, id, test.backgroundScope).also { test.runCurrent() }
        suspend fun cold(): ComposerModel { session = auth(); session.restore(); return model() }
    }

    @Test fun creationKeepsWorkspaceFolderAndAccountAndNeverBlindlyReplaysAmbiguousCreate() = runTest {
        val rig = Rig(this); rig.start()
        val target = DraftTarget("w", "folder")
        var model = ComposerModel(rig.session, rig.handle, target.key, backgroundScope, target); runCurrent()
        model.edit("新会话", 3, 3)
        model.config(buildJsonObject { put("model", "live-model"); put("provider", "codex"); put("account", "second") }); runCurrent()
        rig.createLost = true; model.send(); runCurrent()
        val saved = model.state.value.draft.pending!!
        assertEquals("create", saved.endpoint)
        assertEquals("folder", saved.body.text("folderId")); assertEquals("w", saved.body.text("workspaceId"))
        assertEquals("second", saved.body.text("codexAccount")); assertNull(saved.body["clientTurnId"])
        model.close(); model = ComposerModel(rig.session, rig.handle, target.key, backgroundScope, target); runCurrent()
        assertEquals(saved, model.state.value.draft.pending)
        model.retrySend(); model.send(); runCurrent()
        assertEquals(1, rig.calls.count { it.path == listOf("sessions") && it.method == HttpMethod.POST })
        val other = DraftTarget("w", "other-folder")
        val next = ComposerModel(rig.session, rig.handle, other.key, backgroundScope, other); runCurrent()
        assertTrue(next.state.value.draft.text.isEmpty()); assertNull(next.state.value.draft.pending)
        rig.createLost = false; next.edit("成功创建", 0, 0); next.send(); runCurrent()
        assertEquals("created-session", next.state.value.draft.createdSessionId)
        assertNull(next.state.value.draft.pending)
    }

    @Test fun hundredGroupsLostResponsesAndColdProcessesReplayExactlyOneTurnPerKey() = runTest {
        val rig = Rig(this); var model = rig.start()
        repeat(100) { index ->
            model.edit("中文消息 $index", 2, 4); runCurrent(); rig.failPosts = 2
            model.send(); model.send(); runCurrent()
            val first = model.state.value.draft.pending!!
            model.close(); model = rig.cold()
            assertEquals(first, model.state.value.draft.pending)
            model.retrySend(); model.retrySend(); runCurrent()
            assertEquals(first, model.state.value.draft.pending)
            model.close(); model = rig.cold(); model.retrySend(); runCurrent()
            assertNull(model.state.value.draft.pending)
        }
        assertEquals(100, rig.sends.size)
        assertEquals(300, rig.calls.count { it.path.last() == "turns" && it.method == HttpMethod.POST })
    }

    @Test fun savedEndpointAttachmentsAndConfigNeverChangeWhenStateMovesDuringRetry() = runTest {
        val rig = Rig(this); val model = rig.start()
        rig.detail = """{"status":"FAILED","capabilities":{"canSend":false,"canResume":true}}"""
        model.config(buildJsonObject { put("model", "selected"); put("effort", "high") }); runCurrent()
        model.importAttachment(StagedAttachment("a", "中文.txt", "text/plain"),
            { StagedAttachment("a", "中文.txt", "text/plain", 4) to "text".toByteArray() }, {}); runCurrent()
        model.state.first { it.uploads.isEmpty() }
        model.edit("再试", 2, 2); rig.failPosts = 1; model.send(); runCurrent()
        val pending = model.state.value.draft.pending!!
        assertEquals("resume", pending.endpoint); assertEquals("selected", pending.body.text("model"))
        assertEquals(1, pending.body["attachmentIds"]!!.jsonArray.size)
        model.edit("新草稿不能丢", 6, 6)
        rig.detail = """{"status":"RUNNING","capabilities":{"canSend":true}}"""
        model.retrySend(); runCurrent()
        assertEquals("新草稿不能丢", model.state.value.draft.text)
        assertEquals(2, rig.calls.count { it.path.last() == "resume" })
        assertEquals(1, rig.sends.size)
    }

    @Test fun uploadWaitRemovalAndFailureDoNotDropAttachmentsOrResurrectRemovedChips() = runTest {
        val rig = Rig(this); val model = rig.start(); rig.uploadHeld = CompletableDeferred()
        repeat(3) { i -> model.importAttachment(StagedAttachment("a$i", "f$i", "text/plain"),
            { StagedAttachment("a$i", "f$i", "text/plain", 1) to byteArrayOf(1) }, {}) }
        model.edit("with files", 0, 0); runCurrent(); model.send(); runCurrent()
        repeat(2) { rig.uploadStarts.receive() }
        assertTrue(model.state.value.waiting); assertTrue(rig.sends.isEmpty())
        assertEquals(2, rig.calls.count { it.path.first() == "attachments" })
        model.removeAttachment("a0"); runCurrent(); rig.uploadHeld!!.complete(Unit); runCurrent()
        model.state.first { !it.waiting && !it.busy }
        assertEquals(1, rig.sends.size)
        assertEquals(2, Wire.json.parseToJsonElement(rig.sends.values.single()).jsonObject["attachmentIds"]!!.jsonArray.size)
        assertTrue(model.state.value.draft.attachments.isEmpty())
        model.importAttachment(StagedAttachment("bad", "bad", "text/plain"), { error("permission revoked") }, {}); runCurrent()
        model.edit("failure", 0, 0); model.send(); runCurrent()
        assertEquals(1, rig.sends.size); assertEquals("bad", model.state.value.draft.attachments.single().id)
    }

    @Test fun diskFailurePreventsSendAndLongDraftRestoresSelectionAndNamespace() = runTest {
        val rig = Rig(this); var model = rig.start()
        val long = "中文🙂\n".repeat(5000)
        model.edit(long, 1234, 1250); runCurrent(); model.close(); model = rig.cold()
        assertEquals(long, model.state.value.draft.text); assertEquals(1234, model.state.value.draft.selectionStart)
        assertEquals("", rig.model("other-session").state.value.draft.text)
        rig.failSave = true; model.send(); runCurrent(); assertTrue(rig.sends.isEmpty())
        assertNotNull(model.state.value.draft.pending)
        rig.failSave = false; model.retrySend(); runCurrent(); assertEquals(1, rig.sends.size)
        rig.session.logout(); runCurrent(); assertTrue(rig.disk.isEmpty())
        model.edit("late account bytes", 0, 0); runCurrent(); assertTrue(rig.disk.isEmpty())
    }

    @Test fun deniedCapabilitiesAndPermissionsCannotProduceTurnsOrMaskFailure() = runTest {
        val rig = Rig(this); val model = rig.start()
        rig.detail = """{"status":"RUNNING","capabilities":{"canSend":false,"canResume":false,"resumeBlockedReason":"runner_offline"}}"""
        model.edit("don't send", 0, 0); model.send(); runCurrent(); assertTrue(rig.sends.isEmpty())
        assertEquals("don't send", model.state.value.draft.text)
        rig.deny = true; model.loadCatalog(); runCurrent(); assertNull(model.state.value.catalog)
        assertNotNull(model.state.value.catalogError)
        model.config(buildJsonObject { put("model", "other") }); runCurrent()
        assertFalse(rig.calls.any { it.path.last() == "config" })
    }

    @Test fun catalogUsesRealListContractAndRuntimeCapabilities() = runTest {
        val rig = Rig(this); val model = rig.start(); model.loadCatalog(); runCurrent()
        val catalog = model.state.value.catalog!!
        assertEquals("live-model", catalog.models("codex").single().text("value"))
        assertEquals(listOf("low", "high"), catalog.models("codex").single().strings("reasoningLevels"))
        assertEquals("no", catalog.accounts("codex").last().text("auth"))
        assertFalse(rig.calls.any { it.path == listOf("runners", "r") })
        model.config(buildJsonObject { put("model", "live-model") }); runCurrent()
        model.config(buildJsonObject { put("account", "default") }, true); runCurrent()
        model.control("interrupt"); runCurrent(); model.control("turns/turn-id", HttpMethod.DELETE); runCurrent()
        model.control("retry-message", body = JsonObject(emptyMap())); runCurrent()
        assertEquals(listOf("config", "account", "interrupt", "turn-id", "retry-message"), rig.calls.filter { it.method != HttpMethod.GET && it.path.first() != "auth" }.map { it.path.last() })
    }

    @Test fun entrySpecificLimitsKeepPhotoPasteAndFileDifferenceAtExactBoundaries() {
        for (mime in AttachmentLimits.inlineTypes) {
            assertNull(AttachmentLimits.rejection("file", mime, AttachmentLimits.MAX_IMAGE))
            assertNotNull(AttachmentLimits.rejection("file", mime, AttachmentLimits.MAX_IMAGE + 1))
            for (source in listOf("photo", "paste")) assertNull(AttachmentLimits.rejection(source, mime, AttachmentLimits.MAX_FILE))
        }
        assertNull(AttachmentLimits.rejection("file", "application/pdf", AttachmentLimits.MAX_FILE))
        assertNotNull(AttachmentLimits.rejection("file", "text/plain", AttachmentLimits.MAX_FILE + 1))
        assertNotNull(AttachmentLimits.rejection("file", "text/plain", 0))
    }

    @Test fun localStatusCreatesNoTurnAndCatalogPreservesRuntimeAgentAndRootRestrictions() = runTest {
        val rig = Rig(this); val model = rig.start()
        model.edit("/status\n", 0, 0); model.send(); runCurrent()
        assertTrue(rig.sends.isEmpty()); assertTrue(model.state.value.draft.text.isEmpty())
        assertTrue(model.state.value.notice!!.contains("codex"))
        val runner=Wire.json.parseToJsonElement("""{"runsAsRoot":true,"commands":[{"name":"host","type":"command"},{"name":"wrong-agent","agentId":"other","type":"command"},{"name":"kimi","provider":"kimi","type":"command"}],"modelCatalog":{"claude":[{"value":"claude-opus-5","permissionModes":["default"]}]}}""").jsonObject
        val catalog=ComposerCatalog(runner,emptyList())
        assertEquals(listOf("host"),catalog.slashItems("claude","agent").map { it.text("name") })
        assertTrue(catalog.slashItems("codex","agent").isEmpty())
        assertEquals(listOf("kimi"),catalog.slashItems("kimi",null).map { it.text("name") })
        assertFalse("auto" in catalog.permissions("claude","claude-opus-5"))
        assertFalse("bypassPermissions" in catalog.permissions("claude","claude-opus-5"))
    }
}
