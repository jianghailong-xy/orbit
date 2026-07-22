import Foundation

/// Whether the composer can send, and whether the message will run now or queue. Queue-while-
/// running is allowed (the durable PENDING turn), so a send during a live turn is accepted and
/// queued rather than blocked.
public enum SendAvailability: Equatable, Sendable {
    case sendNow        // session parked/resumable → starts (or resumes) immediately
    case queue          // a turn is in flight, or the session is still queued → message queues
    case blocked        // nothing actionable
}

public enum ComposerLogic {
    /// Hard cap on a single prompt, in characters. An oversized message freezes SwiftUI's
    /// synchronous text layout, so the composer clamps input to this and the server rejects
    /// anything larger. Very large content belongs in an uploaded file, not a prompt.
    public static let maxPromptChars = 50_000

    /// Map session status → send availability. Terminal statuses are `sendNow` because a send
    /// revives them via `--resume` (full context preserved).
    public static func availability(status: RunStatus) -> SendAvailability {
        switch status {
        case .awaitingInput, .interrupted, .parked: return .sendNow
        case .running, .pending: return .queue
        case .succeeded, .failed, .cancelled: return .sendNow
        }
    }

    /// True when a terminal-but-resumable session should be revived via POST /resume rather
    /// than POST /turns.
    public static func shouldResume(status: RunStatus) -> Bool {
        switch status {
        case .succeeded, .failed, .cancelled, .parked: return true
        default: return false
        }
    }

    /// Reconcile the stream-derived status with the server's REST status for the send decision.
    ///
    /// The SSE stream is authoritative for *live* transitions, but the *terminal* one
    /// (SUCCEEDED / PARKED / CANCELLED / FAILED) is broadcast live-only — that event never lands
    /// in the replayed durable log, so a client that opens (or reconnects to) an already-ended
    /// session never learns it ended and keeps the last live status. POST /turns then 409s with
    /// "the session has ended" instead of reviving via POST /resume. The REST status IS
    /// authoritative for the lifecycle, so trust it when it says the session ended but the stream
    /// still looks live. Only upgrades *toward* terminal: a stale terminal snapshot must never
    /// override a freshly-live stream (e.g. right after a resume re-spawns the session).
    public static func reconcileStatus(stream: RunStatus, server: RunStatus?) -> RunStatus {
        guard let server, shouldResume(status: server), !shouldResume(status: stream) else {
            return stream
        }
        return server
    }

    /// True while the session is non-terminal (mirrors web's `!TERMINAL`): composer config
    /// edits (model / permission / effort) apply immediately via PATCH /config. Terminal-but-
    /// resumable sessions instead carry the local pick on the next resume.
    public static func isLive(status: RunStatus) -> Bool {
        !shouldResume(status: status)
    }

    /// Whether the composer's single primary button shows STOP (interrupt the turn) instead of SEND.
    /// A 1:1 port of web's `showStop`: the session is authoritatively RUNNING *and* there's nothing
    /// staged to send — empty text, no attachments, not replying to a question — so the moment the
    /// user types a follow-up the button morphs back to Send and can still queue mid-turn.
    ///
    /// The running check keys off the session's AUTHORITATIVE lifecycle status (`session` — the live
    /// control-plane record the nav-bar title also reads, web's `selected?.status`), NOT the
    /// stream-derived reducer status: that never reliably reaches `.running` on a cold open of an
    /// already-running session (no durable "running" event is replayed — only `turn_end`/`status`
    /// transitions move it), so the button used to never appear there. `stream` is the fallback only
    /// when no session record is loaded yet (a fresh deep link).
    public static func showsInterrupt(session: RunStatus?, stream: RunStatus,
                                      hasText: Bool, hasAttachments: Bool, replying: Bool) -> Bool {
        guard !hasText, !hasAttachments, !replying else { return false }
        return (session ?? stream) == .running
    }

    public static func makeTurn(clientTurnId: String, text: String, shell: Bool,
                                attachmentIds: [String]) -> SessionTurnRequest {
        SessionTurnRequest(clientTurnId: clientTurnId,
                           content: text,
                           kind: shell ? "shell" : "message",
                           attachmentIds: attachmentIds.isEmpty ? nil : attachmentIds)
    }

    /// Split a composer draft into the text to send and whether it's a raw shell command. A
    /// leading `!` (the web composer's convention) routes the remainder to the runner shell,
    /// bypassing claude; the result is trimmed and a bare `!` yields empty text (a no-op send).
    public static func parseShell(_ raw: String) -> (text: String, shell: Bool) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("!") else { return (trimmed, false) }
        return (String(trimmed.dropFirst()).trimmingCharacters(in: .whitespacesAndNewlines), true)
    }
}

