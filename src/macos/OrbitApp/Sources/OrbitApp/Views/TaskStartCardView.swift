import SwiftUI
import OrbitKit

/// The turn that starts a task's run, drawn as the task it was built from — instead of the whole
/// brief in the account owner's own bubble, several screens long on a phone.
///
/// The brief is written for the AGENT: the task's description and criteria, then four steps of
/// protocol about which tools to call and which statuses never to write. A person reading the
/// conversation wants the first half and none of the second, so this draws the task — its title, its
/// project, the start of its description, how it will be judged — and keeps the rest behind Show
/// details. The protocol is not on the card at all: the brief is one disclosure away at the foot,
/// verbatim.
///
/// Built in the card language of `OpenItemDeliveryCardView` (a glyph and a name, raised rows, the
/// words the agent read folded at the bottom) because it sits in the same transcript for the same
/// reason — nobody typed it — in the app's tint rather than the attention colour: a run starting asks
/// nothing of whoever is watching. Web parity: `TaskStartCard.tsx`, with every word from OrbitKit's
/// `TaskStartCard`, which `TaskStartCopyParityTests` holds to the web's.
struct TaskStartCardView: View {
    let card: TaskStart
    /// The brief the agent was handed, verbatim — the record this card is drawn from.
    let text: String
    var ts: String?
    var undelivered: Bool = false
    /// Whatever else delivery appended to the same turn (a `controlPlaneNote`), as its own folded
    /// entry — the control plane's words stay in the card rather than in a bubble in the owner's name.
    var attached: (kind: String, text: String)?

    @Environment(\.openURL) private var openURL
    /// Where the project row goes: the app's own link door, which reads for the conversation that
    /// coordinates the project and falls back to the deployment's page when there is none.
    @Environment(AppModel.self) private var app: AppModel?
    @State private var showingDetails = false
    @State private var wholeCommand = false
    @State private var showingRaw = false
    /// Three lines of the description, folded. Scaled with the prose it measures, so a larger type
    /// size folds at three lines too rather than at two.
    @ScaledMetric(relativeTo: .body) private var foldHeight: CGFloat = TaskStartCardView.baseFoldHeight

    #if os(iOS)
    private static let baseFoldHeight: CGFloat = 70
    #else
    private static let baseFoldHeight: CGFloat = 56
    #endif

