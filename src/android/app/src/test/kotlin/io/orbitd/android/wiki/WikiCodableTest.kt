package io.orbitd.android.wiki

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** OrbitKit `WikiCodableTests` over the same fixtures: the reads decode as the user door answers them, and a value
 * this build has never heard of still reads (Swift lands it on `.unknown`; here it stays its own string, which every
 * label and rule treats as unknown) rather than failing the read it is in. The write bodies are WikiStoreHttpTest's. */
class WikiCodableTest {
    private fun <T> decode(serializer: kotlinx.serialization.KSerializer<T>, json: String) = Wire.json.decodeFromString(serializer, json)

    @Test fun theSpacesListCarriesTheCountTheDrawerSums() {
        val spaces = decode(ListSerializer(WikiSpace.serializer()), WikiFixtures.spaces)
        assertEquals(listOf("orbit", "wikova"), spaces.map { it.slug })
        assertEquals(listOf(3, 0), spaces.map { it.pendingOps })
        assertEquals("github.com/jianghailong-xy/orbit", spaces[0].repoUrlNorm)
        assertEquals(true, spaces[0].settings?.push)
        assertNull(spaces[1].rootCommitSha)
        assertNull("only the one-space read carries usage", spaces[0].usage)
    }

    @Test fun oneSpaceCarriesItsUsageWindow() {
        val space = decode(WikiSpace.serializer(), WikiFixtures.space)
        assertNull("the one-space read carries no count", space.pendingOps)
        val usage = space.usage!!
        assertEquals(7, usage.days); assertEquals(214, usage.sessionsPushed); assertEquals(38, usage.searches)
        assertEquals(listOf(41, 33, 29), usage.entries?.map { it.total })
        assertEquals(WikiFixtures.pitfallID, usage.entries?.first()?.entryId)
    }

    @Test fun entriesDecodeWithEveryField() {
        val entries = decode(ListSerializer(WikiEntry.serializer()), WikiFixtures.entries)
        assertEquals(9, entries.size)
        val principle = entries.first { it.id == WikiFixtures.principleID }
        assertEquals("principle", principle.kind); assertEquals("active", principle.status); assertEquals("owner", principle.trust)
        assertEquals("verified", principle.anchorState); assertEquals(WikiFixtures.sha, principle.anchorCheckedRef)
        assertEquals(true, principle.pinned); assertEquals(listOf("tasks-dispatch"), principle.topics)
        assertEquals(JsonObject(emptyMap()), principle.fields)
        assertFalse(principle.isEnded)
        val retired = entries.first { it.status == "retired" }
        assertTrue(retired.isEnded)
        assertEquals("missing", retired.anchorState)
    }

    @Test fun anEntrysPageDecodesItsSourcesHistoryAndExposure() {
        val detail = WikiEntryDetail.decode(Wire.json.parseToJsonElement(WikiFixtures.entryDetail))
        assertEquals(WikiFixtures.pitfallID, detail.entry.id)
        assertEquals("pitfall", detail.entry.kind)
        assertEquals(2, detail.entry.currentRevision)
        assertEquals(2, detail.entry.anchors?.size)
        assertEquals("symbol", detail.entry.anchors?.first()?.type)
        assertEquals("askBeforeCreate", detail.entry.anchors?.first()?.symbol)
        assertEquals("verified", detail.entry.anchors?.first()?.check?.state)
        assertEquals(listOf("turn", "task", "commit"), detail.sources.map { it.kind })
        assertEquals(true, detail.sources.first().quoteVerified)
        assertEquals(412, detail.sources.first().locator["seq"].integer())
        assertEquals(listOf(2, 1), detail.history.map { it.revision })
        assertEquals(listOf("owner", "agent"), detail.history.map { it.authorKind })
        assertEquals(listOf("push", "get", "push"), detail.exposure.map { it.channel })
        // The three lists are what `include` asked for; an answer without them is still an entry.
        val bare = WikiEntryDetail.decode(Wire.json.parseToJsonElement("""{"id":"e1","kind":"concept","title":"t"}"""))
        assertEquals("e1", bare.entry.id)
        assertTrue(bare.sources.isEmpty() && bare.history.isEmpty() && bare.exposure.isEmpty())
    }

    @Test fun theReviewQueueDecodesEveryOpItCarries() {
        val review = decode(ListSerializer(WikiChangeset.serializer()), WikiFixtures.review)
        assertEquals(listOf("agent", "maintenance", "agent"), review.map { it.origin })
        assertEquals(listOf("pending", "pending", "pending"), review.map { it.status })
        assertNull("Wiki maintenance has no session", review[1].sessionId)
        val add = review[0].ops!!.first()
        assertEquals("add", add.op); assertEquals("pending", add.decision)
        assertEquals("pitfall", add.payload["entry"]["kind"].text())
        assertEquals(JsonArray(listOf(JsonPrimitive("src/apiserver/src/watches/watch-redaction.ts"))), add.payload["entry"]["fields"]["trigger"]["paths"])
        val amend = review[2].ops!!.first()
        assertEquals(true, amend.tainted)
        assertEquals("convention", amend.similar?.first()?.kind)
        assertEquals(0.31, amend.similar?.first()?.score)
        assertEquals("auto_applied", review[2].ops?.last()?.decision)
    }

