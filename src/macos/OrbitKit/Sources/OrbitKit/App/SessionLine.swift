import Foundation

/// The preview line shown under a session title in the Agent-console list — a direct port of the
/// web `sessionLine`. For a live session that's generating (see `Session.isGenerating`) it
/// surfaces the current state (the tool in flight, that it's blocked on you, the message you just
/// sent while awaiting the reply, or a bare "Running…") so the row never collapses to just a
/// title; otherwise it's the flattened last assistant reply, falling back to the run's own state
/// word. `tone` drives the colour.
public struct SessionLine: Equatable, Sendable {
    public enum Tone: String, Sendable {
        case preview     // reply content — default/secondary
        case running     // working
        case approval    // needs you
        case queued      // waiting for a slot
        case background  // a process the agent left up — outlives the turn, but isn't work
    }
    public let text: String
    public let tone: Tone
    public init(text: String, tone: Tone) {
        self.text = text
        self.tone = tone
    }

    /// Build the line for a session. `live` is false in Trash. Always yields a line: a run that
    /// ended before producing any reply still says what happened, so the row can't shrink to a
    /// bare title (iOS sizes its list row from its content — a missing line visibly shortens it).
    public static func make(for s: Session, live: Bool) -> SessionLine {
        if live && s.isGenerating {
            if (s.pendingApprovals ?? 0) > 0 { return SessionLine(text: "Waiting for approval", tone: .approval) }
            if let t = s.lastToolUse, !t.isEmpty { return SessionLine(text: "Running \(fmtTool(t))…", tone: .running) }
            // The agent hasn't answered yet: show the message you sent (server-kept from the moment
            // it is enqueued until a reply lands) rather than the previous turn's reply, which
            // would read as if this one had already been answered. Content, not status — the
            // spinner already conveys "working" — so it takes the muted preview tone.
            if let u = s.lastUserText, !u.isEmpty { return sentLine(u) }
            if let a = s.lastAssistantText, !a.isEmpty { return SessionLine(text: plainPreview(a), tone: .preview) }
            return SessionLine(text: "Running…", tone: .running)
        }
        if live && s.effectiveRunState == .queued {
            return SessionLine(text: "Queued", tone: .queued)
        }
        // Parked (AWAITING_INPUT) but a background process is still running — not idle, though
        // not the agent working either (see the glyph): muted, not the working blue.
        if live, let bg = s.runningBgCount, bg > 0 {
            return SessionLine(text: "\(bgRunningLabel(bg))…", tone: .background)
        }
        // A message that never got an answer — the turn was interrupted, or failed, before any
        // reply landed — outranks the previous turn's reply: it's the newer of the two, and it's
        // what the session is left waiting on. The server only keeps it while it stands
        // unanswered, so a non-empty value here always means exactly that.
        if let u = s.lastUserText, !u.isEmpty { return sentLine(u) }
        if let a = s.lastAssistantText, !a.isEmpty { return SessionLine(text: plainPreview(a), tone: .preview) }
        // Nothing to preview at all (a run that died before even its user turn was recorded, or an
        // older row from before the server kept the pending message). Fall back to the run's own
        // state word — the same one the console header shows — so the row still says what happened
        // instead of collapsing.
        return SessionLine(text: SessionHeader.statusWord(for: s), tone: .preview)
    }

    /// The line for a message of YOURS the agent hasn't answered yet. Prefixed, because the preview
    /// line is otherwise the agent's voice: unmarked, a message you sent and a reply to it read
    /// exactly alike, and "has it answered me yet?" is the one question the list has to answer
    /// while a turn is running. Same flattening as a reply — a sent message may be markdown too.
    static func sentLine(_ text: String) -> SessionLine {
        SessionLine(text: "You: \(plainPreview(text))", tone: .preview)
    }

    /// Flatten an assistant reply into a single prose line: drop code blocks and the common
    /// markdown markers, then collapse all whitespace. (Length is left to the view's truncation.)
    static func plainPreview(_ md: String) -> String {
        var s = md
        s = s.replacingOccurrences(of: "```[\\s\\S]*?```", with: " ", options: .regularExpression) // fenced code
        s = s.replacingOccurrences(of: "`([^`]+)`", with: "$1", options: .regularExpression)        // inline code
        s = s.replacingOccurrences(of: "(?m)^[#>\\-*\\s]+", with: "", options: .regularExpression)   // line-start markers
        s = s.replacingOccurrences(of: "[*_~]", with: "", options: .regularExpression)               // emphasis
        s = s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Shorten a tool id for the live status line: mcp__orbit__task_create -> task_create; plain
    /// tool names (Bash, Read, Edit) pass through unchanged.
    static func fmtTool(_ name: String) -> String {
        name.replacingOccurrences(of: "^mcp__[^_]+__", with: "", options: .regularExpression)
    }

    /// "Background process running" / "N background processes running".
    static func bgRunningLabel(_ n: Int) -> String {
        n > 1 ? "\(n) background processes running" : "Background process running"
    }
}
