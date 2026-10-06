package io.orbitd.android

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.navigation.*
import kotlinx.serialization.encodeToString
import org.junit.Assert.*
import org.junit.Test

class WikiWatchNavigationTest {
    private val publicId = "34TcwNgAIo6tGUiIKjqnQ"
    private val uuid = "01a0cca7-8609-70ed-a0e2-d4b55b832b60"

    @Test fun notificationSpaceAndMarkdownEntryAreDifferentDestinations() {
        val space = OrbitLinks.parse("orbit://wiki/$publicId", origin = Origin.EXTERNAL)!!
        assertEquals(OrbitRoute(Destination.WIKI, uuid, origin = Origin.EXTERNAL), space)
        val entry = OrbitLinks.parse("orbit-wiki:$publicId")!!
        assertEquals(Destination.WIKI_ENTRY, entry.destination)
        assertEquals(uuid, entry.id)
        val restored = Wire.json.decodeFromString<OrbitNavigation>(Wire.json.encodeToString(OrbitNavigation().receive(space)))
            .bindAccount("server|reader")
        assertEquals(space, restored.current)
        assertNull(restored.pending)
        assertEquals(Destination.WORKSPACES, restored.back().current.destination)
    }

    @Test fun sourceRecordReturnsToExactDocumentSectionAndSpaceAcrossRecreation() {
        val document = OrbitRoute(Destination.WIKI_DOC, "deployment", wikiSpaceId = uuid, wikiSection = "restore")
        val record = OrbitLinks.parse("orbit-session:$publicId?at=$publicId")!!
        val nav = OrbitNavigation().bindAccount("server|reader").select("Wiki", OrbitRoute(Destination.WIKI, uuid))
            .push(document).push(record)
        val restored = Wire.json.decodeFromString<OrbitNavigation>(Wire.json.encodeToString(nav))
        assertEquals(uuid, restored.current.recordId)
        assertEquals(document, restored.back().current)
        assertEquals("Wiki", restored.back().section)
        val versioned = OrbitRoute(Destination.WIKI_PLAN_SECTION, "deployment", wikiSpaceId = uuid, wikiSection = "2", wikiVersion = 4)
        assertEquals(versioned, Wire.json.decodeFromString<OrbitRoute>(Wire.json.encodeToString(versioned)))
    }

    @Test fun watchPushRetainsOriginalConversationAndLogoutClearsBoth() {
        val session = OrbitRoute(Destination.SESSION, uuid)
        val watch = OrbitLinks.parse("orbit://watch/$publicId", origin = Origin.EXTERNAL)!!
        val nav = OrbitNavigation().bindAccount("server|reader").push(session).receive(watch)
        assertEquals(Destination.WATCH, nav.current.destination)
        assertEquals(session, nav.back().current)
        assertFalse(nav.bindAccount(null).canGoBack)
        assertNull(nav.bindAccount("other|reader").pending)
    }

    @Test fun invalidWikiSpaceLinksNeverBecomeEntryLookups() {
        listOf("orbit://wiki/../../entries", "orbit://wiki/bad!", "orbit://wiki/$publicId/entries",
            "orbit://wiki/zzzzzzzzzzzzzzzzzzzzzz").forEach { assertNull(it, OrbitLinks.parse(it)) }
    }

    @Test fun wikiWebLinksStayExternalAsInTheFixedIosParser() {
        assertNull(OrbitLinks.parse("https://example.test/orbit/wiki/platform/e/$publicId", "https://example.test/orbit"))
        assertNull(OrbitLinks.parse("https://other.test/wiki/platform/e/$publicId", "https://example.test"))
        assertNull(OrbitLinks.parse("https://example.test/wiki/$publicId", "https://example.test"))
        assertNull(OrbitLinks.parse("https://example.test/wiki/platform/e/$publicId", "https://example.test/orbit"))
    }
}