    private var folded: Bool { !showingDetails && TaskStartCard.foldsDescription(card) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            head
            Text(card.title)
                .font(.orbitProse.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let project = card.project { projectRow(project) }
            if let description = card.description { descriptionView(description) }
            if showingDetails {
                if let criteria = card.acceptanceCriteria {
                    // As written, the way the task page shows them: criteria are checks, not
                    // documents, and their globs (`RunnerEngines*`) read as emphasis as Markdown.
                    section(TaskStartCard.criteriaHeading) {
                        Text(criteria)
                            .font(.orbitProse)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                if let instructions = card.listInstructions {
                    section(TaskStartCard.instructionsHeading) {
                        MarkdownView(source: instructions, base: .body, ink: .primary)
                            .font(.orbitProse)
                            .textSelection(.enabled)
                    }
                }
            }
            if let judged = TaskStartCard.judgedBy(card) { judgedRow(judged) }
            links
            Text(TaskStartCard.meta(card, ts: ts))
                .font(.orbitMeta).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if undelivered {
                // Amber, not red: the turn was handed to a session that has not confirmed it.
                Text(TaskStartCard.undelivered)
                    .font(.orbitMeta).foregroundStyle(.orange)
            }
            raw
            if let attached { AttachedNoteEntry(attached: attached) }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.tint.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.tint.opacity(0.28), lineWidth: 1))
    }

    /// "▶ Task started · Auto-started" — what this turn is, before what it is about.
    private var head: some View {
        HStack(spacing: 6) {
            Image(systemName: "play.circle.fill")
                .font(.orbitMeta).foregroundStyle(.tint)
            Text(TaskStartCard.header)
                .font(.orbitLabel.weight(.semibold)).foregroundStyle(.tint)
                .lineLimit(1)
            Spacer(minLength: 6)
            if card.auto {
                Text(TaskStartCard.autoLabel)
                    .font(.orbitMeta).foregroundStyle(.secondary)
                    .lineLimit(1)
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(Color.primary.opacity(0.05), in: Capsule())
                    .overlay(Capsule().strokeBorder(.tint.opacity(0.35), lineWidth: 1))
            }
        }
    }

    /// The project the task is filed under. Its title is the link — the app's own `orbit-project:`
    /// door, the one a `#`-reference in prose is written as — and it opens where every other project
    /// link opens: the conversation that coordinates the project, or the deployment's own page. The
    /// door needs a read to answer that, which is why it is the model's and not the system's.
    private func projectRow(_ project: TaskStartProject) -> some View {
        HStack(spacing: 4) {
            Text(TaskStartCard.projectLabel).font(.orbitLabel).foregroundStyle(.secondary)
            if let url = TaskStartCard.projectLink(card) {
                Button {
                    // The app's own door; the system action is only for a card drawn with no app
                    // around it (a preview), where nothing else could open an `orbit-project:` URL.
                    if app?.openOrbitLink(url) != true { openURL(url) }
                } label: {
                    Text(project.title)
                        .font(.orbitLabel)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain).foregroundStyle(.tint)
            } else {
                Text(project.title)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    /// The description, folded to three lines until Show details — faded out rather than cut, so the
    /// fold reads as more to come and not as the end of the text.
    @ViewBuilder
    private func descriptionView(_ description: String) -> some View {
        let prose = MarkdownView(source: description, base: .body, ink: .primary)
            .font(.orbitProse)
            .textSelection(.enabled)
        if folded {
            prose
                .frame(maxHeight: foldHeight, alignment: .top)
                .clipped()
                .mask {
                    LinearGradient(stops: [.init(color: .black, location: 0),
                                           .init(color: .black, location: 0.7),
                                           .init(color: .clear, location: 1)],
                                   startPoint: .top, endPoint: .bottom)
                }
        } else {
            prose
        }
    }

    private func section<Content: View>(_ heading: String,
                                        @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(heading)
                .font(.orbitLabel.weight(.semibold)).foregroundStyle(.secondary)
            content()
        }
        .padding(.top, 4)
    }

    /// How the run will be judged, and — for an EXECUTABLE task — the command that judges it: one
    /// line while the card is shut, three once it is open, all of it on a second tap. The command is
    /// written for a machine, so even an open card does not unroll it unasked.
    private func judgedRow(_ judged: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "checkmark.seal")
                    .font(.orbitMeta).foregroundStyle(.secondary)
                Text(judged).font(.orbitLabel.weight(.medium))
            }
            if let how = TaskStartCard.judgedHow(card) {
                Text(how)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let command = TaskStartCard.command(card) {
                Text(command)
                    .font(.orbitMono).foregroundStyle(.secondary)
                    .lineLimit(showingDetails ? (wholeCommand ? nil : 3) : 1)
                    .truncationMode(.tail)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if showingDetails {
                    Button(wholeCommand ? TaskStartCard.hideCommand : TaskStartCard.showCommand) {
                        wholeCommand.toggle()
                    }
                    .buttonStyle(.plain).font(.orbitLabel).foregroundStyle(.tint)
                }
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
    }

    /// Show details on the left when there is anything behind it, and the task's own door on the
    /// right. Opened and shut instantly: animating a row the List is re-measuring is the flicker
    /// `ToolGroupCardView` documents.
    private var links: some View {
        HStack(spacing: 12) {
            if TaskStartCard.hasDetails(card) {
                Button {
                    showingDetails.toggle()
                } label: {
                    HStack(spacing: 4) {
                        Text(showingDetails ? TaskStartCard.hideDetails : TaskStartCard.showDetails)
                        Image(systemName: showingDetails ? "chevron.up" : "chevron.down")
                            .font(.orbitMeta)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain).font(.orbitLabel).foregroundStyle(.tint)
            }
            Spacer(minLength: 0)
            if let url = TaskStartCard.taskLink(card) {
                Button(TaskStartCard.openTask) { openURL(url) }
                    .buttonStyle(.plain).font(.orbitLabel).foregroundStyle(.tint)
            }
        }
        .animation(nil, value: showingDetails)
    }

    /// The brief the agent was handed, exactly as it read it — one tap away and folded by default. It
    /// holds the protocol this card deliberately does not repeat.
    private var raw: some View {
        DisclosureGroup(isExpanded: $showingRaw) {
            Text(text)
                .font(.orbitMono)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 4)
        } label: {
            Text(TaskStartCard.rawSummary)
                .font(.orbitMeta)
                .foregroundStyle(.secondary)
        }
    }
}
