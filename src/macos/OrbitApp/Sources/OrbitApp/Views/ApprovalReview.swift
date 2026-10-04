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
    private let content: Content
    private let actions: Actions

    init(title: String, symbol: String, tone: Color, summary: String, dimmed: Bool = false,
         badge: String? = nil,
         @ViewBuilder content: () -> Content, @ViewBuilder actions: () -> Actions) {
        self.title = title
        self.symbol = symbol
        self.tone = tone
        self.summary = summary
        self.dimmed = dimmed
        self.badge = badge
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
                    } else {
                        Text("This request is no longer waiting for an answer.")
                            .font(.orbitProse).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .padding()
                            .navigationTitle("Request closed")
                    }
                case .delivered(let card):
                    DeliveredDecisionCardView(console: console, card: card)
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
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                        .labelStyle(.iconOnly)
                }
            }
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
