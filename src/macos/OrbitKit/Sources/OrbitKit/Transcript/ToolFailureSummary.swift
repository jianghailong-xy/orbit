import Foundation

/// An engine stderr line that reports a failed tool call, reduced to what its folded card shows:
/// which tool, which file, and why. OrbitApp's `ToolFailureCardView` draws it in place of a raw red
/// log row (web parity: `parseToolFailureSummary` + `ToolFailureCard` in `Transcript.tsx`).
public struct ToolFailureSummary {
    public let tool: String?
    public let path: String?
    public let reason: String

    /// Tool verification failures arrive as engine stderr, sometimes with the file path and
    /// explanation split over several lines. Extract only the stable summary for the folded card;
    /// the original message remains available when the reader expands it.
    public static func parse(_ message: String) -> ToolFailureSummary? {
        let clean = message.replacingOccurrences(of: "\r\n", with: "\n")
        guard let marker = clean.range(of: "error=", options: .caseInsensitive) else { return nil }
        let tail = String(clean[marker.lowerBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        let rest = String(tail.dropFirst("error=".count))
        let lowerRest = rest.lowercased()
        let tool: String?
        let detail: String
        if let verification = lowerRest.range(of: " verification failed:") {
            let toolEnd = rest.index(rest.startIndex, offsetBy: verification.lowerBound.utf16Offset(in: lowerRest))
            let detailStart = rest.index(rest.startIndex, offsetBy: verification.upperBound.utf16Offset(in: lowerRest))
            let parsedTool = String(rest[..<toolEnd])
            guard !parsedTool.isEmpty else { return nil }
            tool = parsedTool
            detail = String(rest[detailStart...]).trimmingCharacters(in: .whitespacesAndNewlines)
        } else if lowerRest.hasPrefix("failed to parse function arguments") {
            tool = nil
            detail = rest.trimmingCharacters(in: .whitespacesAndNewlines)
        } else {
            // Tool-router failures that are not verification failures still carry the tool name
            // immediately after `error=` (for example `view_image.detail ...`). Keep them on the
            // same compact tool row instead of falling back to a raw red log line.
            detail = rest.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let name = routerToolName(detail) else { return nil }
            tool = name.isEmpty ? nil : name
        }

        var path: String?
        if let worktrees = detail.range(of: "/worktrees/") {
            let afterWorktree = detail[worktrees.upperBound...]
            if let slash = afterWorktree.firstIndex(of: "/") {
                let candidate = afterWorktree[afterWorktree.index(after: slash)...]
                let end = candidate.firstIndex(where: { $0 == ":" || $0 == "\n" || $0 == " " }) ?? candidate.endIndex
                let value = String(candidate[..<end])
                if !value.isEmpty { path = value }
            }
        }

        let lower = detail.lowercased()
        let reason: String
        if lower.hasPrefix("invalid patch:") {
            reason = "Invalid patch"
        } else if lower.hasPrefix("failed to find expected lines") {
            reason = "Expected lines not found"
        } else if lower.hasPrefix("failed to parse function arguments") {
            reason = detail
        } else if lowerRest.contains("verification failed:") {
            reason = "Patch verification failed"
        } else {
            reason = detail
        }
        return ToolFailureSummary(tool: tool, path: path, reason: reason)
    }

    /// The tool a tool-router failure names: the leading `[\w.-]+` token of what follows `error=`,
    /// up to its first dot (`view_image.detail only supports …` → `view_image`), or nil when the
    /// text doesn't open with one. The reducer settles the running call of this name, so a card and
    /// the call it settles can't disagree on it. Web parity: `parseToolFailureSummary`'s last branch.
    static func routerToolName(_ detail: String) -> String? {
        let token = detail.prefix { $0.isASCII && ($0.isLetter || $0.isNumber || "_.-".contains($0)) }
        return token.isEmpty ? nil : String(token.prefix { $0 != "." })
    }
}
