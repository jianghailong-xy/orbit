package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.Wire
import java.time.Instant
import java.time.ZoneOffset
import org.junit.Assert.*
import org.junit.Test

/** What an owner request says about itself, in the web's words (web lib/ownerRequests.ts, components/OwnerRequestCard.tsx). */
class OwnerRequestsTest {
    private val now = Instant.parse("2026-11-10T08:00:00Z")
    private fun request(json: String) = Wire.decode(json.encodeToByteArray(), OwnerRequest.serializer())
    private val secret = request("""{"id":"34sYUuoSpnReXXn6j28WR","kind":"SECRET","state":"PENDING","title":"Stripe key","why":"Tests",
        "blocksTaskIds":["a","b"],"ifUnanswered":null,"options":null,"recommendedOption":null,"steps":null,
        "secretSpec":{"name":"Stripe test key","runnerId":"r","envVar":"STRIPE_API_KEY"},"secretScope":"SESSION","secretGrant":null,
        "verifyHint":null,"expiresAt":"2026-11-13T08:00:00Z","askedBySessionId":"s","projectId":null,"resolvedAt":null,
        "resolvedByUserId":null,"resolvedBySessionId":null,"resolutionNote":null,"answer":null,"createdAt":"2026-11-10T07:58:00Z",
        "clientRequestId":null,"updatedAt":"2026-11-10T07:58:00Z"}""")

    @Test fun theCardsWordsPerKind() {
        assertEquals("STEPS", OwnerRequests.kindTag("MANUAL_STEP"))
        assertEquals(listOf("Send answer", "Provide key", "Mark done", "Confirm"), listOf("DECISION", "SECRET", "MANUAL_STEP", "CONFIRM").map(OwnerRequests::primary))
        assertEquals(listOf("Answer", "Provide key", "Mark done", "Review"), listOf("DECISION", "SECRET", "MANUAL_STEP", "CONFIRM").map(OwnerRequests::pushAction))
        assertEquals("Can’t do this…", OwnerRequests.declineLabel("MANUAL_STEP"))
        assertEquals("Decline…", OwnerRequests.declineLabel("CONFIRM"))
        assertEquals("Asked 2m ago · expires in 3d", OwnerRequests.askedLine(secret, now))
        assertEquals("Runner mini as STRIPE_API_KEY", OwnerRequests.destination(secret.secretSpec!!, "mini"))
        assertEquals("When the session ends, or after 7 days", OwnerRequests.removedFact(secret))
        assertEquals("Goes straight to mini as a file. Orbit keeps it out of this conversation, but any program running as the runner’s user on " +
            "mini can read the file until it is removed. Use a key you can revoke.",
            OwnerRequests.secretNotice(OwnerRequestSecretSpec("k", filePath = "/tmp/k"), "mini"))
        assertFalse(OwnerRequests.ready(secret, " ", false, "", null, null, ""))
        assertTrue(OwnerRequests.ready(secret, "sk", false, "", null, null, ""))
        assertFalse("saving needs a name", OwnerRequests.ready(secret, "sk", true, " ", null, null, ""))
    }

    /** WIKI_CREATE (docs/wiki-explicit-creation-design.md §3.6): its repository and workspace are read off the card, and a DONE one names
     * the wiki it made. */
    @Test fun aWikiCreateCardReadsItsRepositoryAndNamesTheWikiItMade() {
        val asked = request("""{"id":"w1","kind":"WIKI_CREATE","state":"PENDING","title":"Create a wiki for lfs-builder?","why":"You asked",
            "repoUrlNorm":"github.com/sample/lfs-builder","workspaceId":"ws1","answer":null,"createdAt":"2026-11-10T07:58:00Z"}""")
        assertEquals("github.com/sample/lfs-builder", asked.repoUrlNorm)
        assertEquals("ws1", asked.workspaceId)
        assertTrue(OwnerRequests.WIKI_CREATE in OwnerRequests.kinds)
        assertEquals(listOf("WIKI", "Create wiki", "Review"), listOf(OwnerRequests.kindTag("WIKI_CREATE"), OwnerRequests.primary("WIKI_CREATE"),
            OwnerRequests.pushAction("WIKI_CREATE")))
        val made = request("""{"id":"w1","kind":"WIKI_CREATE","state":"DONE","title":"Create a wiki for lfs-builder?",
            "answer":{"spaceId":"sp1","name":"lfs-builder"},"resolvedByUserId":"u","createdAt":"2026-11-10T07:58:00Z"}""")
        assertEquals("sp1", made.answer?.spaceId)
        assertEquals("Created the wiki lfs-builder", OwnerRequests.outcomeLine(made, "mini"))
        assertEquals("Wiki created", OwnerRequests.outcomeLine(made.copy(answer = null), "mini"))
        assertEquals("Declined: “Not for this repository”",
            OwnerRequests.outcomeLine(made.copy(state = "DECLINED", answer = null, resolutionNote = "Not for this repository"), "mini"))
    }

