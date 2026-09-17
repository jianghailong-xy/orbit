import SwiftUI
import OrbitKit

/// What the control plane appended to a message — a reference's summary, a list's condition board,
/// the background work a returning engine is told about, a coordinator's standing role — named on
/// one line as Orbit's rather than the person's, and opened by a tap (a phone has no hover to hang a
/// tooltip on) to exactly what the model read.
///
/// Two of the blocks open as something other than their own text: the inventory a returning engine
/// is handed, whose lines are a list of outcomes (`BackgroundJobsNoteView`), and the tasks a person
/// named with `#`, whose table holds an id nobody could tap (`ReferencedTaskNoteView`). One note can
/// carry both, so each reading is handed what the one before it did not take and what is left over
/// is drawn as it always was. Their counts go on the line that names the note shut: "background
/// jobs" alone never said whether opening it was worth the tap.
///
/// Drawn under the person's words in their bubble (`UserBubbleView`), and inside the card on a turn
/// nobody typed (`BackgroundWakeCardView`). Web parity: `Transcript.tsx`'s `ControlPlaneNote`.
struct AttachedNoteEntry: View {
    let attached: (kind: String, text: String)
    @State private var open = false

    var body: some View {
        let jobs = BackgroundJobsText.parse(attached.text)
        let tasks = ReferencedTaskText.parse(jobs?.rest ?? attached.text)
        let rest = tasks?.rest ?? jobs?.rest ?? attached.text
        return VStack(alignment: .leading, spacing: 4) {
            Button {
                open.toggle()
            } label: {
                Text(head(jobs, tasks))
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading)
            }
            .buttonStyle(.plain)
            if open {
                if tasks != nil || jobs != nil {
                    if let tasks { ReferencedTaskNoteView(tasks: tasks.tasks) }
                    if let jobs { BackgroundJobsNoteView(jobs: jobs) }
                    // Another block the same note carried is neither reading's to draw as rows.
                    if !rest.isEmpty { verbatim(rest) }
                } else {
                    verbatim(attached.text)
                }
            }
        }
    }

    /// "⊕ Orbit attached: background jobs · 2 running, 1 failed".
    private func head(_ jobs: BackgroundJobs?, _ tasks: ReferencedTasks?) -> String {
        var line = "⊕ Orbit attached: \(attached.kind)"
        if let tasks { line += " · " + ReferencedTaskNote.summary(tasks.tasks) }
        if let jobs { line += " · " + BackgroundJobsNote.summary(jobs) }
        return line
    }

    private func verbatim(_ text: String) -> some View {
        Text(text)
            .font(.orbitLabel.monospaced())
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.leading)
            .textSelection(.enabled)
    }
}

/// The `<background-jobs>` block a returning engine is handed, as rows rather than as the block's
/// own `｜`-separated lines (OrbitKit's `BackgroundJobsText.parse`) — which is what a reader met
/// before: one line four lines wide, holding an id, a kind, a shell command, an outcome and an
/// absolute path, all divided by a `｜` they had to count.
///
/// The row language is the wake card's (`BackgroundWakeCardView`): a mark for how it came out, the
/// command as the row's name, the outcome on the right, the ids under it. The two sentences
/// addressed to the agent, the absolute output paths and the Monitor section are the block's and not
/// a row's, so they are read from the fold at the foot — which says "The block, verbatim" and not
/// "What the agent received", because on a wake turn this sits inside the card that already has a
/// fold by that name, and two folds with one name read as a bug.
///
/// Web parity: `BackgroundJobsNote.tsx`. The words are OrbitKit's `BackgroundJobsNote`, which
/// `BackgroundJobsCopyParityTests` holds to the web's.
struct BackgroundJobsNoteView: View {
    let jobs: BackgroundJobs
    @State private var showingRaw = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            section(BackgroundJobsNote.runningTitle, jobs.running)
            section(BackgroundJobsNote.endedTitle, jobs.ended)
            raw
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func section(_ title: String, _ rows: [BackgroundJobRow]) -> some View {
        if !rows.isEmpty {
            Text(title).font(.orbitMeta).foregroundStyle(.secondary)
            ForEach(rows, id: \.id) { row($0) }
        }
    }