public struct ComposerStatusSnapshot: Equatable, Sendable {
    public let surface: String
    public let sessionTitle: String?
    public let sessionStatus: String?
    public let agentName: String?
    public let provider: String?
    public let model: String?
    public let permissionMode: String?
    public let effort: String?
    public let contextTokens: Int?
    public let contextWindow: Int?
    public let planUsageLabel: String?
    public let planUsagePercent: Int?

    public init(surface: String, sessionTitle: String? = nil, sessionStatus: String? = nil,
                agentName: String? = nil, provider: String? = nil, model: String? = nil,
                permissionMode: String? = nil, effort: String? = nil,
                contextTokens: Int? = nil, contextWindow: Int? = nil,
                planUsageLabel: String? = nil, planUsagePercent: Int? = nil) {
        self.surface = surface
        self.sessionTitle = sessionTitle
        self.sessionStatus = sessionStatus
        self.agentName = agentName
        self.provider = provider
        self.model = model
        self.permissionMode = permissionMode
        self.effort = effort
        self.contextTokens = contextTokens
        self.contextWindow = contextWindow
        self.planUsageLabel = planUsageLabel
        self.planUsagePercent = planUsagePercent
    }
}

public struct ComposerStatusRow: Equatable, Sendable {
    public let label: String
    public let value: String
    public init(label: String, value: String) {
        self.label = label
        self.value = value
    }
}

public enum ComposerHostCommand {
    public static let status = "status"
    public static let slashItems = [
        SlashCommandInfo(name: status, description: "Show local session status", type: "local")
    ]

    public static func commandName(in text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/") else { return nil }
        guard let first = trimmed.split(maxSplits: 1, whereSeparator: { $0.isWhitespace }).first else { return "" }
        return String(first.dropFirst())
    }

    public static func isLocal(_ name: String) -> Bool {
        slashItems.contains { $0.name.caseInsensitiveCompare(name) == .orderedSame }
    }

    public static func statusRows(_ s: ComposerStatusSnapshot) -> [ComposerStatusRow] {
        var rows = [ComposerStatusRow(label: "Surface", value: s.surface)]
        if let title = s.sessionTitle, !title.isEmpty {
            rows.append(ComposerStatusRow(label: "Session",
                                          value: s.sessionStatus.map { "\(title) (\($0))" } ?? title))
        } else {
            rows.append(ComposerStatusRow(label: "Session", value: "New session draft"))
        }
        if let agent = s.agentName, !agent.isEmpty {
            rows.append(ComposerStatusRow(label: "Agent", value: agent))
        }
        if let provider = s.provider, !provider.isEmpty {
            rows.append(ComposerStatusRow(label: "Provider", value: provider))
        }
        if let model = s.model, !model.isEmpty {
            rows.append(ComposerStatusRow(label: "Model", value: model))
        }
        if let permission = s.permissionMode, !permission.isEmpty {
            rows.append(ComposerStatusRow(label: "Permission", value: permission))
        }
        let effort = s.effort ?? ""
        rows.append(ComposerStatusRow(label: "Reasoning", value: effort.isEmpty ? "Default" : effort))
        if let tokens = s.contextTokens, tokens > 0, let window = s.contextWindow, window > 0 {
            let pct = min(100, Int((Double(tokens) / Double(window) * 100).rounded()))
            rows.append(ComposerStatusRow(label: "Context",
                                          value: "\(pct)% (\(fmtTokens(tokens)) / \(fmtTokens(window)) tokens)"))
        } else {
            rows.append(ComposerStatusRow(label: "Context", value: "not reported yet"))
        }
        if let percent = s.planUsagePercent {
            rows.append(ComposerStatusRow(label: "Plan usage",
                                          value: "\(s.planUsageLabel ?? "Primary limit") \(percent)%"))
        } else {
            rows.append(ComposerStatusRow(label: "Plan usage", value: "not reported"))
        }
        return rows
    }

    public static func statusSummary(_ s: ComposerStatusSnapshot) -> String {
        statusRows(s).map { "\($0.label): \($0.value)" }.joined(separator: " | ")
    }

    private static func fmtTokens(_ n: Int) -> String {
        if n >= 1_000_000 { return "\(n / 1_000_000)M" }
        if n >= 1000 { return "\(Int((Double(n) / 1000).rounded()))k" }
        return "\(n)"
    }
}

