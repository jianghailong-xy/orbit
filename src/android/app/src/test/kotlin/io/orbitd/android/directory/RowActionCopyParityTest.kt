package io.orbitd.android.directory

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** A row's actions are named as iOS names them, and its swipe moves by iOS's numbers: each is read off the Swift it was ported from. */
class RowActionCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }
    private fun views(name: String) = File(root, "src/macos/OrbitApp/Sources/OrbitApp/Views/$name").readText()
    private fun kit(name: String) = File(root, "src/macos/OrbitKit/Sources/OrbitKit/App/$name").readText()

    @Test fun everyTitleIsTheSwiftOne() {
        val actions = views("SessionRowActions.swift")
        assertTrue(actions.contains("RowSwipeAction(title: \"Move to Open\", systemImage: \"tray.and.arrow.up\", tint: .blue,"))
        assertTrue(actions.contains("RowSwipeAction(title: isPinned ? \"Unpin\" : \"Pin\""))
        assertTrue(actions.contains("RowSwipeAction(title: \"Share\", systemImage: \"square.and.arrow.up\", tint: .blue"))
        assertTrue(actions.contains("RowSwipeAction(title: \"Move\", systemImage: \"folder\", tint: .indigo"))
        assertTrue(actions.contains("RowSwipeAction(title: \"Delete Permanently\", systemImage: \"trash.slash\", tint: .red,"))
        assertTrue(actions.contains("RowSwipeAction(title: \"Delete\", systemImage: \"trash\", tint: .red,"))
        assertTrue(actions.contains("RowSwipeAction(title: SessionCompletionPresentation.actionTitle,"))
        assertTrue(kit("SessionViews.swift").contains("public static let actionTitle = \"${SessionRowAction.COMPLETE.title}\""))
        // The menu's own words: the editors, and the panels' items with their ellipsis.
        assertTrue(actions.contains("Label(\"Rename…\""))
        assertTrue(actions.contains("Label(\"Tags…\""))
        assertTrue(actions.contains("Label(\"Move…\""))
        assertTrue(actions.contains("Label(SharePanelCopy.share,"))
        assertTrue(kit("SharePanel.swift").contains("public static let share = \"${SessionRowAction.SHARE.menuTitle}\""))
        val held = mapOf(
            SessionRowAction.COMPLETE to ("Complete" to "Complete"), SessionRowAction.MOVE_TO_OPEN to ("Move to Open" to "Move to Open"),
            SessionRowAction.PIN to ("Pin" to "Pin"), SessionRowAction.UNPIN to ("Unpin" to "Unpin"),
            SessionRowAction.SHARE to ("Share" to "Share…"), SessionRowAction.MOVE to ("Move" to "Move…"),
            SessionRowAction.DELETE to ("Delete" to "Delete"), SessionRowAction.DELETE_PERMANENTLY to ("Delete Permanently" to "Delete Permanently"),
            SessionRowAction.RENAME to ("Rename…" to "Rename…"), SessionRowAction.TAGS to ("Tags…" to "Tags…"),
        )
        assertEquals(SessionRowAction.entries.toSet(), held.keys)
        held.forEach { (action, words) -> assertEquals(words, action.title to action.menuTitle) }
        // A project row's Pin is the project copy's, its swipe's Move the session row's.
        val project = views("SessionProjectPage.swift")
        assertTrue(project.contains("[RowSwipeAction(title: \"Move\", systemImage: \"folder\", tint: .indigo,"))
    }

    @Test fun theSwipeMovesByIosNumbers() {
        val geometry = kit("RowSwipeGeometry.swift")
        listOf("public static let slot = 60.0", "public static let gap = 10.0", "public static let growth = 30.0",
            "private static let resistance = 0.3", "private static let flick = 400.0", "max(leadingWidth + Self.slot, rowWidth * 0.6)",
            "reveal <= 0 ? 0 : min(1, 0.15 + 0.85 * reveal)").forEach { assertTrue("RowSwipeGeometry.swift says $it", geometry.contains(it)) }
        assertEquals(60.0, RowSwipeGeometry.SLOT, 0.0)
        assertEquals(10.0, RowSwipeGeometry.GAP, 0.0)
        assertEquals(30.0, RowSwipeGeometry.GROWTH, 0.0)
        // The Delete Permanently confirmation is the one iOS asks.
        val actions = views("SessionRowActions.swift")
        assertTrue(actions.contains(".orbitConfirmation(\"Delete permanently?\", isPresented: \$confirmPurge)"))
        assertTrue(actions.contains("Text(\"This session and its full transcript will be permanently deleted. This can't be undone.\")"))
    }
}
