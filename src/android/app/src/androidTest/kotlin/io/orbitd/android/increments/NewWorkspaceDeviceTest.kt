package io.orbitd.android.increments

import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.orbitd.android.composer.MachineSetupCopy
import io.orbitd.android.composer.NewWorkspaceCopy
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * New workspace on a machine that already has one (docs/mocks/new-workspace-form/02-apple-entry, owner A 2026-11-20, as iOS built it),
 * over the test's own fixture, the iOS probe's two machines (docs/evidence/new-workspace-native/probe-harness/stub.py): orbit@austin
 * holding `orbit`, build-box holding `wiki-site`. The drawer's Workspaces +, its menu, the card empty, a full path to a repository, a
 * missing full path, Create and the new workspace's new session page; and the machine page's New workspace row. Screenshots are taken
 * at each step to set beside the iPhone's.
 */
@RunWith(AndroidJUnit4::class)
class NewWorkspaceDeviceTest : IncrementDeviceTest() {
    private val austin = "34NwsRunnerAustin00001"
    private val build = "34NwsRunnerBuildBox001"
    private val orbit = "34NwsWorkspaceOrbit001"
    private val wiki = "34NwsWorkspaceWiki0001"
    private val api = "34NwsWorkspaceApi00001"
    override val ids get() = listOf(workspace, runner, austin, build, orbit, wiki, api)

    private val home = "/home/orbit"
    private val made = CopyOnWriteArrayList<String>()
    /** Every path the app asked a machine about, as it asked it. */
    private val asked = CopyOnWriteArrayList<String>()

    private fun machine(id: String, name: String) = """{"id":"$id","name":"$name","displayName":null,"hostname":"${name.substringAfter('@')}",
        "online":true,"status":"ONLINE","version":"0.1.262","maxConcurrent":8,"activeSessions":0,"lastHeartbeatAt":"${Instant.now()}",
        "reposRoot":"$home/orbit-repos","modelCatalog":{"claude":[{"value":"claude-opus-5-5","label":"Opus 5.5"}]},
        "runtimeDefaultModels":{"claude":"claude-opus-5-5"},
        "capabilities":["dir-probe/v1","create-workdir/v1","create-workdir/v2","clone-workdir/v1"],
        "engines":[{"engine":"claude","installed":true,"version":"2.1.302","auth":"yes"}],"enrolledAt":"2026-09-01T00:00:00Z"}"""
    private fun machines() = "[${machine(austin, "orbit@austin")},${machine(build, "build-box")}]"
    private fun ws(id: String, name: String, runnerId: String, workDir: String) = """{"id":"$id","name":"$name","provider":"claude",
        "lastProvider":"claude","lastEngine":"claude","model":"claude-opus-5-5","runnerId":"$runnerId","enabled":true,"enableWorktree":true,
        "workDir":"$workDir","workDirExists":true,"workDirIsGit":true,"position":0,"createdAt":"2026-10-01T01:00:00.000Z"}"""
    private fun workspaces() = (listOf(ws(orbit, "orbit", austin, "$home/orbit"), ws(wiki, "wiki-site", build, "$home/wiki-site")) + made)
        .joinToString(",", "[", "]")

    /** `/home/orbit/code/api` is a git repository on `main`; nothing else is there. */
    private fun probe(path: String): String {
        val resolved = if (path.startsWith("~")) home + path.drop(1) else path
        return if (resolved == "$home/code/api") """{"path":"$resolved","exists":true,"isDir":true,"isGit":true,"branch":"main","isHome":false,"freeBytes":412000000000}"""
        else """{"path":"$resolved","exists":false,"isDir":false,"isGit":false,"branch":null,"isHome":false,"freeBytes":null}"""
    }

    override fun answer(req: Req): MockResponse? = when {
        req.path == "auth/capabilities" -> json("{}")
        req.path == "runners" -> json(machines())
        req.path == "runners/$austin" -> json(machine(austin, "orbit@austin"))
        req.path == "runners/$build" -> json(machine(build, "build-box"))
        req.parts.size == 3 && req.parts[0] == "runners" && req.parts[2] == "dir-probe" ->
            if (req.method == "POST") {
                asked += Regex("\"path\"\\s*:\\s*\"([^\"]*)\"").find(req.body)?.groupValues?.get(1).orEmpty()
                json("""{"status":"pending"}""")
            } else json("""{"status":"done","path":${quote(req.q("path").orEmpty())},"result":${probe(req.q("path").orEmpty())}}""")
        req.path == "workspaces" && req.method == "POST" -> {
            made += ws(api, "api", austin, "$home/code/api")
            json(ws(api, "api", austin, "$home/code/api"), 201)
        }
        req.path == "workspaces" -> json(workspaces())
        req.path == "workspaces/$orbit" -> json(ws(orbit, "orbit", austin, "$home/orbit"))
        req.path == "workspaces/$api" -> json(ws(api, "api", austin, "$home/code/api"))
        req.path == "providers/mine" || req.path == "providers/pools" || req.path == "providers/shared-pools" -> json("[]")
        else -> null
    }

