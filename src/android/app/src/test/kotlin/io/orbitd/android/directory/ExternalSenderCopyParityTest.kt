package io.orbitd.android.directory

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Feishu sender's words are the web's (src/web/src/lib/externalSender.ts) and OrbitKit's (`ExternalSender.swift`), one for one, and
 * the row and the conversation say them where those clients do. A missing counterpart is a failure, never a skip. */
class ExternalSenderCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }
    private fun read(path: String) = File(root, path).also { assertTrue("$path is missing", it.isFile) }.readText()
    private val web = read("src/web/src/lib/externalSender.ts")
    private val swift = read("src/macos/OrbitKit/Sources/OrbitKit/Transcript/ExternalSender.swift")

    @Test fun everyWordIsTheWebsAndTheSwifts() {
        assertEquals("From Feishu", ExternalSender.fromFeishu)
        assertEquals(" · ", ExternalSender.nameSeparator)
        assertEquals("FEISHU", ExternalSender.feishuSource)
        assertTrue("externalSender.ts no longer says \"${ExternalSender.fromFeishu}\"",
            web.contains("export const EXTERNAL_SENDER_FROM_FEISHU = '${ExternalSender.fromFeishu}';"))
        assertTrue("externalSender.ts no longer separates the name with \"${ExternalSender.nameSeparator}\"",
            web.contains("export const EXTERNAL_SENDER_NAME_SEPARATOR = '${ExternalSender.nameSeparator}';"))
        assertTrue("externalSender.ts no longer reads only ${ExternalSender.feishuSource}",
            web.contains("if (from.source !== '${ExternalSender.feishuSource}') return null;"))
        assertTrue("externalSender.ts no longer labels a sender as fromFeishu, separator, name",
            web.contains("`\${EXTERNAL_SENDER_FROM_FEISHU}\${EXTERNAL_SENDER_NAME_SEPARATOR}\${from.name}` : EXTERNAL_SENDER_FROM_FEISHU"))
        assertTrue("ExternalSender.swift no longer says \"${ExternalSender.fromFeishu}\"",
            swift.contains("public static let fromFeishu = \"${ExternalSender.fromFeishu}\""))
        assertTrue("ExternalSender.swift no longer separates the name with \"${ExternalSender.nameSeparator}\"",
            swift.contains("public static let nameSeparator = \"${ExternalSender.nameSeparator}\""))
        assertTrue("ExternalSender.swift no longer reads only ${ExternalSender.feishuSource}",
            swift.contains("public static let feishuSource = \"${ExternalSender.feishuSource}\""))
        assertTrue("ExternalSender.swift no longer labels a sender as fromFeishu, separator, name",
            swift.contains("guard let name = from.name else { return fromFeishu }") && swift.contains("return \"\\(fromFeishu)\\(nameSeparator)\\(name)\""))
        // Every word this object declares is one of the above or the guest's below: a word added here and not there fails.
        val declared = ExternalSender::class.java.declaredFields.filter { it.type == String::class.java }
            .map { it.isAccessible = true; it.get(null) as String }
        assertEquals(setOf(ExternalSender.fromFeishu, ExternalSender.nameSeparator, ExternalSender.feishuSource,
            ExternalSender.fromGuest, ExternalSender.guestSource, ExternalSender.readerSource, ExternalSender.you), declared.toSet())
    }

    /** The guest view's own messages (OrbitKit `GuestTranscript.ownMessages`): headed `You`, by the Swift's source and rule. */
    @Test fun theReadersOwnWordsAreTheSwifts() {
        assertEquals("ORBIT_READER", ExternalSender.readerSource)
        assertEquals("You", ExternalSender.you)
        assertTrue("ExternalSender.swift no longer names the reader source ${ExternalSender.readerSource}",
            swift.contains("public static let readerSource = \"${ExternalSender.readerSource}\""))
        assertTrue("ExternalSender.swift no longer says \"${ExternalSender.you}\"", swift.contains("public static let you = \"${ExternalSender.you}\""))
        assertTrue("ExternalSender.swift no longer labels the reader as you", swift.contains("if from.source == readerSource { return you }"))
    }

    /** A guest the owner invited (docs/session-guests-design.md §3): read only with a name, and labelled `From <name>`, by the web's
     * rule and the Swift's. */
    @Test fun theGuestsWordsAndRuleAreTheWebsAndTheSwifts() {
        assertEquals("From", ExternalSender.fromGuest)
        assertEquals("ORBIT_GUEST", ExternalSender.guestSource)
        assertTrue("externalSender.ts no longer says \"${ExternalSender.fromGuest}\" for a guest",
            web.contains("export const EXTERNAL_SENDER_FROM_GUEST = '${ExternalSender.fromGuest}';"))
        assertTrue("externalSender.ts no longer reads a guest only with a name",
            web.contains("if (from.source === '${ExternalSender.guestSource}') return name ? { source: '${ExternalSender.guestSource}', name } : null;"))
        assertTrue("externalSender.ts no longer labels a guest as fromGuest, a space, name",
            web.contains("if (from.source === '${ExternalSender.guestSource}') return `\${EXTERNAL_SENDER_FROM_GUEST} \${from.name}`;"))
        assertTrue("ExternalSender.swift no longer says \"${ExternalSender.fromGuest}\" for a guest",
            swift.contains("public static let fromGuest = \"${ExternalSender.fromGuest}\""))
        assertTrue("ExternalSender.swift no longer names the guest source ${ExternalSender.guestSource}",
            swift.contains("public static let guestSource = \"${ExternalSender.guestSource}\""))
        assertTrue("ExternalSender.swift no longer reads a guest only with a name",
            swift.contains("case guestSource: return name.map { ExternalMessageFrom(source: guestSource, name: \$0) }"))
        assertTrue("ExternalSender.swift no longer labels a guest as fromGuest, a space, name",
            swift.contains("if from.source == guestSource, let name = from.name { return \"\\(fromGuest) \\(name)\" }"))
    }

    /** The row: the sender's label, then what it said, as the owner's "You" and another session's title are said (`SessionLineCopy.sent`). */
    @Test fun theRowSaysTheLabelWhereTheWebAndTheSwiftDo() {
        val line = read("src/macos/OrbitKit/Sources/OrbitKit/App/SessionLine.swift")
        val template = SessionLineCopy.sent("\\(ExternalSender.label(from))", "\\(plainPreview(text))")
        assertTrue("SessionLine.swift no longer says \"$template\"", line.contains("SessionLine(text: \"$template\", tone: .preview)"))
        val workspace = read("src/web/src/components/WorkspaceView.tsx")
        assertTrue("WorkspaceView.tsx no longer names the outsider first",
            workspace.contains("const outsider = parseExternalSender(s.lastUserFromExternal);\n  if (outsider) return externalSenderLabel(outsider);"))
        val kotlin = read("src/android/app/src/main/kotlin/io/orbitd/android/directory/SessionLine.kt")
        assertTrue("SessionLine.kt no longer asks Orbit, the outsider, then the sender on both lines that show a pending message",
            kotlin.split("return orbitLine(it, OrbitMessageFrom.of(s.lastUserFromOrbit)) ?: externalLine(it, ExternalSender.parse(s.lastUserFromExternal)) ?: sentLine(it, s.lastUserFrom) }").size - 1 == 2)
    }

    /** The conversation: the echo's `externalSender` heads the person's words with the label (web `.chat-user-from`, OrbitKit
     * `UserBubbleView`'s sender line). */
    @Test fun theConversationHeadsTheWordsWithTheLabelWhereTheWebAndTheSwiftDo() {
        val transcript = read("src/web/src/components/Transcript.tsx")
        assertTrue("Transcript.tsx no longer reads the echo's externalSender", transcript.contains("parseExternalSender(p.externalSender)"))
        assertTrue("Transcript.tsx no longer heads the bubble with the label",
            transcript.contains("{node.externalSender && <div className=\"chat-user-from\">{externalSenderLabel(node.externalSender)}</div>}"))
        assertTrue("TranscriptReducer.swift no longer reads the echo's externalSender",
            read("src/macos/OrbitKit/Sources/OrbitKit/Transcript/TranscriptReducer.swift").contains("ExternalSender.parse(ev.payload[\"externalSender\"])"))
        assertTrue("MessageBubbles.swift no longer heads the bubble with the label",
            read("src/macos/OrbitApp/Sources/OrbitApp/Views/Console/MessageBubbles.swift").contains("Text(ExternalSender.label(from))"))
        assertTrue("TranscriptRowView.kt no longer heads the words with the label",
            read("src/android/app/src/main/kotlin/io/orbitd/android/reader/TranscriptRowView.kt")
                .contains("?: ExternalSender.parse(event.fields[\"externalSender\"])?.let(ExternalSender::label) ?: LocalOwnerHeading.current"))
    }
}
