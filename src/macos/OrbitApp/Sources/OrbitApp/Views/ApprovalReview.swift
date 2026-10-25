import SwiftUI
import OrbitKit

/// Stores an address, so the review continues to read live state after its transcript row moves.
enum ApprovalReviewTarget: Identifiable {
    case approval(id: String)
    case delivered(DeliveredDecisionCard)

    var id: String {
        switch self {
        case .approval(let id): return "approval-\(id)"
        case .delivered(let card): return card.id
        }
    }
}

private struct OpenApprovalReviewKey: EnvironmentKey {
    static let defaultValue: (ApprovalReviewTarget) -> Void = { _ in }
}

private struct ApprovalReviewTargetKey: EnvironmentKey {
    static let defaultValue: ApprovalReviewTarget? = nil
}

private struct InApprovalReviewKey: EnvironmentKey {
    static let defaultValue = false
}

private struct DismissApprovalReviewKey: EnvironmentKey {
    static let defaultValue: () -> Void = {}
}

/// A card answered in THIS review, drawn as its record: the title the sheet takes, the line where
/// its buttons were, and what the card needs to show the answer it was given.
struct ReviewRecord {
    let title: String
    let footer: ReviewRecordFooter
    /// The labels an AskUserQuestion sent, by question — what its record ticks.
    var answers: [String: [String]]? = nil
    /// Dimmed, so the record does not read as something still to press. A question's record is
    /// not: it greys what was not picked instead, the coordinator question's way.
    var dimsContent = true
}

private struct ReviewRecordKey: EnvironmentKey {
    static let defaultValue: ReviewRecord? = nil
}

extension EnvironmentValues {
    var openApprovalReview: (ApprovalReviewTarget) -> Void {
        get { self[OpenApprovalReviewKey.self] }
        set { self[OpenApprovalReviewKey.self] = newValue }
    }

    var approvalReviewTarget: ApprovalReviewTarget? {
        get { self[ApprovalReviewTargetKey.self] }
        set { self[ApprovalReviewTargetKey.self] = newValue }
    }

    var inApprovalReview: Bool {
        get { self[InApprovalReviewKey.self] }
        set { self[InApprovalReviewKey.self] = newValue }
    }

    var dismissApprovalReview: () -> Void {
        get { self[DismissApprovalReviewKey.self] }
        set { self[DismissApprovalReviewKey.self] = newValue }
    }

    /// Set on a card the review answered: the card draws itself as its record, read-only.
    var reviewRecord: ReviewRecord? {
        get { self[ReviewRecordKey.self] }
        set { self[ReviewRecordKey.self] = newValue }
    }
}

/// One compact transcript preview and a scrolling review with its decisions always in reach.
struct ApprovalReviewLayout<Content: View, Actions: View>: View {
    @Environment(\.inApprovalReview) private var inReview
    @Environment(\.reviewRecord) private var record
    @Environment(\.approvalReviewTarget) private var target
    @Environment(\.openApprovalReview) private var openReview
    let title: String
    let symbol: String
    let tone: Color
    let summary: String
    let dimmed: Bool
    let badge: String?
    /// The review drawn as a grouped page: cards on the grouped backdrop. The batch card's review
    /// draws its content as cards, and the other reviews keep the plain sheet they were built on.
    let grouped: Bool
    private let content: Content
    private let actions: Actions

    init(title: String, symbol: String, tone: Color, summary: String, dimmed: Bool = false,
         badge: String? = nil, grouped: Bool = false,
         @ViewBuilder content: () -> Content, @ViewBuilder actions: () -> Actions) {
        self.title = title
        self.symbol = symbol
        self.tone = tone
        self.summary = summary
        self.dimmed = dimmed
        self.badge = badge
        self.grouped = grouped
        self.content = content()
        self.actions = actions()
    }

    var body: some View {
        if inReview {
            ScrollView {
                VStack(alignment: .leading, spacing: ApprovalMetrics.spacing) {
                    if let badge {
                        Text(badge).font(.orbitLabel.weight(.semibold)).foregroundStyle(tone)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    content
                }
                .opacity(record?.dimsContent == true ? 0.6 : 1)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
            }
            .background {
                if grouped { Color.reviewBackdrop.ignoresSafeArea() }
            }
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: ApprovalMetrics.spacing) {
                    Divider()
                    // Answered here: where the buttons were, who answered and when.
                    if let record {
                        ReviewRecordFooterView(footer: record.footer)
                    } else {
                        actions
                    }
                }
                .padding(.horizontal).padding(.bottom)
                .background(.bar)
            }
            .navigationTitle(record?.title ?? title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
        } else if let target {
            Button { openReview(target) } label: {
                VStack(alignment: .leading, spacing: ApprovalMetrics.spacing) {
                    ApprovalHeader(symbol: symbol, title: title, tone: tone, badge: badge)
                    Text(summary)
                        .font(.orbitLabel).foregroundStyle(.secondary)
                        .lineLimit(3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Divider()
                    HStack {
                        Text(dimmed ? "View details" : "View details & act")
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.right")
                    }
                    .font(.orbitLabel.weight(.semibold)).foregroundStyle(Color.accentColor)
                }
                .approvalChrome(tone, dimmed: dimmed)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        } else {
            // The shared start form also appears directly on the project page.
            VStack(alignment: .leading, spacing: ApprovalMetrics.spacing) {
                ApprovalHeader(symbol: symbol, title: title, tone: tone, badge: badge)
                content
                actions
            }
            .approvalChrome(tone, dimmed: dimmed)
        }
    }
}

/// The beat between the press and the door's answer: the card is optimistically gone, and nothing
/// is decided yet. A state of its own rather than the fallback below, because the answer has NOT
/// gone away — it is on its way, and a refusal has to leave the reader here with the card back.
private struct ApprovalAnswerUnderWay: View {
    var body: some View {
        VStack(spacing: 10) {
            ProgressView()
            Text("Sending your answer…")
                .font(.orbitProse).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
        .navigationTitle("Sending")
    }
}

/// Where a review's buttons were, once its own answer was taken: who answered and when, then what
/// became of it — the coordinator question's record footer, for every card (`ReviewRecords`).
struct ReviewRecordFooterView: View {
    let footer: ReviewRecordFooter

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: symbol).foregroundStyle(footer.mark == .done ? Color.green : Color.secondary)
                Text(footer.line).font(.orbitProse.weight(.semibold))
            }
            if let detail = footer.detail {
                Text(detail)
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .padding(.leading, 22)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var symbol: String {
        switch footer.mark {
        case .done:     return "checkmark.circle.fill"
        case .keptOpen: return "arrow.uturn.backward.circle.fill"
        case .refused:  return "xmark.circle.fill"
        }
    }
}

/// The one way a sheet still leaves on its own: a card this window answered whose record it has
/// no copy of. Every card the review presses keeps one, so this is a guard, not a path.
private struct ReviewAnswered: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Color.clear.task { dismiss() }
    }
}

