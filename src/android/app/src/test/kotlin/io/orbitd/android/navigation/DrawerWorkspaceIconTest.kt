package io.orbitd.android.navigation

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/** Board docs/mocks/workspace-machine-icon, B: a workspace on Orbit Cloud wears its cloud in the drawer, every other the folder,
 * as the web sidebar and the Apple clients' `WorkspaceFolderIcon` draw it. */
class DrawerWorkspaceIconTest {
    private fun source(path: String): String {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            File(dir, path).takeIf { it.isFile }?.let { return it.readText() }
            dir = dir.parentFile
        }
        error("$path not found")
    }

    @Test fun anOrbitCloudWorkspaceWearsTheCloudAndEveryOtherTheFolder() {
        val chrome = source("app/src/main/kotlin/io/orbitd/android/navigation/DrawerChrome.kt")
        assertTrue(chrome.contains("icon = if (cloud) R.drawable.ic_cloud else R.drawable.ic_workspace,"))
        val shell = source("app/src/main/kotlin/io/orbitd/android/MainActivity.kt")
        assertTrue(shell.contains("val onCloud = runner != null && RunnerPage.isManaged(runner.id, managed = runner.managed)"))
        assertTrue(shell.contains("cloud = onCloud,"))
    }
}
