import SwiftUI
import UniformTypeIdentifiers
import OrbitKit
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
import PhotosUI
#endif

/// One shared session as its guest reads it (docs/session-guests-design.md §4): the guest door's
/// head and transcript, followed the way the public page follows a conversation (`GuestFollow`), and
/// the guest's messages: text, images, or both. Web parity: `GuestConversation` in GuestSessionPage.tsx.
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
    /// The guest door's stream: how the view follows the conversation while it can be open.
    @ObservationIgnored private let stream: GuestStreaming
    @ObservationIgnored private let myName: () -> String?
    /// The view's guest-door image store: a finished upload seeds it, so the sent bubble needs no fetch.
    @ObservationIgnored private let attachments: AttachmentImageStore

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
    /// The images staged for the next message, each uploading through the guest door the moment
    /// it is picked (the owner's composer chips, `PendingAttachment`).
    private(set) var images: [PendingAttachment] = []
    @ObservationIgnored private var uploads: [String: Task<Void, Never>] = [:]
    private(set) var sendError: String?
    private(set) var loadingOlder = false

    /// Stream or poll, and the newest seq held: what the next connection or poll asks after.
    @ObservationIgnored private var streamFollow = GuestStreamFollow()
    /// Whether the app is in the foreground (the scene's phase): in the background the stream is closed.
    @ObservationIgnored private var foreground = true
    /// A message was just sent; until its run is seen the conversation is asked as if it worked.
    @ObservationIgnored private var expecting = false
    /// Set by a send: the follow loop asks at once instead of finishing its wait.
    @ObservationIgnored private var kicked = false
    /// What this view sent, drawn below the transcript until the runner's echo of each turn is read.
    private(set) var sent = GuestSentTurns()

    init(sessionID: String, api: APIClient, stream: GuestStreaming, attachments: AttachmentImageStore,
         myName: @escaping () -> String?) {
        self.sessionID = sessionID
        self.api = api
        self.stream = stream
        self.attachments = attachments
        self.myName = myName
    }

    /// Words, or at least one image on its own; never while a message is going.
    var canSend: Bool { !sending && GuestComposer.canSend(text: draft, imageCount: images.count) }

    var items: [TranscriptItem] {
        guard !sent.isEmpty else { return reducer.state.items }
        // Folded by a copy of the reducer, so a drawn message reads as the echo will, and the real window is never touched.
        var drawn = reducer
        drawn.appendNewer(EventPage(events: sent.events, hasMore: false))
        return drawn.state.items
    }
    var hasMoreOlder: Bool { reducer.state.hasMoreOlder }

    /// The first read: the head and the newest page.
    func load() async {
        do {
            let session = try await api.guestSession(sessionID, limit: GuestFollow.tailPage)
            owner = session.ownerName
            seed(session)
            phase = .ready
        } catch {
            phase = .notShared
        }
    }

    /// The window from a tail read: the first one, or again when the stream says it is too far behind.
    private func seed(_ session: GuestSession) {
        title = session.title
        state = session.state
        var fresh = TranscriptReducer()
        fresh.applyTailPage(EventPage(events: own(session.events), hasMore: session.hasMore))
        reducer = fresh
        sent.read(session.events)
        streamFollow.reseeded(after: session.events.last?.seq ?? 0)
        tailRevision &+= 1
    }

    /// The app came to the foreground or left it (the scene's phase): in the background the stream is
    /// closed, and back in the foreground it is opened again from the newest seq held.
    func setForeground(_ isForeground: Bool) {
        guard isForeground != foreground else { return }
        foreground = isForeground
        if isForeground { streamFollow.foreground() }
    }

    /// Whether the app can be seen: in the foreground, and on macOS not hidden or minimized.
    private var visible: Bool { foreground && VisibilityGate.app.isVisible }

    /// Follow the conversation for as long as the view is up: over the guest stream as it is written,
    /// or — when the stream cannot open — by polling, every few seconds while it works, every half
    /// minute while it waits, and not at all once it is over, until a send asks again.
    func follow() async {
        while !Task.isCancelled, phase == .ready {
            await untilVisible()
            guard !Task.isCancelled, phase == .ready else { return }
            switch streamFollow.mode {
            case .stream:
                let end = await streamOnce()
                guard !Task.isCancelled, phase == .ready else { return }
                if end == .resync { await reseed() }
                switch streamFollow.next(after: end) {
                case .stop: return
                case .reconnect(let ms): await pause(TimeInterval(ReconnectPolicy.jittered(ms, unit: .random(in: 0..<1))) / 1000)
                case .poll:
                    // Fallen back: catch up at once, then the polling cadence.
                    await readNewer()
                case .waitForeground: break
                }
            case .polling:
                await pause(sent.delay(GuestFollow.delay(state, moved: false, expecting: expecting)))
                guard !Task.isCancelled, phase == .ready else { return }
                await readNewer()
                _ = streamFollow.retryStream()
            }
        }
    }

    /// One connection of the guest stream, read until it ends, the view goes, or the app leaves the foreground.
    private func streamOnce() async -> GuestStreamFollow.End {
        await withTaskGroup(of: GuestStreamFollow.End.self) { group in
            group.addTask { @MainActor [self] in
                do {
                    for try await frame in stream.guestFrames(sessionID: sessionID, sinceSeq: streamFollow.cursor) {
                        switch streamFollow.read(frame) {
                        case .apply(let event): draw(event)
                        case .head(let head):
                            if let newTitle = head.title, !newTitle.isEmpty { title = newTitle }
                            state = head.state
                            if head.state.live { expecting = false }
                        case .gone:
                            phase = .notShared
                            return .cancelled
                        case .reseed: return .resync
                        case .skip: break
                        }
                    }
                    return .ended
                } catch {
                    return GuestStreamFollow.end(of: error)
                }
            }
            // Closed in the background: wins the race, so the read above is cancelled.
            group.addTask { @MainActor [self] in
                while !Task.isCancelled {
                    if !visible { return .background }
                    try? await Task.sleep(nanoseconds: 250_000_000)
                }
                return .cancelled
            }
            let first = await group.next() ?? .cancelled
            group.cancelAll()
            return Task.isCancelled ? .cancelled : first
        }
    }

    /// One stream event drawn as the owner's console draws it: a delta grows the reply being written, a
    /// stored event folds in and replaces a drawn message it echoes.
    private func draw(_ event: RunEvent) {
        sent.read([event])
        for shown in own([event]) { reducer.apply(shown) }
        tailRevision &+= 1
    }

    /// The stream said this window is too far behind to replay: read the tail page again.
    private func reseed() async {
        do {
            seed(try await api.guestSession(sessionID, limit: GuestFollow.tailPage))
        } catch APIError.http(let status, _) where status == 404 {
            phase = .notShared
        } catch {
            // Transient: the reconnect asks from the cursor held.
        }
    }

    /// Returns once the app can be seen, or the view goes.
    private func untilVisible() async {
        while !Task.isCancelled, !visible {
            await VisibilityGate.app.waitUntilVisible()
            if !foreground { try? await Task.sleep(nanoseconds: 250_000_000) }
        }
    }

    /// Wait `seconds` (nil: until a send), cut short by a send; never while the app cannot be seen.
    private func pause(_ seconds: TimeInterval?) async {
        let deadline = seconds.map { Date().addingTimeInterval($0) }
        while !Task.isCancelled, !kicked, deadline.map({ Date() < $0 }) ?? true {
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
        kicked = false
        await untilVisible()
    }

    /// Ask what the conversation added since the newest event held, until it is caught up.
    private func readNewer() async {
        do {
            var more = true
            while more {
                let after = streamFollow.cursor
                let now = try await api.guestEventsAfter(sessionID, after: after, limit: GuestFollow.pageSize)
                let added = now.events.filter { $0.seq > after }
                sent.read(added)
                if !added.isEmpty {
                    reducer.appendNewer(EventPage(events: own(added), hasMore: false))
                    streamFollow.held(added.last?.seq ?? after)
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

    /// Send the draft and the staged images: a turn of the owner's session, which restarts it when it
    /// has ended. An image still uploading is waited for, so a message sent in that window keeps it.
    func send() async {
        guard canSend else { return }
        sending = true
        sendError = nil
        defer { sending = false }
        // Drawn the moment it is sent: the composer empties and the words sit in the conversation while the send is on its way.
        let content = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = content.isEmpty ? nil : sent.draw(content)
        draft = ""
        tailRevision &+= 1
        do {
            while let upload = images.compactMap({ uploads[$0.id] }).first {
                await upload.value
            }
            let staged = images
            let attachmentIds = staged.compactMap(\.remoteID)
            guard phase == .ready, GuestComposer.canSend(text: content, imageCount: attachmentIds.count) else {
                if let key { sent.refused(key) }
                if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { draft = content }
                return
            }
            let accepted = try await api.sendGuestTurn(sessionID, clientTurnId: PublicID.newToken(), content: content,
                                                       attachmentIds: attachmentIds)
            if let key { sent.accepted(key, turnId: accepted.turnId) }
            images.removeAll { chip in staged.contains { $0.id == chip.id } }
            expecting = true
            kicked = true
        } catch {
            // Not sent: the drawing goes, and the words go back to the composer unless something new was typed meanwhile.
            if let key { sent.refused(key) }
            if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { draft = content }
            switch error {
            case APIError.http(let status, _) where status == 404:
                phase = .notShared
            case APIError.http(_, let body):
                sendError = Self.message(body) ?? "Couldn\u{2019}t send your message."
            default:
                sendError = "Couldn\u{2019}t send your message."
            }
        }
    }

    /// Stage one image: the chip (with its thumbnail) shows at once and the bytes go up through the
    /// guest door in the background; a refusal or a failed upload drops the chip and says why.
    func attachImage(filename: String, mimeType: String, data: Data) {
        if let reason = GuestComposer.rejectReason(mimeType: mimeType, byteCount: data.count) {
            sendError = reason
            return
        }
        sendError = nil
        let uid = UUID().uuidString
        images.append(PendingAttachment(id: uid, remoteID: nil, filename: filename, mimeType: mimeType,
                                        byteCount: data.count, previewImageData: composerThumbnail(from: data)))
        uploads[uid] = Task {
            defer { uploads[uid] = nil }
            do {
                let id = try await api.uploadGuestAttachment(sessionID, filename: filename,
                                                             mimeType: mimeType, data: data)
                // Removed while it went up: nothing to reconcile.
                guard let index = images.firstIndex(where: { $0.id == uid }) else { return }
                attachments.seed(id, data: data)
                images[index].remoteID = id
            } catch APIError.http(let status, _) where status == 404 {
                images.removeAll { $0.id == uid }
                phase = .notShared
            } catch APIError.http(_, let body) {
                images.removeAll { $0.id == uid }
                sendError = Self.message(body) ?? "Upload failed \u{2014} \(filename)"
            } catch {
                images.removeAll { $0.id == uid }
                sendError = "Upload failed \u{2014} \(filename)"
            }
        }
    }

    /// Stage bytes that were pasted, dropped or picked: one of the four image types as it is, any
    /// other image (HEIC, TIFF…) re-encoded by `orbitPhotoUpload`, and anything else on to be refused.
    func stage(_ data: Data, type: UTType?, filename: String) {
        let mime = type?.preferredMIMEType ?? "application/octet-stream"
        let stem = (filename as NSString).deletingPathExtension
        if !Attachments.isInlineImage(mimeType: mime),
           let image = orbitPhotoUpload(data, name: stem.isEmpty ? "image" : stem) {
            attachImage(filename: image.filename, mimeType: image.mimeType, data: image.data)
        } else {
            attachImage(filename: filename, mimeType: mime, data: data)
        }
    }

    func removeImage(_ image: PendingAttachment) {
        images.removeAll { $0.id == image.id }
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
/// text and images (PNG, JPEG, WebP or GIF — pasted, dropped or picked): no mode, model or effort, no
/// `!` shell, no other files.
struct GuestSessionView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    let sessionID: String
    @State private var conversation: GuestConversationModel?
    /// The console's rows read attachment images through the store in the environment; a guest's is
    /// this session's own, which reads them through the guest door.
    @State private var attachments: AttachmentImageStore?

    var body: some View {
        Group {
            if let conversation, let attachments {
                GuestConversationPage(conversation: conversation)
                    .environment(attachments)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: sessionID) {
            guard let api = app.guestDoor, let registry = app.consoleRegistry else { return }
            let store = registry.guestAttachments(sessionID)
            attachments = store
            let account = app
            let tokens = app.tokenStore
            let baseURL = api.baseURL
            let stream = URLSessionEventStream(baseURL: baseURL, token: { tokens.token(for: baseURL) })
            let model = GuestConversationModel(sessionID: sessionID, api: api, stream: stream,
                                               attachments: store) { [weak account] in
                account?.user?.name
            }
            model.setForeground(scenePhase != .background)
            conversation = model
            await model.load()
            await model.follow()
        }
        // In the background the guest stream is closed; back in the foreground it is opened again.
        .onChange(of: scenePhase) { _, phase in
            conversation?.setForeground(phase != .background)
        }
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}

#if os(macOS)
/// Whether the guest's field has focus, read by the long-lived ⌘V monitor (the owner composer's
/// `ComposerPasteState`): a focused field editor takes ⌘V before any SwiftUI paste handler sees it.
private final class GuestPasteFocus {
    var focused = false
}
#endif

private struct GuestConversationPage: View {
    @Bindable var conversation: GuestConversationModel
    @FocusState private var composerFocused: Bool
    private let bottomID = "guest-bottom"
    #if os(macOS)
    @State private var pasteMonitor: Any?
    @State private var pasteFocus = GuestPasteFocus()
    #elseif os(iOS)
    @State private var showPhotoPicker = false
    @State private var pickedPhotos: [PhotosPickerItem] = []
    #endif

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
            // An image dropped anywhere on the conversation is staged for the next message.
            .onDrop(of: [.fileURL, .image], isTargeted: nil) { providers in dropImages(providers) }
            #if os(macOS)
            // The window's title; the phone's bar carries the drawer's button only, the head says it.
            .navigationTitle(SharedWithMe.firstLine(conversation.title))
            #endif
        }
    }

    // MARK: Head

    /// The title and who shared it, then the status; the marks of a narrow window go under the title.
    private var head: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .center, spacing: 10) {
                headTitle.frame(minWidth: 120, idealWidth: 160, maxWidth: .infinity, alignment: .leading)
                headBadges
            }
            VStack(alignment: .leading, spacing: 6) {
                headTitle
                headBadges
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private var headTitle: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(SharedWithMe.firstLine(conversation.title))
                .font(.headline)
                .lineLimit(1)
            Text(GuestCopy.sharedBy(conversation.owner))
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    /// The status, then, with the session facts, its marks and Completed for a filed session
    /// (web `SharedSessionStatus`), and the Guest badge.
    private var headBadges: some View {
        HStack(spacing: 6) {
            if let state = SessionDisplay.state(conversation.state.displayFacts) {
                statePill(state)
                SessionMarkPills(marks: SessionDisplay.marks(conversation.state.displayFacts) ?? [])
                if conversation.state.completed {
                    Text("Completed")
                        .font(.orbitMeta)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .overlay(Capsule().strokeBorder(Color.secondary.opacity(0.35), lineWidth: 0.5))
                }
            } else {
                statusPill
            }
            Text(GuestCopy.guestBadge)
                .font(.orbitMeta.weight(.semibold))
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(Capsule().fill(Color.accentColor.opacity(0.14)))
                .foregroundStyle(Color.accentColor)
        }
    }

    /// The state icon and word from `phase` (`SessionDisplay`), blue while Running only.
    private func statePill(_ state: SessionDisplayState) -> some View {
        HStack(spacing: 5) {
            StatusGlyphView(glyph: state.glyph)
                .accessibilityHidden(true)
            Text(state.word).font(.orbitLabel)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Capsule().fill((state == .running ? Color.blue : .gray).opacity(0.12)))
        .accessibilityElement(children: .combine)
        .fixedSize()
    }

    /// The pill an older server's session draws.
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

    /// The control that reads the messages before what is loaded.
    private var loadOlderRow: some View {
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

    private var transcript: some View {
        ScrollViewReader { proxy in
            List {
                ForEach(GuestTranscriptListLogic.rows(conversation.items,
                                                      hasMoreOlder: conversation.hasMoreOlder,
                                                      bottomID: bottomID)) { row in
                    switch row {
                    case .loadOlder:
                        loadOlderRow
                    case .item(let item):
                        TranscriptItemView(item: item, fullPayload: { seq in await conversation.fullPayload(seq) })
                            .listRowSeparator(.hidden)
                            .listRowBackground(Color.clear)
                    case .bottom(let id):
                        Color.clear.frame(height: 1).id(id)
                            .listRowSeparator(.hidden)
                            .listRowBackground(Color.clear)
                    }
                }
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
            VStack(alignment: .leading, spacing: 8) {
                if !conversation.images.isEmpty {
                    HStack(spacing: 8) {
                        ForEach(conversation.images) { imageChip($0) }
                    }
                }
                HStack(alignment: .bottom, spacing: 8) {
                    attachButton
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
                    .disabled(!conversation.canSend)
                    .keyboardShortcut(.return, modifiers: .command)
                    .accessibilityLabel("Send")
                }
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
        #if os(macOS)
        // ⌘V with an image on the clipboard while the field has focus attaches it and swallows the
        // paste; anything else pastes as text (the owner composer's monitor).
        .onAppear {
            guard pasteMonitor == nil else { return }
            let focus = pasteFocus
            let conversation = self.conversation
            pasteMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
                guard focus.focused,
                      event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
                      event.charactersIgnoringModifiers?.lowercased() == "v",
                      NSPasteboard.general.canReadObject(forClasses: [NSImage.self], options: nil),
                      let image = NSImage(pasteboard: NSPasteboard.general),
                      let png = image.orbitPNGData(),
                      let pasted = orbitPhotoUpload(png, name: "pasted-image")
                else { return event }
                Task { @MainActor in
                    conversation.attachImage(filename: pasted.filename, mimeType: pasted.mimeType, data: pasted.data)
                }
                return nil
            }
        }
        .onDisappear {
            if let monitor = pasteMonitor { NSEvent.removeMonitor(monitor); pasteMonitor = nil }
        }
        .onChange(of: composerFocused) { _, focused in pasteFocus.focused = focused }
        #endif
    }

    /// The `+` of the guest's composer: images only. A Mac opens the file panel (⌘V and a drop add
    /// them too); a phone offers the photo library, and the clipboard's image when it holds one.
    @ViewBuilder
    private var attachButton: some View {
        #if os(iOS)
        Menu {
            Button { showPhotoPicker = true } label: { Label("Photo Library", systemImage: "photo.on.rectangle") }
            // `hasImages` does not read the clipboard, so no paste banner until the tap.
            if UIPasteboard.general.hasImages {
                Button {
                    if let png = UIPasteboard.general.image?.orbitPNGData(),
                       let pasted = orbitPhotoUpload(png, name: "pasted") {
                        conversation.attachImage(filename: pasted.filename, mimeType: pasted.mimeType, data: pasted.data)
                    }
                } label: { Label("Paste image", systemImage: "doc.on.clipboard") }
            }
        } label: {
            attachGlyph
        }
        .menuIndicator(.hidden)
        .accessibilityLabel("Attach images")
        .photosPicker(isPresented: $showPhotoPicker, selection: $pickedPhotos,
                      maxSelectionCount: 5, matching: .images)
        .onChange(of: pickedPhotos) { _, items in
            guard !items.isEmpty else { return }
            Task { await attachPhotos(items); pickedPhotos = [] }
        }
        #else
        Button { pickImages() } label: { attachGlyph }
            .buttonStyle(.borderless)
            .help("Attach images")
            .accessibilityLabel("Attach images")
        #endif
    }

    private var attachGlyph: some View {
        Image(systemName: "plus.circle")
            .font(.title2)
            .foregroundStyle(.secondary)
    }

    /// A staged image: its 48² thumbnail, dimmed with a spinner while it uploads, and a corner ✕.
    private func imageChip(_ image: PendingAttachment) -> some View {
        Group {
            if let data = image.previewImageData, let thumb = PlatformImage(data: data) {
                Image(platformImage: thumb).resizable().scaledToFill()
            } else {
                Image(systemName: "photo").foregroundStyle(.secondary)
            }
        }
        .frame(width: 48, height: 48)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(.primary.opacity(0.08)) }
        .overlay {
            if image.isUploading {
                RoundedRectangle(cornerRadius: 8).fill(.black.opacity(0.35))
                ProgressView().controlSize(.small).tint(.white)
            }
        }
        .overlay(alignment: .topTrailing) {
            Button { conversation.removeImage(image) } label: {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.white, .black.opacity(0.55))
            }
            .buttonStyle(.plain)
            .padding(2)
            .help("Remove image")
            .accessibilityLabel("Remove image")
        }
    }

    /// Files from the Finder (or Files) by their bytes and extension; an image from another app by
    /// the first image type it offers. What is no image is staged anyway, to be refused in words.
    private func dropImages(_ providers: [NSItemProvider]) -> Bool {
        let conversation = self.conversation
        var taken = false
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                taken = true
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    guard let url, let data = try? Data(contentsOf: url) else { return }
                    let type = UTType(filenameExtension: url.pathExtension)
                    let name = url.lastPathComponent
                    Task { @MainActor in conversation.stage(data, type: type, filename: name) }
                }
            } else if let type = provider.registeredTypeIdentifiers.lazy.compactMap({ UTType($0) })
                        .first(where: { $0.conforms(to: .image) }) {
                taken = true
                let name = "image." + (type.preferredFilenameExtension ?? "png")
                _ = provider.loadDataRepresentation(forTypeIdentifier: type.identifier) { data, _ in
                    guard let data else { return }
                    Task { @MainActor in conversation.stage(data, type: type, filename: name) }
                }
            }
        }
        return taken
    }

    #if os(macOS)
    private func pickImages() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowedContentTypes = [.png, .jpeg, .webP, .gif]
        guard panel.runModal() == .OK else { return }
        for url in panel.urls {
            guard let data = try? Data(contentsOf: url) else { continue }
            conversation.stage(data, type: UTType(filenameExtension: url.pathExtension), filename: url.lastPathComponent)
        }
    }
    #elseif os(iOS)
    /// Photo-library picks, made an inline image under the cap as the owner composer does.
    private func attachPhotos(_ items: [PhotosPickerItem]) async {
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self),
                  let photo = orbitPhotoUpload(data) else { continue }
            conversation.attachImage(filename: photo.filename, mimeType: photo.mimeType, data: photo.data)
        }
    }
    #endif
}
