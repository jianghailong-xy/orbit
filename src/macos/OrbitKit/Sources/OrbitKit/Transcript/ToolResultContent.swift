import Foundation

/// A `tool_result`'s `content`, which the engine delivers either as a plain string or as an array
/// of blocks (`text`, `image`, …). Two places read the same shape — the reducer, which files the
/// first copy from the server's preview, and a clipped card, which re-derives it from the untrimmed
/// refetch — so the parsing lives here once. Web parity: `resultImages` / `hasResultImage` in
/// `Transcript.tsx`.
public enum ToolResultContent {
    /// Image blocks decoded to bytes — `Read` on a .png, an MCP tool returning a screenshot. A
    /// string or text-only `content` yields []. Base64 that doesn't decode is dropped: the view has
    /// nothing to draw from it.
    public static func images(_ v: JSONValue?) -> [Data] {
        guard case .array(let blocks)? = v else { return [] }
        return blocks.compactMap { b in
            guard b["type"]?.stringValue == "image",
                  let b64 = b["source"]?["data"]?.stringValue,
                  let bytes = Data(base64Encoded: b64) else { return nil }
            return bytes
        }
    }

    /// Whether an image belongs here at all — including one the server emptied of its bytes because
    /// it was too big to ship inline (the apiserver's `MAX_IMAGE_PAYLOAD` drops `source.data` and
    /// keeps the block). `images` is empty for that one, so a card that decided it had nothing to
    /// show would fold — and a folded card never refetches, which makes the picture gone rather
    /// than deferred. Web parity: `hasResultImage`.
    public static func hasImage(_ v: JSONValue?) -> Bool {
        guard case .array(let blocks)? = v else { return false }
        return blocks.contains { $0["type"]?.stringValue == "image" }
    }
}