    /// One job's row: how it came out, what it was, and the ids underneath.
    private func row(_ job: BackgroundJobRow) -> some View {
        let outcome = BackgroundJobsNote.outcome(job)
        return VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                mark(job)
                // The command is the row: a job carries no description here, and three rows headed
                // by their kind would all read "job". Held to two lines — the whole of a forty-line
                // heredoc is in the fold below.
                Text(BackgroundJobsNote.name(job))
                    .font(.orbitMono)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !outcome.isEmpty {
                    Text(outcome)
                        .font(.orbitMonoFine).foregroundStyle(.secondary)
                        .lineLimit(1)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 4))
                }
            }
            // The ids line up under the command that named the row, not under its glyph.
            Text(BackgroundJobsNote.meta(job))
                .font(.orbitMonoFine).foregroundStyle(.secondary)
                .padding(.leading, 20)
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
    }

    /// The block exactly as the agent received it — one tap away and folded by default.
    private var raw: some View {
        DisclosureGroup(isExpanded: $showingRaw) {
            Text(jobs.text)
                .font(.orbitMono)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 4)
        } label: {
            Text(BackgroundJobsNote.rawSummary)
                .font(.orbitMeta)
                .foregroundStyle(.secondary)
        }
    }

    /// The glyph a row opens on: green where it exited cleanly, red where it did not, and the clock
    /// for one the block listed as still running.
    @ViewBuilder
    private func mark(_ job: BackgroundJobRow) -> some View {
        switch BackgroundJobsNote.mark(job) {
        case .ok:
            Image(systemName: "checkmark.circle.fill").font(.orbitLabel).foregroundStyle(.green)
        case .failed:
            Image(systemName: "xmark.circle.fill").font(.orbitLabel).foregroundStyle(.red)
        case .running:
            Image(systemName: "clock").font(.orbitLabel).foregroundStyle(.secondary)
        }
    }
}

/// The tasks a person named with `#`, as cards rather than as the block's own plain-text table
/// (OrbitKit's `ReferencedTaskText.parse`) — which is what a reader met before: five labelled lines
/// per task, eight of them in one note, and on the first of them an id they could see and not tap.
///
/// The card language is the block-rows' (`BackgroundJobsNoteView`), since the two sit one above the
/// other in the same fold whenever a note carries both: the lifecycle pill for how it stands, the
/// title as the row, the last run on the right, the ids under it. The title is the link — it opens
/// the task through the same `orbit-task:` scheme a `#`-reference in prose is written as, which both
/// app shells route (`ReferenceLink`).
///
/// Web parity: `ReferencedTaskNote.tsx`. The words are OrbitKit's `ReferencedTaskNote`, which
/// `ReferencedTaskCopyParityTests` holds to the web's.
struct ReferencedTaskNoteView: View {
    let tasks: [ReferencedTask]
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(tasks, id: \.id) { card($0) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// One task's card: how it stands, what it is called, how its last run came out, and the ids.
    private func card(_ task: ReferencedTask) -> some View {
        let outcome = ReferencedTaskNote.outcome(task)
        return VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                TaskStatusPill(pill: ReferencedTaskNote.pill(task))
                // `DONE · 验收任务`: what kind of task it is, which its lifecycle does not say.
                ForEach(task.suffixes, id: \.self) { suffix in
                    Text(suffix)
                        .font(.orbitMeta).foregroundStyle(.secondary)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 4))
                }
                // The title is the row, and tapping it opens the task the block could only name.
                Button {
                    if let url = ReferencedTaskNote.link(task) { openURL(url) }
                } label: {
                    Text(task.title)
                        .font(.orbitLabel)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain).foregroundStyle(.tint)
                if !outcome.isEmpty {
                    Text(outcome)
                        .font(.orbitMonoFine).foregroundStyle(.secondary)
                        .lineLimit(1)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 4))
                }
            }
            Text(ReferencedTaskNote.meta(task))
                .font(.orbitMonoFine).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
    }
}
