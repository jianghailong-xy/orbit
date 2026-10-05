import SwiftUI
import OrbitKit

// MARK: - "Is this project done?", its receipt, and "Why is this project not done?"

/// The closing cards, drawn from what they are given and from nothing else — the coordinator
/// conversation's cards (`ApprovalCards.swift`) and the project page's own Review / Record as done…
/// (`ProjectsView`) both draw these, the way the browser's `ProjectDoneCard` and
/// `ProjectWhyNotDoneCard` are drawn by `SessionProjectSettlementCard` and `ProjectDoneDialog`.
///
/// Every word is OrbitKit's `ProjectDone`, held to the browser's `lib/projectDone.ts` by
/// `ProjectDoneCopyParityTests`; every number is the server's (`derivedDone.counts`), and nothing
/// here counts anything itself.

/// "Is this project done?" — the coordinator's call, Done when, what Orbit can't prove, what Orbit
/// checked, and the two answers — or, once the project is recorded done, its receipt.
///
/// The look is the start card's: the same blue surface and header, the same white grouped panels.
/// It is the whole card wherever it is drawn — in the coordinator conversation, where it arrived,
/// and over the project page — never a preview that opens a review (`ApprovalReviewLayout`'s
/// whole-card path: nobody hands it a review target).
struct ProjectDoneCard: View {
    let subject: ProjectDoneSubject
    /// The coordinator's request, or nil for a card nobody asked for — Orbit then fills in the gaps.
    let request: DoneRequest?
    /// When the coordinator asked; nil when nobody did.
    let askedAt: String?
    /// When the owner confirmed the criteria, for the Orbit checked line; nil when unread.
    let confirmedAt: String?
    /// How many open items, and how many landings, the Orbit checked line counts.
    let openItems: Int
    let running: Int
    /// What a press here recorded, before the reads catch up with it.
    let record: ProjectDoneRecord?
    /// Whether the seal a press would name has been read: the press is dark until it has.
    let sealRead: Bool
    /// A press the door did not take, in its own words.
    var error: String? = nil
    let onRecord: () async -> Void
    /// "Not yet…", answered with the owner's note — nil where there is no request to answer. Says
    /// whether the note went.
    var onNotYet: ((String) async -> Bool)? = nil
    /// Reopen project, on the receipt.
    var onReopen: (() async -> Void)? = nil

    @Environment(\.inApprovalReview) private var inReview
    @State private var recording = false
    @State private var notYetOpen = false
    @State private var note = ""
    @State private var sending = false
    @State private var criteriaOpen = false

    var body: some View {
        if ProjectDone.recorded(subject, record: record) {
            // Recorded while its review was open: the receipt takes the review's place.
            if inReview {
                ScrollView {
                    ProjectDoneReceiptCard(subject: subject, record: record, onReopen: onReopen).padding()
                }
                .navigationTitle(ProjectDone.thisProjectIsDone)
            } else {
                ProjectDoneReceiptCard(subject: subject, record: record, onReopen: onReopen)
            }
        } else {
            question
        }
    }

    private var counts: ProjectDoneCounts? { subject.counts }
    private var gaps: [AcceptedGap] { ProjectDone.gaps(subject, request: request) }

    /// How long ago the coordinator asked, in this platform's own clock words; nil for a card nobody
    /// asked for.
    private var askedAgo: String? {
        guard request != nil else { return nil }
        return askedAt.flatMap { RelativeTime.format($0) } ?? "just now"
    }

