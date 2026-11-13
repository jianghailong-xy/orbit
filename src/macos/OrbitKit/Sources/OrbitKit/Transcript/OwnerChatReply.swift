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
        guard result.hasPrefix(lead), let end = result.range(of: tail, options: .backwards),
              end.lowerBound >= result.index(result.startIndex, offsetBy: lead.count) else { return nil }
        let words = result[result.index(result.startIndex, offsetBy: lead.count)..<end.lowerBound]
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return words.isEmpty ? nil : words
    }

    /// The words of `card`'s result when it is one of Orbit's own calls answered this way.
    public static func words(of card: ToolCard) -> String? {
        guard card.name.hasPrefix("mcp__orbit__"), card.status != .error, let result = card.result else { return nil }
        return words(result)
    }
}
