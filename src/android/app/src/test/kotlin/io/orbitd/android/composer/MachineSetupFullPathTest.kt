package io.orbitd.android.composer

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.navigation.Origin
import io.orbitd.android.navigation.addsWorkspace
import io.orbitd.android.navigation.newWorkspaceRoute
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

/**
 * The card's folder field takes a full path too (docs/mocks/new-workspace-form, decision 2 A): the cases of iOS's
 * `MachineSetupFullPathTests` (and the web's `MachineSetupCard.test.tsx` "a full path" block) on the logic the Android card draws, and
 * the machines the drawer's New workspace + offers (docs/mocks/new-workspace-form/02-apple-entry, owner A).
 */
class MachineSetupFullPathTest {
    private val machine = "orbit@austin"
    private val root = "/home/orbit"

    private fun probe(path: String, exists: Boolean = true, isDir: Boolean = true, isGit: Boolean = true, branch: String? = "develop",
                      error: String? = null) =
        DirProbe(path = path, exists = exists, isDir = isDir, isGit = isGit, isHome = false, branch = branch, freeBytes = 1024, error = error)

    private fun line(folder: String, found: DirProbe? = null, managedSetup: String? = null, pathHintRoot: String? = null) =
        MachineSetup.folderLine(folder, createError = null, found = found, unanswered = false, machine = machine,
            managedSetup = managedSetup, pathHintRoot = pathHintRoot)

    private fun json(raw: String): JsonObject = Wire.json.parseToJsonElement(raw).jsonObject

    // What is a full path

    @Test fun aPathStartsWithASlashOrATilde() {
        assertTrue(MachineSetup.isFolderPath("/srv/app"))
        assertTrue(MachineSetup.isFolderPath("~/code/app"))
        assertTrue(MachineSetup.isFolderPath("~"))
        assertFalse(MachineSetup.isFolderPath("app"))
        assertFalse(MachineSetup.isFolderPath("code/app"))
        assertFalse(MachineSetup.isFolderPath(""))
    }

    // The machine is asked about the path as typed

    @Test fun aFullPathIsAskedAsTyped() {
        assertEquals("/home/orbit/code/api", MachineSetup.folderQuestion("/home/orbit/code/api", root, canAsk = true))
        assertEquals("the runner expands ~, not the app", "~/nowhere", MachineSetup.folderQuestion("~/nowhere", root, canAsk = true))
    }

    @Test fun aNameIsStillAskedWhereItWouldGo() {
        assertEquals("/home/orbit/payments-api", MachineSetup.folderQuestion("payments-api", root, canAsk = true))
        assertNull("a name the server refuses", MachineSetup.folderQuestion("my app", root, canAsk = true))
        assertNull(MachineSetup.folderQuestion("", root, canAsk = true))
    }

    @Test fun nothingIsAskedWhereNothingCanBe() {
        assertNull(MachineSetup.folderQuestion("/srv/app", root, canAsk = false))
    }

    /** The relay asks exactly the question it is handed: the path as typed reaches the machine. */
    @Test fun theRelayAsksThePathItIsGiven() = runBlocking {
        val asked = MachineSetup.folderQuestion("~/code/api", root, canAsk = true)!!
        val sent = mutableListOf<String>()
        val outcome = DirProbeRelay.probe(
            ask = { sent += asked },
            read = { DirProbeAnswer(status = "done", path = asked, result = probe("/home/orbit/code/api")) },
            sleep = {},
        )
        assertEquals(listOf("~/code/api"), sent)
        assertEquals(DirProbeRelay.Outcome.Answered(probe("/home/orbit/code/api")), outcome)
    }

    // What it finds