    private var question: some View {
        ApprovalReviewLayout(title: ProjectDone.heading, symbol: "checkmark.circle", tone: .blue,
                             summary: "\(subject.title) · \(ProjectDone.cardTally(counts))",
                             badge: doneQuestionBadge) {
            content
        } actions: {
            ApprovalActions {
                if notYetOpen, let onNotYet {
                    sendButton(onNotYet)
                    backButton
                } else {
                    recordButton
                    if request != nil, onNotYet != nil { notYetButton }
                }
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        Text(ProjectDone.meta(projectTitle: subject.title, askedAgo: askedAgo))
            .font(.orbitLabel).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
        if let request {
            DoneSectionHead(title: ProjectDone.coordinatorCall)
            DonePanel {
                Text(request.judgment)
                    .font(.orbitProse)
                    .fixedSize(horizontal: false, vertical: true)
                    .doneRow()
            }
        }
        doneWhen
        ProjectDoneGapList(subject: subject, gaps: gaps)
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.green)
            Text(ProjectDone.orbitCheckedLine(counts: counts, confirmedAt: confirmedAt,
                                              openItems: openItems, running: running))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(.orbitLabel)
        Text(ProjectDone.recordingExplanation)
            .font(.orbitProse)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
        if let error {
            Text("\(ProjectDone.notRecorded) — \(error)")
                .font(.orbitLabel).foregroundStyle(Color.red)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        if notYetOpen {
            VStack(alignment: .leading, spacing: 6) {
                TextField(ProjectDone.missingBeforeDone, text: $note, axis: .vertical)
                    .lineLimit(2...5)
                    .font(.orbitProse)
                    .textFieldStyle(.roundedBorder)
                    .disabled(sending)
                Text(ProjectDone.notYetHint)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// Done when: the three counts, and every criterion one toggle away.
    @ViewBuilder
    private var doneWhen: some View {
        let criteria = subject.derivedDone?.criteria ?? []
        let count = counts?.criteria ?? criteria.count
        DoneSectionHead(title: ProjectDone.doneWhenHead(count),
                        aside: count > 0 ? (criteriaOpen ? ProjectDone.showLess : ProjectDone.showAll(count)) : nil,
                        onAside: { criteriaOpen.toggle() })
        Text(ProjectDone.cardTally(counts))
            .font(.orbitLabel).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
        if criteriaOpen {
            DonePanel {
                ForEach(Array(criteria.enumerated()), id: \.element.id) { index, criterion in
                    if index > 0 { Divider() }
                    let item = subject.criterion(criterion.definitionId)
                    HStack(alignment: .top, spacing: 8) {
                        DoneOrdinal(text: "\(item?.ordinal ?? index + 1)")
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item?.text ?? criterion.definitionId).font(.orbitSubtext)
                                .fixedSize(horizontal: false, vertical: true)
                            Text(ProjectDone.criterionState(criterion))
                                .font(.orbitLabel).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                    }
                    .doneRow()
                }
            }
        }
    }

    // MARK: the answers

    /// One press, one write: the seal and the gaps the card shows (`ProjectDone.body`).
    private var recordButton: some View {
        Button {
            guard sealRead, !recording else { return }
            PlatformHaptics.tap()
            recording = true
            Task {
                await onRecord()
                recording = false
            }
        } label: {
            Text(ProjectDone.recordLabel(counts)).approvalActionLabel()
        }
        .buttonStyle(.borderedProminent)
        .disabled(recording || !sealRead)
    }

    private var notYetButton: some View {
        Button {
            PlatformHaptics.tap()
            notYetOpen = true
        } label: {
            Text(ProjectDone.notYet).approvalActionLabel()
        }
        .buttonStyle(.bordered)
        .disabled(recording)
    }

    private func sendButton(_ send: @escaping (String) async -> Bool) -> some View {
        Button {
            guard let text = ProjectDone.declineNote(note), !sending else { return }
            PlatformHaptics.tap()
            sending = true
            Task {
                if await send(text) {
                    note = ""
                    notYetOpen = false
                }
                sending = false
            }
        } label: {
            Text(ProjectDone.sendToCoordinator).approvalActionLabel()
        }
        .buttonStyle(.borderedProminent)
        .disabled(sending || ProjectDone.declineNote(note) == nil)
    }

    private var backButton: some View {
        Button {
            notYetOpen = false
        } label: {
            Text(ProjectDone.back).approvalActionLabel()
        }
        .buttonStyle(.bordered)
        .disabled(sending)
    }
}

/// What Orbit can't prove: each gap under the criterion it names, why Orbit cannot prove it, and
/// what the coordinator checked instead — three at a time, the rest one press away.
struct ProjectDoneGapList: View {
    let subject: ProjectDoneSubject
    let gaps: [AcceptedGap]
    @State private var expanded = false

    var body: some View {
        DoneSectionHead(title: ProjectDone.gapsHead(gaps.count))
        if gaps.isEmpty {
            Text(ProjectDone.noGaps)
                .font(.orbitLabel).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            let shown = expanded ? gaps : Array(gaps.prefix(3))
            DonePanel {
                ForEach(Array(shown.enumerated()), id: \.offset) { index, gap in
                    if index > 0 { Divider() }
                    row(gap, index: index)
                }
            }
            if !expanded, gaps.count > shown.count {
                Button {
                    expanded = true
                } label: {
                    Text(ProjectDone.showAll(gaps.count)).font(.orbitLabel).foregroundStyle(Color.blue)
                }
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func row(_ gap: AcceptedGap, index: Int) -> some View {
        let item = subject.criterion(gap.criterionKey)
        return HStack(alignment: .top, spacing: 8) {
            DoneOrdinal(text: "\(item?.ordinal ?? index + 1)")
            VStack(alignment: .leading, spacing: 3) {
                Text(gap.title ?? item?.text ?? gap.criterionKey)
                    .font(.orbitSubtext.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                if let why = gap.whyNotProven {
                    Text(why).font(.orbitLabel).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let checked = ProjectDone.checkedLine(gap) {
                    (Text("✓ \(ProjectDone.coordinatorChecked): ").bold().foregroundStyle(Color.green)
                        + Text(checked))
                        .font(.orbitLabel)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .doneRow()
    }
}

/// The record a press leaves — "This project is done", who recorded it and when, what was accepted,
/// and the way back: Reopen project.
struct ProjectDoneReceiptCard: View {
    let subject: ProjectDoneSubject
    let record: ProjectDoneRecord?
    var onReopen: (() async -> Void)? = nil
    @State private var reopening = false
    @State private var acceptedOpen = false

    var body: some View {
        let accepted = ProjectDone.accepted(subject, record: record)
        VStack(alignment: .leading, spacing: ApprovalMetrics.spacing) {
            ApprovalHeader(symbol: "checkmark.circle.fill", title: ProjectDone.thisProjectIsDone,
                           tone: .green, badge: ProjectDone.provenance)
            Text(ProjectDone.receiptMeta(subject, record: record))
                .font(.orbitLabel).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(ProjectDone.receiptLine(subject, record: record))
                .font(.orbitProse.weight(.semibold))
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(ProjectDone.receiptTally(subject, record: record))
                .font(.orbitLabel).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !accepted.isEmpty {
                Button {
                    acceptedOpen.toggle()
                } label: {
                    Text(acceptedOpen ? ProjectDone.showLess : ProjectDone.seeWhatAccepted)
                        .font(.orbitLabel).foregroundStyle(Color.blue)
                }
                .buttonStyle(.plain)
                if acceptedOpen {
                    ProjectDoneGapList(subject: subject, gaps: accepted)
                }
            }
            if let onReopen {
                ApprovalActions {
                    Button {
                        guard !reopening else { return }
                        PlatformHaptics.tap()
                        reopening = true
                        Task {
                            await onReopen()
                            reopening = false
                        }
                    } label: {
                        Text(ProjectDone.reopenProject).approvalActionLabel()
                    }
                    .buttonStyle(.bordered)
                    .disabled(reopening)
                }
            }
        }
        .approvalChrome(.green)
    }
}

/// "Why is this project not done?" — the criteria the projection is waiting on, in two groups: the
/// work (and who has it), and the calls only the owner can make. Read off each criterion's own
/// answer (`ProjectDone.WhyNotDone`); nothing here decides what landed.
struct ProjectNotDoneCard: View {
    let subject: ProjectDoneSubject
    /// How many open items are with the coordinator — somebody is on the work.
    let withCoordinator: Int
    /// When the coordinator asked to record the project done, or nil while nobody has.
    let askedAt: String?
    var onReview: (() -> Void)? = nil
    var onAskCoordinator: (() -> Void)? = nil

    var body: some View {
        let why = ProjectDone.WhyNotDone(subject: subject, withCoordinator: withCoordinator,
                                         requested: askedAt != nil && onReview != nil)
        VStack(alignment: .leading, spacing: ApprovalMetrics.spacing) {
            if why.settled(subject) {
                ApprovalHeader(symbol: "checkmark.circle.fill", title: ProjectDone.thisProjectIsDone,
                               tone: .green, badge: ProjectDone.settledBadge(subject.doneBy))
                tally
            } else {
                ApprovalHeader(symbol: "questionmark.circle", title: ProjectDone.whyHeading, tone: .blue,
                               badge: doneQuestionBadge)
                if !why.waiting.isEmpty {
                    group(ProjectDone.waitingOnWork, why.waiting, waiting: true,
                          aside: why.coordinatorOnIt ? "● \(ProjectDone.coordinatorIsOnIt)" : nil)
                }
                if !why.needsCall.isEmpty {
                    group(ProjectDone.needsYourCall, why.needsCall, waiting: false,
                          aside: askedAt.map { ProjectDone.askedAside(RelativeTime.format($0) ?? "just now") })
                }
                tally
                actions(why)
            }
        }
        .approvalChrome(why.settled(subject) ? .green : .blue)
    }

    private var tally: some View {
        Text(ProjectDone.whyNotDoneTally(subject.counts))
            .font(.orbitLabel).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func group(_ title: String, _ rows: [ProjectDoneCriterion], waiting: Bool,
                       aside: String?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(title)
                    .font(.orbitLabel.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                Spacer(minLength: 4)
                if let aside {
                    Text(aside).font(.orbitLabel)
                        .foregroundStyle(waiting ? Color.green : Color.secondary)
                        .lineLimit(1)
                }
            }
            DonePanel {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, criterion in
                    if index > 0 { Divider() }
                    let item = subject.criterion(criterion.definitionId)
                    HStack(alignment: .top, spacing: 8) {
                        DoneOrdinal(text: item.map { "\($0.ordinal)" } ?? "•")
                        VStack(alignment: .leading, spacing: 3) {
                            Text(item?.text ?? criterion.definitionId)
                                .font(.orbitSubtext.weight(.semibold))
                                .fixedSize(horizontal: false, vertical: true)
                            Text(ProjectDone.landingReasonLabel(criterion.landingReason))
                                .font(.orbitLabel).foregroundStyle(.secondary)
                            Text(waiting ? ProjectDone.waitingDetail : ProjectDone.needsCallDetail)
                                .font(.orbitLabel).foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                    }
                    .doneRow()
                }
            }
        }
    }

    @ViewBuilder
    private func actions(_ why: ProjectDone.WhyNotDone) -> some View {
        let action = why.action
        if action != nil || why.saysCoordinatorIsOnIt {
            ApprovalActions {
                if action == .review, let onReview {
                    Button {
                        PlatformHaptics.tap()
                        onReview()
                    } label: {
                        Text(ProjectDone.reviewDoneRequest).approvalActionLabel()
                    }
                    .buttonStyle(.borderedProminent)
                } else if action == .askCoordinator, let onAskCoordinator {
                    Button {
                        PlatformHaptics.tap()
                        onAskCoordinator()
                    } label: {
                        Text(ProjectDone.askCoordinator).approvalActionLabel()
                    }
                    .buttonStyle(.bordered)
                }
                if why.saysCoordinatorIsOnIt {
                    Text(ProjectDone.coordinatorIsOnIt)
                        .font(.orbitLabel).foregroundStyle(.secondary)
                }
            }
        }
    }
}

// MARK: - the project page's two rows

/// The coordinator's request in the project page's Open items: Ready to close, the card's question,
/// who asked and how many gaps it could not prove, and Review — which opens the same card.
struct ProjectDoneRequestRow: View {
    let row: ProjectOpenItemRow
    let now: Date
    var busy = false
    let onReview: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Circle().fill(Color.orange).frame(width: 8, height: 8)
                Text(ProjectDone.readyToClose)
                    .font(.orbitMeta.weight(.semibold))
                    .foregroundStyle(Color.orange)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(ProjectDone.heading).font(.orbitSubtext.weight(.semibold))
                Text(ProjectDone.requestRowDetail(row))
                    .font(.orbitLabel).foregroundStyle(.secondary)
                Text("\(ProjectPage.who(row)) · \(ProjectPage.waitingLabel(row, now: now))")
                    .font(.orbitMeta)
                    .foregroundStyle(.secondary)
            }
            .fixedSize(horizontal: false, vertical: true)
            Button(action: onReview) {
                Text(ProjectPage.actionLabel(.review) ?? "").frame(maxWidth: .infinity)
            }
            .font(.orbitLabel.weight(.semibold))
            .buttonStyle(.borderedProminent)
            .tint(Color.accentColor)
            .buttonBorderShape(.capsule)
            .controlSize(.large)
            .disabled(busy)
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .onTapGesture { if !busy { onReview() } }
    }
}

/// The owner's own Record as done… — nobody asked, so it is quiet, and opens the same card over the
/// page with the facts Orbit fills in.
struct ProjectOwnDoneRow: View {
    var busy = false
    let onRecord: () -> Void

    var body: some View {
        Button(action: onRecord) {
            HStack(alignment: .center, spacing: 10) {
                Circle().fill(Color.secondary.opacity(0.45)).frame(width: 8, height: 8)
                VStack(alignment: .leading, spacing: 2) {
                    Text(ProjectDone.recordAsDoneRow)
                        .font(.orbitSubtext.weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                    Text(ProjectDone.notAskedYet).font(.orbitLabel).foregroundStyle(.secondary)
                }
                Spacer(minLength: 6)
                Image(systemName: "chevron.forward")
                    .font(.orbitMeta.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }
}

// MARK: - the pieces

/// The provenance badge beside either card's question (`FROM ORBIT`, as the browser's cards carry
/// it). On a phone the question takes the whole row and the badge would be cut to "FRO…BIT", so it
/// is left off there, as the phone mock leaves it off.
private var doneQuestionBadge: String? {
    #if os(iOS)
    return nil
    #else
    return ProjectDone.provenance
    #endif
}

/// A section's head on the done cards: small, upper-cased, secondary — with a press at its trailing
/// edge where the section folds.
private struct DoneSectionHead: View {
    let title: String
    var aside: String? = nil
    var onAside: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(title)
                .font(.orbitLabel.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            Spacer(minLength: 4)
            if let aside {
                Button {
                    onAside?()
                } label: {
                    Text(aside).font(.orbitLabel).foregroundStyle(Color.blue).lineLimit(1)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.top, 4)
    }
}

/// The white grouped panel the done cards' sections sit in, rows divided by hairlines — the start
/// card's own panel.
private struct DonePanel<Content: View>: View {
    private let content: () -> Content

    init(@ViewBuilder content: @escaping () -> Content) { self.content = content }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content() }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(light: .white, dark: Color(red: 0.17, green: 0.17, blue: 0.18)),
                        in: RoundedRectangle(cornerRadius: 12))
            .overlay {
                RoundedRectangle(cornerRadius: 12).strokeBorder(Color.primary.opacity(0.05))
            }
    }
}

/// A criterion's number, in the dark disc the browser's cards number their rows with.
private struct DoneOrdinal: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.orbitMeta.weight(.bold))
            .monospacedDigit()
            .foregroundStyle(Color(light: .white, dark: .black))
            .frame(minWidth: 18, minHeight: 18)
            .background(Color.primary, in: Circle())
    }
}

private extension View {
    /// One row of a `DonePanel`: the grouped list's own insets.
    func doneRow() -> some View {
        padding(.horizontal, 12).padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