/// `/`-autocomplete for the composer, mirroring the web composer. The runner reports its on-disk
/// slash commands and skills (they ride the GET /runners payload as `commands` / `skills`); the
/// composer pops a hint menu while the cursor sits on a `/token` at the start of input or right
/// after whitespace, and the `+` menu opens it scoped to one asset kind.
public enum ComposerSlash {
    /// The `/token` the cursor word is on — i.e. the trailing run of non-whitespace must start
    /// with `/`. Mirrors the web regex `(?:^|\s)\/(\S*)$`. Returns the part after `/` (may be "").
    public static func token(in text: String) -> String? {
        let word = String(text.reversed().prefix { !$0.isWhitespace }.reversed())
        guard word.first == "/" else { return nil }
        return String(word.dropFirst())
    }

    /// Restrict the runner-reported items to those usable here: host-level assets (no `agentId`)
    /// plus the ones owned by this session's agent. Mirrors the web `slashItems` scoping.
    public static func scoped(items: [SlashCommandInfo], agentID: String?) -> [SlashCommandInfo] {
        items.filter { ($0.agentId ?? "").isEmpty || $0.agentId == agentID }
    }

    /// Items matching the active token, optionally narrowed to one `type` ("command"/"skill"),
    /// sorted prefix-matches-first then alphabetically and capped at 50 — web parity.
    public static func matches(items: [SlashCommandInfo], token: String?,
                               scope: String?) -> [SlashCommandInfo] {
        guard let token else { return [] }
        let q = token.lowercased()
        return items
            // `String.contains("")` is false in Swift (unlike JS `.includes('')`); an empty token
            // (just-typed `/`) must match everything.
            .filter { (scope == nil || $0.type == scope) && (q.isEmpty || $0.name.lowercased().contains(q)) }
            .sorted { a, b in
                let pa = a.name.lowercased().hasPrefix(q) ? 0 : 1
                let pb = b.name.lowercased().hasPrefix(q) ? 0 : 1
                if pa != pb { return pa < pb }
                return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
            }
            .prefix(50)
            .map { $0 }
    }

    /// Replace the trailing `/token` with `/name ` (the trailing space drops the token so the menu
    /// auto-hides), preserving any text before the token. Mirrors the web `pickSlash`.
    public static func pick(text: String, name: String) -> String {
        let wordLen = text.reversed().prefix { !$0.isWhitespace }.count
        guard wordLen > 0, text.suffix(wordLen).first == "/" else { return text }
        return String(text.dropLast(wordLen)) + "/\(name) "
    }

    /// Open the menu from the `+` button: append `/` (space-prefixed when mid-message) so a token
    /// becomes active. Mirrors the web `insertSlash`.
    public static func opening(text: String) -> String {
        if text.isEmpty || (text.last?.isWhitespace ?? false) { return text + "/" }
        return text + " /"
    }
}

/// Attachment size/kind rules, mirrored from the web composer (`addImage`). Inline-image types get
/// a 5 MB cap; everything else uploads to the worktree under a 25 MB cap.
public enum Attachments {
    public static let allowedImageTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"]
    public static let maxImageBytes = 5 * 1024 * 1024
    public static let maxFileBytes = 25 * 1024 * 1024

    public static func isInlineImage(mimeType: String) -> Bool { allowedImageTypes.contains(mimeType) }
    public static func cap(mimeType: String) -> Int {
        isInlineImage(mimeType: mimeType) ? maxImageBytes : maxFileBytes
    }

    /// `nil` ⇒ OK to upload; otherwise a user-facing reason it was rejected.
    public static func rejectReason(mimeType: String, byteCount: Int) -> String? {
        if byteCount <= 0 { return "File is empty" }
        if byteCount > cap(mimeType: mimeType) {
            return isInlineImage(mimeType: mimeType) ? "Image exceeds the 5MB limit"
                                                     : "File exceeds the 25MB limit"
        }
        return nil
    }
}

/// Builds a `multipart/form-data` body for attachment upload (POST /attachments). Kept pure so
/// the byte layout is unit-testable without a network round-trip.
public enum Multipart {
    public static func boundary(seed: Int) -> String { "orbit.boundary.\(seed)" }

    public static func body(boundary: String, fieldName: String, filename: String,
                            mimeType: String, fileData: Data) -> Data {
        var body = Data()
        func append(_ s: String) { body.append(Data(s.utf8)) }
        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"\(fieldName)\"; filename=\"\(filename)\"\r\n")
        append("Content-Type: \(mimeType)\r\n\r\n")
        body.append(fileData)
        append("\r\n--\(boundary)--\r\n")
        return body
    }
}
