package io.orbitd.android.reader

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The SubAgent card's end says what the web's says (board docs/mocks/subagent-card-and-end-line; web `SubagentCardEnd.tsx`, which landed
 * first): every word [SubagentEnd] draws is a literal, a template or JSX text there. A missing counterpart is a failure, never a skip.
 */
class SubagentCardEndCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/web/src/components/SubagentCardEnd.tsx").isFile }
    private val web = File(root, "src/web/src/components/SubagentCardEnd.tsx").readText()

    private fun has(literal: String) = assertTrue("SubagentCardEnd.tsx no longer contains $literal", web.contains(literal))

    @Test fun everySentenceIsTheWebs() {
        SubagentEnd.because.forEach { (status, sentence) -> has("$status: '$sentence'") }
        has("Show files")
        has("Waiting for the agent to read it ·")
        has("Don&apos;t send".also { assertTrue(SubagentEnd.dontSend == "Don't send") })
        has("<summary>${SubagentEnd.whatTheAgentRead}</summary>")
        has("const FILES_SHOWN = ${SubagentEnd.FILES_SHOWN};")
        has("`\${n} \${n === 1 ? 'file' : 'files'} left uncommitted`")
        has("{fileCount(files.length)} in the working tree:")
        has("… {files.length - shown.length} more")
        has("Run {runId}")
        has("` · read by the agent at \${readAt}`")
        has("`Stopped\${when} by the agent.`")
        has("`\${run.status === 'FAILED' ? 'Failed' : 'Interrupted'}\${when}: \${lowerFirst(")
        has("files.slice(0, 2).map(basename)")
        has("`+\${files.length - first.length}`")
        has("join(' · ')")
    }
}
