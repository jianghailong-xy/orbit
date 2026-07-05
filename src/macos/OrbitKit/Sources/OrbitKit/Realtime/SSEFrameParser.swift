import Foundation

/// One dispatched Server-Sent Event (per the WHATWG SSE framing).
public struct SSEEvent: Equatable, Sendable {
    public let id: String?
    public let event: String?
    public let data: String
}

/// Incremental SSE line parser. Feed it lines (as the byte stream yields them); it returns a
/// completed `SSEEvent` when a blank line dispatches the accumulated `data:` fields. Pure and
/// stateful — no networking — so it is fully unit-testable.
public struct SSEFrameParser: Sendable {
    private var dataLines: [String] = []
    private var event: String?
    private var lastID: String?
    private var byteLine: [UInt8] = []

    public init() {}

    /// Feed one raw byte from the network stream; returns a dispatched event when a line ends
    /// (`\n`) and completes a frame (a blank line).
    ///
    /// This is the live-transport path. It splits lines on raw bytes itself rather than relying
    /// on `URLSession.AsyncBytes.lines`, whose handling of the empty line in SSE's `\n\n` frame
    /// delimiter is unreliable — if the blank line is swallowed, frames never dispatch and the
    /// stream looks connected but silent. `consume(line:)` strips a trailing `\r`, so CRLF works.
    public mutating func consume(byte: UInt8) -> SSEEvent? {
        if byte == 0x0A {                                  // \n ends a line
            let line = String(decoding: byteLine, as: UTF8.self)
            byteLine.removeAll(keepingCapacity: true)
            return consume(line: line)
        }
        byteLine.append(byte)
        return nil
    }

    /// Consume one line (without its trailing newline). Returns an event on dispatch (blank line).
    public mutating func consume(line rawLine: String) -> SSEEvent? {
        var line = rawLine
        if line.hasSuffix("\r") { line.removeLast() }   // tolerate CRLF

        if line.isEmpty {
            guard !dataLines.isEmpty else { return nil } // stray blank / heartbeat gap
            let ev = SSEEvent(id: lastID, event: event, data: dataLines.joined(separator: "\n"))
            dataLines.removeAll(keepingCapacity: true)
            event = nil
            return ev
        }
        if line.hasPrefix(":") { return nil }            // comment (servers send `:` keepalives)

        let (field, value) = Self.split(line)
        switch field {
        case "data":  dataLines.append(value)
        case "event": event = value
        case "id":    lastID = value
        case "retry": break
        default:      break
        }
        return nil
    }

    /// Convenience for whole buffers / tests: split on newlines (keeping blanks) and dispatch.
    /// Splits with `Character.isNewline` rather than `split(separator: "\n")`: in Swift, `\r\n`
    /// is a single grapheme cluster, so splitting on a lone `"\n"` Character silently fails to
    /// break CRLF lines. `isNewline` matches LF, CR, and the CRLF cluster alike.
    public mutating func parse(_ text: String) -> [SSEEvent] {
        var out: [SSEEvent] = []
        for sub in text.split(omittingEmptySubsequences: false, whereSeparator: { $0.isNewline }) {
            if let ev = consume(line: String(sub)) { out.append(ev) }
        }
        return out
    }

    private static func split(_ line: String) -> (field: String, value: String) {
        guard let idx = line.firstIndex(of: ":") else { return (line, "") }
        let field = String(line[line.startIndex..<idx])
        var rest = String(line[line.index(after: idx)...])
        if rest.hasPrefix(" ") { rest.removeFirst() }   // SSE strips one leading space
        return (field, rest)
    }
}

public enum SSEDecoding {
    private static let decoder = JSONDecoder()

    /// Decode a dispatched SSE event's `data` payload into a `RunEvent` (nil on non-JSON, e.g.
    /// a keepalive that slipped through).
    public static func runEvent(from e: SSEEvent) -> RunEvent? {
        guard let data = e.data.data(using: .utf8) else { return nil }
        return try? decoder.decode(RunEvent.self, from: data)
    }

    /// Decode a control-plane frame (`GET /api/events`) into a `ControlEvent`. nil for frames
    /// that aren't control events — notably the server's `{type:"ping"}` keepalive, which has no
    /// sessionId and exists only to feed the byte watchdog.
    public static func controlEvent(from e: SSEEvent) -> ControlEvent? {
        guard let data = e.data.data(using: .utf8) else { return nil }
        return try? decoder.decode(ControlEvent.self, from: data)
    }
}