    @Test fun anExistingRepositoryIsUsedAsItStands() {
        val found = probe("/home/orbit/code/api")
        assertEquals(MachineSetup.FolderLine.Verdict("Found · git repository · develop", FolderVerdict.Tone.OK), line("/home/orbit/code/api", found))
        val pick = MachineSetup.typedPick("/home/orbit/code/api", found, root, machine, managedSetup = null)
        assertEquals(PickedFolder.Existing("/home/orbit/code/api", "git repository · develop"), pick)
        val body = MachineSetup.createWorkspaceBody("api", "r1", pick!!)
        assertEquals("/home/orbit/code/api", body.text("workDir"))
        assertNull("nothing is made for a full path", body["newFolder"])
    }

    @Test fun aFolderThatIsNotARepositoryIsTakenWithItsWarning() {
        val found = probe("/srv/data", isGit = false, branch = null)
        assertEquals(MachineSetup.FolderLine.Verdict("Found · not a git repository — sessions will share it instead of isolating.", FolderVerdict.Tone.WARN),
            line("/srv/data", found))
        assertNotNull(MachineSetup.typedPick("/srv/data", found, root, machine, managedSetup = null))
    }

    @Test fun aMissingPathIsRefusedNeverMade() {
        val found = probe("/home/orbit/nowhere", exists = false, isDir = false, isGit = false, branch = null)
        assertEquals(MachineSetup.FolderLine.Verdict("No such directory on orbit@austin.", FolderVerdict.Tone.BAD), line("~/nowhere", found))
        assertNull(MachineSetup.typedPick("~/nowhere", found, root, machine, managedSetup = null))
        // A name with nothing there is a new folder; a path with nothing there is not.
        assertNotNull(MachineSetup.typedPick("nowhere", found, root, machine, managedSetup = null))
    }

    @Test fun aFileOrAFailedCheckIsRefused() {
        val file = probe("/srv/app.txt", exists = true, isDir = false, isGit = false, branch = null)
        assertEquals(MachineSetup.FolderLine.Verdict("That isn’t a directory on orbit@austin.", FolderVerdict.Tone.BAD), line("/srv/app.txt", file))
        assertNull(MachineSetup.typedPick("/srv/app.txt", file, root, machine, managedSetup = null))
        val failed = probe("/root/x", exists = false, isDir = false, isGit = false, branch = null, error = "permission denied")
        assertNull(MachineSetup.typedPick("/root/x", failed, root, machine, managedSetup = null))
    }

    @Test fun aPathIsNeverCalledAnInvalidName() {
        assertEquals("spaces are fine in a path: the machine is asked", MachineSetup.FolderLine.Checking, line("/srv/my app"))
    }

    @Test fun nothingIsPickedBeforeTheAnswer() {
        assertNull(MachineSetup.typedPick("/srv/app", null, root, machine, managedSetup = null))
    }

    // A managed runner that isn't up

    @Test fun aManagedRunnerNotUpRefusesAPath() {
        for (state in listOf("preparing", "asleep")) {
            assertEquals(MachineSetup.FolderLine.Meta("orbit@austin checks a full path once it’s up."), line("/srv/app", managedSetup = state))
            val pick = MachineSetup.typedPick("/srv/app", null, root, machine, managedSetup = state)
            assertNull(pick)
            // The card asks nothing of a managed runner that isn't up.
            assertNull(MachineSetup.folderQuestion("/srv/app", root, canAsk = false))
            assertFalse(MachineSetup.canCreate(pick, "app", usable = true, creating = false))
        }
    }

    @Test fun aManagedRunnerNotUpStillTakesANameUnchecked() {
        assertEquals(PickedFolder.New("app", "/home/orbit/app"), MachineSetup.typedPick("app", null, root, machine, managedSetup = "asleep"))
        assertEquals(MachineSetup.FolderLine.Meta(ManagedRunner.Setup.FOLDER_UNCHECKED.getValue("asleep")), line("app", managedSetup = "asleep"))
    }

    // The name follows the path's last segment

