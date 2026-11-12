import SwiftUI
import OrbitKit

// The task moves waiting on a conversation, drawn where they were asked (`TaskMoves.swift`).
//
// One card per batch: what it is and where it comes from, the task and target criterion each move
// carries, and two presses for the whole batch. The first only asks; the second names both projects,
// every move and its crossing key, says what the answer does, and sends it. Show all lists them
// all, each answered on its own row through the project page's `ProjectCrossingRow` — the same two
// presses, the same words. An answered batch is the one line it became.
//
// The words are OrbitKit's (`TaskMoves`), so the console and any other surface say the same thing;
// web parity is `TaskMoves.swift`'s shared copy.

private extension Color {
    static let taskMoveAccent = Color.orange
}

/// One batch card, read out of the console by its server batch key and re-derived on every render.
struct TaskMoveBatchCardView: View {
    let console: ConsoleModel
    let batchKey: String

    var body: some View {
        if let batch = console.taskMoveBatch(batchKey) {
            TaskMoveBatchCard(console: console, batch: batch)
                // The read that keeps the card honest: it can be answered at another end — the
                // project page, a browser — while this one is on screen, and a card that only
                // learned that from the stream would go on offering buttons for a spent request.
                .task(id: batchKey) { await console.refreshTaskMoves(force: true) }
        }
    }
}

private struct TaskMoveBatchCard: View {
    let console: ConsoleModel
    let batch: TaskMoveBatch

    /// Show all: every move, each answered on its own row.
    @State private var expanded = false
    /// The batch's own second press, when one is showing.
    @State private var confirming: ProjectCrossingDecision?
    /// The move whose second press is showing inside Show all.
    @State private var asking: ProjectCrossingAsk?
    @State private var answering: String?
    @State private var busy = false
    @State private var refusal: ProjectCrossings.Refusal?
    @State private var itemRefusal: ProjectCrossingRefusal?

    private var fromTitle: String {
        batch.moves.first?.fromProject?.title ?? batch.fromProjectId
    }

    private var toTitle: String {
        batch.moves.first?.toProject?.title ?? batch.toProjectId
    }

    /// The source project's status, shown only when it is not Open — the board's "From X (Done)".
    private var fromStatus: String? {
        guard let raw = batch.moves.first?.fromProject?.status, raw != "OPEN",
              let status = ProjectStatus(rawValue: raw) else { return nil }
        return status.label
    }

    private var shown: [ProjectCrossing] {
        expanded ? batch.moves : Array(batch.moves.prefix(TaskMoves.collapsedCount))
    }

    var body: some View {
        if batch.isWaiting {
            waitingCard
        } else {
            resolvedLine
        }
    }

    // MARK: waiting