    private val change = request("""{"id":"c1","kind":"CHANGE","state":"PENDING","title":"Raise Max Concurrent on mini","why":"Queue is long",
        "changeSpec":{"runnerId":"r1","field":"maxConcurrent","requested":6,"before":4},"answer":null,"createdAt":"2026-11-10T07:58:00Z"}""")

    /** CHANGE: change_spec is parsed off the server's row, and an applied card reads what was written. */
    @Test fun aChangeCardParsesItsSpecAndSaysWhatWasApplied() {
        assertEquals(OwnerRequestChangeSpec("r1", "maxConcurrent", 6, 4), change.changeSpec)
        assertTrue(OwnerRequests.CHANGE in OwnerRequests.kinds)
        assertEquals(listOf("SETTING", "Apply", "Review"), listOf(OwnerRequests.kindTag("CHANGE"), OwnerRequests.primary("CHANGE"), OwnerRequests.pushAction("CHANGE")))
        assertEquals(ChangeCopy.lowering(2), OwnerRequests.changeEffect(2, 4))
        assertEquals(ChangeCopy.raising(6), OwnerRequests.changeEffect(6, 4))
        assertNull(OwnerRequests.changeEffect(4, 4))
        val done = request("""{"id":"c1","kind":"CHANGE","state":"DONE","title":"t","changeSpec":{"runnerId":"r1","field":"maxConcurrent","requested":6,"before":4},
            "answer":{"applied":5,"actualBefore":3},"createdAt":"2026-11-10T07:58:00Z"}""")
        assertEquals("Applied: mini Max Concurrent 3 → 5 (asked for 6)", OwnerRequests.outcomeLine(done, "mini"))
        assertEquals("Applied: mini Max Concurrent 4 → 6", OwnerRequests.outcomeLine(done.copy(answer = null), "mini"))
    }

    /** The card's strings are the web card's: lib/ownerRequests.ts CHANGE_COPY, read from the source. */
    @Test fun theChangeCardsWordsEqualTheWebCards() {
        val source = generateSequence(java.io.File("").absoluteFile) { it.parentFile }.map { java.io.File(it, "src/web/src/lib/ownerRequests.ts") }
            .first { it.exists() }.readText()
        val block = source.substringAfter("export const CHANGE_COPY = {").substringBefore("} as const;")
        fun literal(key: String) = Regex("""\b$key: '([^']*)'""").find(block)!!.groupValues[1]
        fun template(key: String) = Regex("""\b$key: \([^)]*\) => `([^`]*)`""").find(block)!!.groupValues[1]
        fun fill(text: String, vararg values: Pair<String, Any>) = values.fold(text) { acc, (name, v) -> acc.replace("\${$name}", v.toString()) }
        assertEquals(literal("tag"), ChangeCopy.tag)
        assertEquals(literal("primary"), ChangeCopy.primary)
        assertEquals(literal("numberLabel"), ChangeCopy.numberLabel)
        assertEquals(fill(template("setting"), "runner" to "mini"), ChangeCopy.setting("mini"))
        assertEquals(fill(template("runningNow"), "n" to 3), ChangeCopy.runningNow(3))
        assertEquals(fill(template("wasWhenAsked"), "before" to 4), ChangeCopy.wasWhenAsked(4))
        assertEquals(fill(template("lowering"), "n" to 2), ChangeCopy.lowering(2))
        assertEquals(fill(template("raising"), "n" to 8), ChangeCopy.raising(8))
        val applied = Regex("""applied: \([^)]*\) =>\s*`(.*)`,""").find(block)!!.groupValues[1]
        assertEquals("Applied: \${runner} Max Concurrent \${from} → \${to}\${to !== requested ? ` (asked for \${requested})` : ''}", applied)
        assertEquals("Applied: mini Max Concurrent 4 → 6", ChangeCopy.applied("mini", 4, 6, 6))
        assertEquals("Applied: mini Max Concurrent 4 → 5 (asked for 6)", ChangeCopy.applied("mini", 4, 5, 6))
    }

