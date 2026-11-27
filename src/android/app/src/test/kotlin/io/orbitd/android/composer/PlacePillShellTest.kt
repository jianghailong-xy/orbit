package io.orbitd.android.composer

import androidx.compose.ui.test.*
import io.orbitd.android.core.net.ApiResponse
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Test

/**
 * Where a new session runs, under the engine (docs/mocks/new-session-place, option A; web's `PlacePill`): one pill naming the workspace,
 * and the folder only once one is picked; its menu lists the workspaces alone, a workspace with folders opening them in place of the list
 * under None (board 02, option D), and a folder picked there is the one the session is created in.
 */
class PlacePillShellTest : ComposerShellTest() {
    private val folder = "34A07cComposerFoldr001"
    private val pill = hasTestTag("new-session-place")
    private val menu = hasAnyAncestor(hasTestTag("new-session-place-menu"))

    private fun folders() {
        ComposerShell.answers["GET session-folders"] = {
            ApiResponse(200, """[{"id":"$folder","workspaceId":"${ComposerShell.WORKSPACE}","name":"Releases"}]""".encodeToByteArray())
        }
    }

    @Test fun thePillNamesTheWorkspaceAloneUntilAFolderIsPicked() {
        folders()
        signIn(); openDraft()
        await { has(pill and hasContentDescription("Runs in: Alpha")) }
        assertFalse("no folder state is said", shows("No folder"))

        compose.onNode(pill).performClick()
        // The workspaces alone; this one opens its folders in place of the list.
        await { has(hasText("Alpha") and menu) }
        assertFalse(has(hasText("Releases") and menu))
        compose.onNode(hasText("Alpha") and menu and hasClickAction()).performClick()
        await { has(hasText("Releases") and menu) }
        assertTrue(has(hasText("Workspaces") and menu))
        assertTrue(has(hasText("FOLDERS IN ALPHA") and menu))
        assertTrue(has(hasText("None") and menu))

        compose.onNode(hasText("Releases") and menu).performClick()
        await { has(pill and hasContentDescription("Runs in: Alpha / Releases")) }
        await { has(hasTestTag("composer-model") and isEnabled()) }
        compose.onNodeWithTag("composer-input").performTextInput("File it in Releases")
        compose.onNodeWithTag("composer-send").performClick()
        await { ComposerShell.body("POST sessions") != null }
        assertEquals(folder, ComposerShell.body("POST sessions")!!["folderId"]?.jsonPrimitive?.content)
    }

    @Test fun aWorkspaceWithNoFoldersIsPickedFromItsRow() {
        signIn(); openDraft()
        await { has(pill) }
        compose.onNode(pill).performClick()
        await { has(hasText("Alpha") and menu) }
        compose.onNode(hasText("Alpha") and menu and hasClickAction()).performClick()
        await { !has(menu) }
        assertFalse(shows("None"))
    }
}
