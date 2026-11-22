package io.orbitd.android.core.cards

/**
 * A turn nobody typed: a SubAgent (`delegate`) ended and the control plane opened a turn in its parent to hand over how it ended and
 * what it said (web `lib/subagentFinished.ts`, read case for case). Like a background job's wake ([backgroundWake]) the block is the
 * turn's control-plane note, built by the apiserver's `buildSubagentFinishedBlock` (runner-api/background-job-wake.ts):
 *
 *     <orbit-subagent-finished>
 *       SubAgent <description> (run <id>) finished: <STATUS>
 *       <why it ended, for a run that did not finish>
 *       Result:
 *         <the result, four spaces in>          — or —   (no result)
 *       … the next run …
 *       <the sentences for the agent>
 *     </orbit-subagent-finished>
 *
 * A wording this does not recognise parses as nothing at all rather than half a line: the note then stays the entry it has always been.
 */
data class SubagentFinishedRun(
    val runId: String,
    /** The `delegate` call's description (or what the block names a run without one by). */
    val description: String,
    /** DONE, FAILED, STOPPED or INTERRUPTED. */
    val status: String,
    /** Why a run that did not finish ended, as the control plane put it; null for DONE. */
    val reason: String?,
    /** What it handed back, back at column zero; empty where the block said there was none. */
    val result: String,
) {
    /** Whether it came to its end on its own. */
    val ok: Boolean get() = status == "DONE"
}

data class SubagentFinished(
    val runs: List<SubagentFinishedRun>,
    /** The block itself, exactly as the agent received it. */
    val text: String,
    /** Whatever else the same note carried: not the line's to draw, it stays an attached entry (or a background job's own line). */
    val rest: String,
) {
    companion object {
        // The web reader's patterns (OrbitKit `SubagentFinishedText` pins the same ones; SubagentFinishedCopyParityTest holds them).
        internal const val blockPattern = "<orbit-subagent-finished>\\n([\\s\\S]*?)\\n</orbit-subagent-finished>"
        /** `SubAgent <description> (run <id>) finished: <STATUS>` — the description may hold brackets of its own. */
        internal const val headPattern = "^ {2}SubAgent (.+) \\(run (\\S+)\\) finished: (DONE|FAILED|STOPPED|INTERRUPTED)$"
        /** A line at the block's own indent, not inside a result. */
        internal const val sentencePattern = "^ {2}(?! )(.+)$"
        private val block = Regex(blockPattern)
        private val head = Regex(headPattern)
        private val sentence = Regex(sentencePattern)

        /** The SubAgent block in a control-plane note, or null for a note carrying none it can read. */
        fun parse(note: String?): SubagentFinished? {
            if (note == null || "<orbit-subagent-finished>" !in note) return null
            val runs = mutableListOf<SubagentFinishedRun>()
            val blocks = mutableListOf<String>()
            val rest = StringBuilder()
            var end = 0
            for (m in block.findAll(note)) {
                // One block it cannot read is a note it cannot read: never a line that drops a run.
                runs += parseRuns(m.groupValues[1]) ?: return null
                rest.append(note, end, m.range.first)
                end = m.range.last + 1
                blocks += m.value
            }
            if (runs.isEmpty()) return null
            rest.append(note.substring(end))
            return SubagentFinished(runs, blocks.joinToString("\n\n"), rest.toString().replace(Regex("\\n{3,}"), "\n\n").trim())
        }

        private enum class At { START, HEAD, RESULT, ENDED, CLOSING }

        /** Each run in a block, read line by line; null on any line the shape has no place for. */
        private fun parseRuns(body: String): List<SubagentFinishedRun>? {
            val runs = mutableListOf<SubagentFinishedRun>()
            var run: SubagentFinishedRun? = null
            // Where the reading is: just past a run's head, inside its result, past its result, or in the sentences closing the block
            // (which are the agent's and never shown outside the raw block).
            var at = At.START
            val result = mutableListOf<String>()
            fun close() {
                run?.let { runs[runs.lastIndex] = it.copy(result = result.joinToString("\n").trimEnd()) }
                run = null
                result.clear()
            }
            for (line in body.split("\n")) {
                // A blank line of the result is four spaces, unless something on the way trimmed it.
                if (at == At.RESULT && (line.startsWith("    ") || line.isEmpty())) { result += line.drop(4); continue }
                if (at == At.CLOSING) { if (!sentence.matches(line)) return null; continue }
                val h = head.matchEntire(line)
                if (h != null && at != At.HEAD) {
                    close()
                    run = SubagentFinishedRun(h.groupValues[2], h.groupValues[1], h.groupValues[3], null, "").also { runs += it }
                    at = At.HEAD
                    continue
                }
                val current = run
                if (at == At.HEAD && current != null) {
                    when {
                        line == "  Result:" -> at = At.RESULT
                        line == "  (no result)" -> at = At.ENDED
                        current.reason == null && !current.ok && sentence.matches(line) -> {
                            run = current.copy(reason = line.drop(2)); runs[runs.lastIndex] = run!!
                        }
                        else -> return null
                    }
                    continue
                }
                if ((at == At.RESULT || at == At.ENDED) && sentence.matches(line)) { close(); at = At.CLOSING; continue }
                return null
            }
            // A block cut off before a run said how its result reads is not one this knows.
            if (at == At.START || at == At.HEAD) return null
            close()
            return runs
        }
    }
}
