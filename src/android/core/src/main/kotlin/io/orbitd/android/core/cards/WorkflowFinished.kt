package io.orbitd.android.core.cards

/**
 * One Orbit workflow's end, as the `<orbit-workflow-finished>` block the control plane opens a turn with spells it (apiserver
 * `buildWorkflowFinishedBlock`, runner-api/background-job-wake.ts; OrbitKit `WorkflowFinishedText` reads it case for case):
 *
 *     <orbit-workflow-finished>
 *       Workflow <name>[ — <description>] (run <id>) finished: <STATUS>
 *       [why an interrupted one stopped]
 *         Calls done: <n>, failed: <m>. Cost: $<x>.
 *         [Error: …] [Result: …]
 *       <one sentence for the agent>
 *     </orbit-workflow-finished>
 */
data class WorkflowFinishedRun(
    val runId: String,
    val name: String,
    val description: String?,
    /** DONE, FAILED, STOPPED or INTERRUPTED. */
    val status: String,
    val callsDone: Int?,
    val callsFailed: Int?,
    val costUsd: Double?,
)

data class WorkflowFinished(
    val runs: List<WorkflowFinishedRun>,
    /** The block itself, exactly as the agent received it. */
    val text: String,
    /** Whatever else the same note carried, for the lines that draw it. */
    val rest: String,
) {
    companion object {
        private val block = Regex("<orbit-workflow-finished>\\n([\\s\\S]*?)\\n</orbit-workflow-finished>")
        private val head = Regex("^ {2}Workflow (.+?)(?: — (.+))? \\(run (\\S+)\\) finished: (DONE|FAILED|STOPPED|INTERRUPTED)$",
            RegexOption.MULTILINE)
        private val stats = Regex("^ {4}Calls done: (\\d+), failed: (\\d+)\\. Cost: \\$([0-9.]+)\\.$", RegexOption.MULTILINE)

        /** The workflow blocks in a control-plane note, or null for a note carrying none it can read. */
        fun parse(note: String?): WorkflowFinished? {
            if (note == null || "<orbit-workflow-finished>" !in note) return null
            val runs = mutableListOf<WorkflowFinishedRun>()
            val blocks = mutableListOf<String>()
            val rest = StringBuilder()
            var end = 0
            for (m in block.findAll(note)) {
                val body = m.groupValues[1]
                val heads = head.findAll(body).toList()
                // A block with no head it can read is a note it cannot read: never a strip that drops a run.
                if (heads.isEmpty()) return null
                heads.forEachIndexed { i, h ->
                    // This run's lines reach to the next run's head.
                    val upper = heads.getOrNull(i + 1)?.range?.first ?: body.length
                    val s = stats.find(body.substring(h.range.first, upper))
                    runs += WorkflowFinishedRun(h.groupValues[3], h.groupValues[1], h.groupValues[2].ifEmpty { null }, h.groupValues[4],
                        s?.groupValues?.get(1)?.toIntOrNull(), s?.groupValues?.get(2)?.toIntOrNull(), s?.groupValues?.get(3)?.toDoubleOrNull())
                }
                rest.append(note, end, m.range.first)
                end = m.range.last + 1
                blocks += m.value
            }
            if (runs.isEmpty()) return null
            rest.append(note, end, note.length)
            return WorkflowFinished(runs, blocks.joinToString("\n\n"), rest.toString().trim())
        }
    }
}
