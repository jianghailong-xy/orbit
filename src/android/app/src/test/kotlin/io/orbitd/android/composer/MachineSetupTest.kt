package io.orbitd.android.composer

import io.orbitd.android.core.protocol.Wire
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

/**
 * The rules of a machine's first workspace, from docs/mocks/first-workspace-in-conversation/04-rules:
 * the same cases as OrbitKit `MachineSetupTests` and the web's `lib/machineSetup.test.ts`, plus empty-machine
 * detection (`machinesToSetUp`), first online machine landing (`firstOnlineRunnerId`), the waiting message
 * lifecycle (`MachineSetupState`), the directory probe relay (`DirProbeRelay`), and the `Created workspace` line.
 */
class MachineSetupTest {
    private val nowMs = 1_760_000_000_000L
    private val machine = "orbit@austin"

    private fun probe(
        path: String = "/home/orbit/code/app",
        exists: Boolean = true,
        isDir: Boolean = true,
        isGit: Boolean = true,
        branch: String? = "main",
        isHome: Boolean = false,
        error: String? = null,
    ) = DirProbe(
        path = path,
        exists = exists,
        isDir = isDir,
        isGit = isGit,
        branch = branch,
        isHome = isHome,
        freeBytes = 1024L,
        error = error,
    )

    private fun json(raw: String): JsonObject = Wire.json.parseToJsonElement(raw).jsonObject