    @Test fun theTimelineDecodes() {
        val items = decode(WikiTimeline.serializer(), WikiFixtures.timeline).items!!
        assertEquals(5, items.size)
        assertEquals("add", items[0].op); assertEquals("accepted", items[0].decision)
        assertEquals("Headless Chromium clamps windows under 500", items[1].supersededByTitle)
        assertEquals("auto_applied", items[2].decision); assertEquals("owner", items[2].origin)
        assertEquals("an op id stays the raw UUID", "0196e000-0000-7000-8000-00000000a001", items[0].opId)
    }

    @Test fun aValueFromALaterServerStillReadsAndIsTreatedAsUnknown() {
        val entries = decode(ListSerializer(WikiEntry.serializer()), """
            [{"id":"e1","kind":"hypothesis","status":"parked","trust":"crowd","anchorState":"stale",
              "anchors":[{"type":"url","check":{"state":"flaky"}}]},
             {"id":"e2","kind":"pitfall","status":"active","trust":"owner","anchorState":"verified"}]""")
        val later = entries[0]
        assertEquals("", WikiCopy.kindLabel(later.kind))
        assertEquals("", WikiCopy.statusLabel(later.status))
        assertEquals("", WikiCopy.trustLabel(later.trust))
        assertNull(WikiLogic.anchorMark(later.anchorState, null))
        assertEquals("unknown anchor", WikiModeLogic.anchorWords(later.anchors!!.first()))
        assertEquals(WikiAnchorMark("Unchecked", WikiTone.MUTED), WikiLogic.anchorStateMark(later.anchors!!.first()))
        assertFalse(later.isEnded)
        assertEquals("pitfall", entries[1].kind)
        val changesets = decode(ListSerializer(WikiChangeset.serializer()), """
            [{"id":"c1","origin":"oracle","status":"archived","ops":[{"id":"o1","op":"merge","decision":"deferred"}]}]""")
        assertEquals("", WikiCopy.opLabel(changesets[0].ops!!.first().op))
        // An op whose decision is not "pending" never becomes a Review card.
        assertTrue(WikiLogic.reviewCards(changesets).isEmpty())
        assertEquals("", WikiModeCopy.originWord(changesets[0].origin))
        val source = decode(WikiSource.serializer(), """{"id":"s1","kind":"hologram","state":"shredded"}""")
        assertEquals("", WikiLogic.sourceWord(source.kind))
        assertEquals("telepathy", decode(WikiExposure.serializer(), """{"channel":"telepathy"}""").channel)
        assertEquals("ghost", decode(WikiRevision.serializer(), """{"id":"r1","authorKind":"ghost"}""").authorKind)
    }

    @Test fun anAnchorsLastCheckDecodes() {
        val entry = decode(WikiEntry.serializer(), """
            {"id":"e1","kind":"pitfall","anchorState":"changed","anchorCheckedRef":"${WikiFixtures.sha}",
             "anchors":[{"type":"symbol","path":"src/a.ts","symbol":"foo","check":{"state":"changed","ref":"${WikiFixtures.sha}",
               "at":"2026-09-28T02:00:00.000Z","regionSha256":"${"b".repeat(64)}","baselineSha256":"${"a".repeat(64)}"}},
               {"type":"commit","sha":"${WikiFixtures.sha}","check":{"state":"missing","ref":"${WikiFixtures.sha}","at":"2026-09-28T02:00:00.000Z"}}]}""")
        assertEquals("changed", entry.anchorState)
        assertEquals(listOf("changed", "missing"), entry.anchors?.map { it.check?.state })
        assertEquals(WikiFixtures.sha, entry.anchors?.first()?.check?.ref)
        // What goes back is what a proposer writes: never the check, nor a key no anchor type names.
        assertEquals(buildJsonObject { put("type", "symbol"); put("path", "src/a.ts"); put("symbol", "foo") }, wikiAnchorInput(entry.anchors!!.first()))
    }

    @Test fun theOwnerWritesAnswerDecodes() {
        val result = decode(WikiChangeResult.serializer(), """
            {"changesetId":"c1","changesetPublicId":"c1","replayed":false,"ops":[
              {"seq":0,"status":"applied","opId":"0196e000-0000-7000-8000-000000000001","entryId":"e1","revision":3},
              {"seq":1,"status":"refused","reasons":[{"code":"WIKI_SCHEMA","message":"title: is too long"}]}]}""")
        assertEquals(listOf("applied", "refused"), result.ops?.map { it.status })
        assertEquals(3, result.ops?.first()?.revision)
        assertEquals("WIKI_SCHEMA", result.ops?.last()?.reasons?.first()?.code)
    }
}
