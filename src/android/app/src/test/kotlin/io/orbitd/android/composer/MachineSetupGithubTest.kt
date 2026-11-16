package io.orbitd.android.composer

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

/** From GitHub's rules (docs/github-workspace-design.md §5.3, §8): the cases of web's `lib/machineSetup.test.ts` and OrbitKit's. */
class MachineSetupGithubTest {
    private fun json(raw: String): JsonObject = Wire.json.parseToJsonElement(raw).jsonObject

    private val repo = GithubRepository(id = 77, fullName = "orbit-labs/orbit-web", private = true, defaultBranch = "main", installationId = 9)
    private fun probe(exists: Boolean, error: String? = null) =
        DirProbe(path = "/Users/austin/orbit-repos/orbit-web", exists = exists, isDir = exists, isGit = false, isHome = false, error = error)

    @Test fun aMachineClonesWithTheCapabilityAndAReposFolder() {
        assertTrue(MachineSetup.clonesRepositories(json("""{"capabilities":["clone-workdir/v1"],"reposRoot":"/r"}""")))
        assertFalse(MachineSetup.clonesRepositories(json("""{"capabilities":["clone-workdir/v1"],"reposRoot":"  "}""")))
        assertFalse(MachineSetup.clonesRepositories(json("""{"capabilities":["create-workdir/v1"],"reposRoot":"/r"}""")))
        assertFalse(MachineSetup.clonesRepositories(json("""{"reposRoot":"/r"}""")))
    }

    @Test fun homeIsWrittenAsTilde() {
        assertEquals("~/orbit-repos/x", MachineSetup.homeShortPath("/Users/austin/orbit-repos/x"))
        assertEquals("~/orbit-repos/x", MachineSetup.homeShortPath("/home/orbit/orbit-repos/x"))
        assertEquals("~/x", MachineSetup.homeShortPath("/root/x"))
        assertEquals("~", MachineSetup.homeShortPath("/root"))
        assertEquals("/rootless/x", MachineSetup.homeShortPath("/rootless/x"))
        assertEquals("/srv/repos/x", MachineSetup.homeShortPath("/srv/repos/x"))
        assertEquals("/Users", MachineSetup.homeShortPath("/Users"))
    }

    @Test fun theDefaultFolderIsTheRepositorysNameWhenThatIsAFolderName() {
        assertEquals("orbit-web", MachineSetup.repositoryFolder("orbit-labs/orbit-web"))
        assertEquals("a.b_c", MachineSetup.repositoryFolder("o/a.b_c"))
        assertEquals("", MachineSetup.repositoryFolder("o/.."))
    }

    @Test fun theRefIsWhatWasTypedUnlessItIsTheDefault() {
        assertNull(MachineSetup.cloneRef(null, "main"))
        assertNull(MachineSetup.cloneRef("  ", "main"))
        assertNull(MachineSetup.cloneRef(" main ", "main"))
        assertEquals("dev", MachineSetup.cloneRef(" dev ", "main"))
    }

    @Test fun onlyAFolderTheMachineSaysIsNotThereCanBePicked() {
        assertNull("no answer yet", MachineSetup.githubPick(repo, "orbit-web", null, "/Users/austin/orbit-repos", null))
        assertNull("already there", MachineSetup.githubPick(repo, "orbit-web", null, "/Users/austin/orbit-repos", probe(exists = true)))
        assertNull("couldn't check", MachineSetup.githubPick(repo, "orbit-web", null, "/Users/austin/orbit-repos", probe(false, "denied")))
        assertNull("not a folder name", MachineSetup.githubPick(repo, "a/b", null, "/Users/austin/orbit-repos", probe(exists = false)))
        val picked = MachineSetup.githubPick(repo, "orbit-web", "dev", "/Users/austin/orbit-repos/", probe(exists = false))
        assertEquals(
            PickedFolder.Github(GithubPick(77, "orbit-labs/orbit-web", true, "main", "dev", "orbit-web", "/Users/austin/orbit-repos/orbit-web")),
            picked,
        )
    }