    @Test fun theNameFollowsTheLastSegment() {
        assertEquals("api", MachineSetup.followedName("/home/orbit/code/api"))
        assertEquals("web-app", MachineSetup.followedName("~/code/web-app/"))
        assertEquals("payments-api", MachineSetup.followedName("payments-api"))
        assertEquals("/", MachineSetup.folderName("/"))
        assertEquals("~", MachineSetup.folderName("~"))
        // The card's Name shows the followed folder until it is edited; an edit stays.
        assertEquals("app", MachineSetup.shownName(null, MachineSetup.followedName("/srv/app")))
        assertEquals("Billing", MachineSetup.shownName("Billing", MachineSetup.followedName("/srv/other")))
    }

    // The hint

    @Test fun theHintSaysAFullPathWhereTheScreenNamesTheMachine() {
        assertEquals(MachineSetup.FolderLine.Meta("A name in /home/orbit, or a full path. Uses the folder if it exists, otherwise creates it."),
            line("", pathHintRoot = "/home/orbit/"))
        assertEquals("a bare machine's card keeps its hint", MachineSetup.FolderLine.Meta("Uses this folder if it exists, otherwise creates it."), line(""))
    }

    // The machines New workspace offers, and the page it opens

    @Test fun everyMachineIsOfferedWithWhatItHolds() {
        val machines = MachineSetup.newWorkspaceMachines(
            runners = listOf(json("""{"id":"austin","name":"austin@host","online":true}"""), json("""{"id":"build","name":"build@host","online":false}""")),
            workspaces = listOf(json("""{"id":"orbit","name":"orbit","runnerId":"austin"}"""), json("""{"id":"tea","name":"tea","runnerId":"austin"}"""),
                json("""{"id":"old","name":"old","runnerId":"build","deletedAt":"2026-10-31T00:00:00Z"}""")),
        )
        assertEquals(listOf(NewWorkspaceMachine("austin", "austin@host", online = true, workspaces = 2),
            NewWorkspaceMachine("build", "build@host", online = false, workspaces = 0)), machines)
    }

    @Test fun theMenuSaysWhatEachMachineHolds() {
        assertEquals("2 workspaces", NewWorkspaceCopy.machineDetail(2, online = true))
        assertEquals("1 workspace", NewWorkspaceCopy.machineDetail(1, online = true))
        assertEquals("Offline · No workspaces yet", NewWorkspaceCopy.machineDetail(0, online = false))
    }

    /** The words are iOS's `NewWorkspaceCopy.swift`, read from the tree: a missing file fails, never skips. */
    @Test fun theNewWorkspaceWordsAreSwifts() {
        val swift = generateSequence(java.io.File(System.getProperty("user.dir"))) { it.parentFile }
            .map { java.io.File(it, "src/macos/OrbitKit/Sources/OrbitKit/App/NewWorkspaceCopy.swift") }
            .firstOrNull { it.isFile }
            .also { assertNotNull("NewWorkspaceCopy.swift was not found above the test's working directory", it) }!!
            .readText()
        assertTrue(swift.contains("""public static let NEW_WORKSPACE = "${NewWorkspaceCopy.NEW_WORKSPACE}""""))
        assertTrue(swift.contains("""public static let NEW_WORKSPACE_ON = "${NewWorkspaceCopy.NEW_WORKSPACE_ON}""""))
        assertTrue(swift.contains("""let held = workspaces == 0 ? "No workspaces yet" : workspaces == 1 ? "1 workspace" : "\(workspaces) workspaces""""))
        assertTrue(swift.contains("""return online ? held : "Offline · \(held)""""))
    }

    /** A machine with a workspace opens its page as New workspace; one with none gets the page its Set up row opens. */
    @Test fun thePageOpenedAsNewWorkspaceMakesOneMore() {
        val more = newWorkspaceRoute("austin", hasWorkspace = true, Origin.DRAWER)
        assertEquals(Destination.DRAFT, more.destination)
        assertEquals("austin", more.id)
        assertTrue(more.addsWorkspace)
        assertEquals(OrbitRoute(Destination.DRAFT, id = "build", origin = Origin.DRAWER), newWorkspaceRoute("build", hasWorkspace = false, Origin.DRAWER))
        assertFalse(OrbitRoute(Destination.DRAFT, id = "austin").addsWorkspace)
    }
}
