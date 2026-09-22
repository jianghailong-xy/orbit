import SwiftUI
import OrbitKit

/// An exception item's delivery to the coordinator, drawn as the card it already was in every other
/// surface — instead of 30 lines of prose inside the reader's own bubble.
///
/// The delivery is a `user` event the control plane opened, and its text is written for the AGENT: it
/// names the tools to call and the ids to call them with, and it says out loud that the platform will
/// not retry. A person watching the conversation gets none of that from a card, so this draws what
/// the payload records (OrbitKit's `OpenItemDelivery`, read out of `openItemDelivery`): what kind of
/// item it is, what it is about, the facts the item was opened with — the files a merge conflicted
/// on, the check that disagreed, the attempt that failed — the doors the coordinator has on it, and
/// the one thing the platform already knows and the coordinator otherwise re-checks by hand every
/// time: whether the work is on the target branch.
///
/// The words the agent read are not thrown away — they are one disclosure away at the bottom, which
/// is also where a reader finds the instruction this card deliberately does not repeat.
///
/// Built in the card language of `BackgroundWakeCardView` (amber, a glyph and a name, raised rows)
/// because it sits in the same place in the same transcript and is the control plane's for the same
/// reason: nobody typed it. Web parity: `OpenItemDeliveryCard.tsx`, with every word from OrbitKit's
/// `OpenItemDeliveryCard`, which `OpenItemDeliveryCopyParityTests` holds to the web's.
struct OpenItemDeliveryCardView: View {
    let card: OpenItemDelivery
    /// The words the agent was handed, verbatim — the record this card is drawn from.
    let text: String
    var ts: String?
    var undelivered: Bool = false
    /// Whatever else the same turn's note carried (a `controlPlaneNote`), as its own folded entry.
    /// It rides in the card because nobody typed this turn either: handing it back to a user bubble
    /// would draw the control plane's own words in the reader's name (web parity:
    /// `BackgroundWakeCardView.attached`).
    var attached: (kind: String, text: String)?
    /// Withdraws a delivery that is still queued behind the running turn. Nil once a runner has
    /// taken it — by then the turn is the transcript's, and there is nothing left to take back
    /// (web parity: the queue's own line, drawn at the card's foot).
    var onCancelQueued: (() -> Void)?

    @Environment(\.openURL) private var openURL
    @State private var allFiles = false
    @State private var showingRaw = false

    private var queued: Bool { onCancelQueued != nil }