    private var waitingCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            meta
            moves
            if batch.count > TaskMoves.collapsedCount {
                Button {
                    withAnimation(.easeInOut(duration: 0.18)) { expanded.toggle() }
                } label: {
                    Text(expanded ? TaskMoves.showFewer : TaskMoves.showAll(batch.count))
                        .font(.orbitLabel.weight(.semibold))
                }
                .buttonStyle(.borderless)
            }
            if let refusal { refused(refusal) }
            if let confirming {
                secondPress(confirming)
            } else {
                firstPress
            }
        }
        .padding(16)
        .background(Color.taskMoveAccent.opacity(0.04), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12)
            .strokeBorder(Color.taskMoveAccent.opacity(0.45)))
        .accessibilityIdentifier("task-move-batch-\(batch.batchKey)")
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "hand.raised.fill")
                .foregroundStyle(Color.taskMoveAccent)
            Text(TaskMoves.title(batch))
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// Where the moves come from — by title and by the status it has now — and when they were
    /// asked, in the project page's own line.
    private var meta: some View {
        VStack(alignment: .leading, spacing: 2) {
            (Text(TaskMoves.from).foregroundColor(.secondary)
                + Text(fromTitle).bold()
                + Text(fromStatus.map { " (\($0))" } ?? "").foregroundColor(.secondary))
                .fixedSize(horizontal: false, vertical: true)
            Text(TaskMoves.asked(batch)).foregroundStyle(.secondary)
        }
        .font(.orbitLabel)
    }

    @ViewBuilder
    private var moves: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(shown.enumerated()), id: \.element.id) { index, move in
                if expanded {
                    ProjectCrossingRow(
                        row: move,
                        confirming: asking?.id == move.id ? asking?.decision : nil,
                        busy: answering == move.id,
                        locked: answering.map { $0 != move.id } ?? busy,
                        refusal: asking?.id == move.id && itemRefusal?.id == move.id
                            ? itemRefusal?.refusal : nil,
                        onAsk: { decision in
                            itemRefusal = nil
                            asking = ProjectCrossingAsk(id: move.id, decision: decision)
                        },
                        onCancel: {
                            asking = nil
                            itemRefusal = nil
                        },
                        onAnswer: { answer(move, in: batch.toProjectId, $0) })
                } else {
                    summary(move)
                }
                if index < shown.count - 1 { Divider() }
            }
        }
    }

    /// The collapsed row: the task as it reads now, and the target criterion it would serve.
    private func summary(_ move: ProjectCrossing) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(ProjectCrossings.subjectTitle(move))
                .font(.orbitSubtext)
                .fixedSize(horizontal: false, vertical: true)
            Text(TaskMoves.moveLine(move))
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var firstPress: some View {
        ApprovalActions {
            Button(role: .destructive) { confirming = .deny } label: {
                Text(ProjectCrossings.refuseAsk).approvalActionLabel()
            }
            .buttonStyle(.bordered)
            Button { confirming = .approve } label: {
                Text(TaskMoves.approveAsk(batch.count)).approvalActionLabel()
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.taskMoveAccent)
        }
        .font(.orbitLabel.weight(.semibold))
        .controlSize(.small)
        .disabled(answering != nil)
        .padding(.top, 2)
    }

    /// The second press: both ends, every move with the crossing key it sends back, what the answer
    /// does, and the one button that sends it.
    private func secondPress(_ decision: ProjectCrossingDecision) -> some View {
        let named = Array(batch.moves.prefix(TaskMoves.collapsedCount))
        return VStack(alignment: .leading, spacing: 8) {
            Text(TaskMoves.confirmTitle(batch.count, decision))
                .font(.orbitSubtext.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            (Text(TaskMoves.from).foregroundColor(.secondary)
                + Text(fromTitle).bold()
                + Text(ProjectCrossings.arrow).foregroundColor(.secondary)
                + Text(toTitle).bold())
                .font(.orbitLabel)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(named) { move in
                VStack(alignment: .leading, spacing: 1) {
                    Text(ProjectCrossings.subjectTitle(move))
                        .font(.orbitLabel.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    Text(TaskMoves.confirmLine(move))
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if batch.count > named.count {
                Text(TaskMoves.more(batch.count - named.count))
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
            }
            Text(TaskMoves.consequence(decision))
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.taskMoveAccent.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
            ApprovalActions {
                Button { onCancel() } label: {
                    Text(ProjectCrossings.cancel).approvalActionLabel()
                }
                .buttonStyle(.bordered)
                .disabled(busy)
                Button(role: decision == .deny ? ButtonRole.destructive : nil) { answer(decision) } label: {
                    HStack(spacing: 6) {
                        if busy { ProgressView().controlSize(.small) }
                        Text(decision == .approve ? TaskMoves.approve(batch.count)
                                                  : TaskMoves.refuse(batch.count))
                    }
                    .approvalActionLabel()
                }
                .buttonStyle(.borderedProminent)
                .tint(decision == .deny ? Color.red : Color.taskMoveAccent)
                .disabled(busy || answering != nil)
            }
            .font(.orbitLabel.weight(.semibold))
            .controlSize(.small)
            .padding(.top, 2)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background((decision == .deny ? Color.red : Color.taskMoveAccent).opacity(0.07),
                    in: RoundedRectangle(cornerRadius: 8))
    }

    // MARK: the answer

    private func onCancel() {
        confirming = nil
        refusal = nil
    }

    /// The whole batch, in one answer.
    private func answer(_ decision: ProjectCrossingDecision) {
        guard !busy else { return }
        busy = true
        refusal = nil
        Task { @MainActor in
            if let failure = await console.answerTaskMoveBatch(batch, decision) {
                refusal = failure
            } else {
                confirming = nil
            }
            busy = false
        }
    }

    /// One move of the batch, on its row inside Show all.
    private func answer(_ move: ProjectCrossing, in projectID: String,
                        _ decision: ProjectCrossingDecision) {
        guard answering == nil else { return }
        answering = move.id
        itemRefusal = nil
        Task { @MainActor in
            if let failure = await console.answerTaskMove(move, in: projectID, decision) {
                itemRefusal = ProjectCrossingRefusal(id: move.id, refusal: failure)
            } else {
                asking = nil
            }
            answering = nil
        }
    }

    /// The door's refusal: its code when it sent one, and its reason. The batch's second press
    /// stays open, so a batch refused because one move changed can be read again and answered.
    private func refused(_ refusal: ProjectCrossings.Refusal) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Label(ProjectCrossings.notRecorded, systemImage: "exclamationmark.circle.fill")
                .font(.orbitLabel.weight(.semibold))
                .foregroundStyle(.red)
            (Text(refusal.code.map { "\($0) " } ?? "").font(.orbitMonoFine) + Text(refusal.message))
                .font(.orbitLabel)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    }

    // MARK: answered

    /// The line the card is left as: what the answer did, and when it happened.
    private var resolvedLine: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "hand.raised.fill")
                .foregroundStyle(batch.state == "DENIED" ? Color.secondary : Color.taskMoveAccent)
            Text(TaskMoves.resolved(batch))
                .font(.orbitSubtext.weight(.medium))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            if let moment = batch.decidedAt ?? (batch.since.isEmpty ? nil : batch.since),
               let relative = RelativeTime.format(moment) {
                Text(relative).font(.orbitLabel).foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: 10)
            .strokeBorder(Color.secondary.opacity(0.3)))
        .accessibilityIdentifier("task-move-batch-\(batch.batchKey)")
    }
}
