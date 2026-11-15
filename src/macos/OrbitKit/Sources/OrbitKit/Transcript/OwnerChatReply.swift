import Foundation

/// The owner's words from a "Chat about this" on one of Orbit's own asks (a project, a task, a batch,
/// a deletion…), read back from the tool result the runner wrote for the agent (`ownerChatReply` in
/// src/runner-go/mcp.go). They are a message the owner sent, so the transcript draws them as one under
/// the call's row and never folds that call into a steps line.
///
/// Hand copy of @orbit/shared `ownerChatReply.ts`; `src/shared/src/owner-chat-reply.fixture.json` is
/// the contract both are held to.
public enum OwnerChatReply {
    static let lead = "Not done yet, and not a no: the owner pressed \"Chat about this\" on the card to talk it over before deciding. Their message:\n\n"
    static let tail = "\n\nReply to it as you would to any message from them."

    /// The owner's words when `result` is a chat reply to a card, otherwise nil.
    public static func words(_ result: String) -> String? {
        let reply = receiptText(result) ?? result
        guard reply.hasPrefix(lead), let end = reply.range(of: tail, options: .backwards),
              end.lowerBound >= reply.index(reply.startIndex, offsetBy: lead.count) else { return nil }
        let words = reply[reply.index(reply.startIndex, offsetBy: lead.count)..<end.lowerBound]
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return words.isEmpty ? nil : words
    }

    /// The reply inside a chat's receipt (outcome "chat"), which is what an engine records in place of
    /// the result's text: Claude Code and Codex pass a result's structuredContent on when it has one,
    /// and the receipt carries the reply as its `text` (src/runner-go/tool_receipt.go).
    static func receiptText(_ result: String) -> String? {
        guard result.hasPrefix("{"),
              result.range(of: #""outcome"\s*:\s*"chat""#, options: .regularExpression) != nil,
              let receipt = (try? JSONSerialization.jsonObject(with: Data(result.utf8))) as? [String: Any],
              (receipt["outcome"] as? String) == "chat" else { return nil }
        return receipt["text"] as? String
    }

    /// The words of `card`'s result when it is one of Orbit's own calls answered this way.
    public static func words(of card: ToolCard) -> String? {
        guard card.name.hasPrefix("mcp__orbit__"), card.status != .error, let result = card.result else { return nil }
        return words(result)
    }
}