    /** The web's `ownerRequestChatContext`, word for word. */
    @Test fun chatAboutThisNamesTheRequestAndSaysItIsStillOpen() {
        assertEquals("Chat about this", OwnerRequests.chatAction)
        assertEquals("The owner pressed Chat about this on your request “Stripe key” (owner request 34sYUuoSpnReXXn6j28WR). " +
            "It is still open: not marked done and not declined. Their message:", OwnerRequests.chatContext(secret))
    }

    /** BROWSER_SIGN_IN: the site, the Orbit Cloud runner and the asking session are read off the card; its words are the web's;
     * Open browser goes to the runner's browser tab on the web; DONE says where it signed in, a decline says Not now. */
    @Test fun aBrowserSignInCardReadsItsSiteAndRunnerAndSaysHowItEnded() {
        val asked = request("""{"id":"b1","kind":"BROWSER_SIGN_IN","state":"PENDING","title":"Sign in to github.com","why":"Needs a token page",
            "browserSite":"github.com","browserRunnerId":"r9","askedBySessionTitle":"Fix CI","answer":null,"createdAt":"2026-11-10T07:58:00Z"}""")
        assertEquals(listOf("github.com", "r9", "Fix CI"), listOf(asked.browserSite, asked.browserRunnerId, asked.askedBySessionTitle))
        assertNull(request("""{"id":"w","kind":"CONFIRM","state":"PENDING","title":"t","createdAt":"2026-11-10T07:58:00Z"}""").browserSite)
        assertTrue(OwnerRequests.BROWSER_SIGN_IN in OwnerRequests.kinds)
        assertEquals(listOf("SIGN IN", "Open browser", "Sign in"), listOf(OwnerRequests.kindTag("BROWSER_SIGN_IN"),
            OwnerRequests.primary("BROWSER_SIGN_IN"), OwnerRequests.pushAction("BROWSER_SIGN_IN")))
        assertEquals("Sign in needed · Orbit Cloud browser", OwnerRequests.browserSignInEyebrow)
        assertEquals("You sign in yourself; Orbit never sees your password. The login stays on this runner, and every agent on it can use it.",
            OwnerRequests.browserSignInNote)
        assertEquals("From session Fix CI", OwnerRequests.fromSession("Fix CI"))
        assertEquals("Not now", OwnerRequests.notNow)
        assertEquals("https://orbit.example/runners/r9/browser?control=1", OwnerRequests.browserTabUrl("https://orbit.example/", "r9"))
        assertEquals("Signed in to github.com", OwnerRequests.outcomeLine(asked.copy(state = "DONE", resolvedByUserId = "u"), "mini"))
        assertEquals("Not now", OwnerRequests.outcomeLine(asked.copy(state = "DECLINED", resolutionNote = "Not now"), "mini"))
        assertEquals("Expired before anyone answered", OwnerRequests.outcomeLine(asked.copy(state = "EXPIRED"), "mini"))
    }

    @Test fun theResolvedLineSaysHowWhoAndWhen() {
        val done = secret.copy(state = "DONE", resolvedAt = "2026-11-10T07:59:00Z", resolvedByUserId = "u", resolvedClient = "android")
        assertEquals("Delivered to mini as STRIPE_API_KEY", OwnerRequests.outcomeLine(done, "mini"))
        assertEquals("by you · 7:59\u202FAM · via Android", OwnerRequests.byLine(done, now, ZoneOffset.UTC))
        val decision = done.copy(kind = "DECISION", options = listOf(OwnerRequestOption("Ship"), OwnerRequestOption("Wait")),
            answer = OwnerRequestAnswer(1, " soon "))
        assertEquals("Wait: “soon”", OwnerRequests.outcomeLine(decision, "mini"))
        assertEquals("Declined: “no”", OwnerRequests.outcomeLine(done.copy(state = "DECLINED", resolutionNote = "no"), "mini"))
        assertEquals("Expired before anyone answered", OwnerRequests.outcomeLine(done.copy(state = "EXPIRED"), "mini"))
        assertEquals("", OwnerRequests.byLine(done.copy(state = "EXPIRED", resolvedAt = null, resolvedClient = null), now))
        val removing = OwnerRequestSecretGrant("REMOVING", runnerOnline = false, runnerLastSeenAt = "2026-11-10T06:00:00Z")
        assertEquals("Removal pending: mini has not been online since 6:00\u202FAM", OwnerRequests.grantLine(removing, "mini", now, ZoneOffset.UTC))
        assertTrue(OwnerRequests.removalToTell(removing))
        assertEquals("Removed: you revoked it", OwnerRequests.grantLine(OwnerRequestSecretGrant("REMOVED", endReason = "REVOKED"), "mini", now))
        assertFalse(OwnerRequests.removalToTell(OwnerRequestSecretGrant("REMOVED", endReason = "REVOKED")))
    }

