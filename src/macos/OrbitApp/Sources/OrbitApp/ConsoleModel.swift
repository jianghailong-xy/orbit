import Foundation
import Observation
import UniformTypeIdentifiers
import OrbitKit
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

struct PendingAttachment: Identifiable, Equatable, Sendable {
    let id: String
    let filename: String
    let mimeType: String
    let byteCount: Int
    /// A small PNG thumbnail for an inline image, downsampled once at attach time so SwiftUI
    /// isn't re-decoding the full-resolution source on every body pass; nil for a non-image file.
    let previewImageData: Data?
}

/// Active "Chat about this" reply: the composer's next send resolves this pending question as a
/// deny+message (claude reads it as in-turn feedback) instead of starting a fresh turn.
struct QuestionReply: Equatable, Sendable {
    let approvalID: String
    let question: String
}

/// Drives one open session: the reconnecting SSE consume loop (folded through the verified
/// `TranscriptReducer`) plus the interactive actions — send/queue/interrupt, tool approvals,
/// and worktree commit/merge. All decision logic lives in OrbitKit (ComposerLogic / Approvals);
/// this is the orchestration + UI-facing state.
@MainActor
@Observable
final class ConsoleModel {
    let sessionID: String
    let agentID: String?
    /// Non-nil when this is a draft (pre-session) console backing the "new session" composer: it
    /// runs no stream, and `send()` calls `createSession` for this agent instead of POSTing a turn
    /// (see `createDraftSession`). A live console leaves this nil.
    private let draftAgent: Agent?
    var isDraft: Bool { draftAgent != nil }
    /// Draft only: fired with the freshly created session so the caller can open its live console.
    var onSessionCreated: ((Session) -> Void)?
    private(set) var state = TranscriptState()
    private(set) var connected = false

    // The session's lifecycle status per the server (REST). The SSE stream can't redeliver the
    // terminal transition (its event is broadcast live-only, never in the replayed log), so the
    // stream alone leaves an opened/reconnected ended session looking live. This is seeded on
    // open and refreshed on each reconnect; the composer reconciles it with the stream status so
    // a send to a dormant/finished session resumes instead of 409-ing on POST /turns.
    private var serverStatus: RunStatus?

    // composer
    var composerText = ""
    var modelID = AgentDefaults.defaultModelID
    var permissionMode: PermissionMode = .default
    var effort: Effort = .default
    private(set) var pendingAttachments: [PendingAttachment] = []
    private(set) var sending = false
    /// Set while replying to a pending question via "Chat about this" (see send()).
    private(set) var replyContext: QuestionReply?

    // Owning agent's name + the runner's Claude-subscription quota, shown in the composer
    // footer (web parity); loaded once when the console opens (see loadContext).
    private(set) var agentName: String?
    private(set) var planUsage: PlanUsage?

    // `/` command & skill autocomplete (the `+` menu opens it scoped). `slashItems` is the
    // runner-reported set already narrowed to host-level + this session's agent (see loadSlashItems).
    private(set) var slashItems: [SlashCommandInfo] = []
    var slashScope: String?   // nil = both kinds; "command"/"skill" when opened from the + menu

    // worktree
    private(set) var diff: [FilePatch] = []
    private(set) var worktreeBusy = false

    var statusMessage: String?

    private var reducer = TranscriptReducer()
    private let stream: EventStreaming
    private let api: APIClient
    /// Shared image cache (owned by the registry) — seeded on send so the sent bubble shows its
    /// image instantly, and read by the transcript's `ChatAttachmentImage`.
    let attachments: AttachmentImageStore

    init(sessionID: String, agentID: String? = nil, baseURL: URL, tokenStore: TokenStore,
         attachments: AttachmentImageStore, restoring reducer: TranscriptReducer? = nil) {
        self.sessionID = sessionID
        self.agentID = agentID
        self.draftAgent = nil
        self.attachments = attachments
        self.api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
        #if os(macOS)
        self.stream = URLSessionEventStream(baseURL: baseURL, token: { tokenStore.token(for: baseURL) })
        #else
        self.stream = MockEventStream([])
        #endif
        if let reducer {
            self.reducer = reducer
            self.state = reducer.state   // render the persisted transcript instantly, before SSE connects
        }
    }

