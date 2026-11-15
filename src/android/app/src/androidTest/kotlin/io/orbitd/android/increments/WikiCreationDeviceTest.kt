package io.orbitd.android.increments

import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The ways to another wiki and the WIKI_CREATE card (docs/wiki-explicit-creation-design.md §3.4, §3.6; board 46 parts 3-5) on a device,
 * over the test's own fixture: an account with three wikis, four workspaces on three repositories — one of which (github.com/sample/orbit)
 * has a wiki — one runner offline, and an agent's open WIKI_CREATE request for lfs-builder. Each journey leaves the screenshot set beside
 * the board: the drawer's New wiki… row (4 ②), the head picker's New wiki… item (4 ③), the Create wiki form with the repository that has
 * a wiki greyed under Has a wiki (5), and the card with Create wiki, Change settings… and Not for this repository (3).
 */
@RunWith(AndroidJUnit4::class)
class WikiCreationDeviceTest : IncrementDeviceTest() {
    private val wsDevelop = "34NwWikiWsOrbitDev0001"
    private val wsProd = "34NwWikiWsOrbitPrd0001"
    private val wsLfs = "34NwWikiWsLfsBuilder01"
    private val wsInfra = "34NwWikiWsInfraScrpt01"
    private val runnerOff = "34NwWikiRunnerOffline1"
    private val session = "34NwWikiSessionLfs0001"
    private val request = "34NwWikiReqLfsBuilder1"
    private val spaces = listOf("34NwWikiSpaceOrbit0001" to "orbit", "34NwWikiSpaceDocsSite01" to "docs-site", "34NwWikiSpaceBilling001" to "billing-service")
    override val ids get() = listOf(workspace, runner, wsDevelop, wsProd, wsLfs, wsInfra, runnerOff, session, request) + spaces.map { it.first }

    private fun ws(id: String, name: String, runnerId: String, repoUrl: String, position: Int) = """{"id":"$id","name":"$name","runnerId":"$runnerId",
        "enabled":true,"position":$position,"provider":"claude","model":"claude-opus-5-5","repoUrl":"$repoUrl","createdAt":"2026-10-01T01:00:00.000Z"}"""
    private fun workspaces() = listOf(ws(wsDevelop, "orbit-develop", runner, "https://github.com/sample/orbit.git", 0),
        ws(wsProd, "orbit-prod", runner, "git@github.com:sample/orbit.git", 1), ws(wsLfs, "lfs", runner, "https://github.com/sample/lfs-builder", 2),
        ws(wsInfra, "infra", runnerOff, "https://github.com/sample/infra-scripts", 3)).joinToString(",", "[", "]")
    private fun runners() = """[{"id":"$runner","name":"build-01","online":true,"status":"ONLINE","version":"0.1.262",
        "engines":[{"engine":"claude","installed":true,"auth":"yes"}],"modelCatalog":{"claude":[{"value":"claude-opus-5-5","label":"Opus 5.5"}]}},
        {"id":"$runnerOff","name":"build-02","online":false,"status":"OFFLINE","version":"0.1.262","engines":[],"modelCatalog":{}}]"""

    private fun spaceRow(id: String, slug: String) = """{"id":"$id","publicId":"$id","slug":"$slug","title":"$slug",
        "repoUrlNorm":"github.com/sample/$slug","rootCommitSha":null,"pendingOps":0,"planWaiting":0,"workspaceIds":[],"docs":null,
        "createdAt":"2026-09-01T00:00:00.000Z","updatedAt":"2026-09-25T09:00:00.000Z",
        "settings":{"reviewMode":"automatic","automaticSpotChecks":false,"push":true,"autoAcceptReinforce":true,
        "maintenance":{"enabled":true,"workspaceId":"$wsDevelop","dailyRunLimit":8,"lookbackDays":14}}}"""

    private val why = "You asked for one here. I'd start it with what we found about the WireGuard config, then keep it up to date " +
        "from this repository's sessions."
    private fun requestJson() = """{"id":"$request","kind":"WIKI_CREATE","state":"PENDING","title":"Create a wiki for lfs-builder?",
        "why":${quote(why)},"blocksTaskIds":[],"ifUnanswered":null,"options":null,"recommendedOption":null,"steps":null,"secretSpec":null,
        "secretScope":null,"secretGrant":null,"verifyHint":null,"repoUrlNorm":"github.com/sample/lfs-builder","workspaceId":"$wsLfs",
        "expiresAt":null,"askedBySessionId":"$session","projectId":null,"resolvedAt":null,"resolvedByUserId":null,"resolvedBySessionId":null,
        "resolutionNote":null,"answer":null,"createdAt":"${ago(0)}"}"""