    private fun engine(
        name: String,
        auth: String,
        installed: Boolean = true,
        authSource: String? = null,
    ): JsonObject = json(
        buildString {
            append("""{"engine":"$name","installed":$installed,"auth":"$auth"""")
            if (authSource != null) append(""","authSource":"$authSource"""")
            append("}")
        }
    )

    private fun machineRunner(engines: List<JsonObject>? = null, online: Boolean = true): JsonObject = json(
        buildString {
            append("""{"id":"r","name":"m","online":$online""")
            if (engines != null) append(""","engines":[${engines.joinToString(",")}]""")
            append("}")
        }
    )

    private fun choice(
        slug: String,
        kind: CredentialKind,
        label: String = "Key",
        unavailable: String? = null,
    ) = ProviderOption(
        id = slug,
        label = label,
        kind = kind,
        models = emptyList(),
        unavailable = unavailable,
    )

    private fun engineChoice(slug: String, providers: List<ProviderOption>) = EngineOption(
        engine = slug,
        providers = providers,
        landing = providers.firstOrNull(),
    )

    // Rule 1 & 9 & 11: empty machine detection and landing

    @Test fun onlineMachinesWithNoWorkspacesAreMachinesToSetUpAndOfflineOrPopulatedOnesAreNot() {
        val austin = json("""{"id":"r-austin","name":"orbit@austin","online":true}""")
        val mac = json("""{"id":"r-mac","name":"mac-studio","displayName":"Mac Studio","online":true}""")
        val offline = json("""{"id":"r-off","name":"spare-box","online":false}""")
        val wsOnMac = json("""{"id":"w-1","name":"orbit","runnerId":"r-mac"}""")
        val deletedOnAustin = json("""{"id":"w-del","name":"old","runnerId":"r-austin","deletedAt":"2026-10-31T00:00:00Z"}""")

        assertEquals(
            listOf(MachineToSetUp(id = "r-austin", name = "orbit@austin")),
            MachineSetup.machinesToSetUp(
                runners = listOf(austin, mac, offline),
                workspaces = listOf(wsOnMac, deletedOnAustin),
                nowMs = nowMs,
            )
        )
        assertEquals(
            listOf(
                MachineToSetUp(id = "r-austin", name = "orbit@austin"),
                MachineToSetUp(id = "r-mac", name = "Mac Studio"),
            ),
            MachineSetup.machinesToSetUp(
                runners = listOf(austin, mac, offline),
                workspaces = emptyList(),
                nowMs = nowMs,
            )
        )
    }

    @Test fun firstOnlineRunnerIdFindsTheFirstOnlineMachineOrNullWhenAllAreOffline() {
        val offline = json("""{"id":"r-off","name":"spare-box","online":false}""")
        val austin = json("""{"id":"r-austin","name":"orbit@austin","online":true}""")
        val mac = json("""{"id":"r-mac","name":"mac-studio","online":true}""")

        assertEquals("r-austin", MachineSetup.firstOnlineRunnerId(listOf(offline, austin, mac), nowMs))
        assertNull(MachineSetup.firstOnlineRunnerId(listOf(offline), nowMs))
        assertNull(MachineSetup.firstOnlineRunnerId(emptyList(), nowMs))
    }

    // Rule 2: the folder orbit register ran in is a suggestion

    @Test fun aRegisterDirIsNotAskedAboutWhenThePathAloneIsTheAnswer() {
        for (dir in listOf(null, "", "   ", "~", "/", "~/", "//", " ~ ")) {
            assertNull("$dir", MachineSetup.registerDirToProbe(dir))
        }
    }

    @Test fun aRegisterDirIsAskedAboutAsItWasReportedTidied() {
        assertEquals("/home/orbit/code/app", MachineSetup.registerDirToProbe("/home/orbit/code/app"))
        assertEquals("~/code/app", MachineSetup.registerDirToProbe(" ~/code/app/ "))
        assertEquals("relative/dir", MachineSetup.registerDirToProbe("relative/dir"))
    }

    @Test fun aFolderIsOfferedOnlyWhenItIsThereAndNeitherHomeNorTheRoot() {
        assertTrue(MachineSetup.isOfferedFolder(probe()))
        assertTrue(MachineSetup.isOfferedFolder(probe(isGit = false, branch = null)))
        assertFalse(MachineSetup.isOfferedFolder(probe(exists = false, isDir = false)))
        assertFalse(MachineSetup.isOfferedFolder(probe(isDir = false)))
        assertFalse(MachineSetup.isOfferedFolder(probe(isHome = true)))
        assertFalse(MachineSetup.isOfferedFolder(probe(path = "/")))
        assertFalse(MachineSetup.isOfferedFolder(probe(error = "permission denied")))
        assertFalse(MachineSetup.isOfferedFolder(null))
    }

    @Test fun theSuggestionIsTheDefaultOnlyWhenItIsAGitRepository() {
        assertEquals(FolderChoice.SUGGESTED, MachineSetup.defaultFolderChoice(suggested = probe(), offersNewFolder = true))
        assertEquals(FolderChoice.NEW, MachineSetup.defaultFolderChoice(suggested = probe(isGit = false), offersNewFolder = true))
        assertEquals(FolderChoice.NEW, MachineSetup.defaultFolderChoice(suggested = null, offersNewFolder = true))
    }

    @Test fun onAMachineThatCantMakeAFolderWhatIsLeftIsTheDefault() {
        assertEquals(FolderChoice.SUGGESTED, MachineSetup.defaultFolderChoice(suggested = probe(isGit = false), offersNewFolder = false))
        assertEquals(FolderChoice.OTHER, MachineSetup.defaultFolderChoice(suggested = null, offersNewFolder = false))
    }

    // What a machine declares

    @Test fun aMachineIsAskedAboutAPathOnlyIfItSaysItAnswers() {
        assertTrue(MachineSetup.answersDirProbe(json("""{"id":"r","name":"m","capabilities":["dir-probe/v1"]}""")))
        assertFalse(MachineSetup.answersDirProbe(json("""{"id":"r","name":"m","capabilities":[]}""")))
        assertFalse(MachineSetup.answersDirProbe(json("""{"id":"r","name":"m"}""")))
    }

    @Test fun aMachineMakesANewFolderOnlyIfItSaysSoAndHasReportedWhereTheyGo() {
        assertTrue(
            MachineSetup.makesNewFolders(
                json("""{"id":"r","name":"m","capabilities":["create-workdir/v1"],"reposRoot":"/home/orbit/orbit-repos"}""")
            )
        )
        assertFalse(MachineSetup.makesNewFolders(json("""{"id":"r","name":"m","capabilities":["create-workdir/v1"]}""")))
        assertFalse(
            MachineSetup.makesNewFolders(
                json("""{"id":"r","name":"m","capabilities":["create-workdir/v1"],"reposRoot":"  "}""")
            )
        )
        assertFalse(
            MachineSetup.makesNewFolders(
                json("""{"id":"r","name":"m","capabilities":[],"reposRoot":"/home/orbit/orbit-repos"}""")
            )
        )
    }

    @Test fun aMachineTooOldToAnswerGetsThereByItselfUnlessItsUpdaterSaysItCant() {
        assertTrue(MachineSetup.updatesItself(json("""{"id":"r","name":"m"}""")))
        assertTrue(MachineSetup.updatesItself(json("""{"id":"r","name":"m","selfUpdate":{"state":"enabled"}}""")))
        assertFalse(MachineSetup.updatesItself(json("""{"id":"r","name":"m","selfUpdate":{"state":"disabledByEnv"}}""")))
        assertFalse(MachineSetup.updatesItself(json("""{"id":"r","name":"m","selfUpdate":{"state":"dirNotWritable"}}""")))
    }

    /** What the server reads for a machine whose `orbit run` has not beaten yet (contract §2). */
    @Test fun approvedAndNeverHeardFromAMachineIsStillConnecting() {
        assertTrue(MachineSetup.isConnecting(json("""{"id":"r","name":"m","online":false,"lastHeartbeatAt":null,"capabilities":[]}"""), nowMs))
        assertTrue(MachineSetup.isConnecting(json("""{"id":"r","name":"m","online":false}"""), nowMs))
    }

    @Test fun heardFromOnceAMachineIsOfflineOrOnlineNeverConnecting() {
        val seen = java.time.Instant.ofEpochMilli(nowMs - 3 * 86_400_000L).toString()
        assertFalse(MachineSetup.isConnecting(json("""{"id":"r","name":"m","online":false,"lastHeartbeatAt":"$seen"}"""), nowMs))
        assertFalse(MachineSetup.isConnecting(json("""{"id":"r","name":"m","online":true,"lastHeartbeatAt":"${java.time.Instant.ofEpochMilli(nowMs)}"}"""), nowMs))
        // Online is its own heartbeat's word, whatever else the row has yet to carry.
        assertFalse(MachineSetup.isConnecting(json("""{"id":"r","name":"m","online":true,"lastHeartbeatAt":null}"""), nowMs))
    }

    /** The card's page reads its machine as often as the web's and iOS's do, and more often while it connects. */
    @Test fun theCardsPageReadsAConnectingMachineMoreOften() {
        assertEquals(2_000L, MachineSetup.refreshMs(json("""{"id":"r","name":"m","online":false,"lastHeartbeatAt":null}"""), nowMs))
        assertEquals(5_000L, MachineSetup.refreshMs(json("""{"id":"r","name":"m","online":true,"lastHeartbeatAt":"${java.time.Instant.ofEpochMilli(nowMs)}"}"""), nowMs))
        assertEquals(5_000L, MachineSetup.refreshMs(null, nowMs))
    }

    // Rule 3: a new folder

    @Test fun aNewFolderTakesTheNamesTheServerTakes() {
        for (good in listOf("app", "payments-api", "a.b_c-1", ".hidden", "x".repeat(64))) {
            assertTrue(good, MachineSetup.isValidNewFolder(good))
        }
        for (bad in listOf("", ".", "..", "a/b", "a\\b", "with space", "naïve", "~", "app\n", "x".repeat(65))) {
            assertFalse(bad, MachineSetup.isValidNewFolder(bad))
        }
    }

    @Test fun aNewFolderLandsUnderTheMachinesReposFolderHoweverThatWasReported() {
        assertEquals("/home/orbit/orbit-repos/app", MachineSetup.newFolderPath("/home/orbit/orbit-repos", "app"))
        assertEquals("/home/orbit/orbit-repos/app", MachineSetup.newFolderPath("/home/orbit/orbit-repos/", "app"))
        assertEquals("C:\\Users\\orbit\\orbit-repos\\app", MachineSetup.newFolderPath("C:\\Users\\orbit\\orbit-repos", "app"))
        assertEquals("/home/orbit/orbit-repos/", MachineSetup.newFolderPath("/home/orbit/orbit-repos", ""))
    }

    private fun inReposFolder(exists: Boolean = false, isDir: Boolean = false, isGit: Boolean = false, branch: String? = null,
                              error: String? = null) =
        probe(path = "/home/orbit/orbit-repos/app", exists = exists, isDir = isDir, isGit = isGit, branch = branch, error = error)

    @Test fun aNewFolderWithNothingThereStartsEmptyAsTheBoardSays() {
        assertEquals(
            FolderVerdict(FolderVerdict.Tone.OK, "Starts empty. Ask for a clone or a new project in your first message.",
                "new folder · created as the session starts", usable = true),
            MachineSetup.newFolderVerdict(inReposFolder(), machine),
        )
        assertEquals(
            PickedFolder.New("app", "/home/orbit/orbit-repos/app"),
            MachineSetup.newFolderPick(inReposFolder(), "app", "/home/orbit/orbit-repos", machine),
        )
    }

    @Test fun aNewFolderThatIsThereAlreadyIsUsedWithWhatIsInItAsThatFolder() {
        val there = inReposFolder(exists = true, isDir = true, isGit = true, branch = "main")
        assertEquals(
            FolderVerdict(FolderVerdict.Tone.WARN, "This folder already exists on orbit@austin. Sessions will use what’s in it.",
                "git repository · main", usable = true),
            MachineSetup.newFolderVerdict(there, machine),
        )
        assertEquals(
            PickedFolder.Existing("/home/orbit/orbit-repos/app", "git repository · main"),
            MachineSetup.newFolderPick(there, "app", "/home/orbit/orbit-repos", machine),
        )
        assertEquals(
            "not a git repository — sessions will share it instead of isolating.",
            MachineSetup.newFolderVerdict(inReposFolder(exists = true, isDir = true), machine).short,
        )
    }

    @Test fun aNewFolderOverAFileCantBeAndSaysWhy() {
        val file = inReposFolder(exists = true)
        val text = "There’s already a file with this name on orbit@austin. Pick another name."
        assertEquals(FolderVerdict(FolderVerdict.Tone.BAD, text, text, usable = false), MachineSetup.newFolderVerdict(file, machine))
        assertNull(MachineSetup.newFolderPick(file, "app", "/home/orbit/orbit-repos", machine))
    }

    @Test fun aNewFolderTheRunnerCouldNotLookAtHasNothingToPick() {
        val failed = inReposFolder(error = "permission denied")
        assertEquals("Couldn’t check on orbit@austin: permission denied", MachineSetup.newFolderVerdict(failed, machine).text)
        assertNull(MachineSetup.newFolderPick(failed, "app", "/home/orbit/orbit-repos", machine))
    }

    // Rule 4: how a checked path reads

    @Test fun aGitRepositoryNamesItsBranch() {
        assertEquals(
            FolderVerdict(
                tone = FolderVerdict.Tone.OK,
                text = "Found · git repository · main",
                short = "git repository · main",
                usable = true,
            ),
            MachineSetup.folderVerdict(probe(), machine = machine)
        )
    }

    @Test fun aDetachedHeadHasNoBranchToName() {
        assertEquals("Found · git repository", MachineSetup.folderVerdict(probe(branch = null), machine = machine).text)
    }

    @Test fun aFolderThatIsNoRepositoryCanBeUsedAndSaysWhatThatCosts() {
        assertEquals(
            FolderVerdict(
                tone = FolderVerdict.Tone.WARN,
                text = "Found · not a git repository — sessions will share it instead of isolating.",
                short = "not a git repository — sessions will share it instead of isolating.",
                usable = true,
            ),
            MachineSetup.folderVerdict(probe(isGit = false, branch = null), machine = machine)
        )
    }

    @Test fun whatIsntThereCantBeUsed() {
        val verdict = MachineSetup.folderVerdict(probe(exists = false, isDir = false, isGit = false), machine = machine)
        assertEquals(FolderVerdict.Tone.BAD, verdict.tone)
        assertEquals("No such directory on orbit@austin.", verdict.text)
        assertFalse(verdict.usable)
    }

    @Test fun norAFileNorAPathTheRunnerCouldNotLookAt() {
        val file = MachineSetup.folderVerdict(probe(isDir = false, isGit = false), machine = machine)
        assertEquals("That isn’t a directory on orbit@austin.", file.text)
        assertFalse(file.usable)
        val refused = MachineSetup.folderVerdict(probe(exists = false, error = "permission denied"), machine = machine)
        assertEquals("Couldn’t check on orbit@austin: permission denied", refused.text)
        assertFalse(refused.usable)
    }

    // What POST /sessions is told

    @Test fun aNewFolderGoesByItsNameAnExistingOneByThePathTheRunnerResolved() {
        assertEquals(
            NewWorkspaceRequest(newFolder = "app"),
            PickedFolder.New(name = "app", path = "/home/orbit/orbit-repos/app").newWorkspace
        )
        assertEquals(
            NewWorkspaceRequest(workDir = "/home/orbit/code/app"),
            PickedFolder.Existing(path = "/home/orbit/code/app", note = "").newWorkspace
        )
    }

    @Test fun theWorkspaceNameAFolderGivesAsTheServerDerivesIt() {
        assertEquals("app", MachineSetup.folderName("/home/orbit/code/app"))
        assertEquals("app", MachineSetup.folderName("/home/orbit/code/app/"))
        assertEquals("app", MachineSetup.folderName("C:\\work\\app"))
        assertEquals("/", MachineSetup.folderName("/"))
        assertEquals("app", PickedFolder.Existing(path = "/home/orbit/code/app", note = "").workspaceName)
        assertEquals("payments", PickedFolder.New(name = "payments", path = "/r/payments").workspaceName)
    }

    // Which engine a machine's first draft starts on

    @Test fun oneSignedInBeforeOneThatIsnt() {
        assertEquals("codex", MachineSetup.firstEngineOn(machineRunner(listOf(engine("claude", "no"), engine("codex", "yes")))))
    }

    @Test fun elseTheFirstItHas() {
        assertEquals("codex", MachineSetup.firstEngineOn(machineRunner(listOf(engine("claude", "no", installed = false), engine("codex", "no")))))
        assertEquals("claude", MachineSetup.firstEngineOn(machineRunner(listOf(engine("codex", "no"), engine("claude", "no")))))
    }

    @Test fun elseClaudeCodeOnAMachineThatHasSaidNothing() {
        assertEquals("claude", MachineSetup.firstEngineOn(machineRunner(null)))
        assertEquals("claude", MachineSetup.firstEngineOn(machineRunner(emptyList())))
    }

    @Test fun onlyWhatSignsInCounts() {
        assertEquals(
            listOf("codex"),
            MachineSetup.installedLogins(
                machineRunner(listOf(engine("opencode", "unknown"), engine("codex", "no"), engine("kimi", "no", installed = false)))
            )
        )
    }

    @Test fun anAnswerOfUnknownIsNotAYes() {
        assertEquals("claude", MachineSetup.firstEngineOn(machineRunner(listOf(engine("claude", "unknown"), engine("codex", "unknown")))))
    }

    // Rule 5: the second step

    @Test fun theStepFollowsTheDraftsEngine() {
        val row = machineRunner(listOf(engine("claude", "no"), engine("codex", "yes")))
        assertEquals(
            SetupCredential.SignIn,
            MachineSetup.credential(runner = row, engine = "claude", provider = choice("claude", CredentialKind.LOGIN))
        )
        assertEquals(
            SetupCredential.SignedIn,
            MachineSetup.credential(runner = row, engine = "codex", provider = choice("codex", CredentialKind.LOGIN))
        )
    }

    @Test fun aKeyOrAPoolHasNothingToSignInOnThisMachine() {
        val row = machineRunner(listOf(engine("claude", "no")))
        assertEquals(
            SetupCredential.OnKey(label = "DeepSeek", pool = false),
            MachineSetup.credential(runner = row, engine = "claude", provider = choice("deepseek", CredentialKind.KEY, label = "DeepSeek"))
        )
        assertEquals(
            SetupCredential.OnKey(label = "Team", pool = true),
            MachineSetup.credential(runner = row, engine = "claude", provider = choice("team", CredentialKind.POOL, label = "Team"))
        )
    }

    @Test fun anEngineTheMachineDoesntHaveCantBeSignedIn() {
        assertEquals(
            SetupCredential.NotInstalled,
            MachineSetup.credential(runner = machineRunner(listOf(engine("claude", "no"))), engine = "codex", provider = null)
        )
        assertEquals(
            SetupCredential.NotInstalled,
            MachineSetup.credential(runner = machineRunner(listOf(engine("codex", "no", installed = false))), engine = "codex", provider = null)
        )
    }

    @Test fun nothingReportedIsNotNothingInstalled() {
        assertEquals(
            SetupCredential.SignIn,
            MachineSetup.credential(runner = machineRunner(null), engine = "claude", provider = null)
        )
    }

    @Test fun antigravityOnAMachinesKeyIsNotASignIn() {
        val key = machineRunner(listOf(engine("antigravity", "yes", authSource = "env")))
        assertEquals(SetupCredential.SignIn, MachineSetup.credential(runner = key, engine = "antigravity", provider = null))
        val google = machineRunner(listOf(engine("antigravity", "yes", authSource = "google")))
        assertEquals(SetupCredential.SignedIn, MachineSetup.credential(runner = google, engine = "antigravity", provider = null))
    }

    @Test fun readyIsBothStepsAndTheMachineHere() {
        val folder = PickedFolder.New(name = "app", path = "/r/app")
        assertTrue(MachineSetup.isReady(bare = true, folder = folder, online = true, credential = SetupCredential.SignedIn))
        assertTrue(MachineSetup.isReady(bare = true, folder = folder, online = true, credential = SetupCredential.OnKey("k", pool = false)))
        assertFalse(MachineSetup.isReady(bare = true, folder = null, online = true, credential = SetupCredential.SignedIn))
        assertFalse(MachineSetup.isReady(bare = true, folder = folder, online = true, credential = SetupCredential.SignIn))
        assertFalse(MachineSetup.isReady(bare = true, folder = folder, online = true, credential = SetupCredential.NotInstalled))
        assertFalse(MachineSetup.isReady(bare = true, folder = folder, online = false, credential = SetupCredential.SignedIn))
        assertFalse(MachineSetup.isReady(bare = false, folder = folder, online = true, credential = SetupCredential.SignedIn))
    }

    @Test fun useXInsteadIsTheOtherSignInsInstalledHere() {
        val row = machineRunner(
            listOf(
                engine("claude", "no"),
                engine("codex", "no"),
                engine("kimi", "no", installed = false),
                engine("opencode", "unknown"),
            )
        )
        assertEquals(listOf("codex"), MachineSetup.otherEngines(runner = row, engine = "claude", fleet = listOf(row)))
        assertEquals(listOf("claude"), MachineSetup.otherEngines(runner = row, engine = "codex", fleet = listOf(row)))
    }

    @Test fun cursorIsOfferedOnlyOnceTheFleetKnowsIt() {
        val row = machineRunner(listOf(engine("claude", "no"), engine("cursor", "no")))
        val older = machineRunner(listOf(engine("claude", "no")))
        assertEquals(listOf("cursor"), MachineSetup.otherEngines(runner = row, engine = "claude", fleet = listOf(row)))
        assertEquals(emptyList<String>(), MachineSetup.otherEngines(runner = row, engine = "claude", fleet = listOf(older)))
    }

    @Test fun useAnApiKeyLandsOnAKeyThatCanRunTheDraftsEngineFirst() {
        val claude = engineChoice("claude", listOf(choice("claude", CredentialKind.LOGIN), choice("deepseek", CredentialKind.KEY)))
        val codex = engineChoice("codex", listOf(choice("codex", CredentialKind.LOGIN), choice("team", CredentialKind.POOL)))
        assertEquals(EnginePick("codex", "team"), MachineSetup.firstKey(engines = listOf(claude, codex), preferring = "codex"))
        assertEquals(EnginePick("claude", "deepseek"), MachineSetup.firstKey(engines = listOf(claude, codex), preferring = "claude"))
        assertEquals(EnginePick("claude", "deepseek"), MachineSetup.firstKey(engines = listOf(claude, codex), preferring = "kimi"))
    }

    @Test fun aKeyThatCantRunHereIsNotOffered() {
        val spent = choice("deepseek", CredentialKind.KEY, unavailable = "No")
        assertNull(MachineSetup.firstKey(engines = listOf(engineChoice("claude", listOf(choice("claude", CredentialKind.LOGIN), spent))), preferring = "claude"))
        assertNull(MachineSetup.firstKey(engines = emptyList(), preferring = "claude"))
    }

    // Rule 6: the message waiting

    private val pickedFolder = PickedFolder.Existing(path = "/home/orbit/code/app", note = "git repository · main")
    private val heldMessage = HeldMessage(content = "Fix the flaky login test")

    @Test fun readyTheSendMakesTheWorkspace() {
        val state = MachineSetupState(folder = pickedFolder)
        assertEquals(
            MachineSend.Create(NewWorkspaceRequest(workDir = "/home/orbit/code/app")),
            state.send(bare = true, ready = true)
        )
    }

    @Test fun notReadyTheMessageWaits() {
        assertEquals(MachineSend.Hold, MachineSetupState().send(bare = true, ready = false))
        assertEquals(MachineSend.Hold, MachineSetupState(folder = pickedFolder).send(bare = true, ready = false))
    }

    @Test fun oneWaitsAtATime() {
        assertEquals(MachineSend.AlreadyWaiting, MachineSetupState(folder = pickedFolder, held = heldMessage).send(bare = true, ready = true))
        assertEquals(MachineSend.AlreadyWaiting, MachineSetupState(held = heldMessage).send(bare = true, ready = false))
    }

    @Test fun aMachineNotKnownToBeBareSendsNothing() {
        assertEquals(MachineSend.Nothing, MachineSetupState(folder = pickedFolder).send(bare = false, ready = false))
    }

    @Test fun bothStepsDoneItGoesWithNobodyPressingAnythingOnce() {
        val state = MachineSetupState(folder = pickedFolder, held = heldMessage)
        val result = state.takeHeldToSend(ready = true, busy = false)
        assertNotNull(result)
        val (next, taken) = result!!
        assertEquals(heldMessage, taken.first)
        assertEquals(NewWorkspaceRequest(workDir = "/home/orbit/code/app"), taken.second)
        assertTrue(next.sendingHeld)
        assertNull("a send makes a workspace: it must not go twice", next.takeHeldToSend(ready = true, busy = false))
    }

    @Test fun itWaitsForTheStepsAndForASendAlreadyOut() {
        val state = MachineSetupState(folder = pickedFolder, held = heldMessage)
        assertNull(state.takeHeldToSend(ready = false, busy = false))
        assertNull(state.takeHeldToSend(ready = true, busy = true))
        assertNull(MachineSetupState(held = heldMessage).takeHeldToSend(ready = true, busy = false))
        assertNull(MachineSetupState(folder = pickedFolder).takeHeldToSend(ready = true, busy = false))
        assertFalse(state.sendingHeld)
    }

    @Test fun aRefusalStaysSayingWhyUntilItIsTriedAgain() {
        val state = MachineSetupState(folder = pickedFolder, held = heldMessage)
        val (sending, _) = state.takeHeldToSend(ready = true, busy = false)!!
        val failed = sending.failHeld("Claude Code isn’t signed in")
        assertEquals("Claude Code isn’t signed in", failed.held?.error)
        assertFalse(failed.sendingHeld)
        assertNull("it waits on the person, not on another try", failed.takeHeldToSend(ready = true, busy = false))

        val retried = failed.retryHeld()
        assertNull(retried.held?.error)
        assertEquals(heldMessage, retried.takeHeldToSend(ready = true, busy = false)?.second?.first)
    }

    @Test fun withdrawnItComesBackAndNothingIsLeftWaiting() {
        val state = MachineSetupState(folder = pickedFolder, held = heldMessage)
        val (next, withdrawn) = state.withdraw()
        assertEquals(heldMessage, withdrawn)
        assertNull(next.held)
        assertEquals("the folder stays answered", pickedFolder, next.folder)
        assertNull(next.withdraw().second)
    }

    @Test fun aMessageOnItsWayCantBeWithdrawn() {
        val state = MachineSetupState(folder = pickedFolder, held = heldMessage)
        val (sending, _) = state.takeHeldToSend(ready = true, busy = false)!!
        assertNull(sending.withdraw().second)
        assertEquals(heldMessage, sending.held)
    }

    @Test fun aMessageAlreadyRefusedCanBeWithdrawn() {
        val state = MachineSetupState(folder = pickedFolder, held = heldMessage)
        val (sending, _) = state.takeHeldToSend(ready = true, busy = false)!!
        val failed = sending.failHeld("no")
        assertEquals(heldMessage.content, failed.withdraw().second?.content)
    }

    @Test fun changingTheFolderKeepsTheMessageWaiting() {
        val state = MachineSetupState(folder = pickedFolder, held = heldMessage).pick(null)
        assertNull(state.folder)
        assertEquals(heldMessage, state.held)
        assertNull("no folder, nothing to send it with", state.takeHeldToSend(ready = true, busy = false))
    }

    @Test fun aMachineWithAWorkspaceHasNothingLeftToRemember() {
        val state = MachineSetupState(folder = pickedFolder, held = heldMessage).finish()
        assertEquals(MachineSetupState(), state)
    }

    // The directory probe relay

    private class Script(answers: List<DirProbeAnswer>) {
        val answers = answers.toMutableList()
        var asked = 0
        var reads = 0
        val slept = mutableListOf<Long>()
        var clock = 0L

        fun read(): DirProbeAnswer {
            reads += 1
            return if (answers.size > 1) answers.removeAt(0) else answers[0]
        }

        fun sleep(ms: Long) {
            slept += ms
            clock += ms
        }
    }

    private fun runScript(script: Script, asks: Boolean = true): DirProbeRelay.Outcome = runBlocking {
        DirProbeRelay.probe(
            ask = if (asks) { { script.asked += 1 } } else null,
            read = { script.read() },
            sleep = { script.sleep(it) },
            nowMs = { script.clock },
        )
    }

    @Test fun itAsksThenReadsUntilTheRunnerAnswers() {
        val result = probe()
        val script = Script(
            listOf(
                DirProbeAnswer(path = "p", status = "pending"),
                DirProbeAnswer(path = "p", status = "pending"),
                DirProbeAnswer(path = "p", status = "done", result = result),
            )
        )
        val outcome = runScript(script)
        assertEquals(DirProbeRelay.Outcome.Answered(result), outcome)
        assertEquals(1, script.asked)
        assertEquals(3, script.reads)
        assertEquals(listOf(DirProbeRelay.POLL_MS, DirProbeRelay.POLL_MS), script.slept)
    }

    @Test fun anOfflineMachineIsReadNotAsked() {
        val result = probe()
        val script = Script(listOf(DirProbeAnswer(path = "p", status = "done", result = result)))
        val outcome = runScript(script, asks = false)
        assertEquals(DirProbeRelay.Outcome.Answered(result), outcome)
        assertEquals(0, script.asked)
    }

    @Test fun aReplacedQuestionHasNothingMoreToWaitFor() {
        val script = Script(listOf(DirProbeAnswer(path = "p", status = "pending"), DirProbeAnswer(path = "p", status = "idle")))
        val outcome = runScript(script)
        assertEquals(DirProbeRelay.Outcome.Replaced, outcome)
    }

    /**
     * One question at a time per machine: the register directory's, replaced by a path asked before it was answered, is asked again
     * once nothing else waits, and only while the machine can be asked.
     */
    @Test fun aReplacedRegisterQuestionIsAskedAgainOnceNothingElseWaits() {
        assertTrue(DirProbeRelay.asksAgain(DirProbeRelay.Outcome.Replaced, online = true, otherWaiting = false))
        assertFalse(DirProbeRelay.asksAgain(DirProbeRelay.Outcome.Replaced, online = true, otherWaiting = true))
        assertFalse("offline, what is stored is all", DirProbeRelay.asksAgain(DirProbeRelay.Outcome.Replaced, online = false, otherWaiting = false))
        assertFalse("still asking", DirProbeRelay.asksAgain(null, online = true, otherWaiting = false))
        assertFalse(DirProbeRelay.asksAgain(DirProbeRelay.Outcome.Unanswered, online = true, otherWaiting = false))
        assertFalse(DirProbeRelay.asksAgain(DirProbeRelay.Outcome.Answered(probe()), online = true, otherWaiting = false))
    }

    @Test fun aMachineThatNeverAnswersIsSaidToHaveNot() {
        val script = Script(listOf(DirProbeAnswer(path = "p", status = "pending")))
        val outcome = runScript(script)
        assertEquals(DirProbeRelay.Outcome.Unanswered, outcome)
        assertTrue(script.clock >= DirProbeRelay.WAIT_MS)
    }

    // Rule 8: the line a created workspace opens with

    @Test fun createdWorkspaceLineReadsFromSessionDetail() {
        val runners = listOf(json("""{"id":"r-1","name":"orbit@austin"}"""))
        val workspaces = listOf(json("""{"id":"w-1","name":"app","workDir":"/home/orbit/code/app","runnerId":"r-1"}"""))
        val detail = json(
            """{"id":"s","status":"RUNNING","createdWorkspace":true,"agent":{"id":"w-1","name":"app","workDir":"/home/orbit/code/app","runnerId":"r-1","deletedAt":null}}"""
        )
        assertEquals(
            CreatedWorkspaceLine(
                workspaceId = "w-1",
                name = "app",
                machine = "orbit@austin",
                path = "/home/orbit/code/app",
                live = true,
            ),
            CreatedWorkspaceLine.fromSession(detail, runners, workspaces)
        )

        val deleted = json(
            """{"id":"s","status":"RUNNING","createdWorkspace":true,"agent":{"id":"w-1","name":"app","workDir":"/home/orbit/code/app","runnerId":"r-1","deletedAt":"2026-10-31T00:00:00Z"}}"""
        )
        assertEquals(
            CreatedWorkspaceLine(
                workspaceId = "w-1",
                name = "app",
                machine = "orbit@austin",
                path = "/home/orbit/code/app",
                live = false,
            ),
            CreatedWorkspaceLine.fromSession(deleted, runners, emptyList())
        )

        assertNull(CreatedWorkspaceLine.fromSession(json("""{"id":"s","status":"RUNNING"}"""), runners, workspaces))
        assertNull(CreatedWorkspaceLine.fromSession(json("""{"id":"s","status":"RUNNING","createdWorkspace":false}"""), runners, workspaces))
    }
}