    @Test fun eachRequestGoesAfterTheLastRowStampedBeforeIt() {
        val rows = listOf("2026-11-10T07:00:00Z", null, "2026-11-10T07:59:00Z", "2026-11-10T08:01:00Z")
        val early = secret.copy(id = "a", createdAt = "2026-11-10T06:00:00Z")
        val placed = OwnerRequests.place(rows, listOf(early, secret))
        assertEquals(listOf(early), placed[-1])
        assertEquals("filed at 07:58, after the 07:00 row and before the 07:59 one", listOf(secret), placed[0])
        // A deadline in two hours leaves only the hour.
        assertEquals(listOf("In 1 hour"), OwnerRequests.snoozeChoices(secret.copy(expiresAt = "2026-11-10T10:00:00Z"), now).map { it.label })
        assertEquals(3, OwnerRequests.snoozeChoices(secret, now).size)
        // Either spelling of an id is one request.
        assertEquals(OwnerRequests.key("34sYUuoSpnReXXn6j28WR"), OwnerRequests.key(OwnerRequests.key("34sYUuoSpnReXXn6j28WR")))
        assertEquals(listOf(secret), OwnerRequests.forSession("s", listOf(secret), listOf(secret.copy(id = OwnerRequests.key(secret.id)))).map { it.copy(id = secret.id) })
    }

    /** A press on a session's needs-you notice opens the oldest request it asked that is still pending (OrbitKit's twin). */
    @Test fun aNoticeOpensTheSessionsOldestPendingRequest() {
        val asked = OwnerRequest(id = "new", kind = "MANUAL_STEP", state = "PENDING", title = "t", askedBySessionId = "s",
            createdAt = "2026-11-17T22:36:15Z")
        val older = asked.copy(id = "older", createdAt = "2026-11-17T19:07:30Z")
        val ended = asked.copy(id = "ended", state = "WITHDRAWN", createdAt = "2026-11-17T14:12:35Z")
        val elsewhere = asked.copy(id = "other", askedBySessionId = "x", createdAt = "2026-11-17T04:55:08Z")
        assertEquals("older", OwnerRequests.oldestPending("s", listOf(asked, ended, elsewhere), listOf(older))?.id)
        assertNull(OwnerRequests.oldestPending("s", listOf(ended, elsewhere)))
    }

    @Test fun theResolutionTurnIsADividerNotTheOwnersBubble() {
        fun turn(head: String) = listOf(head, "", OwnerRequests.RESOLUTION_MARK + " The request is final and will not wake this session again.",
            "", "```json", "{}", "```").joinToString("\n")
        assertEquals("Owner action resolved · turn started automatically",
            OwnerRequests.resolutionTurnLabel(turn("Orbit owner request 34uabc (MANUAL_STEP) ended DONE: the owner did what was asked.")))
        assertEquals("Owner request expired · turn started automatically",
            OwnerRequests.resolutionTurnLabel(turn("Orbit owner request 34uabc (DECISION) ended EXPIRED: its deadline passed.")))
        assertEquals("Owner action resolved · turn started automatically",
            OwnerRequests.resolutionTurnLabel(turn("Orbit owner request 34uabc (WIKI_CREATE) ended DONE. The owner created the wiki w.")))
        assertNull(OwnerRequests.resolutionTurnLabel("Orbit owner request 34uabc (SECRET) ended DONE: looks wrong to me"))
        assertNull(OwnerRequests.resolutionTurnLabel(null))
    }
}
