package io.orbitd.android.reader

import io.orbitd.android.core.cards.CoordinatorQueue
import io.orbitd.android.core.cards.OwnerAnswerLine
import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/** The owner's answer handed to the coordinator says the same line on every client: every word here is the one OrbitKit's
 * `OwnerAnswer.swift` and the web's `OwnerAnswerLine.tsx` declare, the line is the web's `sentToCoordinatorLine`, and the kinds a card
 * can be are OrbitKit's. A missing counterpart is a failure, never a skip (ProjectCopyParityTest's rule). */
class OwnerAnswerCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }
    private fun read(path: String) = File(root, path).also { assertTrue("$path is gone", it.isFile) }.readText()
    private val swift = read("src/macos/OrbitKit/Sources/OrbitKit/Transcript/OwnerAnswer.swift")
    private val webLine = read("src/web/src/components/OwnerAnswerLine.tsx")
    private val webEvidence = read("src/web/src/components/EvidenceDecisionCard.tsx")
    private val webReader = read("src/web/src/lib/ownerAnswer.ts")

    private fun assertHas(source: String, file: String, needle: String) =
        assertTrue("$file no longer contains $needle", source.contains(needle))

    @Test fun theWordsAreOrbitKitsAndTheWebs() {
        assertHas(swift, "OwnerAnswer.swift", "static let told = \"${OwnerAnswerLine.told}\"")
        assertHas(swift, "OwnerAnswer.swift", "static let undelivered = \"${OwnerAnswerLine.undelivered}\"")
        assertHas(webLine, "OwnerAnswerLine.tsx", "export const OWNER_ANSWER_TOLD = '${OwnerAnswerLine.told}'")
        assertHas(webLine, "OwnerAnswerLine.tsx", ">${OwnerAnswerLine.undelivered}<")
    }

    @Test fun theLineIsTheWebsSentToCoordinatorLine() {
        assertHas(webLine, "OwnerAnswerLine.tsx", "{sentToCoordinatorLine(card.deliveredAt)}")
        assertHas(webEvidence, "EvidenceDecisionCard.tsx", "export const EVIDENCE_DECISION_SENT_TO_COORDINATOR = '${CoordinatorQueue.sent}'")
        assertHas(webEvidence, "EvidenceDecisionCard.tsx", "`\${EVIDENCE_DECISION_SENT_TO_COORDINATOR} · \${decisionReceiptTime(deliveredAt, now)}`")
        assertHas(swift, "OwnerAnswer.swift", "EvidenceDecisions.sentLine(card.deliveredAt, now: now)")
    }

    @Test fun aCardIsTheSameKindsOnEveryClient() {
        listOf("COORDINATOR_QUESTION", "DONE_REQUEST").forEach { kind ->
            assertHas(swift, "OwnerAnswer.swift", "= \"$kind\"")
            assertHas(webReader, "ownerAnswer.ts", "card.kind !== '$kind'")
        }
    }
}
