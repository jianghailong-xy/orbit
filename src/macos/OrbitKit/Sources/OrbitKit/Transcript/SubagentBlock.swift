import Foundation

/// Orbit's own SubAgent — a `mcp__orbit__delegate` call (docs/subagent-design.md §6.4) — as the
/// transcript's block draws it: the folded row's grey second line, the Background mark and the opened
/// block's grey Why line. UI-free so the words stay unit-testable and both native clients draw them
/// the same.
///
/// iOS and macOS have no room for web's trailing meta on the row itself (board 03): the second line
/// carries the type, tier and model, and, once the run has ended, how long it took and what it cost —
/// the same ' · <duration> · $<cost>' web appends to its meta. A background run puts `Background` in
/// the type's place — the same fact web draws as a tag beside the call.
public struct SubagentBlock: Equatable, Sendable {
    public static let toolName = "mcp__orbit__delegate"

    /// `explore`, `general`, or a definition file's name; `general` when the call named none.
    public let type: String
    public let background: Bool
    /// `<type> · <tier> · <model> · <duration> · <cost>` (Background in the type's place), with the
    /// duration and cost only once the run has ended. Nil when the call has not been answered yet by
    /// a run and named no type of its own.
    public let detailLine: String?
    /// The router's reasons in order, joined — the opened block's Why line. Nil when it gave none.
    public let why: String?
    /// Whether the run is still going (a background call answers at once, so its card's status is
    /// already `ok` while the work goes on).
    public let running: Bool

    public static func describe(input: JSONValue, run: SubagentRunView?, status: ToolStatus) -> SubagentBlock {
        let callType = nonEmpty(input["type"]?.stringValue) ?? "general"
        let type = nonEmpty(run?.type) ?? callType
        let background = run?.background ?? (input["background"]?.boolValue == true)

        var parts: [String] = [background ? "Background" : type]
        if let level = nonEmpty(run?.level) { parts.append(level) }
        if let model = nonEmpty(run?.modelLabel) ?? nonEmpty(run?.model) { parts.append(model) }
        if let duration = duration(run) { parts.append(duration) }
        if let cost = cost(run) { parts.append(cost) }

        let reasons = (run?.reasons ?? []).filter { !$0.isEmpty }
        return SubagentBlock(
            type: type,
            background: background,
            detailLine: parts.joined(separator: " · "),
            why: reasons.isEmpty ? nil : reasons.joined(separator: " · "),
            running: run?.isRunning ?? (status == .running),
        )
    }

    /// How long the run took, once it has ended. A run still going has no duration to show yet.
    private static func duration(_ run: SubagentRunView?) -> String? {
        guard let run, !run.isRunning, let endedAt = run.endedAt,
              let start = RelativeTime.parse(run.createdAt), let end = RelativeTime.parse(endedAt) else {
            return nil
        }
        return WikiRunsLogic.duration(end.timeIntervalSince(start))
    }

    /// What the run cost, once it has ended: `$0.03` in cents, or `<$0.01` when it came to less.
    private static func cost(_ run: SubagentRunView?) -> String? {
        guard let run, !run.isRunning else { return nil }
        guard run.costUsd >= 0.01 else { return "<$0.01" }
        return String(format: "$%.2f", locale: Locale(identifier: "en_US_POSIX"), run.costUsd)
    }
}

/// What a SubAgent handed back: a foreground call's result is `{ runId, status, result, … }`; a
/// background call's is only its receipt, so its result comes from the run once that has ended.
public enum SubagentResult {
    /// The text the opened block ends with, or nil while there is nothing to show (a background
    /// call's receipt says only that the work started). Anything unrecognised is shown as it came.
    public static func text(callResult: String?, run: SubagentRunView?) -> String? {
        guard let text = callResult?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty else {
            return endedSummary(run)
        }
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return text
        }
        if let handedBack = object["result"] as? String, !handedBack.isEmpty { return handedBack }
        if let summary = endedSummary(run) { return summary }
        // A launch receipt (`{ runId, status: "running" }`): the work is drawn, not this.
        if object["runId"] != nil { return nil }
        return text
    }

    private static func endedSummary(_ run: SubagentRunView?) -> String? {
        guard let run, !run.isRunning else { return nil }
        return nonEmpty(run.resultSummary)
    }
}

/// What moves a session's SubAgent runs: each top-level `delegate` call and its result, and the
/// terminal `background_task` a background run ends with. Empty when the transcript holds no delegate
/// call, so a session that never delegated reads nothing (web parity: `delegateRunsSignature`).
public enum SubagentRuns {
    public static func signature(items: [TranscriptItem], background: [BackgroundProc]) -> String {
        var parts: [String] = []
        var calls: Set<String> = []
        for item in items {
            guard case .toolCall(let card) = item, card.name == SubagentBlock.toolName else { continue }
            calls.insert(card.id)
            parts.append("\(card.id):\(card.status.rawValue):\(card.resultSeq.map(String.init) ?? "-")")
        }
        for row in background where calls.contains(row.id) {
            parts.append("\(row.id):\(row.status)")
        }
        return parts.joined(separator: ",")
    }
}

private func nonEmpty(_ value: String?) -> String? {
    guard let value, !value.isEmpty else { return nil }
    return value
}