    /// The card's one tone. An exception item is the project's business and asks nothing of whoever
    /// is watching, so it is drawn in the product's attention colour rather than an alarm's.
    private var tone: Color { .orange }
    private var why: String? { OpenItemDeliveryCard.headline(card) }
    private var landing: (text: String, landed: Bool)? { OpenItemDeliveryCard.landingLine(card) }
    private var doors: [String] { OpenItemDeliveryCard.actionLabels(card.actions) }
    private var files: [String] {
        allFiles ? card.files : Array(card.files.prefix(OpenItemDeliveryCard.filesShown))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            head
            Text(card.title)
                .font(.orbitProse.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let task = card.task { taskRow(task) }
            if let why {
                Text(why).font(.orbitProse)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !card.files.isEmpty { fileList }
            if let landing { facts(landing) }
            if !doors.isEmpty { doorsRow }
            links
            Text(OpenItemDeliveryCard.meta(card, ts: ts))
                .font(.orbitMeta).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if undelivered {
                // Amber, not red: the turn was handed to a session that has not confirmed it.
                Text(OpenItemDeliveryCard.undelivered)
                    .font(.orbitMeta).foregroundStyle(.orange)
            }
            raw
            if let attached { AttachedNoteEntry(attached: attached) }
            if let onCancelQueued { queuedFoot(onCancelQueued) }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tone.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
        // Dashed while it is still queued — the browser's `.oic.is-queued` border, so the one card
        // reads as two states rather than as two cards (`BackgroundWakeCardView`).
        .overlay(
            RoundedRectangle(cornerRadius: 8).strokeBorder(
                tone.opacity(0.35),
                style: StrokeStyle(lineWidth: 1, dash: queued ? [4, 3] : []))
        )
    }

    /// The queue's own line at the card's foot, in the words a queued message already uses: a
    /// delivery is withdrawn by an ordinary cancel — the item stays owed, and the next chance the
    /// control plane gets files a new turn for it — so unlike a watch's wake this asks nothing first.
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

    /// "Exception item · Merge conflict" — what this turn is, before what it is about.
    private var head: some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.orbitMeta).foregroundStyle(tone)
            Text(OpenItemDeliveryCard.header)
                .font(.orbitLabel.weight(.semibold)).foregroundStyle(tone)
                .lineLimit(1)
            Spacer(minLength: 6)
            Text(OpenItemDeliveryCard.kindLabel(card.kind))
                .font(.orbitMeta).foregroundStyle(.secondary)
                .lineLimit(1)
                .padding(.horizontal, 7).padding(.vertical, 2)
                .background(Color.primary.opacity(0.05), in: Capsule())
                .overlay(Capsule().strokeBorder(tone.opacity(0.35), lineWidth: 1))
        }
    }

    /// The task the item is about. Its title is the link — into the app's own `orbit-task:` door,
    /// the one a `#`-reference in prose is written as and both shells route (`ReferenceLink`).
    private func taskRow(_ task: OpenItemDeliveryTask) -> some View {
        let url = OpenItemDeliveryCard.taskLink(card)
        return HStack(spacing: 4) {
            Text("Task").font(.orbitLabel).foregroundStyle(.secondary)
            if let url {
                Button {
                    openURL(url)
                } label: {
                    Text(task.title)
                        .font(.orbitLabel)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain).foregroundStyle(.tint)
            } else {
                // An id that names no task is drawn as the title it is, not as a link that could
                // only do nothing.
                Text(task.title)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Spacer(minLength: 0)
        }
    }

    /// The files a conflicting merge reported, folded past the third — the one fact of this card a
    /// reader scans rather than reads.
    private var fileList: some View {
        VStack(alignment: .leading, spacing: 4) {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(files, id: \.self) { path in
                    Text(path)
                        .font(.orbitMono)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
            if let toggle = OpenItemDeliveryCard.filesToggle(total: card.files.count,
                                                              expanded: allFiles) {
                Button(toggle) { allFiles.toggle() }
                    .buttonStyle(.plain).font(.orbitLabel).foregroundStyle(.tint)
            }
        }
    }

    /// What the platform already knew about the work when it handed the item over: the one fact that
    /// used to cost the coordinator a re-check of the merge receipts every time an item came round.
    private func facts(_ landing: (text: String, landed: Bool)) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            if landing.landed {
                Image(systemName: "checkmark.circle.fill")
                    .font(.orbitMeta).foregroundStyle(.green)
            } else {
                // Not a cross: a receipt nobody wrote is no evidence either way.
                Text("◌").font(.orbitMeta).foregroundStyle(.secondary)
            }
            Text(landing.text)
                .font(.orbitLabel)
                .foregroundStyle(landing.landed ? Color.green : Color.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
    }

    /// The doors the coordinator has on this item, as the server decided them (§4.8) — named, not
    /// offered: the reader is watching somebody else's conversation, and the press belongs to it.
    private var doorsRow: some View {
        FlowLayout(spacing: 6) {
            Text(OpenItemDeliveryCard.doorsLead)
                .font(.orbitLabel).foregroundStyle(.secondary)
            ForEach(doors, id: \.self) { door in
                Text(door)
                    .font(.orbitLabel)
                    .padding(.horizontal, 8).padding(.vertical, 2)
                    .background(Color.primary.opacity(0.05), in: Capsule())
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Where the reader can go: the task, and the run that failed. Both are the app's own doors, so
    /// a tap lands on the screen the rest of the product already opens for that id.
    private var links: some View {
        HStack(spacing: 12) {
            if let url = OpenItemDeliveryCard.taskLink(card) {
                Button(OpenItemDeliveryCard.openTask) { openURL(url) }
                    .buttonStyle(.plain).font(.orbitLabel).foregroundStyle(.tint)
            }
            if let url = OpenItemDeliveryCard.sessionLink(card) {
                Button(OpenItemDeliveryCard.openSession) { openURL(url) }
                    .buttonStyle(.plain).font(.orbitLabel).foregroundStyle(.tint)
            }
            Spacer(minLength: 0)
        }
    }

    /// The paragraph the agent was handed, exactly as it read it — one tap away and folded by
    /// default. It is the instruction this card deliberately does not repeat.
    private var raw: some View {
        DisclosureGroup(isExpanded: $showingRaw) {
            Text(text)
                .font(.orbitMono)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 4)
        } label: {
            Text(OpenItemDeliveryCard.rawSummary)
                .font(.orbitMeta)
                .foregroundStyle(.secondary)
        }
    }
}
