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
}

/// One compact transcript preview and a scrolling review with its decisions always in reach.
struct ApprovalReviewLayout<Content: View, Actions: View>: View {
    @Environment(\.inApprovalReview) private var inReview
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
                    actions
                }
                .padding(.horizontal).padding(.bottom)
                .background(.bar)
            }
            .navigationTitle(title)
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

/// The press's own outcome, drawn once the door has taken it, for the moment before the sheet
/// leaves with the request it just answered.
///
/// A receipt rather than a dismissal on the press, because nothing is decided until the door has
/// it — a refusal leaves the reader here, with the card re-seeded and the reason above it. And a
/// receipt rather than nothing, because this is the one surface still showing the question (the
/// transcript's card is already gone) and the reader is owed the words for what happened to their
/// press. Not for the other way a subject goes away: that one keeps the card and says so.
private struct ReviewReceipt: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let detail: String

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "checkmark.circle.fill")
                .font(.orbitHeroGlyph).foregroundStyle(.green)
            Text(title).font(.orbitProse.weight(.semibold))
            Text(detail).font(.orbitLabel).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
        .navigationTitle("Answered")
        // Long enough to read two lines, short enough not to be a thing to dismiss. The Close
        // button stays live throughout, and a sheet closed by hand cancels this with the view.
        .task {
            try? await Task.sleep(for: .seconds(1.2))
            dismiss()
        }
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
                        case .sent:    ReviewReceipt(
                            title: "Answer sent",
                            detail: "The agent has been told, and this request has nothing left to answer.")
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
                        // Closed HERE (`close(_:)`): the question is over, and the record the read
                        // publishes where the decision was made is what the conversation keeps.
                        ReviewReceipt(
                            title: "Decision recorded",
                            detail: "The conversation keeps the record where it was made.")
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
