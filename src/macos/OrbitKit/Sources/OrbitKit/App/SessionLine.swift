import Foundation

/// The preview line shown under a session title in the Agent-console list — a direct port of the
/// web `sessionLine`. For a live RUNNING session it surfaces the current state (the tool in flight,
/// that it's blocked on you, the message you just sent while awaiting the reply, or a bare
/// "Running…") so the row never collapses to just a title; otherwise it's the flattened last
/// assistant reply (or nil). `tone` drives the colour.
public struct SessionLine: Equatable, Sendable {
    public enum Tone: String, Sendable {
        case preview   // reply content — default/secondary
        case running   // working
        case approval  // needs you
        case queued    // waiting for a slot
    }
    public let text: String
    public let tone: Tone
    public init(text: String, tone: Tone) {
        self.text = text
        self.tone = tone
    }

    /// Build the line for a session. `live` mirrors the web's `openable` (true for every non-trash
    /// tab); macOS has no trash view, so callers pass `true`. Returns nil when there's nothing to
    /// show (an idle session with no last reply) — the row then shows only its title.
    public static func make(for s: Session, live: Bool) -> SessionLine? {
        if live && s.status == .running {
            if (s.pendingApprovals ?? 0) > 0 { return SessionLine(text: "Waiting for approval", tone: .approval) }
            if let t = s.lastToolUse, !t.isEmpty { return SessionLine(text: "Running \(fmtTool(t))…", tone: .running) }
            // A turn just started and the agent hasn't replied yet: show the message you just sent
            // (server-set while the user turn is the frontier, cleared once a reply/tool lands)
            // rather than the now-stale previous reply. Content, not status — the spinner already
            // conveys "working" — so it takes the muted preview tone.
            if let u = s.lastUserText, !u.isEmpty { return SessionLine(text: plainPreview(u), tone: .preview) }
            if let a = s.lastAssistantText, !a.isEmpty { return SessionLine(text: plainPreview(a), tone: .preview) }
            return SessionLine(text: "Running…", tone: .running)
        }
        if live && s.status == .pending { return SessionLine(text: "Queued", tone: .queued) }
        // Parked (AWAITING_INPUT) but a background process is still running — not idle.
        if live, let bg = s.runningBgCount, bg > 0 {
            return SessionLine(text: "\(bgRunningLabel(bg))…", tone: .running)
        }
        if let a = s.lastAssistantText, !a.isEmpty { return SessionLine(text: plainPreview(a), tone: .preview) }
        return nil
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
