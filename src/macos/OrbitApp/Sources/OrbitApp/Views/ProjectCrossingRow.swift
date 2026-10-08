import SwiftUI
import OrbitKit

/// The row whose second press is showing on the project page, and the answer it would give.
struct ProjectCrossingAsk: Equatable {
    let id: String
    let decision: ProjectCrossingDecision
}

/// The door's refusal of an answer, and the row it was given on.
struct ProjectCrossingRefusal: Equatable {
    let id: String
    let refusal: ProjectCrossings.Refusal
}

/// One crossing on the project page — web's `CrossingRow`, in its words (`ProjectCrossings`).
///
/// What it is and where it stands, first in words: the server's state, what that state is called,
/// and the kind. Then what it is about — for a move, the task by its title now and its id — both
/// ends by title and by id, what follows from the state, and for a move the criteria it changes.
///
/// A crossing that is still a question offers two presses. The first only asks; the second names
/// the subject and both ends, says what the answer does, shows the crossing key the answer echoes,
/// and sends it. The parent holds which row is asking, so opening a second question closes the
/// first. A refusal stays on its row with the door's own code and reason, the second press still
/// open: a move refused because its task was being landed can be confirmed again once that ends.
struct ProjectCrossingRow: View {
    let row: ProjectCrossing
    /// The answer this row's second press would give, when it is showing.
    let confirming: ProjectCrossingDecision?
    /// This row's answer is on its way.
    let busy: Bool
    /// Another row's answer is on its way: one answer at a time.
    let locked: Bool
    let refusal: ProjectCrossings.Refusal?
    let onAsk: (ProjectCrossingDecision) -> Void
    let onCancel: () -> Void
    let onAnswer: (ProjectCrossingDecision) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                tag(row.state)
                Text(ProjectCrossings.label(row.state))
                    .font(.orbitLabel.weight(.semibold))
                tag(row.kind)
            }
            if row.isMove {
                moveSubject
            } else {
                Text(row.title)
                    .font(.orbitSubtext)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ends
            Text(ProjectCrossings.meaning(row))
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if row.isMove { moveCriteria }
            if let reason = row.reason {
                Text(ProjectCrossings.reasonGiven(reason))
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let refusal { refused(refusal) }
            if ProjectCrossings.isAnswerable(row.state) {
                if let confirming {
                    secondPress(ProjectCrossings.prompt(row, confirming), decision: confirming)
                } else {
                    firstPress
                }
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: what it is about

    /// A move: the task that already exists and is asked to move, by title and by id.
    private var moveSubject: some View {
        (Text(ProjectCrossings.moveSubjectLabel + ": ").font(.orbitLabel).foregroundColor(.secondary)
            + Text(ProjectCrossings.subjectTitle(row)).bold()
            + Text(ProjectCrossings.subjectID(row).map { " \($0)" } ?? "").font(.orbitMonoFine)
                .foregroundColor(.secondary))
            .font(.orbitSubtext)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// The project it leaves and the one it joins, each by title, id and status.
    private var ends: some View {
        (end(row.fromProject, id: ProjectCrossings.fromID(row))
            + Text(ProjectCrossings.arrow).foregroundColor(.secondary)
            + end(row.toProject, id: ProjectCrossings.toID(row)))
            .font(.orbitLabel)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func end(_ project: ProjectCrossing.ProjectEnd?, id: String) -> Text {
        let title = Text(project?.title ?? ProjectCrossings.unnamedProject).bold()
        let code = Text(" \(id)").font(.orbitMonoFine).foregroundColor(.secondary)
        guard let status = project?.status else { return title + code }
        return title + code + Text(" · \(status)").foregroundColor(.secondary)
    }

    /// A move: what the task would count towards over there, and what it counts towards here now —
    /// the declaration the move takes back.
    @ViewBuilder
    private var moveCriteria: some View {
        if let requested = row.requestedCriterion {
            criterion(ProjectCrossings.moveRequestedCriterionLabel,
                      text: requested.text ?? ProjectCrossings.moveCriterionGone, key: requested.key)
        }
        if let withdrawn = row.withdrawnCriterion {
            criterion(ProjectCrossings.moveWithdrawnCriterionLabel, text: withdrawn.text ?? "",
                      key: withdrawn.key, note: ProjectCrossings.moveWithdrawnCriterionNote)
        }
    }

    private func criterion(_ label: String, text: String, key: String, note: String? = nil) -> some View {
        (Text(label + ": ").foregroundColor(.secondary)
            + Text(text)
            + Text(" \(key)").font(.orbitMonoFine).foregroundColor(.secondary)
            + Text(note.map { " \($0)" } ?? "").foregroundColor(.secondary))
            .font(.orbitLabel)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: the answer

    private var firstPress: some View {
        ApprovalActions {
            Button { onAsk(.approve) } label: {
                Text(ProjectCrossings.approveAsk).approvalActionLabel()
            }
            .buttonStyle(.bordered)
            Button(role: .destructive) { onAsk(.deny) } label: {
                Text(ProjectCrossings.refuseAsk).approvalActionLabel()
            }
            .buttonStyle(.bordered)
        }
        .font(.orbitLabel.weight(.semibold))
        .controlSize(.small)
        .disabled(locked)
        .padding(.top, 2)
    }

    /// The question the second press answers: both ends, the subject, what follows from it, and
    /// the crossing key it sends back.
    private func secondPress(_ prompt: ProjectCrossings.Prompt,
                             decision: ProjectCrossingDecision) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(ProjectCrossings.question(prompt))
                .font(.orbitSubtext.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            Text(prompt.consequence)
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            (Text(ProjectCrossings.crossingKeyLabel + " ").foregroundColor(.secondary)
                + Text(ProjectCrossings.shortKey(row.crossingKey)).font(.orbitMonoFine))
                .font(.orbitLabel)
            ApprovalActions {
                Button(role: decision == .deny ? ButtonRole.destructive : nil) { onAnswer(decision) } label: {
                    HStack(spacing: 6) {
                        if busy { ProgressView().controlSize(.small) }
                        Text(ProjectCrossings.confirmLabel(prompt))
                    }
                    .approvalActionLabel()
                }
                .buttonStyle(.borderedProminent)
                .tint(decision == .deny ? Color.red : Color.accentColor)
                .disabled(busy || locked)
                Button { onCancel() } label: {
                    Text(ProjectCrossings.cancel).approvalActionLabel()
                }
                .buttonStyle(.bordered)
                .disabled(busy)
            }
            .font(.orbitLabel.weight(.semibold))
            .controlSize(.small)
            .padding(.top, 2)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background((decision == .deny ? Color.red : Color.accentColor).opacity(0.07),
                    in: RoundedRectangle(cornerRadius: 8))
    }

    /// The door's refusal: its code when it sent one, and its reason.
    private func refused(_ refusal: ProjectCrossings.Refusal) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Label(ProjectCrossings.notRecorded, systemImage: "exclamationmark.circle.fill")
                .font(.orbitLabel.weight(.semibold))
                .foregroundStyle(.red)
            (Text(refusal.code.map { "\($0) " } ?? "").font(.orbitMonoFine)
                + Text(refusal.message))
                .font(.orbitLabel)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    }

    /// The server's own value, as a chip: the state's word comes beside it, never instead of it.
    private func tag(_ code: String) -> some View {
        Text(code)
            .font(.orbitMeta.weight(.semibold).monospaced())
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .foregroundStyle(.secondary)
            .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 5))
    }
}