    /// Draft (pre-session) console backing the "new session" composer. There's no session yet, so it
    /// runs no stream; the first `send()` calls `createSession` for `agent` and hands the new session
    /// to `onSessionCreated`, after which the caller opens its live console. The model/permission
    /// pills are seeded from the agent's saved config — web parity: leaving them at "Default" would
    /// make the server treat that as an explicit override and ignore the agent's configured mode.
    init(draftFor agent: Agent, baseURL: URL, tokenStore: TokenStore, attachments: AttachmentImageStore) {
        self.sessionID = ""
        self.agentID = agent.id
        self.draftAgent = agent
        self.attachments = attachments
        self.api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
        #if os(macOS)
        self.stream = URLSessionEventStream(baseURL: baseURL, token: { tokenStore.token(for: baseURL) })
        #else
        self.stream = MockEventStream([])
        #endif
        self.agentName = agent.name
        let m = agent.model ?? AgentDefaults.defaultModelID
        self.modelID = AgentDefaults.models.contains { $0.id == m } ? m : AgentDefaults.defaultModelID
        self.permissionMode = PermissionMode(rawValue: agent.permissionMode ?? "dontAsk") ?? .dontAsk
    }

    /// Snapshot the full reducer (state + dedup/cursor internals) for the local store. Restoring
    /// it lets the resumed `?sinceSeq=maxSeq` stream continue verbatim — see `ConsoleRegistry`.
    func snapshotReducer() -> TranscriptReducer { reducer }

    // MARK: live stream

    func run() async {
        Task { await loadSlashItems() }   // one-shot; concurrent with the stream connect
        Task { await loadContext() }      // footer context: agent name / plan usage / live config
        // Durable approvals aren't in the replayed stream (the `approval_request` nudge rides
        // seq 0, live-only) — fetch them once on open so a prompt already pending (e.g. an
        // AskUserQuestion awaiting an answer) surfaces. Decoupled from the stream; cancels with run().
        let approvalsSeed = Task { [weak self] in await self?.refreshApprovals() }
        defer { approvalsSeed.cancel() }
        var attempt = 0
        while !Task.isCancelled {
            do {
                connected = true
                for try await ev in stream.events(sessionID: sessionID, sinceSeq: reducer.state.maxSeq) {
                    reducer.apply(ev)
                    scheduleStatePublish()
                    attempt = 0
                }
                connected = false
                publishStateNow()
                // The stream closed — if the session ended during the drop, the terminal
                // status broadcast was missed and won't be replayed, so refresh it from REST.
                await refreshServerStatus()
                try? await Task.sleep(nanoseconds: 300_000_000)
            } catch is CancellationError {
                publishStateNow()
                return
            } catch {
                connected = false
                attempt += 1
                if attempt > 12 { return }
                let ms = min(15_000, 500 * (1 << min(attempt, 5)))
                try? await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
            }
        }
    }

