import SwiftUI
import OrbitKit

/// **Needs you** — everything in the account waiting on this person, wherever it is.
///
/// The session's own approval card answers "what is this session asking", which is the wrong question
/// when the user is the bottleneck across twenty projects: finding what has been blocked longest
/// meant opening every session in turn. This is the other view — one flat list, longest wait on top,
/// each card carrying enough of its own identity (what is being asked, by which role, on which task,
/// in which project, and for how long) to be answered without opening anything.
///
/// Order is the server's (`waitingSince` ASC) and is rendered as received. There is deliberately no
/// client-side sort: a second ordering here would be a second answer to "what is most overdue".
/// Shared by macOS and iOS — the metrics fork, the list does not.
struct InboxView: View {
    @Environment(AppModel.self) private var model
    /// Re-read on a slow tick so the wait badges keep counting between pushes. The data itself
    /// arrives by push (`approval.*` on the control-plane stream), never by poll — so this clock
    /// moves the labels, not the list. They count minutes, so 30s keeps a badge from ever being a
    /// full minute out of date.
    @State private var now = Date()

    var body: some View {
        let inbox = model.inbox
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                if let inbox {
                    if inbox.pending.isEmpty {
                        Text("All clear — every agent is running fine.")
                            .font(.orbitProse).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 8)
                    }
                    ForEach(inbox.pending) { item in
                        InboxCard(item: item, now: now,
                                  questions: model.inboxQuestions[item.approvalId] ?? [])
                    }
                    if !inbox.resolved.isEmpty {
                        Text("Resolved · today")
                            .font(.orbitLabel.weight(.semibold)).foregroundStyle(.secondary)
                            .padding(.top, 14)
                        ForEach(inbox.resolved) { ResolvedCard(item: $0) }
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(.vertical, 24)
                }
            }
            .padding(16)
        }
        .navigationTitle(navigationTitle)
        .task { await model.loadInbox() }
        .refreshable { await model.loadInbox() }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                if Task.isCancelled { break }
                now = Date()
            }
        }
    }

    /// The count rides in the title rather than in a separate header line: this is a whole screen,
    /// and "Needs you · 3" is the same fact the nav badge carries.
    private var navigationTitle: String {
        guard let count = model.inboxCount, count > 0 else { return AppSection.inbox.title }
        return "\(AppSection.inbox.title) · \(count)"
    }
}

/// One waiting approval, answerable in place.
///
/// The three kinds offer what the session's own cards offer, minus what an inbox cannot mean: a
/// permission is allow/deny and NOT "always allow" (that writes a standing rule onto a workspace,
/// which is not a thing to hand someone triaging twenty projects a tap at a time, and the payload
/// carries no `input` to derive one from). A plan gets its approval but not its rejection — "keep
/// planning" is the start of a conversation, and the conversation is in the session. Every card
/// carries the way there.
private struct InboxCard: View {
    @Environment(AppModel.self) private var model
    let item: InboxApprovalItem
    let now: Date
    let questions: [AskQuestion]
    @State private var selections: [String: Set<String>] = [:]

