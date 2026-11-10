package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.Wire
import java.time.Instant
import java.time.ZoneOffset
import kotlinx.serialization.json.jsonObject
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
        assertEquals(listOf("Answer", "Provide", "Open steps", "Review"), listOf("DECISION", "SECRET", "MANUAL_STEP", "CONFIRM").map(OwnerRequests::inboxAction))
        assertEquals(listOf("Answer", "Provide key", "Mark done", "Review"), listOf("DECISION", "SECRET", "MANUAL_STEP", "CONFIRM").map(OwnerRequests::pushAction))
        assertEquals("Can’t do this…", OwnerRequests.declineLabel("MANUAL_STEP"))
        assertEquals("Decline…", OwnerRequests.declineLabel("CONFIRM"))
        assertEquals("Asked 2m ago · expires in 3d", OwnerRequests.askedLine(secret, now))
        assertEquals("Runner mini as STRIPE_API_KEY", OwnerRequests.destination(secret.secretSpec!!, "mini"))
        assertEquals("When the session ends, or after 7 days", OwnerRequests.removedFact(secret))
        assertEquals("Goes straight to mini as a file. Orbit keeps it out of this conversation, but any program running as the runner’s user on " +
            "mini can read the file until it is removed. Use a key you can revoke.",
            OwnerRequests.secretNotice(OwnerRequestSecretSpec("k", filePath = "/tmp/k"), "mini"))
        assertEquals("holds 2 tasks", OwnerRequests.holdsText(secret, now))
        assertFalse(OwnerRequests.ready(secret, " ", false, "", null, null, ""))
        assertTrue(OwnerRequests.ready(secret, "sk", false, "", null, null, ""))
        assertFalse("saving needs a name", OwnerRequests.ready(secret, "sk", true, " ", null, null, ""))
    }

    @Test fun theResolvedLineSaysHowWhoAndWhen() {
        val done = secret.copy(state = "DONE", resolvedAt = "2026-11-10T07:59:00Z", resolvedByUserId = "u", resolvedClient = "android")
        assertEquals("Delivered to mini as STRIPE_API_KEY", OwnerRequests.outcomeLine(done, "mini"))
        assertEquals("by you · 07:59 · via Android", OwnerRequests.byLine(done, now, ZoneOffset.UTC))
        val decision = done.copy(kind = "DECISION", options = listOf(OwnerRequestOption("Ship"), OwnerRequestOption("Wait")),
            answer = OwnerRequestAnswer(1, " soon "))
        assertEquals("Wait: “soon”", OwnerRequests.outcomeLine(decision, "mini"))
        assertEquals("Declined: “no”", OwnerRequests.outcomeLine(done.copy(state = "DECLINED", resolutionNote = "no"), "mini"))
        assertEquals("Expired before anyone answered", OwnerRequests.outcomeLine(done.copy(state = "EXPIRED"), "mini"))
        assertEquals("", OwnerRequests.byLine(done.copy(state = "EXPIRED", resolvedAt = null, resolvedClient = null), now))
        val removing = OwnerRequestSecretGrant("REMOVING", runnerOnline = false, runnerLastSeenAt = "2026-11-10T06:00:00Z")
        assertEquals("Removal pending: mini has not been online since 06:00", OwnerRequests.grantLine(removing, "mini", now, ZoneOffset.UTC))
        assertTrue(OwnerRequests.removalToTell(removing))
        assertEquals("Removed: you revoked it", OwnerRequests.grantLine(OwnerRequestSecretGrant("REMOVED", endReason = "REVOKED"), "mini", now))
        assertFalse(OwnerRequests.removalToTell(OwnerRequestSecretGrant("REMOVED", endReason = "REVOKED")))
    }

    @Test fun eachRequestGoesAfterTheLastRowStampedBeforeItAndSnoozesLeaveTheCount() {
        val rows = listOf("2026-11-10T07:00:00Z", null, "2026-11-10T07:59:00Z", "2026-11-10T08:01:00Z")
        val early = secret.copy(id = "a", createdAt = "2026-11-10T06:00:00Z")
        val placed = OwnerRequests.place(rows, listOf(early, secret))
        assertEquals(listOf(early), placed[-1])
        assertEquals("filed at 07:58, after the 07:00 row and before the 07:59 one", listOf(secret), placed[0])
        assertEquals(1, OwnerRequests.waitingCount(listOf(secret, early), mapOf(OwnerRequests.key("a") to now.toEpochMilli() + 1), now))
        assertEquals(2, OwnerRequests.waitingCount(listOf(secret, early), mapOf(OwnerRequests.key("a") to now.toEpochMilli()), now))
        // A deadline in two hours leaves only the hour.
        assertEquals(listOf("In 1 hour"), OwnerRequests.snoozeChoices(secret.copy(expiresAt = "2026-11-10T10:00:00Z"), now).map { it.label })
        assertEquals(3, OwnerRequests.snoozeChoices(secret, now).size)
        // Either spelling of an id is one request.
        assertEquals(OwnerRequests.key("34sYUuoSpnReXXn6j28WR"), OwnerRequests.key(OwnerRequests.key("34sYUuoSpnReXXn6j28WR")))
        assertEquals(listOf(secret), OwnerRequests.forSession("s", listOf(secret), listOf(secret.copy(id = OwnerRequests.key(secret.id)))).map { it.copy(id = secret.id) })
    }

    /** The inbox's Open tab and its one count (web `WaitingOnYouPage`, `waitingCount`): the coordinators' questions beside the requests. */
    @Test fun questionsJoinTheRequestsNewestFirstAndInTheCount() {
        val project = Wire.json.parseToJsonElement("""{"id":"p1","title":"Payments rollout","attention":{"ownerItems":[
            {"kind":"COORDINATOR_QUESTION","count":2},{"kind":"FUSE_PAUSED","count":1}]}}""").jsonObject
        val quiet = Wire.json.parseToJsonElement("""{"id":"p2","title":"Quiet","attention":{"ownerItems":[]}}""").jsonObject
        val items = Wire.json.parseToJsonElement("""{"needsYou":[
            {"itemId":"q1","kind":"COORDINATOR_QUESTION","waitingSince":"2026-11-10T07:59:00Z",
             "question":{"question":"Go **now**?","options":[{"label":"Yes"},{"label":"No"}],"recommendedOption":1}},
            {"itemId":"q2","kind":"COORDINATOR_QUESTION","waitingSince":"2026-11-10T07:00:00Z","question":{"question":"Which?","options":[]}},
            {"itemId":"x","kind":"COORDINATOR_QUESTION","waitingSince":"2026-11-10T07:00:00Z","question":null},
            {"itemId":"f","kind":"FUSE_PAUSED","waitingSince":"2026-11-10T07:30:00Z"}]}""").jsonObject
        assertEquals(listOf(project), OwnerRequests.projectsWithQuestions(listOf(project, quiet)))
        val questions = OwnerRequests.coordinatorQuestions(project, items)
        assertEquals(listOf("q1", "q2"), questions.map { it.itemId })
        assertEquals("Go now?", questions[0].question)
        assertEquals("Payments rollout · decision · recommended: No", questions[0].detail)
        assertEquals("Payments rollout · decision", questions[1].detail)
        // Requests at 07:58 (secret) and 06:00; questions at 07:59 and 07:00.
        val early = secret.copy(id = "a", createdAt = "2026-11-10T06:00:00Z")
        val rows = OwnerRequests.openRows(listOf(secret, early), questions)
        assertEquals(listOf("q1", secret.id, "q2", "a"), rows.map {
            when (it) { is OwnerRequests.OpenRow.Question -> it.question.itemId; is OwnerRequests.OpenRow.Request -> it.request.id }
        })
        // One count: the requests not put off for later, and every open question the projects' attention counts.
        val snoozed = mapOf(OwnerRequests.key("a") to now.toEpochMilli() + 60_000)
        assertEquals(3, OwnerRequests.waitingCount(listOf(secret, early), listOf(project, quiet), snoozed, now))
        assertEquals(4, OwnerRequests.waitingCount(listOf(secret, early), listOf(project, quiet), emptyMap(), now))
        assertEquals(0, OwnerRequests.waitingCount(emptyList(), listOf(quiet), emptyMap(), now))
    }
}