/// The review's ✕, on its first page and on every page pushed onto it. On iOS it sits where the
/// share sheet's Done does (`.topBarTrailing`): iOS 26 draws `.confirmationAction` as the prominent
/// filled button, which made a second blue yes beside the card's own. The Mac draws that placement
/// plainly, so it keeps it.
struct ApprovalReviewCloseButton: ToolbarContent {
    let close: () -> Void

    var body: some ToolbarContent {
        #if os(iOS)
        ToolbarItem(placement: .topBarTrailing) {
            Button("Close", systemImage: "xmark", action: close)
                .labelStyle(.iconOnly)
        }
        #else
        ToolbarItem(placement: .confirmationAction) {
            Button("Close", systemImage: "xmark", action: close)
                .labelStyle(.iconOnly)
        }
        #endif
    }
}

/// Presented by ConsoleView, outside the transcript's recyclable rows.
struct ApprovalReviewSheet: View {
    @Environment(\.dismiss) private var dismiss
    let console: ConsoleModel
    let target: ApprovalReviewTarget
    @State private var reviewStatusMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                switch target {
                case .approval(let id):
                    if let approval = console.state.pendingApprovals.first(where: { $0.id == id }) {
                        ApprovalCard(console: console, approval: approval)
                    } else if let answer = console.approvalAnswers[id] {
                        // Gone because the reader answered it. The fallback below is for the OTHER
                        // way a request goes away, and saying it here would read the reader's own
                        // press back to them as somebody else's news.
                        switch answer {
                        case .sending: ApprovalAnswerUnderWay()
                        // The card as it was asked, as its record: the answer it was given ticked,
                        // and who gave it where its buttons were.
                        case .sent(let answered):
                            ApprovalCard(console: console, approval: answered.approval)
                                .environment(\.reviewRecord, answered.record)
                        }
                    } else {
                        Text("This request is no longer waiting for an answer.")
                            .font(.orbitProse).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .padding()
                            .navigationTitle("Request closed")
                    }
                case .delivered(let card):
                    if console.answeredHere(card) {
                        // Closed HERE (`close(_:)`): the card as it was asked, as its record. The
                        // live card would read its own answer back as somebody else's.
                        if let answered = console.answeredDecision(card) {
                            AnsweredDecisionView(console: console, answered: answered)
                        } else {
                            ReviewAnswered()
                        }
                    } else {
                        DeliveredDecisionCardView(console: console, card: card)
                    }
                }
            }
            .environment(\.inApprovalReview, true)
            .environment(\.dismissApprovalReview, { dismiss() })
            .safeAreaInset(edge: .top, spacing: 0) {
                if let reviewStatusMessage {
                    Text(reviewStatusMessage)
                        .font(.orbitLabel).foregroundStyle(.orange).lineLimit(4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding()
                        .background(.bar)
                }
            }
            // Existing composer notices do not belong to a newly opened review. New failures
            // must remain visible here even if an optimistic answer briefly removed its card.
            .onChange(of: console.statusMessageRevision) { _, _ in
                reviewStatusMessage = console.statusMessage
            }
            .toolbar { ApprovalReviewCloseButton { dismiss() } }
        }
        .task {
            await console.refreshRulerQuestions(force: true)
            await console.refreshOwnerConfirmation()
        }
        #if os(iOS)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        #else
        .frame(minWidth: 520, minHeight: 560)
        #endif
    }
}

extension ConsoleModel.AnsweredApproval {
    /// The record the review draws this approval as: the sheet's title, and the line where its
    /// buttons were. A question ticks what it sent rather than dimming; the rest dim.
    var record: ReviewRecord {
        switch approval.kind {
        case .question:
            return ReviewRecord(title: ReviewRecords.answeredTitle, footer: ReviewRecords.question(at: at),
                                answers: answers ?? [:], dimsContent: false)
        case .plan:
            return ReviewRecord(title: ReviewRecords.answeredTitle,
                                footer: ReviewRecords.plan(approved: behavior == .allow, at: at))
        case .tool:
            // Only Orbit's own asks are answered in a review, and their no goes to the composer.
            return ReviewRecord(title: ReviewRecords.answeredTitle, footer: ReviewRecords.toolAsk(at: at))
        }
    }
}
