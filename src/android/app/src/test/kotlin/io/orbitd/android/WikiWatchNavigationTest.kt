package io.orbitd.android

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.navigation.*
import io.orbitd.android.watch.withFollowingUnder
import io.orbitd.android.wiki.WikiNav
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
        // The link's arrival is a frame of its own (OrbitRoute.entry), kept across recreation.
        assertEquals(space, restored.current.copy(entry = 0))
        assertNotEquals(0L, restored.current.entry)
        assertNull(restored.pending)
        assertEquals(Destination.WORKSPACES, restored.back().current.destination)
    }

    @Test fun sourceRecordReturnsToExactDocumentSectionAcrossRecreation() {
        var nav = OrbitNavigation().bindAccount("server|reader").select("Wiki", OrbitRoute(Destination.WIKI, origin = Origin.DRAWER))
        val wiki = WikiNav({ nav = nav.push(it) }, { change -> nav = change(nav) }, "https://example.test") {}
        val document = OrbitRoute(Destination.WIKI_DOC, "deployment", wikiSection = "restore")
        wiki.open(document)
        // A footnote's one button: the session at the quoted record, by the same deep link iOS opens.
        wiki.sessionRecord(publicId, publicId)
        val restored = Wire.json.decodeFromString<OrbitNavigation>(Wire.json.encodeToString(nav))
        assertEquals(OrbitRoute(Destination.SESSION, uuid, recordId = uuid, origin = Origin.LINK), restored.current)
        assertEquals(document, restored.back().current)
        assertEquals("Wiki", restored.back().section)
        val versioned = OrbitRoute(Destination.WIKI_PLAN_SECTION, "deployment", wikiPart = 2, wikiVersion = 4)
        assertEquals(versioned, Wire.json.decodeFromString<OrbitRoute>(Wire.json.encodeToString(versioned)))
    }

    @Test fun aRecordTheLinkCannotNameStillOpensTheSession() {
        var nav = OrbitNavigation().bindAccount("server|reader")
        val wiki = WikiNav({ nav = nav.push(it) }, { change -> nav = change(nav) }, "https://example.test") {}
        wiki.sessionRecord(publicId, "not a record!")
        assertEquals(OrbitRoute(Destination.SESSION, publicId, origin = Origin.LINK), nav.current)
    }

    @Test fun contentsHomeReturnsToTheWikiHomeUnderThePageOrPushesOne() {
        var nav = OrbitNavigation().bindAccount("server|reader").select("Wiki", OrbitRoute(Destination.WIKI, origin = Origin.DRAWER))
        val wiki = WikiNav({ nav = nav.push(it) }, { change -> nav = change(nav) }, "https://example.test") {}
        wiki.open(OrbitRoute(Destination.WIKI_BROWSE)); wiki.open(OrbitRoute(Destination.WIKI_ARTICLE, "reader", wikiPart = 1))
        wiki.home()
        assertEquals(listOf(OrbitRoute(Destination.WIKI, origin = Origin.DRAWER)), nav.frames)
        // An entry a session's link opened rides the workspace's stack: its Home is the Wiki home over it.
        nav = OrbitNavigation().bindAccount("server|reader").push(OrbitRoute(Destination.SESSION, uuid))
        wiki.entry(uuid); wiki.home()
        assertEquals(listOf(Destination.WORKSPACES, Destination.SESSION, Destination.WIKI_ENTRY, Destination.WIKI), nav.frames.map { it.destination })
        wiki.replace(OrbitRoute(Destination.WIKI_PLAN, wikiVersion = 3))
        assertEquals(listOf(Destination.WORKSPACES, Destination.SESSION, Destination.WIKI_ENTRY, Destination.WIKI_PLAN), nav.frames.map { it.destination })
        wiki.back()
        assertEquals(Destination.WIKI_ENTRY, nav.current.destination)
    }

    @Test fun aLinkedWatchHasFollowingUnderItAndBackStillReachesTheSource() {
        val session = OrbitRoute(Destination.SESSION, uuid)
        val watch = OrbitLinks.parse("orbit://watch/$publicId", origin = Origin.EXTERNAL)!!
        val received = OrbitNavigation().bindAccount("server|reader").push(session).receive(watch)
        val arrived = received.current
        assertEquals(watch, arrived.copy(entry = 0))
        val linked = received.withFollowingUnder(arrived)
        assertEquals(listOf(Destination.WORKSPACES, Destination.SESSION, Destination.WATCH, Destination.WATCH), linked.frames.map { it.destination })
        assertEquals(arrived, linked.current)
        assertEquals(OrbitRoute(Destination.WATCH, origin = Origin.LINK), linked.back().current)
        assertEquals(session, linked.back().back().current)
        // Opened from Following, or applied twice, the stack is left as it is.
        assertEquals(linked, linked.withFollowingUnder(arrived))
        val fromList = OrbitNavigation().bindAccount("server|reader").push(OrbitRoute(Destination.WATCH)).push(OrbitRoute(Destination.WATCH, uuid))
        assertEquals(fromList, fromList.withFollowingUnder(OrbitRoute(Destination.WATCH, uuid)))
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
