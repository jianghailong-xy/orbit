import SwiftUI
import OrbitKit

/// The request a message is, as it stands now — the line under a "From [session]" card whose
/// message asked for a reply: "Asked for a reply · due 18:00" and its state, waiting or which of the
/// five outcomes it came to (docs/session-request-reply-contract.md §6).
///
/// Read live (`GET /session-requests/:id`): the card is stored once and the state moves. Read again
/// whenever the asked session's own row moves — an outcome is announced to both sessions, and the
/// row's `owesReplyTo` loses the request when it closes — and, while it waits, on a slow poll, so a
/// dropped announcement costs latency only. Read-only: the owner does not answer for the session.
///
/// One view for both native clients (`src/ios/project.yml` compiles this folder). Web parity:
/// `SessionRequestStatus` in `SessionMessageCard.tsx`, with every word from OrbitKit's
/// `SessionRequestCopy`.
struct SessionRequestStatusView: View {
    let requestId: String

    @Environment(AppModel.self) private var model
    @State private var request: SessionRequestView?

    /// What moves when the request does: the asked session's row, as the list and the live summaries
    /// keep it.
    private var refreshKey: String {
        let row = request.flatMap { model.session(id: $0.toSessionId) }
        let owed = row?.owesReplyTo?.map(\.requestId).joined(separator: ",") ?? "-"
        return "\(requestId)|\(owed)|\(row?.lastTurnAt ?? "-")"
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(SessionRequestCopy.statusLine(request))
                .font(.orbitMeta.weight(.semibold)).foregroundStyle(.secondary)
            if let state = request?.state {
                Text(SessionRequestCopy.stateLabel(state))
                    .font(.orbitMeta)
                    .foregroundStyle(tint(state))
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .overlay(Capsule().strokeBorder(tint(state).opacity(0.45), lineWidth: 1))
            }
            Spacer(minLength: 0)
        }
        .task(id: refreshKey) { await load() }
        .task(id: requestId) {
            // While it waits, look again now and then: the deadline passing is an event only once
            // the worker has closed it.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                if Task.isCancelled { break }
                if request?.state == .open || request == nil { await load() }
            }
        }
    }

    private func load() async {
        guard let baseURL = model.baseURL else { return }
        let api = APIClient(baseURL: baseURL, tokenStore: model.tokenStore)
        if let fresh = try? await api.sessionRequest(requestId) { request = fresh }
    }

    private func tint(_ state: SessionRequestState) -> Color {
        switch state {
        case .open: return .accentColor
        case .closed(.replied): return .green
        case .closed: return .orange
        }
    }
}

/// The outcomes of this session's own requests, handed back to it — drawn as reply cards rather than
/// as the owner's bubble, because nobody typed the turn: the platform opened it to say what each
/// request came to (contract §4.2). One card per outcome the turn carried, from the snapshot the
/// control plane recorded beside the echo (OrbitKit's `SessionReply`, read out of `sessionReplies`),
/// each naming the session that was asked and opening the request where it sits in that session's
/// transcript. Read-only.
///
/// One view for both native clients. Web parity: `SessionReplyCard.tsx`.
struct SessionReplyCardsView: View {
    let replies: [SessionReply]
    var ts: String?
    /// What else delivery appended to the same turn, as its own folded entry.
    var attached: (kind: String, text: String)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(replies, id: \.requestId) { reply in
                SessionReplyCardView(reply: reply, ts: ts)
            }
            if let attached { AttachedNoteEntry(attached: attached) }
        }
    }
}

struct SessionReplyCardView: View {
    let reply: SessionReply
    var ts: String?

    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            head
            Text("\(SessionRequestCopy.youAsked) \(reply.requestPreview)")
                .font(.orbitMeta).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let option = reply.replyOption {
                Text("\(SessionRequestCopy.chose) \(option). \(reply.replyOptionLabel ?? "")")
                    .font(.orbitMeta).foregroundStyle(.secondary)
            }
            if let text = reply.replyText {
                MarkdownView(source: text, base: .body, ink: .primary)
                    .font(.orbitProse)
                    .textSelection(.enabled)
            }
            if reply.outcome == .undelivered {
                Text(SessionRequestCopy.neverSeen)
                    .font(.orbitMeta).foregroundStyle(.orange)
            }
            if reply.outcome != .replied, let excerpt = reply.excerpt {
                VStack(alignment: .leading, spacing: 2) {
                    Text(SessionRequestCopy.lastWords)
                        .font(.orbitMeta).foregroundStyle(.secondary)
                    MarkdownView(source: excerpt, base: .body, ink: .secondary)
                        .font(.orbitProse)
                        .textSelection(.enabled)
                }
                .padding(.leading, 8)
                .overlay(alignment: .leading) {
                    Rectangle().fill(Color.primary.opacity(0.12)).frame(width: 2)
                }
            }
            foot
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.tint.opacity(0.28), lineWidth: 1))
    }

    /// "Reply from <session title>  Replied" — whose answer, and what it came to.
    private var head: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrowshape.turn.up.left")
                .font(.orbitMeta).foregroundStyle(.tint)
            Text(SessionRequestCopy.replyFrom)
                .font(.orbitLabel).foregroundStyle(.secondary)
            if let url = SessionRequestCopy.sessionLink(reply) {
                Button {
                    openURL(url)
                } label: {
                    Text(SessionRequestCopy.title(reply))
                        .font(.orbitLabel.weight(.semibold))
                        .multilineTextAlignment(.leading)
                }
                .buttonStyle(.plain).foregroundStyle(.tint)
            } else {
                Text(SessionRequestCopy.title(reply)).font(.orbitLabel.weight(.semibold))
            }
            Spacer(minLength: 6)
            Text(SessionRequestCopy.outcomeLabel(reply.outcome))
                .font(.orbitMeta)
                .foregroundStyle(reply.outcome == .replied ? Color.green : Color.orange)
                .padding(.horizontal, 7).padding(.vertical, 2)
                .overlay(Capsule().strokeBorder((reply.outcome == .replied ? Color.green : Color.orange).opacity(0.45),
                                                lineWidth: 1))
        }
    }

    /// "Handed back by Orbit, not typed by you · 2m ago", and the way back to the request.
    private var foot: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(meta).font(.orbitMeta).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            if let url = SessionRequestCopy.requestLink(reply) {
                Button(SessionRequestCopy.openRequest) { openURL(url) }
                    .buttonStyle(.plain).font(.orbitMeta).foregroundStyle(.tint)
            }
        }
    }

    private var meta: String {
        var line = SessionRequestCopy.notYou
        if let ts, let relative = RelativeTime.format(ts) { line += " · \(relative)" }
        return line
    }
}

/// Who a session list row is waiting on for a reply, and who is waiting on it (session requests,
/// contract §6): "Waiting on Worker 2 · Owes a reply to Coordinator". Read off the row's own
/// `awaitingReplyFrom` / `owesReplyTo`, which every list read and every live summary carries; nothing
/// when neither is open. Web parity: `SessionRequestsLine` in `WorkspaceView.tsx`.
struct SessionRequestsLine: View {
    let session: Session

    var body: some View {
        if let text = SessionRequestCopy.peersLine(awaiting: session.awaitingReplyFrom, owes: session.owesReplyTo) {
            Text(text)
                .font(.orbitMeta)
                .foregroundStyle(.tint)
                .lineLimit(1)
        }
    }
}