    override fun answer(req: Req): MockResponse? {
        val p = req.parts
        val space = spaces.firstOrNull { p.size >= 3 && p[0] == "wiki" && p[1] == "spaces" && p[2] == it.first }
        return when {
            req.path == "workspaces" -> json(workspaces())
            req.path == "runners" -> json(runners())
            req.path == "owner-requests" -> json(if (req.q("state") in setOf("open", "all", null)) """{"requests":[${requestJson()}]}""" else """{"requests":[]}""")
            req.path == "owner-requests/$request" -> json(requestJson())
            req.path == "link-previews" -> json("""{"previews":[]}""")
            req.path == "wiki/spaces" && req.method == "GET" -> json(spaces.joinToString(",", "[", "]") { spaceRow(it.first, it.second) })
            req.path == "wiki/trash" -> json("""{"spaces":[]}""")
            req.path == "wiki/system-model" -> json("""{"message":"not found"}""", 404)
            req.path == "wiki/search" -> json("""{"q":"","hits":[]}""")
            req.path == "wiki/review" -> json("[]")
            space != null && p.size == 3 -> json(spaceRow(space.first, space.second))
            space != null && p[3] == "entries" -> json("[]")
            space != null && p[3] == "timeline" -> json("""{"items":[]}""")
            space != null && p[3] == "health" -> json("""{"spaceId":"${space.first}","entries":40,"maintenance":{"look":"ok","enabled":true,"backlog":0},
                "repo":{"look":"ready","pending":0}}""")
            space != null && p[3] == "plan" && p.size == 4 -> json("""{"spaceId":"${space.first}","confirmed":null,"draft":null,"proposals":[],"job":null}""")
            space != null && p[3] == "plan" -> json("""{"spaceId":"${space.first}","versions":[]}""")
            space != null && p[3] == "share" -> json("""{"message":"not found"}""", 404)
            p[0] == "wiki" -> json("""{"message":"not found"}""", 404)
            else -> null
        }
    }

    private fun openDrawer() {
        compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
        await("the drawer's Wiki row") { exists(hasText("Wiki") and hasClickAction()) }
    }

    /** The form's workspace menu, open: the repository with a wiki greyed under Has a wiki, its workspaces not pickable. */
    private fun verifyTheFormGreysTheRepositoryWithAWiki() {
        await("the Create wiki form") { exists(hasTestTag("wiki-settings-form")) }
        await("the workspaces read") { exists(hasTestTag("wiki-settings-workspace")) && !says("wiki-settings-workspace", "No workspace") }
        compose.onNodeWithTag("wiki-settings-workspace").performClick()
        await("the workspace menu") { exists(hasTestTag("wiki-settings-workspace:$wsLfs"), unmerged = true) }
        verify("the repository with a wiki is tagged Has a wiki", says("wiki-settings-group:github.com/sample/orbit", "Has a wiki"))
        verify("the others are not", !says("wiki-settings-group:github.com/sample/lfs-builder", "Has a wiki"))
        listOf(wsDevelop, wsProd).forEach { id ->
            verify("$id cannot be picked", compose.onAllNodesWithTag("wiki-settings-workspace:$id", useUnmergedTree = true).onFirst()
                .fetchSemanticsNode().config.contains(androidx.compose.ui.semantics.SemanticsProperties.Disabled))
        }
        verify("lfs can be picked", !compose.onAllNodesWithTag("wiki-settings-workspace:$wsLfs", useUnmergedTree = true).onFirst()
            .fetchSemanticsNode().config.contains(androidx.compose.ui.semantics.SemanticsProperties.Disabled))
    }

    /** Board 46 part 4 ②, then part 5: the drawer's New wiki… row under Wiki opens the Create wiki form. */
    @Test fun theDrawersNewWikiRowOpensTheForm() = journey {
        signIn()
        openDrawer()
        await("New wiki… under Wiki") { exists(hasTestTag("drawer:wiki-new")) }
        verify("it says New wiki…", says("drawer:wiki-new", "New wiki…"))
        capture("1-drawer-new-wiki")
        compose.onNodeWithTag("drawer:wiki-new").performClick()
        verifyTheFormGreysTheRepositoryWithAWiki()
        capture("3-form-has-a-wiki")
    }

    /** Board 46 part 4 ③: the head picker's last item is New wiki…, which opens the same form. */
    @Test fun theHeadPickersNewWikiOpensTheForm() = journey {
        signIn()
        openDrawer()
        compose.onAllNodes(hasText("Wiki") and hasClickAction()).onFirst().performClick()
        awaitTag("wiki-space-picker")
        compose.onNodeWithTag("wiki-space-picker").performClick()
        awaitTag("wiki-space-new")
        verify("it says New wiki…", says("wiki-space-new", "New wiki…"))
        capture("2-picker-new-wiki")
        compose.onNodeWithTag("wiki-space-new").performClick()
        verifyTheFormGreysTheRepositoryWithAWiki()
    }

    /** Board 46 part 3: the WIKI_CREATE card — what it will make and its three answers; Change settings… opens the form on lfs. */
    @Test fun theWikiCreateCardHasItsThreeAnswers() = journey {
        signIn()
        open("orbit://owner-request/$request")
        val tag = "owner-request:$request"
        awaitTag("$tag:change-settings")
        await("the workspace it reads from") { says("$tag:reads-from", "lfs", substring = true) }
        verify("the tag is WIKI", textOf("$tag:kind") == "WIKI")
        verify("it names the repository", says("$tag:repository", "github.com/sample/lfs-builder"))
        verify("it says the maintenance", says("$tag:maintenance", "On · 8 runs a day · last 14 days"))
        verify("Create wiki", says("$tag:primary", "Create wiki"))
        verify("Change settings…", says("$tag:change-settings", "Change settings…"))
        verify("Not for this repository", says("$tag:decline", "Not for this repository"))
        verify("no Remind me later", !exists(hasTestTag("$tag:later"), unmerged = true))
        capture("4-wiki-create-card")
        compose.onNodeWithTag("$tag:change-settings").performClick()
        await("the Create wiki form") { exists(hasTestTag("wiki-settings-form")) }
        await("it opens on lfs") { says("wiki-settings-workspace", "lfs", substring = true) }
        capture("5-change-settings")
    }
}