    private fun drawer() {
        compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
        awaitTag("new-workspace")
    }

    private fun typeFolder(text: String) {
        compose.onNodeWithTag("setup-new-folder-name").performTextClearance()
        compose.onNodeWithTag("setup-new-folder-name").performTextInput(text)
    }

    /** The bar names the page New workspace and its machine. */
    private fun titled() = exists(hasText(NewWorkspaceCopy.NEW_WORKSPACE) and hasAnyAncestor(hasTestTag("app-bar")), unmerged = true) &&
        exists(hasText("orbit@austin") and hasAnyAncestor(hasTestTag("app-bar")), unmerged = true)

    @Test fun theDrawersPlusOpensTheCardWhichTakesAFullPathAndCreates() = journey {
        signIn()
        drawer()
        await("the drawer lists both workspaces") { exists(hasText("orbit", substring = true), unmerged = true) && exists(hasText("wiki-site", substring = true), unmerged = true) }
        verify("no Set up row: both machines have a workspace", !exists(hasText("Set up", substring = true), unmerged = true))
        capture("01-entry")

        compose.onNodeWithTag("new-workspace").performClick()
        awaitText(NewWorkspaceCopy.NEW_WORKSPACE_ON)
        verify("the menu offers both machines with what they hold",
            exists(hasTestTag("new-workspace-machine:$austin"), unmerged = true) && exists(hasTestTag("new-workspace-machine:$build"), unmerged = true) &&
                count(hasText("1 workspace"), unmerged = true) == 2)
        capture("02-menu")

        compose.onNodeWithTag("new-workspace-machine:$austin").performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick)
        awaitTag("machine-setup-card")
        await("the bar says New workspace on orbit@austin") { titled() }
        awaitText(MachineSetupCopy.setupFolderOrPathHint(home))
        verify("the card has no head under the bar", !exists(hasText(MachineSetupCopy.setupNewWorkspaceTitle("orbit@austin")), unmerged = true))
        verify("the page didn't move on to orbit", !exists(hasTestTag("new-session-engine"), unmerged = true))
        capture("03-card-empty")

        typeFolder("$home/code/api")
        awaitText("Found · git repository · main")
        verify("the machine was asked the path as typed", asked.contains("$home/code/api"))
        verify("the Name follows the last segment", exists(hasTestTag("setup-workspace-name") and hasText("api"), unmerged = true))
        verify("Create workspace can be pressed", exists(hasTestTag("setup-create") and isEnabled()))
        dropFocus()
        capture("04-found")

        typeFolder("~/nowhere")
        awaitText("No such directory on orbit@austin.")
        verify("the machine was asked ~/nowhere as typed", asked.contains("~/nowhere"))
        verify("a missing path can't be created", exists(hasTestTag("setup-create") and isNotEnabled()))
        dropFocus()
        capture("05-missing")

        typeFolder("$home/code/api")
        awaitText("Found · git repository · main")
        dropFocus()
        compose.onNodeWithTag("setup-create").performClick()
        await("the new workspace's new session page", timeoutMs = 45_000) { exists(hasTestTag("new-session-engine"), unmerged = true) }
        verify("one POST workspaces with the path as found", bodies.count { it.first == "POST workspaces" } == 1 &&
            bodies.first { it.first == "POST workspaces" }.second.contains("\"workDir\":\"$home/code/api\"") &&
            !bodies.first { it.first == "POST workspaces" }.second.contains("newFolder"))
        verify("the bar names the new workspace", exists(hasText("api") and hasAnyAncestor(hasTestTag("app-bar")), unmerged = true))
        capture("06-created")
    }

    @Test fun theMachinePagesRowOpensTheSameCard() = journey {
        signIn()
        open("orbit://runner/$austin")
        await("the machine page lists orbit") { exists(hasText("orbit"), unmerged = true) }
        compose.onNodeWithTag("machine-new-workspace").performScrollTo()
        settle()
        verify("the row says New workspace", says("machine-new-workspace", NewWorkspaceCopy.NEW_WORKSPACE))
        capture("08-machine-row")
        compose.onNodeWithTag("machine-new-workspace").performClick()
        awaitTag("machine-setup-card")
        await("the bar says New workspace on orbit@austin") { titled() }
        awaitText(MachineSetupCopy.setupFolderOrPathHint(home))
        capture("09-from-machine-row")
    }
}
