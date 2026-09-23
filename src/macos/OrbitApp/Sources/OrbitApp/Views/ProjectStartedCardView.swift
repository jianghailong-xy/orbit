import SwiftUI
import OrbitKit

/// The message telling a coordinator its project was started, drawn as a card — instead of a screen
/// of prose inside the reader's own bubble (design: docs/mocks/project-started-card.png).
///
/// The prose is written for the AGENT: tool names, ids, `autoRunWhenReady`. A person watching the
/// conversation needs three facts from it — how the project was started, which project, and which of
/// its tasks now wait on the coordinator — and this draws those from the payload the control plane
/// recorded beside the turn (OrbitKit's `ProjectStarted`, read out of `projectStarted`). The words the
/// agent read are one disclosure away at the foot.
///
/// Built like `OpenItemDeliveryCardView`, which sits in the same place for the same reason, in the
/// brand tone `BackgroundWakeCardView` uses where nothing failed. Web parity: `ProjectStartedCard.tsx`,
/// with every word from OrbitKit's `ProjectStartedCard`, which `ProjectStartedCopyParityTests` holds
/// to the web's.
struct ProjectStartedCardView: View {
    let card: ProjectStarted
    /// The words the agent was handed, verbatim — the record this card is drawn from.
    let text: String
    var ts: String?
    var undelivered: Bool = false
    /// Whatever else the same turn's note carried (a `controlPlaneNote`), as its own folded entry —
    /// nobody typed this turn, so it does not go back into a bubble in the reader's name.
    var attached: (kind: String, text: String)?
    /// Withdraws the message while it is still queued behind the running turn; nil once a runner has
    /// taken it.
    var onCancelQueued: (() -> Void)?

    @Environment(\.openURL) private var openURL
    @State private var allTasks = false
    @State private var showingRaw = false

    private var queued: Bool { onCancelQueued != nil }
    /// Nothing here failed, so the card is in the product's own colour, as a finished wake's is.
    private var tone: Color { .accentColor }
    private var tasks: [ProjectStartedTask] {
        allTasks ? card.held : Array(card.held.prefix(ProjectStartedCard.tasksShown))
    }
    /// The waiting tasks the message did not list; only the project page names them.
    private var unlisted: Int { card.heldCount - card.held.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            head
            Text(card.projectTitle)
                .font(.orbitProse.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if card.heldCount == 0 {
                Text(ProjectStartedCard.noneHeld)
                    .font(.orbitSubtext)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text(ProjectStartedCard.heldLead(card.heldCount))
                    .font(.orbitSubtext)
                    .fixedSize(horizontal: false, vertical: true)
                if !tasks.isEmpty { taskList }
                if let toggle = ProjectStartedCard.tasksToggle(card, expanded: allTasks) {
                    Button(toggle) { allTasks.toggle() }
                        .buttonStyle(.plain).font(.orbitLabel).foregroundStyle(.tint)
                }
                if unlisted > 0, allTasks || card.held.count <= ProjectStartedCard.tasksShown,
                   let url = ProjectStartedCard.projectLink(card) {
                    Button(ProjectStartedCard.moreInProject(unlisted)) { openURL(url) }
                        .buttonStyle(.plain).font(.orbitLabel).foregroundStyle(.tint)
                }
            }
            Text(ProjectStartedCard.meta(card, ts: ts))
                .font(.orbitMeta).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if undelivered {
                Text(ProjectStartedCard.undelivered)
                    .font(.orbitMeta).foregroundStyle(.orange)
            }
            raw
            if let attached { AttachedNoteEntry(attached: attached) }
            if let onCancelQueued { queuedFoot(onCancelQueued) }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tone.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
        // Dashed while it is still queued, as the other control-plane cards are.
        .overlay(
            RoundedRectangle(cornerRadius: 8).strokeBorder(
                tone.opacity(0.30),
                style: StrokeStyle(lineWidth: 1, dash: queued ? [4, 3] : []))
        )
    }

    /// "Project started · Criteria confirmed" — what this turn is, before what it is about.
    private var head: some View {
        HStack(spacing: 6) {
            Image(systemName: "play.circle.fill")
                .font(.orbitMeta).foregroundStyle(tone)
            Text(ProjectStartedCard.label(card.by))
                .font(.orbitLabel.weight(.semibold)).foregroundStyle(tone)
                .lineLimit(1)
            Spacer(minLength: 6)
            Text(ProjectStartedCard.kind(card.by))
                .font(.orbitMeta).foregroundStyle(.secondary)
                .lineLimit(1)
                .padding(.horizontal, 7).padding(.vertical, 2)
                .background(Color.primary.opacity(0.05), in: Capsule())
                .overlay(Capsule().strokeBorder(tone.opacity(0.30), lineWidth: 1))
        }
    }

    /// The tasks that wait on the coordinator, each a way into its task through the app's own
    /// `orbit-task:` door. An id that names no task is drawn as the title it is.
    private var taskList: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(tasks.enumerated()), id: \.element.id) { index, task in
                if index > 0 { Divider() }
                if let url = ProjectStartedCard.taskLink(task) {
                    Button {
                        openURL(url)
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(task.title)
                                .font(.orbitSubtext)
                                .multilineTextAlignment(.leading)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Image(systemName: "chevron.right")
                                .font(.orbitMeta).foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, 6)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).foregroundStyle(.tint)
                } else {
                    Text(task.title)
                        .font(.orbitSubtext)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 6)
                }
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
    }

    /// The queue's own line at the card's foot, in the words a queued message already uses.
    private func queuedFoot(_ cancel: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            Text("Queued").font(.orbitMeta).foregroundStyle(.secondary)
            Button("Cancel") { cancel() }
                .buttonStyle(.plain)
                .font(.orbitMeta)
                .foregroundStyle(.tint)
                .contentShape(Rectangle())
        }
    }

    /// The words the agent was handed, exactly as it read them — one tap away and folded by default.
    private var raw: some View {
        DisclosureGroup(isExpanded: $showingRaw) {
            Text(text)
                .font(.orbitMono)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 4)
        } label: {
            Text(ProjectStartedCard.told)
                .font(.orbitMeta)
                .foregroundStyle(.secondary)
        }
    }
}