    private var waited: TimeInterval { InboxLogic.waited(item, now: now) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: symbol)
                    .font(.orbitMeta)
                    .foregroundStyle(tone)
                    .frame(width: 22, height: 22)
                    .background(tone.opacity(0.16), in: RoundedRectangle(cornerRadius: 6))
                VStack(alignment: .leading, spacing: 3) {
                    Text(InboxLogic.cardTitle(item))
                        .font(.orbitProse.bold()).foregroundStyle(.primary)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(InboxLogic.metaLine(item))
                        .font(.orbitLabel).foregroundStyle(.secondary).lineLimit(1)
                }
                // How long it has been waiting, which is what the list is ordered by — amber, then
                // red past half an hour, the point at which "in progress" has become "stuck".
                Text(InboxLogic.waitedLabel(waited))
                    .font(.orbitMeta.monospacedDigit())
                    .foregroundStyle(waited >= InboxLogic.urgentAfter ? Color.red : Color.orange)
                    .help(item.waitingSince)
            }
            actions
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tone.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(tone.opacity(0.28)) }
    }

    @ViewBuilder private var actions: some View {
        switch item.kind {
        case .permission:
            InboxActions {
                Button("Allow") { decide(.allow) }.buttonStyle(.borderedProminent)
                Button("Deny", role: .destructive) { decide(.deny) }.buttonStyle(.bordered)
                openButton
            }
        case .plan:
            // Approval but no rejection: "keep planning" is the start of a conversation, and the
            // conversation is in the session.
            InboxActions {
                Button("Approve plan") { decide(.allow) }.buttonStyle(.borderedProminent)
                openButton
            }
        case .question:
            VStack(alignment: .leading, spacing: 10) {
                ForEach(questions) { question in questionBlock(question) }
                InboxActions {
                    if !questions.isEmpty {
                        Button("Send") {
                            decide(.allow, answers: Approvals.buildAnswers(questions,
                                                                           selections: selections,
                                                                           custom: [:]))
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(!Approvals.allAnswered(questions, selections: selections,
                                                         custom: [:]))
                    }
                    openButton
                }
            }
        }
    }

    /// One question's options as pick buttons. Free-typed answers are deliberately not offered here
    /// — the composer is where you write one, and this card carries the way to it.
    private func questionBlock(_ question: AskQuestion) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if question.question != InboxLogic.cardTitle(item) {
                Text(question.header ?? question.question)
                    .font(.orbitLabel.bold()).foregroundStyle(.secondary)
            }
            ForEach(question.options) { option in
                let picked = selections[question.question]?.contains(option.label) ?? false
                Button {
                    PlatformHaptics.tap()
                    pick(question, option.label)
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: picked ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(picked ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                        Text(option.label).font(.orbitProse).foregroundStyle(.primary)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .frame(maxWidth: .infinity, minHeight: rowMinHeight, alignment: .leading)
                    .background(picked ? Color.accentColor.opacity(0.14) : Color.primary.opacity(0.05),
                                in: RoundedRectangle(cornerRadius: 8))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(picked ? [.isButton, .isSelected] : [.isButton])
            }
        }
    }

    private var openButton: some View {
        Button("Open session") { model.openInboxItem(item) }
            .buttonStyle(.bordered)
    }

    private func pick(_ question: AskQuestion, _ label: String) {
        var set = selections[question.question] ?? []
        if question.multiSelect {
            if set.contains(label) { set.remove(label) } else { set.insert(label) }
        } else {
            set = [label]
        }
        selections[question.question] = set
    }

    private func decide(_ behavior: ApprovalBehavior, answers: [String: [String]]? = nil) {
        PlatformHaptics.tap()
        let decision = InboxLogic.decision(for: item, behavior: behavior, answers: answers)
        Task { await model.decideInbox(item, decision) }
    }

    /// The card's colour, in the same language the session's own approval cards speak: amber for a
    /// permission, purple for a plan, blue for a question.
    private var tone: Color {
        switch item.kind {
        case .permission: return .orange
        case .plan:       return .purple
        case .question:   return .blue
        }
    }

    private var symbol: String {
        switch item.kind {
        case .permission: return "hand.raised.fill"
        case .plan:       return "list.bullet.clipboard"
        case .question:   return "questionmark.circle.fill"
        }
    }

    #if os(iOS)
    private let rowMinHeight: CGFloat = 44   // a mis-tap here runs a command; every target is real
    #else
    private let rowMinHeight: CGFloat = 0
    #endif
}

/// A settled card: the same identity it had while it waited, plus how it went. Read-only — undoing a
/// decision is the session's business, not the inbox's.
private struct ResolvedCard: View {
    let item: InboxResolvedItem

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                Text(InboxLogic.cardTitle(item.item))
                    .font(.orbitProse).foregroundStyle(.secondary).lineLimit(1)
                Text(InboxLogic.metaLine(item.item))
                    .font(.orbitLabel).foregroundStyle(.tertiary).lineLimit(1)
            }
            Spacer(minLength: 8)
            Text(item.decision == .allow ? "Allowed" : "Denied")
                .font(.orbitMeta)
                .foregroundStyle(item.decision == .allow ? Color.green : Color.red)
                .help(item.resolvedAt)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
    }
}

/// A card's decisions: stacked full-width on a phone (three buttons can't share a row without the
/// long labels crushing each other, and stacking keeps a destructive Deny a thumb-width from Allow),
/// a natural row on macOS. Mirrors `ApprovalCards`' own `ApprovalActions`.
private struct InboxActions<Content: View>: View {
    private let content: () -> Content
    init(@ViewBuilder content: @escaping () -> Content) { self.content = content }

    var body: some View {
        #if os(iOS)
        VStack(spacing: 8) { content() }
        #else
        HStack(spacing: 8) { content() }
        #endif
    }
}
