package io.orbitd.android.core.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

/** The session's intent and the mode its engine runs in, decoded as the server sends them (shared `SessionPermissionModeFacts`):
 * the list row's two fields, the detail's changes, and what an older server or an unreadable entry leaves. */
class PermissionModesTest {
    private fun json(text: String): JsonObject = Wire.json.parseToJsonElement(text).jsonObject

    @Test fun anOlderServerSaysNothingOfTheModeRunning() {
        val older = json("""{"id":"s","status":"RUNNING","permissionMode":"auto"}""")
        assertEquals("auto", PermissionModes.intent(older))
        assertFalse(PermissionModes.reported(older))
        assertNull(PermissionModes.actual(older))
        assertNull(PermissionModes.actualAt(older))
        assertTrue(PermissionModes.changes(older).isEmpty())
    }

    @Test fun aListRowCarriesTheModeRunningAndNoHistory() {
        val row = json("""{"id":"s","permissionMode":"auto","actualPermissionMode":"default","actualPermissionModeAt":"2026-11-22T12:00:00.000Z"}""")
        assertTrue(PermissionModes.reported(row))
        assertEquals("default", PermissionModes.actual(row))
        assertEquals("2026-11-22T12:00:00.000Z", PermissionModes.actualAt(row))
        assertTrue(PermissionModes.changes(row).isEmpty())
    }

    /** Null until a claim since migration 1437 records one: reported, and nothing recorded yet. */
    @Test fun aSessionNoClaimHasRecordedReportsNoMode() {
        val fresh = json("""{"id":"s","permissionMode":"plan","actualPermissionMode":null,"actualPermissionModeAt":null,"permissionModeChanges":[]}""")
        assertTrue(PermissionModes.reported(fresh))
        assertNull(PermissionModes.actual(fresh))
        assertTrue(PermissionModes.changes(fresh).isEmpty())
    }

    @Test fun theDetailsChangesDecodeOldestFirstWithWhoMadeThem() {
        val detail = json("""{"id":"s","permissionMode":"auto","actualPermissionMode":"auto","actualPermissionModeAt":"2026-11-22T12:00:03.000Z",
            "permissionModeChanges":[
              {"fromMode":null,"toMode":"auto","cause":"CLAIM","client":null,"at":"2026-11-22T12:00:00.000Z"},
              {"fromMode":"auto","toMode":"default","cause":"OWNER_PICK","client":"android","at":"2026-11-22T12:00:02.000Z"},
              {"fromMode":"default","toMode":"auto","cause":"RUNNER_CORRECTION","client":null,"at":"2026-11-22T12:00:03.000Z"}]}""")
        assertEquals(listOf(
            PermissionModeChange(null, "auto", "CLAIM", null, "2026-11-22T12:00:00.000Z"),
            PermissionModeChange("auto", "default", "OWNER_PICK", "android", "2026-11-22T12:00:02.000Z"),
            PermissionModeChange("default", "auto", "RUNNER_CORRECTION", null, "2026-11-22T12:00:03.000Z"),
        ), PermissionModes.changes(detail))
        assertEquals(3, PermissionModes.changes(detail).map { it.key }.toSet().size)
    }

    /** An entry with no mode, cause or time is left out rather than failing the read; a mode word this build does not know is kept
     * as the server spells it, and named so. */
    @Test fun anUnreadableEntryIsLeftOutAndAnUnknownModeIsKept() {
        val detail = json("""{"permissionModeChanges":[
              "not an object",
              {"fromMode":"auto","cause":"CLAIM","at":"2026-11-22T12:00:00.000Z"},
              {"fromMode":"auto","toMode":"default","at":"2026-11-22T12:00:01.000Z"},
              {"fromMode":"auto","toMode":"default","cause":"CLAIM"},
              {"fromMode":7,"toMode":"sandboxed","cause":"FUTURE_CAUSE","at":"2026-11-22T12:00:02.000Z"}]}""")
        assertEquals(listOf(PermissionModeChange(null, "sandboxed", "FUTURE_CAUSE", null, "2026-11-22T12:00:02.000Z")), PermissionModes.changes(detail))
        assertEquals("sandboxed", PermissionModes.label("sandboxed"))
        assertTrue(PermissionModes.changes(json("""{"permissionModeChanges":{"toMode":"auto"}}""")).isEmpty())
    }

    /** Since migration 1810 each change carries the order it was recorded in, and the detail says whether older ones are recorded:
     * two repeated transitions at one moment are two lines, and a page of older ones decodes the same way. */
    @Test fun eachChangeCarriesItsSeqAndThePageOfOlderOnesDecodes() {
        val detail = json("""{"permissionModeChangesHasMore":true,"permissionModeChanges":[
              {"fromMode":"auto","toMode":"plan","cause":"OWNER_PICK","client":"web","at":"2026-11-22T12:00:00.000Z","seq":41},
              {"fromMode":"plan","toMode":"auto","cause":"OWNER_PICK","client":"android","at":"2026-11-22T12:00:00.000Z","seq":42},
              {"fromMode":"auto","toMode":"plan","cause":"OWNER_PICK","client":"web","at":"2026-11-22T12:00:00.000Z","seq":43},
              {"fromMode":"plan","toMode":"auto","cause":"OWNER_PICK","client":"android","at":"2026-11-22T12:00:00.000Z","seq":44}]}""")
        val changes = PermissionModes.changes(detail)
        assertEquals(listOf(41L, 42L, 43L, 44L), changes.map { it.seq })
        assertEquals(4, changes.map { it.key }.toSet().size)
        assertTrue(PermissionModes.changesHasMore(detail))
        assertFalse(PermissionModes.changesHasMore(json("""{"permissionModeChanges":[]}""")))
        val page = PermissionModes.page(json("""{"changes":[
              {"fromMode":null,"toMode":"auto","cause":"CLAIM","client":null,"at":"2026-11-22T11:59:00.000Z","seq":7}],"hasMore":false}"""))
        assertEquals(ModeChangePage(listOf(PermissionModeChange(null, "auto", "CLAIM", null, "2026-11-22T11:59:00.000Z", 7)), false), page)
        // A seq spelled as a string is no seq.
        assertNull(PermissionModes.changes(json("""{"permissionModeChanges":[
              {"fromMode":null,"toMode":"auto","cause":"CLAIM","at":"2026-11-22T11:59:00.000Z","seq":"7"}]}""")).single().seq)
    }

    @Test fun eachModeHasTheSharedTablesName() {
        assertEquals(listOf("Default", "Accept Edits", "Plan", "Auto", "Don't Ask", "Bypass"),
            listOf("default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions").map(PermissionModes::label))
    }
}
