import Foundation

/// A `tool_result`'s `content` — a plain string, an array of blocks (`text`, `image`, …), or a whole
/// MCP `CallToolResult` wrapper, depending on the engine. Two places read the same shapes: the
/// reducer, which files the first copy from the server's preview, and a clipped card, which
/// re-derives it from the untrimmed refetch — so the parsing lives here once. Web parity:
/// `resultText` / `resultImages` / `hasResultImage` in `Transcript.tsx`.
public enum ToolResultContent {
    /// A tool_result's `content` flattened to displayable text — the native half of web's
    /// `resultText`. Three shapes reach us and all three are web's: a plain string (Claude's own
    /// tools), an array of blocks (an MCP tool's `[{type:"text"}]`), and the whole `CallToolResult`
    /// wrapper (`{_meta, content}`) that some engines pass through verbatim. Blocks join on a
    /// newline, image blocks contribute nothing (`images` draws them instead), and anything with no
    /// text of its own falls back to its own JSON, as it does on web.
    ///
    /// nil, not "", when nothing came of it: an image-only result must not open an empty OUTPUT
    /// panel under its picture, and `closeTool` reads a nil `result` as "this card is still open".
    public static func text(_ v: JSONValue?) -> String? {
        guard let v else { return nil }
        let flat: String
        switch v {
        case .null:
            return nil
        case .string(let raw):
            flat = raw
        case .int, .double, .bool:
            flat = v.asString ?? ""
        case .array(let blocks):
            flat = blocks.compactMap(blockText).joined(separator: "\n")
        case .object:
            flat = json(v) ?? ""
        }
        return flat.isEmpty ? nil : flat
    }

    /// One content block's text, or nil for a block that contributes none.
    private static func blockText(_ b: JSONValue) -> String? {
        if let raw = b.stringValue { return raw.isEmpty ? nil : raw }
        switch b["type"]?.stringValue {
        case "text":
            let t = b["text"]?.stringValue ?? ""
            return t.isEmpty ? nil : t
        case "image":
            return nil          // drawn by `images`, not printed
        default:
            return json(b) ?? b.asString
        }
    }

    /// A block/wrapper rendered as JSON, standing in for web's `safeJson`
    /// (`JSON.stringify(v, null, 2)`). Two cosmetic differences remain, both from Foundation's
    /// printer and neither worth hand-rolling a serializer over: keys come out sorted rather than in
    /// the server's order (a Swift dictionary has none to preserve, and an unsorted encode would
    /// reshuffle the same result between renders), and the separator is `" : "` where JS writes
    /// `": "`.
    private static func json(_ v: JSONValue) -> String? {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let d = try? e.encode(v) else { return nil }
        return String(data: d, encoding: .utf8)
    }

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
