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
        var rejectTurn = false
        var rejectionStatus = 409
        var failCreateAckSave = false
        /** GET /providers, and how many reads of the runners fail before one answers. */
        var providers = "[]"
        var failRunners = 0
        var runners = """[{"id":"r","modelCatalog":{"codex":[{"value":"live-model","label":"Live","reasoningLevels":["low","high"]}]},"engines":[{"engine":"codex","installed":true,"auth":"yes","accounts":[{"id":"default","auth":"yes"},{"id":"expired","auth":"no"}]}]}]"""
        fun auth() = AuthSession(HttpTransport { request ->
            val call = request.api; calls += call
            if (call.path.first() == "auth") return@HttpTransport ApiResponse(200, """{"accessToken":"access","refreshToken":"refresh","user":{"id":"u","email":"a@example.test","name":"A"}}""".toByteArray())
            if (deny) return@HttpTransport ApiResponse(403, "{}".toByteArray())
            val answer = when {
                call.path == listOf("sessions", "s") -> detail
                call.path.first() == "workspaces" -> """{"id":"w","provider":"codex","runnerId":"r","enabled":true}"""
                call.path == listOf("sessions") && call.method == HttpMethod.POST -> {
                    if (createLost) throw NetworkException()
                    if (failCreateAckSave) failSave = true
                    """{"id":"created-session"}"""
                }
                call.path.first() == "attachments" -> {
                    uploadStarts.send(Unit)
                    uploadHeld?.await()
                    call.onUploadProgress?.invoke(100, 100)
                    """{"id":"remote-${calls.count { it.path.first() == "attachments" }}"}"""
                }
                call.path.last() in setOf("turns", "resume") && call.method == HttpMethod.POST -> {
                    if (rejectTurn) return@HttpTransport ApiResponse(rejectionStatus, "{\"message\":\"the session has ended\"}".toByteArray())
                    val raw = call.body!!.decodeToString(); val payload = Wire.json.parseToJsonElement(raw).jsonObject
                    val id = payload.text("clientTurnId")!!
                    // No packet may leave until a recoverable, identical outbox entry exists.
                    assertTrue(disk.values.any { bytes -> bytes.decodeToString().contains(id) })
                    val prior = sends.putIfAbsent(id, raw)
                    if (prior != null) assertEquals(prior, raw)
                    if (failPosts-- > 0) throw NetworkException() // Accepted, then response lost.
                    """{"turnId":"turn-$id","kind":"message","status":"PENDING"}"""
                }
                call.path == listOf("runners") -> if (failRunners-- > 0) throw NetworkException() else runners
                call.path == listOf("providers") -> providers
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
        assertNull(model.state.value.draft.pending); assertEquals(long, model.state.value.draft.text)
        rig.failSave = false; model.send(); runCurrent(); assertEquals(1, rig.sends.size)
        rig.session.logout(); runCurrent(); assertTrue(rig.disk.isEmpty())
        model.edit("late account bytes", 0, 0); runCurrent(); assertTrue(rig.disk.isEmpty())
    }

    @Test fun deniedCapabilitiesAndPermissionsCannotProduceTurnsOrMaskFailure() = runTest {
        val rig = Rig(this); val model = rig.start()
        rig.detail = """{"status":"RUNNING","capabilities":{"canSend":false,"canResume":false,"resumeBlockedReason":"runner_offline"}}"""
        model.edit("don't send", 0, 0); model.send(); runCurrent(); assertTrue(rig.sends.isEmpty())
        assertEquals("don't send", model.state.value.draft.text)
        // The catalogue's opening read is tried three times (A07-18) before its failure is said.
        rig.deny = true; model.loadCatalog(); advanceTimeBy(1_000); runCurrent(); assertNull(model.state.value.catalog)
        assertNotNull(model.state.value.catalogError)
        model.config(buildJsonObject { put("model", "other") }); runCurrent()
        assertFalse(rig.calls.any { it.path.last() == "config" })
    }

    @Test fun catalogUsesRealListContractAndRuntimeCapabilities() = runTest {
        val rig = Rig(this); val model = rig.start(); model.loadCatalog(); runCurrent()
        val catalog = model.state.value.catalog!!
        assertEquals("live-model", catalog.models("codex", "codex").single().text("value"))
        assertEquals(listOf("low", "high"), catalog.efforts("codex", "codex", "live-model"))
        assertEquals("no", catalog.accounts("codex").last().text("auth"))
        assertFalse(rig.calls.any { it.path == listOf("runners", "r") })
        model.config(buildJsonObject { put("model", "live-model") }); runCurrent()
        model.config(buildJsonObject { put("account", "default") }, true); runCurrent()
        model.control("interrupt"); runCurrent(); model.control("turns/turn-id", HttpMethod.DELETE); runCurrent()
        model.control("retry-message", body = JsonObject(emptyMap())); runCurrent()
        assertEquals(listOf("config", "account", "interrupt", "turn-id", "retry-message"), rig.calls.filter { it.method != HttpMethod.GET && it.path.first() != "auth" }.map { it.path.last() })
    }

    /** A07-20 (iOS f4e1b0efa): the composer's Stop asks for the background work the session left running to end with the turn; any other
     * interrupt goes out bodyless, as one that kills nothing. */
    @Test fun theComposersStopEndsTheBackgroundWorkAndABareInterruptKillsNothing() = runTest {
        val rig = Rig(this); val model = rig.start()
        model.stop(); runCurrent()
        assertEquals("Stop requested.", model.state.value.notice)
        model.control("interrupt"); runCurrent()
        val interrupts = rig.calls.filter { it.method == HttpMethod.POST && it.path == listOf("sessions", "s", "interrupt") }
        assertEquals(listOf("""{"stopBackgroundWork":true}""", null), interrupts.map { it.body?.decodeToString() })
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
        // A07-19 (c): the engine first, by its CLI's name, as iOS's status card's Engine row (iOS cef3c3f83).
        assertEquals("Engine: Codex · Provider: codex · Model:  · Session: AWAITING_INPUT · Permission: default", model.state.value.notice)
        val runner=Wire.json.parseToJsonElement("""{"runsAsRoot":true,"commands":[{"name":"host","type":"command"},{"name":"wrong-agent","agentId":"other","type":"command"},{"name":"kimi","provider":"kimi","type":"command"}],"modelCatalog":{"claude":[{"value":"claude-opus-5","permissionModes":["default"]}]}}""").jsonObject
        val catalog=ComposerCatalog(runner,emptyList())
        assertEquals(listOf("host"),catalog.slashItems("claude","agent").map { it.text("name") })
        assertTrue(catalog.slashItems("codex","agent").isEmpty())
        assertEquals(listOf("kimi"),catalog.slashItems("kimi",null).map { it.text("name") })
        assertFalse("auto" in catalog.permissions("claude","claude","claude-opus-5"))
        assertFalse("bypassPermissions" in catalog.permissions("claude","claude","claude-opus-5"))
    }

    @Test fun shellUsesSameSwiftPostContractIncludingCarriedAttachments() = runTest {
        val rig=Rig(this);val model=rig.start()
        model.importAttachment(StagedAttachment("a","file.txt","text/plain"),{ StagedAttachment("a","file.txt","text/plain",1) to byteArrayOf(1) },{})
        model.state.first { it.uploads.isEmpty() }
        model.edit("! echo 你好",0,0);model.send();runCurrent()
        val body=Wire.json.parseToJsonElement(rig.sends.values.single()).jsonObject
        assertEquals("shell",body.text("kind"));assertEquals("echo 你好",body.text("content"))
        assertEquals(1,body["attachmentIds"]!!.jsonArray.size)
    }

    @Test fun usageFollowsTheBilledAccountAndNeverFallsBackAcrossProviders() {
        fun obj(text:String)=Wire.json.parseToJsonElement(text).jsonObject
        val catalog=ComposerCatalog(obj("""{"planUsage":{"codex":{"planType":"default-plan","accounts":{"second":{"planType":"second-plan"}}},"claude":{"planType":"claude-plan"}}}"""),
            listOf(obj("""{"slug":"custom","runtime":"codex","planUsage":{"planType":"custom-plan"}}"""),obj("""{"slug":"unknown","runtime":"codex"}"""),
                obj("""{"slug":"pool","runtime":"claude","members":[{"id":"member","next":true,"planUsage":{"planType":"member-plan"}}]}""")))
        assertEquals("second-plan",catalog.usage(obj("""{"provider":"codex","codexAccount":"second"}"""))?.text("planType"))
        assertEquals("custom-plan",catalog.usage(obj("""{"provider":"custom"}"""))?.text("planType"))
        assertNull(catalog.usage(obj("""{"provider":"unknown"}""")))
        assertNull(catalog.usage(obj("""{"provider":"opencode"}""")))
        assertEquals("member-plan",catalog.usage(obj("""{"provider":"pool"}"""))?.text("planType"))
        assertNull(catalog.usage(obj("""{"provider":"pool","poolMemberProviderId":"removed"}""")))
    }
    @Test fun createAccountUsesTheExistingAutomaticDefaultAndSlotContract() = runTest {
        for (provider in listOf("codex", "claude")) for (account in listOf("automatic", "default", "1a2b3c4d")) {
            val rig = Rig(this); rig.start(); val target = DraftTarget("w")
            val model = ComposerModel(rig.session, rig.handle, target.key, backgroundScope, target); runCurrent()
            model.config(buildJsonObject { put("provider", provider); put("account", account) }); runCurrent()
            model.edit("create $provider $account", 0, 0); model.send(); runCurrent()
            val body = Wire.json.parseToJsonElement(rig.calls.single { it.path == listOf("sessions") && it.method == HttpMethod.POST }.body!!.decodeToString()).jsonObject
            assertEquals(if (account == "automatic") null else account, body.text("${provider}Account"))
            assertNull(body["account"])
            assertTrue(body.text("${provider}Account")?.matches(Regex("(?:default|[0-9a-f]{8})")) != false)
        }
        val rig = Rig(this); val model = rig.start()
        model.config(buildJsonObject { put("account", "automatic") }, true); runCurrent()
        assertEquals("automatic", Wire.json.parseToJsonElement(rig.calls.last().body!!.decodeToString()).jsonObject.text("account"))
    }

    /** A13-4: Antigravity keeps accounts as Codex and Claude Code do — its rows are offered, a session's quota is its Google
     * account's own buckets (read from the engine health, never the runner's own report), and a new session names the one
     * picked as antigravityAccount. */
    @Test fun antigravityAccountsAreOfferedReadAndCarriedLikeCodexAndClaudes() = runTest {
        fun obj(s: String) = Wire.json.parseToJsonElement(s).jsonObject
        val catalog = ComposerCatalog(obj("""{"id":"r","capabilities":["antigravity-account-login/v1"],"planUsage":{"claude":{"planType":"claude-plan"}},
            "engines":[{"engine":"antigravity","installed":true,"auth":"yes","authSource":"google",
              "accounts":[{"id":"default","auth":"yes"},{"id":"5c2e91a0","name":"Work","auth":"yes"}],
              "planUsage":{"provider":"antigravity","buckets":[{"id":"gemini-5h","window":"5h","remainingFraction":0.5}],
                "accounts":{"5c2e91a0":{"provider":"antigravity","buckets":[{"id":"gemini-5h","window":"5h","remainingFraction":0.04}]}}}}]}"""), emptyList())
        assertEquals(listOf("default", "5c2e91a0"), catalog.accounts("antigravity").map { it.text("id") })
        fun left(detail: String) = catalog.usage(obj(detail))?.objects("buckets")?.single()?.get("remainingFraction")?.jsonPrimitive?.double
        assertEquals(0.04, left("""{"provider":"antigravity","antigravityAccount":"5c2e91a0"}""")!!, 0.0)
        assertEquals("Default's own, without Work's", 0.5, left("""{"provider":"antigravity"}""")!!, 0.0)
        assertNull("Automatic names no account yet", catalog.usage(obj("""{"provider":"antigravity","account":"automatic"}""")))
        val rig = Rig(this); rig.start(); val target = DraftTarget("w")
        val model = ComposerModel(rig.session, rig.handle, target.key, backgroundScope, target); runCurrent()
        model.config(buildJsonObject { put("provider", "antigravity"); put("account", "5c2e91a0") }); runCurrent()
        model.edit("create antigravity", 0, 0); model.send(); runCurrent()
        val body = Wire.json.parseToJsonElement(rig.calls.single { it.path == listOf("sessions") && it.method == HttpMethod.POST }.body!!.decodeToString()).jsonObject
        assertEquals("5c2e91a0", body.text("antigravityAccount"))
        assertNull(body["account"])
    }

    @Test fun draftUsageFollowsSelectionAndProviderSwitchDoesNotCarryAnotherEnginesSlot() = runTest {
        fun obj(s: String) = Wire.json.parseToJsonElement(s).jsonObject
        val catalog = ComposerCatalog(obj("""{"planUsage":{"codex":{"planType":"default","accounts":{"1a2b3c4d":{"planType":"selected"},"abcd1234":{"planType":"workspace"}}},"claude":{"planType":"claude-default"}}}"""), emptyList())
        val detail = obj("""{"provider":"codex","codexAccount":"abcd1234"}""")
        for ((account, expected) in listOf("1a2b3c4d" to "selected", "default" to "default", "automatic" to null, "aaaaaaaa" to null)) {
            assertEquals(expected, catalog.usage(JsonObject(detail + ("account" to JsonPrimitive(account))))?.text("planType"))
        }
        val rig = Rig(this); rig.start(); val target = DraftTarget("w")
        val model = ComposerModel(rig.session, rig.handle, target.key, backgroundScope, target); runCurrent()
        model.config(obj("""{"provider":"codex","account":"1a2b3c4d"}""")); runCurrent()
        model.config(obj("""{"provider":"claude"}""")); runCurrent()
        assertNull(model.state.value.draft.resumeConfig["account"])
        assertEquals("claude-default", catalog.usage(JsonObject(detail + model.state.value.draft.resumeConfig))?.text("planType"))
    }

    @Test fun rejectedFirstSendRestoresAttachmentsAndRechecksResumeButUnknownRetryKeepsIdentity() = runTest {
        val rig = Rig(this); val model = rig.start()
        model.importAttachment(StagedAttachment("a", "file.txt", "text/plain"), { StagedAttachment("a", "file.txt", "text/plain", 1) to byteArrayOf(1) }, {})
        model.state.first { it.uploads.isEmpty() }
        model.edit("recover this", 0, 0); runCurrent()
        rig.rejectTurn = true; model.send(); runCurrent()
        assertNull(model.state.value.draft.pending)
        assertEquals("recover this", model.state.value.draft.text)
        assertEquals("a", model.state.value.draft.attachments.single().id)
        rig.rejectTurn = false; rig.detail = """{"status":"FAILED","capabilities":{"canSend":false,"canResume":true}}"""
        model.send(); runCurrent()
        assertEquals(1, rig.calls.count { it.path.last() == "resume" && it.method == HttpMethod.POST })
        assertEquals(1, rig.sends.size)
        model.edit("unknown", 0, 0); rig.failPosts = 1; model.send(); runCurrent()
        val pending = model.state.value.draft.pending!!
        rig.rejectTurn = true; model.retrySend(); runCurrent()
        assertEquals(pending, model.state.value.draft.pending)
        model.close(); val restored = rig.cold()
        assertEquals(pending, restored.state.value.draft.pending)
    }

    @Test fun definite409MustRestoreAnEditableDraft() = runTest {
        val rig = Rig(this); val model = rig.start()
        model.edit("must resume instead", 0, 0); runCurrent()
        rig.rejectTurn = true; model.send(); runCurrent()
        rig.detail = """{"status":"FAILED","capabilities":{"canSend":false,"canResume":true}}"""
        model.retrySend(); runCurrent()
        println("409: pending=${model.state.value.draft.pending?.endpoint}, text=${model.state.value.draft.text}, endpoints=${rig.calls.filter { it.method == HttpMethod.POST }.map { it.path }}")
        assertNull("A definitive rejection must release pending so the message can resume", model.state.value.draft.pending)
    }
    @Test fun zeroPostCreateDiskFailureMustRemainSendable() = runTest {
        val rig = Rig(this); rig.start(); val target = DraftTarget("w")
        val model = ComposerModel(rig.session, rig.handle, target.key, backgroundScope, target); runCurrent()
        model.edit("never submitted", 0, 0); runCurrent()
        rig.failSave = true; model.send(); runCurrent()
        rig.failSave = false; model.retrySend(); model.send(); runCurrent()
        val count = rig.calls.count { it.path == listOf("sessions") && it.method == HttpMethod.POST }
        println("create before POST disk failure: POST count=$count, pending=${model.state.value.draft.pending?.endpoint}, error=${model.state.value.error}")
        assertEquals("After disk recovers, a never-submitted creation must be sendable", 1, count)
    }
    @Test fun knownCreatedIdMustSurviveAckDiskFailure() = runTest {
        val rig = Rig(this); rig.start(); val target = DraftTarget("w")
        val model = ComposerModel(rig.session, rig.handle, target.key, backgroundScope, target); runCurrent()
        model.edit("created already", 0, 0); runCurrent()
        rig.failCreateAckSave = true; model.send(); runCurrent()
        assertEquals("created-session", model.state.value.draft.createdSessionId)
        assertTrue(model.state.value.acknowledgementPending)
        model.send(); model.config(buildJsonObject { put("provider", "claude") }); runCurrent()
        rig.failSave = false; model.retrySend(); runCurrent()
        println("create ACK disk failure: createdId=${model.state.value.draft.createdSessionId}, pending=${model.state.value.draft.pending?.endpoint}")
        assertEquals("A successful response's known session id must remain recoverable", "created-session", model.state.value.draft.createdSessionId)
        assertFalse(model.state.value.acknowledgementPending)
        assertEquals(1, rig.calls.count { it.path == listOf("sessions") && it.method == HttpMethod.POST })
        model.close()
        val restored = ComposerModel(rig.session, rig.handle, target.key, backgroundScope, target); runCurrent()
        assertEquals("created-session", restored.state.value.draft.createdSessionId)
        restored.retrySend(); restored.send(); runCurrent()
        assertEquals(1, rig.calls.count { it.path == listOf("sessions") && it.method == HttpMethod.POST })
    }
    @Test fun reviewAllWhitelistedFirstAndLaterRejections() = runTest {
        for (status in listOf(400, 403, 404, 409, 422)) {
            val rig=Rig(this); val m=rig.start(); rig.rejectTurn=true; rig.rejectionStatus=status
            m.edit("rejected $status",0,0); m.send();runCurrent()
            assertNull("first $status",m.state.value.draft.pending)
            assertEquals("rejected $status",m.state.value.draft.text)
            rig.rejectTurn=false;rig.failPosts=1;m.send();runCurrent()
            val prior=m.state.value.draft.pending!!
            rig.rejectTurn=true;m.retrySend();runCurrent()
            assertEquals("late $status",prior,m.state.value.draft.pending)
            m.close();val cold=rig.cold();assertEquals(prior,cold.state.value.draft.pending)
        }
    }
    @Test fun review413RestoresOversizeDraftForCorrection() = runTest {
        val rig=Rig(this);val m=rig.start();rig.rejectTurn=true;rig.rejectionStatus=413
        m.importAttachment(StagedAttachment("a", "retained.txt", "text/plain"),
            { StagedAttachment("a", "retained.txt", "text/plain", 4) to "keep".toByteArray() }, {})
        m.state.first { it.uploads.isEmpty() }
        val staged=m.state.value.draft.attachments
        val content="x".repeat(10*1024*1024+1)
        m.edit(content,0,0);m.send();runCurrent()
        println("413 observed: draft length=${m.state.value.draft.text.length}, pending=${m.state.value.draft.pending?.endpoint}")
        assertTrue("First 413 rejects before handling; oversized text must be editable",m.state.value.draft.pending==null)
        assertEquals(content,m.state.value.draft.text)
        assertEquals(staged,m.state.value.draft.attachments)
        m.close();val cold=rig.cold()
        assertEquals(content,cold.state.value.draft.text)
        assertEquals(staged,cold.state.value.draft.attachments)
        assertTrue(rig.sends.isEmpty())
        rig.rejectTurn=false;cold.edit("shortened",0,0);cold.send();runCurrent()
        assertNull(cold.state.value.draft.pending)
        assertEquals(1,rig.sends.size)
        val accepted=Wire.json.parseToJsonElement(rig.sends.values.single()).jsonObject
        assertEquals("shortened",accepted.text("content"))
        assertEquals(1,accepted["attachmentIds"]!!.jsonArray.size)
    }

    @Test fun reviewUnknownThen413RetainsExactIdentity() = runTest {
        val rig=Rig(this);val m=rig.start();m.edit("accepted response lost",0,0)
        rig.failPosts=1;m.send();runCurrent();val prior=m.state.value.draft.pending!!
        rig.rejectTurn=true;rig.rejectionStatus=413;m.retrySend();runCurrent()
        assertEquals(prior,m.state.value.draft.pending)
        val requests=rig.calls.filter { it.path.last()=="turns" && it.method==HttpMethod.POST }
        assertArrayEquals(requests[0].body,requests[1].body)
        m.close();val cold=rig.cold();assertEquals(prior,cold.state.value.draft.pending)
        println("unknown then 413: original endpoint/body/clientTurnId retained across retry and cold restoration")
    }

    // The provider/engine split (docs/provider-engine-contract.md; boards 4–5): every pick is asked of the session's engine.

    /** A session's engine is the one it recorded, never changed by a pick; a draft's is its pick, else the workspace's last where
     * it runs the provider beside it, else that provider's default. */
    @Test fun theEngineIsTheSessionsOwnOrTheDraftsPick() {
        val catalog = EngineFixture.catalog()
        fun engine(detail: String) = catalog.engineOf(EngineFixture.obj(detail))
        assertEquals("dsh", engine("""{"engine":"dsh","provider":"deepseek"}"""))
        assertEquals("an unrecorded session is its provider's default", "claude", engine("""{"provider":"deepseek"}"""))
        assertEquals("dsh", engine("""{"lastEngine":"dsh","provider":"deepseek-2"}"""))
        assertEquals("a picked key Harness doesn't run leaves the workspace's engine behind", "claude", engine("""{"lastEngine":"dsh","provider":"glm"}"""))
        assertEquals("opencode", engine("""{"provider":"opencode"}"""))
        assertEquals("claude", engine("""{"provider":"a-deleted-key"}"""))
    }

    /** The Provider menu lists only what the engine runs, grouped: its own sign-in (or OpenCode's own configuration), its pools,
     * its keys. Harness lists every DeepSeek key and no row of its own; no engine lists another engine's credential. */
    @Test fun theProviderMenuGroupsTheEnginesCredentialsAndHarnessTakesEveryDeepSeekKey() {
        val catalog = EngineFixture.catalog()
        fun menu(engine: String) = catalog.credentials(engine).map { it.id to it.kind }
        assertEquals(listOf("claude" to CredentialKind.LOGIN, "claude-accounts" to CredentialKind.POOL, "deepseek" to CredentialKind.KEY,
            "deepseek-2" to CredentialKind.KEY, "glm" to CredentialKind.KEY, "claude-max" to CredentialKind.KEY), menu("claude"))
        assertEquals(listOf("deepseek" to CredentialKind.KEY, "deepseek-2" to CredentialKind.KEY), menu("dsh"))
        assertEquals(listOf("opencode" to CredentialKind.OPENCODE, "deepseek" to CredentialKind.KEY, "deepseek-2" to CredentialKind.KEY,
            "glm" to CredentialKind.KEY, "gemini" to CredentialKind.KEY, "moonshot" to CredentialKind.KEY), menu("opencode"))
        assertEquals(listOf("codex" to CredentialKind.LOGIN), menu("codex"))
        assertEquals(listOf("antigravity" to CredentialKind.LOGIN, "gemini" to CredentialKind.KEY), menu("antigravity"))
        // Never a separate Harness row: no credential is called dsh, and the keys keep their own names under every engine.
        assertTrue(ProviderEngines.ALL_ENGINES.flatMap { catalog.credentials(it) }.none { it.id == "dsh" || it.id == "deepseek-harness" })
        assertEquals(listOf("DeepSeek", "DeepSeek 2"), catalog.credentials("dsh").map { it.label })
        assertEquals(EngineCopy.OPENCODE_OWN, catalog.credentials("opencode").first().label)
        assertEquals(EngineCopy.OPENCODE_OWN_DETAIL, catalog.credentials("opencode").first().detail)
        // A CLI this machine lacks is the reason under every credential of it, its keys' included.
        assertEquals(listOf("Not installed", "Not installed"), catalog.credentials("kimi").map { it.unavailable })
        // Harness on a runner that predates it: its keys stay listed, with why.
        val old = EngineFixture.catalog(runner = """{"id":"r","engines":[]}""")
        assertEquals(listOf("Update runner", "Update runner"), old.credentials("dsh").map { it.unavailable })
    }

    /** The New Session's Engine list: every engine in ALL_ENGINES order, each landing where it can — the draft's pick or the
     * workspace's last first — and Harness with no DeepSeek key offering the connection instead. */
    @Test fun theNewSessionsEnginesLandWhereTheyCanAndHarnessOffersTheConnection() {
        val catalog = EngineFixture.catalog()
        val engines = catalog.engines(listOf("dsh" to "deepseek-2"))
        assertEquals(listOf("Claude Code", "Codex", "Kimi Code", "Antigravity CLI", "OpenCode", "DeepSeek Harness"), engines.map { it.label })
        assertEquals("deepseek-2", engines.last().landing?.id)
        assertEquals("deepseek", catalog.engines().last().landing?.id)
        assertEquals("claude", engines.first().landing?.id)
        assertEquals("Not installed", engines.single { it.engine == "kimi" }.unavailable)
        assertEquals("opencode", engines.single { it.engine == "opencode" }.landing?.id)
        assertEquals("DeepSeek V4 Pro", catalog.modelLabel("dsh", "deepseek-2", catalog.defaultModel("dsh", "deepseek-2")))
        assertEquals("Managed by OpenCode", catalog.modelLabel("opencode", "opencode", catalog.defaultModel("opencode", "opencode")))
        // No DeepSeek key yet: Harness is still a row, which connects one; a runner that predates Harness has no row for it.
        val keyless = EngineFixture.catalog(keys = "[]")
        val harness = keyless.engines().single { it.engine == "dsh" }
        assertNull(harness.landing); assertEquals(EngineCopy.CONNECT_DEEPSEEK_KEY, harness.unavailable)
        assertTrue(EngineFixture.catalog(runner = """{"id":"r"}""", keys = "[]").engines().none { it.engine == "dsh" })
    }

    /** Harness enforces Default, Auto and Don't Ask alone, as the server does at admission (shared DSH_PERMISSION_MODES): the rest
     * are not offered, whichever DeepSeek key it spends. The same key on Claude Code offers Claude Code's. */
    @Test fun harnessOffersOnlyTheModesItEnforces() {
        val catalog = EngineFixture.catalog()
        assertEquals(listOf("default", "auto", "dontAsk"), catalog.permissions("dsh", "deepseek", "deepseek-v4-pro"))
        assertEquals(listOf("default", "auto", "dontAsk"), catalog.permissions("dsh", "deepseek-2", "deepseek-v4-flash"))
        assertEquals(listOf("default", "auto", "dontAsk"), catalog.permissions("dsh", "dsh", ""))
        assertEquals(listOf("default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"), catalog.permissions("claude", "deepseek", "deepseek-v4-pro"))
        val root = EngineFixture.catalog(runner = EngineFixture.RUNNER.replace("\"runsAsRoot\":false", "\"runsAsRoot\":true"))
        assertFalse("bypassPermissions" in root.permissions("claude", "claude", "claude-opus-5-5"))
        assertEquals(listOf("default", "auto", "dontAsk"), root.permissions("dsh", "deepseek", "deepseek-v4-pro"))
    }

    /** The model space, efforts, fast lane and slash commands are the pair's and the engine's, never the slug's: one DeepSeek key is
     * Harness's ACP catalogue under Harness and its own table under Claude Code and OpenCode. */
    @Test fun modelsEffortsFastAndSlashAreAskedOfTheEngine() {
        val catalog = EngineFixture.catalog()
        assertEquals(listOf("deepseek-v4-pro", "deepseek-v4-flash"), catalog.models("dsh", "deepseek").map { it.text("value") })
        assertEquals(listOf("high", "max"), catalog.efforts("dsh", "deepseek", "deepseek-v4-pro"))
        assertEquals(listOf("high"), catalog.efforts("claude", "deepseek", "deepseek-v4-pro"))
        assertEquals("OpenCode describes a key's model itself", emptyList<String>(), catalog.efforts("opencode", "deepseek", "deepseek-v4-pro"))
        assertEquals(listOf("claude-opus-5-5"), catalog.models("claude", "claude-max").map { it.text("value") })
        assertEquals("glm-5.2", catalog.defaultModel("claude", "glm"))
        assertEquals("deepseek-v4-pro", catalog.defaultModel("dsh", "deepseek-2"))
        assertEquals("", catalog.defaultModel("opencode", "opencode"))
        assertTrue(catalog.fast("codex", "codex", "gpt-5.6-sol")); assertTrue(catalog.fast("claude", "claude", "claude-opus-5-5"))
        assertFalse(catalog.fast("opencode", "opencode", "anthropic/claude-sonnet"))
        assertEquals(listOf("review"), catalog.slashItems("claude", null).map { it.text("name") })
        assertTrue("Harness takes no runner slash commands, whichever key", catalog.slashItems("dsh", null).isEmpty())
        assertEquals(listOf("kimi-only"), catalog.slashItems("kimi", null).map { it.text("name") })
    }

    /** A session whose key the menu no longer lists says what became of it, and never changes engine: turned off or deleted; the
     * legacy built-in `dsh` is its workspace's key. */
    @Test fun aSessionWhoseKeyIsGoneSaysWhatBecameOfIt() {
        val catalog = EngineFixture.catalog(own = listOf(EngineFixture.obj("""{"slug":"old-deepseek","label":"Old DeepSeek","enabled":false}""")))
        assertEquals(EngineCopy.TURNED_OFF, catalog.gone("dsh", "old-deepseek"))
        assertEquals("Old DeepSeek", catalog.current("dsh", "old-deepseek").label)
        assertEquals(EngineCopy.KEY_DELETED, catalog.gone("dsh", "deleted-key"))
        assertNull(catalog.gone("dsh", "deepseek"))
        assertNull(catalog.gone("dsh", "dsh"))
        assertEquals(EngineCopy.WORKSPACE_KEY, catalog.current("dsh", "dsh").label)
        assertNull("unread, nothing is claimed", EngineFixture.catalog().gone("dsh", "deleted-key"))
    }

    /** New, switch, resume and retry each carry the engine with the provider (contract §3.5, §6.1): a draft's pick is the pair, a
     * live session's PATCH names its own engine beside the new key, an ended one holds the pair for the message that revives it. */
    @Test fun theEngineTravelsWithTheProviderOnCreateSwitchResumeAndRetry() = runTest {
        fun pick(provider: String) = buildJsonObject { put("provider", provider); put("engine", "dsh"); put("model", "deepseek-v4-pro"); put("effort", "") }
        val create = Rig(this); create.start(); val target = DraftTarget("w")
        val draft = ComposerModel(create.session, create.handle, target.key, backgroundScope, target); runCurrent()
        draft.config(pick("deepseek-2")); runCurrent()
        draft.edit("on Harness", 0, 0); draft.send(); runCurrent()
        val created = Wire.json.parseToJsonElement(create.calls.single { it.path == listOf("sessions") && it.method == HttpMethod.POST }.body!!.decodeToString()).jsonObject
        assertEquals("dsh", created.text("engine")); assertEquals("deepseek-2", created.text("provider")); assertEquals("deepseek-v4-pro", created.text("model"))

        val live = Rig(this); val session = live.start()
        live.detail = """{"id":"s","status":"AWAITING_INPUT","assignedRunnerId":"r","engine":"dsh","provider":"deepseek","capabilities":{"canSend":true,"canResume":false}}"""
        session.config(pick("deepseek-2")); runCurrent()
        val patch = live.calls.last { it.path == listOf("sessions", "s", "config") }
        assertEquals(HttpMethod.PATCH, patch.method)
        assertEquals(pick("deepseek-2"), Wire.json.parseToJsonElement(patch.body!!.decodeToString()).jsonObject)
        // Whoever names only the provider, the model sends it beside the session's own engine.
        session.config(buildJsonObject { put("provider", "deepseek") }); runCurrent()
        val bare = live.calls.last { it.path == listOf("sessions", "s", "config") }
        assertEquals(buildJsonObject { put("provider", "deepseek"); put("engine", "dsh") }, Wire.json.parseToJsonElement(bare.body!!.decodeToString()).jsonObject)

        val ended = Rig(this); val revived = ended.start()
        ended.detail = """{"id":"s","status":"FAILED","engine":"dsh","provider":"deepseek","capabilities":{"canSend":false,"canResume":true}}"""
        revived.config(pick("deepseek-2")); runCurrent()
        assertEquals("deepseek-2", revived.state.value.draft.resumeConfig.text("provider"))
        assertEquals(buildJsonObject { put("provider", "deepseek-2"); put("engine", "dsh") }, revived.retryIdentity())
        revived.edit("again", 0, 0); revived.send(); runCurrent()
        val resumed = Wire.json.parseToJsonElement(ended.sends.values.single()).jsonObject
        assertEquals("dsh", resumed.text("engine")); assertEquals("deepseek-2", resumed.text("provider"))
        assertEquals(1, ended.calls.count { it.path.last() == "resume" && it.method == HttpMethod.POST })
        assertEquals(JsonObject(emptyMap()), retryIdentityOf(buildJsonObject { put("model", "x") }))
    }
    /** A07-18 (iOS bc790273c `fetchRunners`): the catalogue's opening read is tried three times, 300 ms and then 600 ms apart, before
     * it fails. */
    @Test fun theCataloguesOpeningReadIsTriedThreeTimes() = runTest {
        val rig = Rig(this); val model = rig.start()
        rig.failRunners = 2
        model.loadCatalog(); runCurrent()
        assertNull(model.state.value.catalog); assertTrue(model.state.value.catalogLoading)
        advanceTimeBy(300); runCurrent()
        assertNull(model.state.value.catalog)
        advanceTimeBy(600); runCurrent()
        assertNotNull(model.state.value.catalog); assertNull(model.state.value.catalogError)
        assertEquals(3, rig.calls.count { it.path == listOf("runners") })
    }

    /** A07-18 (iOS `refreshRunner`): the re-read on a reconnect, and each minute, is the session's runner row — what it says now is
     * taken, a failed read keeps what is shown, without a spinner or an error — a catalogue whose opening read failed is read whole,
     * and nothing is read for one nobody asked for. */
    @Test fun theCataloguesReReadKeepsWhatIsShownWhenItFails() = runTest {
        val rig = Rig(this); val model = rig.start()
        model.refreshCatalog()
        assertFalse("no catalogue was asked for", rig.calls.any { it.path == listOf("runners") })
        model.loadCatalog(); runCurrent()
        val shown = model.state.value.catalog!!
        rig.failRunners = 1
        model.refreshCatalog()
        assertSame("a failed re-read keeps what is shown", shown, model.state.value.catalog)
        assertNull(model.state.value.catalogError); assertFalse(model.state.value.catalogLoading)
        rig.runners = rig.runners.replace("live-model", "newer-model")
        val keys = rig.calls.count { it.path == listOf("providers") }
        model.refreshCatalog()
        assertEquals("newer-model", model.state.value.catalog!!.models("codex", "codex").single().text("value"))
        assertEquals("the runner's row alone", keys, rig.calls.count { it.path == listOf("providers") })
        val failed = rig.model()
        rig.failRunners = 3; failed.loadCatalog(); advanceTimeBy(1_000); runCurrent()
        assertNotNull(failed.state.value.catalogError)
        failed.refreshCatalog()
        assertNotNull(failed.state.value.catalog); assertNull(failed.state.value.catalogError)
    }

    /** A07-19 (a) (iOS e6295abe7/6f3083272 `providerSwitchNote`): a provider picked for a session says by the credentials' names what
     * it will do, and when — over a session still going, the turn in flight finishes on the one it is on — for as long as the pick
     * stands: until the next message goes. A draft's pick is the session being made, and says nothing of the kind. */
    @Test fun aProviderPickSaysWhatItWillDoAndWhen() = runTest {
        val key = """[{"slug":"custom-codex","label":"Custom account","runtime":"codex","engines":["codex"],"models":[{"value":"custom-model","label":"Custom model"}]}]"""
        val rig = Rig(this); rig.providers = key
        val model = rig.start()
        model.config(buildJsonObject { put("provider", "custom-codex") }); runCurrent()
        assertNull("not before the catalogue that names them is read", model.state.value.switchNote)
        assertEquals("Selection saved.", model.state.value.notice)
        model.loadCatalog(); runCurrent()
        model.config(buildJsonObject { put("provider", "custom-codex"); put("engine", "codex") }); runCurrent()
        val live = "The turn in flight finishes on Codex. Your next one uses Custom account."
        assertEquals(live, model.state.value.switchNote)
        assertNull("the note says what the saved line did", model.state.value.notice)
        model.config(buildJsonObject { put("model", "live-model") }); runCurrent()
        assertEquals("a model picked after it leaves it standing", live, model.state.value.switchNote)
        model.edit("go", 2, 2); model.send(); runCurrent()
        assertNull("the next message went", model.state.value.switchNote)

        val ended = Rig(this); ended.providers = key
        val revived = ended.start()
        ended.detail = """{"id":"s","status":"FAILED","assignedRunnerId":"r","provider":"codex","capabilities":{"canSend":false,"canResume":true}}"""
        revived.loadCatalog(); runCurrent()
        revived.config(buildJsonObject { put("provider", "custom-codex"); put("engine", "codex") }); runCurrent()
        assertEquals("Your next message uses Custom account.", revived.state.value.switchNote)
        assertNull(revived.state.value.notice)

        val target = DraftTarget("w")
        val draft = ComposerModel(ended.session, ended.handle, target.key, backgroundScope, target); runCurrent()
        draft.loadCatalog(); runCurrent()
        draft.config(buildJsonObject { put("provider", "custom-codex"); put("engine", "codex") }); runCurrent()
        assertNull(draft.state.value.switchNote)
        assertEquals("Applies when this session starts.", draft.state.value.notice)
    }

    /** Send's other way while a turn runs (docs/mocks/steer-tray): queued for the next turn, it says so; an ordinary send leaves where it
     * goes to the server, as every send before it did. */
    @Test fun queueingForTheNextTurnSaysSoAndASendOtherwiseLeavesItToTheServer() = runTest {
        val rig = Rig(this)
        rig.detail = """{"id":"s","status":"RUNNING","runState":"RUNNING","assignedRunnerId":"r","provider":"claude","capabilities":{"canSend":true,"canResume":false}}"""
        val model = rig.start()
        model.edit("then push it to main", 0, 0); model.send(queueForNextTurn = true); runCurrent()
        model.edit("and tag it", 0, 0); model.send(); runCurrent()
        val bodies = rig.sends.values.map { Wire.json.parseToJsonElement(it).jsonObject }
        assertEquals("NEXT_TURN", bodies.single { it.text("content") == "then push it to main" }.text("intent"))
        assertNull("no intent goes out unless asked for", bodies.single { it.text("content") == "and tag it" }["intent"])
    }

    /** The tray's Withdraw: the server takes the turn back, its words return under whatever the box holds, and the row is gone before
     * the listing says so. */
    @Test fun aWithdrawnMessagesWordsComeBackUnderTheDraft() = runTest {
        val rig = Rig(this); val model = rig.start()
        model.withdraw("t-1", "then push it to main", steer = false, engine = "claude"); runCurrent()
        assertEquals("then push it to main", model.state.value.draft.text)
        model.edit("a draft", 7, 7)
        model.withdraw("t-2", "!npm test", steer = true, engine = "claude"); runCurrent()
        assertEquals("a draft\n\n!npm test", model.state.value.draft.text)
        assertEquals("the cursor after them", "a draft\n\n!npm test".length, model.state.value.draft.selectionStart)
        assertEquals(listOf(listOf("sessions", "s", "turns", "t-1"), listOf("sessions", "s", "turns", "t-2")),
            rig.calls.filter { it.method == HttpMethod.DELETE }.map { it.path })
        assertEquals(listOf("t-1", "t-2").map { io.orbitd.android.navigation.ObjectId.canonical(it) ?: it }.toSet(), model.state.value.withdrawn)
        assertTrue(model.state.value.withdrawing.isEmpty())
        // A message of pictures alone hands nothing back, and a second press on one taken back asks nothing.
        model.withdraw("t-3", null, steer = false, engine = "claude"); model.withdraw("t-3", null, steer = false, engine = "claude"); runCurrent()
        assertEquals("a draft\n\n!npm test", model.state.value.draft.text)
        assertEquals(3, rig.calls.count { it.method == HttpMethod.DELETE })
        // The words were kept, as everything the box holds is.
        model.close(); assertEquals("a draft\n\n!npm test", rig.cold().state.value.draft.text)
    }

    /** Put back in the composer: a steer that was not delivered gives its words back under whatever the box holds, and nothing is sent.
     * One known only from the server's receipt is discarded as well — once, however often it is pressed — and gone before the listing
     * says so. */
    @Test fun aSteerPutBackComesBackUnderTheDraftAndSendsNothing() = runTest {
        val rig = Rig(this); val model = rig.start()
        model.edit("a draft", 7, 7)
        model.putBack("then push it to main"); runCurrent()
        assertEquals("a draft\n\nthen push it to main", model.state.value.draft.text)
        assertEquals("the cursor after them", "a draft\n\nthen push it to main".length, model.state.value.draft.selectionStart)
        assertTrue("nothing sent, nothing discarded", rig.calls.none { it.method == HttpMethod.DELETE || it.path.last() in setOf("turns", "resume") })
        model.putBack("and tag the release", discard = "t-9"); model.putBack("and tag the release", discard = "t-9"); runCurrent()
        assertEquals("a draft\n\nthen push it to main\n\nand tag the release", model.state.value.draft.text)
        assertEquals(listOf(listOf("sessions", "s", "turns", "t-9")), rig.calls.filter { it.method == HttpMethod.DELETE }.map { it.path })
        assertEquals(setOf(io.orbitd.android.navigation.ObjectId.canonical("t-9") ?: "t-9"), model.state.value.withdrawn)
        assertTrue(model.state.value.withdrawing.isEmpty())
        assertTrue("still nothing sent", rig.calls.none { it.path.last() in setOf("turns", "resume") })
        // The words were kept, as everything the box holds is.
        model.close(); assertEquals("a draft\n\nthen push it to main\n\nand tag the release", rig.cold().state.value.draft.text)
    }

    /** The tray's Steer: the message goes into the running turn, and is drawn on its way there until the listing says so. */
    @Test fun aSteeredMessageIsOnItsWayIntoTheTurnUntilTheListingSaysSo() = runTest {
        val rig = Rig(this); val model = rig.start()
        model.steer("t-4"); runCurrent()
        assertEquals(1, rig.calls.count { it.method == HttpMethod.POST && it.path == listOf("sessions", "s", "turns", "t-4", "steer") })
        assertEquals(setOf(io.orbitd.android.navigation.ObjectId.canonical("t-4") ?: "t-4"), model.state.value.steered)
        assertTrue(model.state.value.steering.isEmpty())
    }
}