    // Coalesce transcript publishes. A busy replay or live stream would otherwise copy the full
    // state and re-render the whole transcript PER event (≈ O(N²) over the session), pegging the
    // main actor — opening a busy session froze the app near 100% CPU. Events still fold into the
    // reducer eagerly; the rendered snapshot is pushed to the view at most ~20×/sec.
    private var publishScheduled = false
    private func scheduleStatePublish() {
        guard !publishScheduled else { return }
        publishScheduled = true
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 50_000_000)
            guard let self else { return }
            self.publishScheduled = false
            self.state = self.reducer.state
            self.reconcileReplyContext()
        }
    }
    private func publishStateNow() {
        publishScheduled = false
        state = reducer.state
        reconcileReplyContext()
    }

    /// Drop the chat-reply context if its question was resolved another way (an option was picked,
    /// or an SSE `approval_resolved` arrived) — mirrors the web clearing replyTo when it leaves.
    private func reconcileReplyContext() {
        if let r = replyContext, !state.pendingApprovals.contains(where: { $0.id == r.approvalID }) {
            replyContext = nil
        }
    }

    // MARK: composer

    /// The status that drives send decisions: the stream status, upgraded to the server's
    /// terminal status when the stream missed the (un-replayable) terminal transition.
    var sessionStatus: RunStatus { ComposerLogic.reconcileStatus(stream: state.status, server: serverStatus) }

    var availability: SendAvailability { isDraft ? .sendNow : ComposerLogic.availability(status: sessionStatus) }

    /// Non-terminal session → composer config edits apply immediately (see `applyConfig`). A draft
    /// has no session to PATCH, so it's never "live": the picked pills ride along in createSession.
    var isLive: Bool { isDraft ? false : ComposerLogic.isLive(status: sessionStatus) }

    var canSend: Bool {
        guard !composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !sending else { return false }
        if replyContext != nil { return true }   // a question reply always sends (deny+message)
        return availability != .blocked
    }

    // What we believe the server's stored config is — set on load, updated after each push.
    // A picker's onChange fires even when loadContext adopts the server's value programmatically;
    // without this the adopted value would echo straight back as a PATCH, and a live PATCH
    // re-spawns claude (see SessionsService.updateConfig). So we only push genuine user edits.
    private var syncedConfig: (model: String, permissionMode: String, effort: String)?

    /// Load the footer context once: the owning agent's name + the runner's plan usage, and —
    /// for a LIVE session — adopt its stored model/permission/effort so the pills show the
    /// server's choice (matching web). A terminal session keeps the local picks for resume.
    private func loadContext() async {
        guard let s = try? await api.session(sessionID) else { return }
        serverStatus = s.status
        agentName = s.agent?.name
        if ComposerLogic.isLive(status: s.status) {
            if let m = s.model { modelID = m }
            if let pm = s.permissionMode, let mode = PermissionMode(rawValue: pm) { permissionMode = mode }
            if let ef = s.effort, let e = Effort(rawValue: ef) { effort = e }
            syncedConfig = (modelID, permissionMode.rawValue, effort.rawValue)
        }
        // Plan usage rides the GET /runners list (there's no per-runner detail endpoint —
        // the web reads it the same way), so fetch the list and pick this session's runner.
        if let rid = s.assignedRunnerId,
           let r = (try? await api.runners())?.first(where: { $0.id == rid }) {
            planUsage = r.planUsage
        }
    }

    /// Re-read just the authoritative lifecycle status from REST (lighter than loadContext).
    /// The terminal transition is a live-only SSE broadcast absent from the replayed log, so
    /// the stream alone can leave an ended session looking live; this lets the composer pick
    /// resume over a doomed POST /turns. No-op on a transient fetch failure (keeps the last value).
    private func refreshServerStatus() async {
        if let s = try? await api.session(sessionID) { serverStatus = s.status }
    }

    /// A picker change on a LIVE session is pushed to the server immediately (PATCH /config,
    /// like web's configMut); on a terminal/draft session the local value is kept and carried
    /// by the next resume. Pass only the field that changed (effort uses its raw value so
    /// Default sends "" to clear it). No-op when the value equals the synced server config —
    /// that filters the programmatic adopt in `loadContext` from re-spawning the session.
    func applyConfig(model: String? = nil, permissionMode: String? = nil, effort: String? = nil) async {
        guard isLive else { return }
        let changed = (model.map { $0 != syncedConfig?.model } ?? false)
            || (permissionMode.map { $0 != syncedConfig?.permissionMode } ?? false)
            || (effort.map { $0 != syncedConfig?.effort } ?? false)
        guard changed else { return }
        do {
            try await api.updateConfig(sessionID: sessionID,
                ConfigUpdateRequest(model: model, permissionMode: permissionMode, effort: effort))
            if let s = syncedConfig {
                syncedConfig = (model ?? s.model, permissionMode ?? s.permissionMode, effort ?? s.effort)
            }
        } catch {
            statusMessage = "Couldn't apply change — \(error)"
        }
    }

    // MARK: `/` autocomplete

    var hasCommands: Bool { slashItems.contains { $0.type == "command" } }
    var hasSkills: Bool { slashItems.contains { $0.type == "skill" } }
    var slashToken: String? { ComposerSlash.token(in: composerText) }
    var slashMatches: [SlashCommandInfo] {
        ComposerSlash.matches(items: slashItems, token: slashToken, scope: slashScope)
    }

    /// Fold every runner's reported commands + skills, scoped to host-level + this session's
    /// agent (web parity). Best-effort: a failure just leaves the menu empty.
    func loadSlashItems() async {
        guard let runners = try? await api.runners() else { return }
        let all = runners.flatMap { ($0.commands ?? []) + ($0.skills ?? []) }
        slashItems = ComposerSlash.scoped(items: all, agentID: agentID)
    }

    /// `+` menu → Command/Skill: pop the menu scoped to one kind by inserting a `/`.
    func openSlash(scope: String) {
        slashScope = scope
        composerText = ComposerSlash.opening(text: composerText)
    }

    /// Replace the active `/token` with `/name `; clears the scope so the next manual `/` shows both.
    func pickSlash(_ name: String) {
        composerText = ComposerSlash.pick(text: composerText, name: name)
        slashScope = nil
    }

    /// `+` menu → Shell: prefix the draft with `!` so send() routes the rest as a raw shell command
    /// run on the runner, bypassing claude. The user types the command after. Mirrors web's insertShell.
    func insertShell() {
        if !composerText.hasPrefix("!") { composerText = "!" + composerText }
    }

    func send() async {
        guard !sending else { return }
        if isDraft { await createDraftSession(); return }
        // A leading `!` runs the remainder as a raw shell command on the runner, bypassing claude
        // (mirrors the web composer). A bare `!` with nothing after it is a no-op.
        let (text, shell) = ComposerLogic.parseShell(composerText)
        guard !text.isEmpty else {
            if shell { composerText = "" }
            return
        }
        // "Chat about this": resolve the pending question as a deny+message so claude reads the
        // text as in-turn feedback and continues — not a fresh turn. (Mirrors the web reroute.)
        if let reply = replyContext {
            composerText = ""
            replyContext = nil
            await replyToQuestion(approvalID: reply.approvalID, text: text)
            return
        }
        let clientTurnId = UUID().uuidString
        let attachmentIds = pendingAttachments.map(\.id)
        // Carry mime/name onto the optimistic bubble so it can render image thumbnails / file chips
        // immediately (the durable `user` event later supplies the authoritative refs).
        let turnAttachments = pendingAttachments.map {
            TurnAttachment(id: $0.id, mime: $0.mimeType, name: $0.filename)
        }

        // A turn already in flight ⇒ this message waits its turn, so label it "Queued" rather than
        // "Sending…" (web parity). Captured now, before the send revives/advances the status.
        let willQueue = availability == .queue
        // Optimistic bubble; reconciled by the server's `user` event (matched by the turnId
        // tagged below once POST returns — the runner echoes turnId, not clientTurnId).
        reducer.addOptimisticUser(clientTurnId: clientTurnId, text: text, attachments: turnAttachments,
                                  queued: willQueue)
        state = reducer.state
        composerText = ""
        pendingAttachments = []

        sending = true
        defer { sending = false }
        do {
            let accepted: TurnAccepted
            if ComposerLogic.shouldResume(status: sessionStatus) {
                accepted = try await api.resume(sessionID: sessionID,
                                         ResumeRequest(clientTurnId: clientTurnId, content: text,
                                                       kind: shell ? "shell" : "message",
                                                       model: modelID, permissionMode: permissionMode.rawValue,
                                                       effort: effort.wire))
                // The session is revived (back to PENDING/RUNNING); drop the stale terminal
                // snapshot so the stream drives status again and a quick follow-up doesn't
                // re-resume a session that hasn't re-claimed yet.
                serverStatus = nil
            } else {
                accepted = try await api.sendTurn(sessionID: sessionID,
                                           ComposerLogic.makeTurn(clientTurnId: clientTurnId, text: text,
                                                                  shell: shell, attachmentIds: attachmentIds))
            }
            // Tag the optimistic bubble with the server's turnId so the durable `user` event
            // reconciles it instead of appending a duplicate (the runner echoes turnId, not
            // clientTurnId). The POST response always precedes that event — see setOptimisticTurnId.
            if let tid = accepted.turnId {
                reducer.setOptimisticTurnId(clientTurnId: clientTurnId, turnId: tid)
                state = reducer.state
            }
        } catch {
            statusMessage = "Send failed — \(error)"
        }
    }

    /// Draft send: create a brand-new session for the agent (mirrors the web composer's create path
    /// when there's no live/resumable selection). A leading `!` seeds a shell first turn; staged
    /// attachments (uploaded session-less) ride along via `attachmentIds`. On success the caller
    /// opens the live console; the pills already carry the agent's seeded config.
    private func createDraftSession() async {
        guard let agent = draftAgent else { return }
        let (text, shell) = ComposerLogic.parseShell(composerText)
        guard !text.isEmpty else {
            if shell { composerText = "" }
            return
        }
        let attachmentIds = pendingAttachments.map(\.id)
        sending = true
        defer { sending = false }
        do {
            let session = try await api.createSession(CreateSessionRequest(
                prompt: text, agentId: agent.id, model: modelID,
                permissionMode: permissionMode.rawValue, effort: effort.wire,
                shell: shell ? true : nil,
                attachmentIds: attachmentIds.isEmpty ? nil : attachmentIds))
            composerText = ""
            pendingAttachments = []
            onSessionCreated?(session)
        } catch {
            statusMessage = "Couldn't start the session — \(error)"
        }
    }

    /// Draft footer/slash seed (no stream): load the `/` command + skill set for the agent and,
    /// best-effort, the agent's runner plan usage — mirrors the live `run()`'s context load.
    func prepareDraft() async {
        await loadSlashItems()
        if let rid = draftAgent?.runnerId,
           let r = (try? await api.runners())?.first(where: { $0.id == rid }) {
            planUsage = r.planUsage
        }
    }

    func interrupt() async {
        do { try await api.interrupt(sessionID: sessionID) }
        catch { statusMessage = "Interrupt failed" }
    }

    /// `+` menu → Attach image / Upload file: read a picked file, enforce the size cap (web
    /// parity), and upload it via the existing attachment path.
    func attachFile(url: URL) async {
        guard let data = try? Data(contentsOf: url) else {
            statusMessage = "Couldn't read \(url.lastPathComponent)"
            return
        }
        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
            ?? "application/octet-stream"
        if let reason = Attachments.rejectReason(mimeType: mime, byteCount: data.count) {
            statusMessage = reason
            return
        }
        await attach(filename: url.lastPathComponent, mimeType: mime, data: data)
    }

    /// Clipboard ⌘V of an image (e.g. a screenshot): the view normalizes it to PNG, then this
    /// enforces the inline-image cap and uploads via the shared path. Mirrors the web composer's
    /// `onPaste` handler, which swallows the paste only when it carries image data.
    func attachPastedImage(pngData: Data) async {
        if let reason = Attachments.rejectReason(mimeType: "image/png", byteCount: pngData.count) {
            statusMessage = reason
            return
        }
        await attach(filename: "pasted-image.png", mimeType: "image/png", data: pngData)
    }

    func attach(filename: String, mimeType: String, data: Data) async {
        do {
            // A draft has no session yet — upload session-less; createSession links the ids later.
            let id = try await api.uploadAttachment(sessionID: isDraft ? nil : sessionID, filename: filename,
                                                    mimeType: mimeType, data: data)
            // Inline images carry a downsampled thumbnail for the composer chip; other files show
            // as a name + size chip instead (web parity).
            let preview = Attachments.isInlineImage(mimeType: mimeType) ? composerThumbnail(from: data) : nil
            // Seed the shared cache with the full-resolution bytes so the sent bubble renders the
            // image instantly (no fetch round-trip) once the turn is sent.
            if Attachments.isInlineImage(mimeType: mimeType) { attachments.seed(id, data: data) }
            pendingAttachments.append(PendingAttachment(id: id, filename: filename, mimeType: mimeType,
                                                        byteCount: data.count, previewImageData: preview))
        } catch {
            statusMessage = "Upload failed"
        }
    }

    func removeAttachment(_ att: PendingAttachment) {
        pendingAttachments.removeAll { $0.id == att.id }
    }

    // MARK: approvals

    /// Begin a "Chat about this" reply to a pending question: the next composer send resolves it
    /// as a deny+message instead of a fresh turn (see send()). The card stays until then.
    func startChatReply(approvalID: String, question: String) {
        replyContext = QuestionReply(approvalID: approvalID, question: question)
    }

    func cancelChatReply() { replyContext = nil }

    /// Resolve a pending question conversationally (deny + the typed text → claude reads it as
    /// in-turn feedback). Optimistic-removes the card; re-seeds from REST on failure.
    private func replyToQuestion(approvalID: String, text: String) async {
        sending = true
        defer { sending = false }
        reducer.removeApproval(id: approvalID)
        publishStateNow()
        let req = ApprovalDecisionRequest(behavior: .deny, message: text, answers: nil, rememberRule: nil)
        do { try await api.decideApproval(sessionID: sessionID, approvalID: approvalID, req) }
        catch {
            statusMessage = "Reply failed"
            await refreshApprovals()
        }
    }

    func decide(_ approval: PendingApproval, behavior: ApprovalBehavior,
                answers: [String: [String]]? = nil, remember: Bool = false) async {
        var rule: PermissionRule?
        if remember, behavior == .allow, let input = approval.input {
            rule = Approvals.rememberRule(toolName: approval.toolName ?? "", input: input)
        }
        // Optimistic: drop the card now (the SSE `approval_resolved` echoes this). On failure,
        // re-seed from REST so it reappears rather than silently vanishing.
        reducer.removeApproval(id: approval.id)
        publishStateNow()
        let req = ApprovalDecisionRequest(behavior: behavior, message: nil, answers: answers, rememberRule: rule)
        do { try await api.decideApproval(sessionID: sessionID, approvalID: approval.id, req) }
        catch {
            statusMessage = "Approval failed"
            await refreshApprovals()
        }
    }

    /// Fetch durable pending approvals (the REST source of truth) and fold them in. Without this
    /// a prompt that predates the stream — or whose seq-0 nudge landed during a reconnect gap —
    /// never surfaces, since those nudges aren't replayed.
    private func refreshApprovals() async {
        guard let infos = try? await api.approvals(sessionID: sessionID) else { return }
        reducer.seedApprovals(infos.map {
            PendingApproval(id: $0.id, kind: Approvals.kind(toolName: $0.toolName),
                            toolName: $0.toolName, input: $0.input)
        })
        publishStateNow()
    }

    // MARK: worktree

    func loadDiff() async {
        worktreeBusy = true
        defer { worktreeBusy = false }
        do { diff = try await api.diff(sessionID: sessionID).patches }
        catch { /* keep last */ }
    }

    func commit() async {
        worktreeBusy = true
        defer { worktreeBusy = false }
        do { try await api.commit(sessionID: sessionID); statusMessage = "Commit requested" }
        catch { statusMessage = "Commit failed" }
    }

    func merge(target: String?) async {
        worktreeBusy = true
        defer { worktreeBusy = false }
        do { try await api.merge(sessionID: sessionID, targetBranch: target); statusMessage = "Merge requested" }
        catch { statusMessage = "Merge failed" }
    }
}

/// Downsample an image to a small PNG for the composer's thumbnail chip. Done once at attach time
/// so SwiftUI isn't decoding the full-resolution source on every body pass — a multi-MB screenshot
/// re-decoded per keystroke would jank typing. Best-effort: nil falls back to a name + size chip.
private func composerThumbnail(from data: Data, maxDimension: CGFloat = 96) -> Data? {
    guard let source = PlatformImage(data: data) else { return nil }
    let size = source.size
    guard size.width > 0, size.height > 0 else { return nil }
    let scale = min(1, maxDimension / max(size.width, size.height))
    let target = CGSize(width: max(1, size.width * scale), height: max(1, size.height * scale))
    #if os(macOS)
    let thumb = NSImage(size: target)
    thumb.lockFocus()
    source.draw(in: NSRect(origin: .zero, size: target),
                from: NSRect(origin: .zero, size: size), operation: .copy, fraction: 1)
    thumb.unlockFocus()
    guard let tiff = thumb.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
    return rep.representation(using: .png, properties: [:])
    #elseif os(iOS)
    let renderer = UIGraphicsImageRenderer(size: target)
    return renderer.pngData { _ in source.draw(in: CGRect(origin: .zero, size: target)) }
    #endif
}
