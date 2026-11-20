package io.orbitd.android.navigation

import io.orbitd.android.core.guests.GuestSessionSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A Shared with me row is a drawer destination of its own, and the open row is found in either id spelling (OrbitKit
 * `SharedWithMe.contains`, `SidebarSelection.guestSession`). */
class SharedWithMeNavigationTest {
    private val uuid = "01a0cca7-8609-70ed-a0e2-d4b55b8c0001"
    private val row = GuestSessionSummary(uuid, "Fix it", "Ana")

    @Test fun theOpenRowIsFoundInEitherIdSpelling() {
        assertTrue(sharedWithMeContains(listOf(row), uuid))
        assertTrue(sharedWithMeContains(listOf(row), ObjectId.toPublic(uuid)))
        assertFalse(sharedWithMeContains(listOf(row), "01a0cca7-8609-70ed-a0e2-d4b55b8c0002"))
        assertFalse(sharedWithMeContains(listOf(row), null))
        assertFalse(sharedWithMeContains(emptyList(), uuid))
    }

    @Test fun aRowOpensTheGuestViewAsItsOwnDestination() {
        assertEquals(guestDestination(uuid), guestDestination(ObjectId.toPublic(uuid)))
        val nav = OrbitNavigation(account = "a").select(guestDestination(uuid), OrbitRoute(Destination.GUEST_SESSION, uuid, origin = Origin.DRAWER))
        assertEquals(guestDestination(uuid), nav.section)
        assertEquals(listOf(OrbitRoute(Destination.GUEST_SESSION, uuid, origin = Origin.DRAWER)), nav.frames)
    }
}