    @Test fun theRequestCarriesTheRepositoryTheFolderAndARefOnlyWhenOneWasAsked() {
        val withRef = PickedFolder.Github(GithubPick(77, "o/r", false, "main", "dev", "r", "/x/r"))
        assertEquals(json("""{"github":{"repoId":77,"folder":"r","ref":"dev"}}"""), withRef.newWorkspace.toJson())
        val noRef = PickedFolder.Github(GithubPick(77, "o/r", false, "main", null, "r", "/x/r"))
        assertEquals(json("""{"github":{"repoId":77,"folder":"r"}}"""), noRef.newWorkspace.toJson())
        assertEquals(json("""{"newFolder":"r"}"""), PickedFolder.New("r", "/x/r").newWorkspace.toJson())
        assertEquals(MachineSend.Create(noRef.newWorkspace), MachineSetupState(folder = noRef).send(bare = true, ready = true))
    }

    @Test fun aPickedCloneSaysWhereItGoesAndWhatHappensAsItStarts() {
        val picked = PickedFolder.Github(GithubPick(77, "orbit-labs/orbit-web", false, "main", null, "orbit-web",
            "/Users/austin/orbit-repos/orbit-web"))
        assertEquals("orbit-labs/orbit-web → ~/orbit-repos/orbit-web", picked.doneLine)
        assertEquals(MachineSetupCopy.SETUP_GITHUB_DONE, picked.doneNote)
        assertEquals("orbit-web", picked.workspaceName)
        assertEquals(
            "Ready. Send a task — Orbit clones orbit-labs/orbit-web into ~/orbit-repos/orbit-web and adds the workspace “orbit-web” as it starts.",
            picked.readySentence,
        )
        val folder = PickedFolder.New("x", "/r/x")
        assertEquals("/r/x", folder.doneLine)
        assertEquals(MachineSetupCopy.setupReady("x", "/r/x"), folder.readySentence)
    }

    @Test fun theCreatedLineReadsTheClonesFields() {
        val detail = json("""{"createdWorkspace":true,"assignedRunnerId":"r1","runnerName":"mac",
            "agent":{"id":"w1","name":"orbit-web","workDir":"/Users/a/orbit-repos/orbit-web",
              "repoUrl":"https://github.com/orbit-labs/orbit-web.git","cloneState":"FAILED","cloneError":"git said no"}}""")
        val line = CreatedWorkspaceLine.fromSession(detail, emptyList())!!
        assertEquals("orbit-labs/orbit-web", line.repository)
        assertEquals("FAILED", line.cloneState)
        assertEquals("git said no", line.cloneError)
        val plain = CreatedWorkspaceLine.fromSession(json("""{"createdWorkspace":true,"runnerName":"mac","agent":{"id":"w1","name":"x"}}"""), emptyList())!!
        assertNull(plain.repository)
        assertNull(plain.cloneState)
    }

    @Test fun theIntegrationIsReadWithWhatAnOlderServerLeavesOut() {
        val view = GithubIntegration.fromJson(json("""{"available":true,"connected":true,"login":"ada","connectedAt":null,
            "needsReconnect":false,"installations":[{"id":7,"account":"ada","type":"User","repositorySelection":"selected","repositoryCount":3},
            {"id":9,"account":"orbit-labs","type":"Organization","repositorySelection":"all","repositoryCount":11}],
            "installUrl":"https://github.com/apps/orbit/installations/new","workspaceCount":2}"""))
        assertTrue(view.usable)
        assertEquals(14, view.repositoryCount)
        assertNull(view.workspaces)
        val unasked = GithubIntegration.fromJson(json("""{"available":true,"connected":true,"needsReconnect":true,"installations":null}"""))
        assertNull(unasked.repositoryCount)
        assertFalse(unasked.usable)
        assertEquals("orbit-labs/", repo.owner)
        assertEquals("orbit-web", repo.name)
    }
}
