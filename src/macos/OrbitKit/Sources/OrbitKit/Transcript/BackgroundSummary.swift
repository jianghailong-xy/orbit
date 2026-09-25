import Foundation

/// The runtime's own words about background work, read for the tray. Each shape is Claude Code's
/// wording verbatim (claude 2.1.282), and each is matched the way the other readers of it match:
/// the shell receipt as web's `BG_ID_RE`, the workflow receipt as `workflowLaunchReceipt` in
/// @orbit/shared.
enum BackgroundSummary {
    /// "Command running in background with ID: <id>. …" → the shell's id.
    static func shellID(_ result: String) -> String? {
        guard let r = result.range(of: "running in background with ID:", options: .caseInsensitive) else { return nil }
        let id = result[r.upperBound...].drop(while: { $0.isWhitespace })
            .prefix(while: { !$0.isWhitespace && $0 != "." })
        return id.isEmpty ? nil : String(id)
    }

    /// "Async agent launched successfully. (…) agentId: <id> …" → the agent's id. Nil for a result
    /// that is not that receipt: an Agent run inline answers with its report here instead.
    static func agentID(_ result: String) -> String? {
        guard result.contains("Async agent launched"),
              let r = result.range(of: "agentId:") else { return nil }
        let id = result[r.upperBound...].drop(while: { $0.isWhitespace })
            .prefix(while: { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
        return id.isEmpty ? nil : String(id)
    }

    /// "Workflow launched in background. Task ID: <id>\nSummary: <text>\n…" → its task id and title.
    static func workflow(_ result: String) -> (taskID: String, summary: String?)? {
        let text = result.drop(while: { $0.isWhitespace })
        let prefix = "Workflow launched in background. Task ID: "
        guard text.hasPrefix(prefix) else { return nil }
        let id = text.dropFirst(prefix.count).prefix(while: { !$0.isWhitespace })
        guard !id.isEmpty else { return nil }
        let summary = text.split(separator: "\n").first(where: { $0.hasPrefix("Summary: ") })
            .map { $0.dropFirst("Summary: ".count).trimmingCharacters(in: .whitespaces) }
        return (String(id), summary?.isEmpty == false ? summary : nil)
    }

    /// A completion notification's summary — `Agent "<description>" finished`, `Dynamic workflow
    /// "<title>" completed` — read back into what finished and what it was called, for a row whose
    /// launch this client never loaded.
    static func parse(_ summary: String?) -> (kind: String, title: String)? {
        guard let summary else { return nil }
        let kind: String
        if summary.hasPrefix("Agent \"") { kind = "agent" }
        else if summary.hasPrefix("Dynamic workflow \"") { kind = "workflow" }
        else { return nil }
        guard let open = summary.firstIndex(of: "\""), let close = summary.lastIndex(of: "\""),
              open < close else { return nil }
        let title = summary[summary.index(after: open)..<close]
        return title.isEmpty ? nil : (kind, String(title))
    }
}
