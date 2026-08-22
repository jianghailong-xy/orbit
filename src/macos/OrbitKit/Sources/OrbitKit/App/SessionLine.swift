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
            // A turn just started and the agent hasn't replied yet: show the message you just sent
            // (server-set while the user turn is the frontier, cleared once a reply/tool lands)
            // rather than the now-stale previous reply. Content, not status — the spinner already
            // conveys "working" — so it takes the muted preview tone.
            if let u = s.lastUserText, !u.isEmpty { return SessionLine(text: plainPreview(u), tone: .preview) }
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
        // reply or tool landed — outranks the previous turn's reply: it's the newer of the two,
        // and it's what the session is left waiting on. The server only keeps it while it stands
        // unanswered, so a non-empty value here always means exactly that.
        if let u = s.lastUserText, !u.isEmpty { return SessionLine(text: plainPreview(u), tone: .preview) }
        if let a = s.lastAssistantText, !a.isEmpty { return SessionLine(text: plainPreview(a), tone: .preview) }
        // Nothing to preview at all (a run that died before even its user turn was recorded, or an
        // older row from before the server kept the pending message). Fall back to the run's own
        // state word — the same one the console header shows — so the row still says what happened
        // instead of collapsing.
        return SessionLine(text: SessionHeader.statusWord(for: s), tone: .preview)
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

/// The chip that leads a row belonging to a project. `tone` is the row's, not a colour — each client
/// paints it in its own palette. Port of web's `sessionRoleChip`.
public struct SessionRoleChip: Equatable, Sendable {
    public enum Tone: String, Sendable { case main, exec, verify }
    public let label: String
    public let tone: Tone
    public init(label: String, tone: Tone) {
        self.label = label
        self.tone = tone
    }
}

/// What a session row is titled with: the role it plays in its project, then the name of the work.
///
/// A dispatched session's own title is machine-written from the prompt that started it ("执行任务：C2
/// · Web：角色身份——…"), so a project's rows all opened with the same nine characters and differed only
/// past the ellipsis the column truncates at. The task's title is the name the work is filed under
/// everywhere else in the product, so it leads here too and the session's own title steps down to the
/// tooltip — still one hover (or long-press) away, no longer the thing you scan.
///
/// A row with no task — a coordinator, or a conversation the user started — keeps its session title:
/// that is the only name it has. Port of web's `sessionRowTitleParts`.
public struct SessionRowTitle: Equatable, Sendable {
    public let chip: SessionRoleChip?
    public let text: String
    /// The engine-written session title, when it says something `text` doesn't.
    public let tooltip: String?

    public init(chip: SessionRoleChip?, text: String, tooltip: String?) {
        self.chip = chip
        self.text = text
        self.tooltip = tooltip
    }

    /// The chip for a role, or nil for a conversation the user started themselves: the unmarked row
    /// IS "yours", and marking every row marks none of them. Nil too for a row from a server that
    /// serves no role at all.
    public static func chip(for role: SessionProjectRole?) -> SessionRoleChip? {
        switch role {
        // The project's own conversation — the one that files the work and answers for it.
        case .coordinator:  return SessionRoleChip(label: "Main", tone: .main)
        case .execution:    return SessionRoleChip(label: "Exec", tone: .exec)
        case .verification: return SessionRoleChip(label: "Verify", tone: .verify)
        case .user, nil:    return nil
        }
    }

    /// Build a row's title line. `fallback` is what an untitled, task-less session shows.
    public static func make(for s: Session, fallback: String = "Untitled session") -> SessionRowTitle {
        let sessionTitle = (s.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let taskTitle = s.taskId == nil
            ? ""
            : (s.taskTitle ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let text = taskTitle.isEmpty ? sessionTitle : taskTitle
        return SessionRowTitle(chip: chip(for: s.role),
                               text: text.isEmpty ? fallback : text,
                               tooltip: sessionTitle.isEmpty || sessionTitle == text ? nil : sessionTitle)
    }
}
