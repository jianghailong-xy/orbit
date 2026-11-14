import SwiftUI
import OrbitKit

/// One shared session as its guest reads it (docs/session-guests-design.md §4): the guest door's
/// head and transcript, followed the way the public page follows a conversation (`GuestFollow`), and
/// the guest's text-only messages. Web parity: `GuestConversation` in GuestSessionPage.tsx.
@MainActor
@Observable
final class GuestConversationModel {
    enum Phase: Equatable {
        case loading
        case ready
        /// The door's one 404: removed, left, Trash or deleted all read the same.
        case notShared
    }

    let sessionID: String
    @ObservationIgnored private let api: APIClient
    @ObservationIgnored private let myName: () -> String?

    private(set) var phase: Phase = .loading
    private(set) var title = ""
    private(set) var owner = ""
    private(set) var state = GuestSessionState(runState: nil, runStatus: nil, sessionState: nil,
                                               lifecycleState: nil, waitingOnOwner: false)
    private(set) var reducer = TranscriptReducer()
    /// Bumped when the newest end of the transcript grew, so the list follows it down.
    private(set) var tailRevision = 0
    var draft = ""
    private(set) var sending = false
    private(set) var sendError: String?
    private(set) var loadingOlder = false

    /// The newest seq held: what the follow read asks after.
    @ObservationIgnored private var after = 0
    /// A message was just sent; until its run is seen the conversation is asked as if it worked.
    @ObservationIgnored private var expecting = false
    /// Set by a send: the follow loop asks at once instead of finishing its wait.
    @ObservationIgnored private var kicked = false

    init(sessionID: String, api: APIClient, myName: @escaping () -> String?) {
        self.sessionID = sessionID
        self.api = api
        self.myName = myName
    }

    var items: [TranscriptItem] { reducer.state.items }
    var hasMoreOlder: Bool { reducer.state.hasMoreOlder }

    /// The first read: the head and the newest page.
    func load() async {
        do {
            let session = try await api.guestSession(sessionID, limit: GuestFollow.tailPage)
            title = session.title
            owner = session.ownerName
            state = session.state
            var fresh = TranscriptReducer()
            fresh.applyTailPage(EventPage(events: own(session.events), hasMore: session.hasMore))
            reducer = fresh
            after = session.events.last?.seq ?? 0
            phase = .ready
            tailRevision &+= 1
        } catch {
            phase = .notShared
        }
    }

    /// Follow the conversation for as long as the view is up: every few seconds while it works, every
    /// half minute while it waits, and not at all once it is over — until a send asks again.
    func follow() async {
        while !Task.isCancelled, phase == .ready {
            await pause(GuestFollow.delay(state, moved: false, expecting: expecting))
            guard !Task.isCancelled, phase == .ready else { return }
            await readNewer()
        }
    }

    /// Wait `seconds` (nil: until a send), cut short by a send; never while the app cannot be seen.
    private func pause(_ seconds: TimeInterval?) async {
        let deadline = seconds.map { Date().addingTimeInterval($0) }
        while !Task.isCancelled, !kicked, deadline.map({ Date() < $0 }) ?? true {
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
        kicked = false
        await VisibilityGate.app.waitUntilVisible()
    }

    /// Ask what the conversation added since the newest event held, until it is caught up.
    private func readNewer() async {
        do {
            var more = true
            while more {
                let now = try await api.guestEventsAfter(sessionID, after: after, limit: GuestFollow.pageSize)
                let added = now.events.filter { $0.seq > after }
                if !added.isEmpty {
                    reducer.appendNewer(EventPage(events: own(added), hasMore: false))
                    after = added.last?.seq ?? after
                    tailRevision &+= 1
                }
                if let newTitle = now.title, !newTitle.isEmpty { title = newTitle }
                state = now.state
                if now.state.live { expecting = false }
                more = now.after != nil && !added.isEmpty
            }
        } catch APIError.http(let status, _) where status == 404 {
            phase = .notShared
        } catch {
            // Transient: the next turn of the loop asks again.
        }
    }

    /// The page just older than the oldest event held.
    func loadOlder() async {
        guard !loadingOlder, reducer.state.hasMoreOlder, let oldest = reducer.state.oldestSeq else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        do {
            let page = try await api.guestEventsBefore(sessionID, before: oldest, limit: GuestFollow.pageSize)
            reducer.prependOlder(EventPage(events: own(page.events), hasMore: page.hasMore))
        } catch APIError.http(let status, _) where status == 404 {
            phase = .notShared
        } catch {}
    }

    /// Send the draft: a text turn of the owner's session, which restarts it when it has ended.
    func send() async {
        let content = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty, !sending else { return }
        sending = true
        sendError = nil
        defer { sending = false }
        do {
            try await api.sendGuestTurn(sessionID, clientTurnId: PublicID.newToken(), content: content)
            draft = ""
            expecting = true
            kicked = true
        } catch APIError.http(let status, _) where status == 404 {
            phase = .notShared
        } catch APIError.http(_, let body) {
            sendError = Self.message(body) ?? "Couldn\u{2019}t send your message."
        } catch {
            sendError = "Couldn\u{2019}t send your message."
        }
    }

    /// A tool card the door clipped, fetched whole when it is opened.
    func fullPayload(_ seq: Int) async -> JSONValue? {
        try? await api.guestEventFull(sessionID, seq: seq).payload
    }

    private func own(_ events: [RunEvent]) -> [RunEvent] {
        GuestTranscript.ownMessages(events, myName: myName())
    }

    /// The server's own sentence from an error body (`{"message": …}`), when it has one.
    private static func message(_ body: String?) -> String? {
        guard let body, let data = body.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        if let text = object["message"] as? String, !text.isEmpty { return text }
        if let list = object["message"] as? [String], let first = list.first { return first }
        return nil
    }
}

/// The guest view: a session somebody shared with this account, opened from Shared with me or from a
/// session id the owner's read found nothing of yours at (boards docs/mocks/share-links/10-session-guests-3
/// and 11-guest-one-link-2). Its head — title, `Shared by <owner>`, the status and a Guest badge — over
/// the transcript the guest door projects, drawn by the console's own rows, and a composer that takes
/// text only: no mode, model or effort, no `!` shell, no attachments.
struct GuestSessionView: View {
    @Environment(AppModel.self) private var app
    let sessionID: String
    @State private var conversation: GuestConversationModel?

    var body: some View {
        Group {
            if let conversation, let registry = app.consoleRegistry {
                // The console's rows read attachment images through the registry's store, as
                // ConsoleView hands it to them.
                GuestConversationPage(conversation: conversation)
                    .environment(registry.attachments)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: sessionID) {
            guard let api = app.guestDoor else { return }
            let account = app
            let model = GuestConversationModel(sessionID: sessionID, api: api) { [weak account] in account?.user?.name }
            conversation = model
            await model.load()
            await model.follow()
        }
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}

private struct GuestConversationPage: View {
    @Bindable var conversation: GuestConversationModel
    @FocusState private var composerFocused: Bool
    private let bottomID = "guest-bottom"

    var body: some View {
        switch conversation.phase {
        case .loading:
            ProgressView(GuestCopy.loading).frame(maxWidth: .infinity, maxHeight: .infinity)
        case .notShared:
            ContentUnavailableView {
                Label(GuestCopy.notShared, systemImage: "person.2.slash")
            } description: {
                Text(GuestCopy.notSharedDetail)
            }
        case .ready:
            VStack(spacing: 0) {
                head
                Divider()
                transcript
                composer
            }
            #if os(macOS)
            // The window's title; the phone's bar carries the drawer's button only, the head says it.
            .navigationTitle(SharedWithMe.firstLine(conversation.title))
            #endif
        }
    }

    // MARK: Head

    private var head: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(SharedWithMe.firstLine(conversation.title))
                    .font(.headline)
                    .lineLimit(1)
                Text(GuestCopy.sharedBy(conversation.owner))
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            statusPill
            Text(GuestCopy.guestBadge)
                .font(.orbitMeta.weight(.semibold))
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(Capsule().fill(Color.accentColor.opacity(0.14)))
                .foregroundStyle(Color.accentColor)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private var statusPill: some View {
        let state = conversation.state
        return HStack(spacing: 5) {
            if state.tone == .running {
                ProgressView().controlSize(.mini)
            } else {
                Circle().fill(toneColor(state.tone)).frame(width: 7, height: 7)
            }
            Text(state.word).font(.orbitLabel)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Capsule().fill(toneColor(state.tone).opacity(0.12)))
        .accessibilityElement(children: .combine)
    }

    private func toneColor(_ tone: GuestTone) -> Color {
        switch tone {
        case .queued: return .secondary
        case .running: return .blue
        case .awaiting: return .orange
        case .done: return .green
        case .failed: return .red
        case .cancelled: return .gray
        }
    }

    // MARK: Transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            List {
                if conversation.hasMoreOlder {
                    Button {
                        Task { await conversation.loadOlder() }
                    } label: {
                        HStack {
                            Spacer()
                            if conversation.loadingOlder { ProgressView().controlSize(.small) }
                            Text("Load earlier messages").font(.orbitLabel)
                            Spacer()
                        }
                    }
                    .buttonStyle(.borderless)
                    .listRowSeparator(.hidden)
                }
                ForEach(conversation.items) { item in
                    TranscriptItemView(item: item, fullPayload: { seq in await conversation.fullPayload(seq) })
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
                Color.clear.frame(height: 1).id(bottomID)
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .onChange(of: conversation.tailRevision, initial: true) { _, _ in
                DispatchQueue.main.async { proxy.scrollTo(bottomID, anchor: .bottom) }
            }
        }
    }

    // MARK: Composer

    private var composer: some View {
        let state = conversation.state
        let owner = conversation.owner
        return VStack(alignment: .leading, spacing: 6) {
            if state.waiting {
                Label(GuestCopy.waiting(owner), systemImage: "hourglass")
                    .font(.orbitLabel)
                    .foregroundStyle(.orange)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField(GuestCopy.placeholder(owner), text: $conversation.draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...6)
                    .focused($composerFocused)
                    .onSubmit { Task { await conversation.send() } }
                    .accessibilityLabel("Message")
                Button {
                    Task { await conversation.send() }
                } label: {
                    if conversation.sending {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "arrow.up.circle.fill").font(.title2)
                    }
                }
                .buttonStyle(.borderless)
                .disabled(conversation.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                          || conversation.sending)
                .keyboardShortcut(.return, modifiers: .command)
                .accessibilityLabel("Send")
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 14).fill(.background))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(.quaternary))
            Text(conversation.sendError ?? state.hint(owner: owner))
                .font(.orbitMeta)
                .foregroundStyle(conversation.sendError == nil ? AnyShapeStyle(.secondary) : AnyShapeStyle(.red))
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 10)
        .background(.bar)
    }
}
