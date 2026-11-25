import Foundation

/// An agent's transfers to and from Drive (`drive_put` / `drive_get`, `documents_put` / `documents_get` while it was
/// called Documents), as one transfer card in the conversation (board docs/mocks/agent-drive-transfer). Web parity:
/// `src/web/src/lib/driveTransfer.ts` and `components/drive/DriveTransferCard.tsx`.
///
/// While a call runs, the runner sends its bytes as the call's live `tool_output`, one sentence restating the whole
/// count: "Uploaded 3355443 of 11954323 bytes" (runner-go documents_progress.go). The reducer keeps that line in the
/// running card's `result`, as it keeps a shell's output; the durable tool_result replaces it when the call ends, so a
/// finished card is drawn from results alone.
public enum DriveTransfer {
    public enum Kind: String, Equatable, Sendable { case put, get }

    /// The kind of transfer a call is, or nil when it is no transfer.
    public static func kind(_ toolName: String) -> Kind? {
        switch toolName {
        case "mcp__orbit__documents_put", "mcp__orbit__drive_put": return .put
        case "mcp__orbit__documents_get", "mcp__orbit__drive_get": return .get
        default: return nil
        }
    }

    // MARK: the live line

    private static let progressLine = try! NSRegularExpression(pattern: "^(Uploaded|Downloaded) (\\d+) of (\\d+) bytes$")

    /// The bytes a progress line counts, or nil when the text is not one.
    public static func progress(_ content: String?) -> (sent: Int, size: Int)? {
        guard let content else { return nil }
        let range = NSRange(content.startIndex..., in: content)
        guard let match = progressLine.firstMatch(in: content, range: range),
              let sentRange = Range(match.range(at: 2), in: content),
              let sizeRange = Range(match.range(at: 3), in: content),
              let sent = Int(content[sentRange]), let size = Int(content[sizeRange]), size > 0 else { return nil }
        return (min(sent, size), size)
    }

    // MARK: one file

    /// A Drive path as the owner reads it: `~/Drive/a`, `/home/orbit/Drive/a` and the mount's
    /// `/run/orbit-drive/drive/a` are `/a`, as are the spellings from before the renames (the mount at
    /// `/run/orbit-documents` and `/run/orbit-files` in an older Pod).
    public static func displayPath(_ raw: String?) -> String {
        var p = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        for prefix in ["~/Drive", "/home/orbit/Drive",
                       "/run/orbit-drive/drive", "/run/orbit-documents/drive", "/run/orbit-files/drive"] where p == prefix || p.hasPrefix(prefix + "/") {
            p = String(p.dropFirst(prefix.count))
        }
        if !p.hasPrefix("/") { p = "/" + p }
        while p.contains("//") { p = p.replacingOccurrences(of: "//", with: "/") }
        return p
    }

    public enum Status: Equatable, Sendable { case waiting, running, done, failed, stopped }

    public struct File: Equatable, Sendable, Identifiable {
        public let id: String
        /// The file's Drive path.
        public let path: String
        public let status: Status
        /// Bytes moved so far; for a finished file, its size.
        public let sent: Int
        /// Nil until the call has said how big the file is.
        public let size: Int?
        /// The Drive entry an upload made, once it is in.
        public let entryID: String?
        public let error: String?
        public let startedAt: Date?
        public let endedAt: Date?

        public var name: String { path.split(separator: "/").last.map(String.init) ?? path }
    }

    /// What one call's input, result and live line say about its file. `live` is whether the session's turn is at
    /// work: a call with no answer in one that is not was cut off.
    public static func file(_ card: ToolCard, live: Bool) -> File {
        let path = displayPath(card.input["path"]?.stringValue)
        let started = card.ts.flatMap(DriveLogic.date)
        let ended = card.resultTs.flatMap(DriveLogic.date)
        func make(_ status: Status, sent: Int = 0, size: Int? = nil, entryID: String? = nil, error: String? = nil) -> File {
            File(id: card.id, path: path, status: status, sent: sent, size: size, entryID: entryID, error: error,
                 startedAt: started, endedAt: ended)
        }
        switch card.status {
        case .running:
            if let line = progress(card.result) {
                return make(live ? .running : .stopped, sent: line.sent, size: line.size)
            }
            return make(live ? .waiting : .stopped)
        case .error:
            return make(.failed, error: refusal(card.result))
        case .ok:
            let parsed = json(card.result)
            // A runner that answers with a receipt puts the call's own answer under `entity`, and says a refusal in
            // `error`.
            if parsed?["receiptVersion"] != nil, parsed?["ok"]?.boolValue == false {
                return make(.failed, error: parsed?["error"]?["message"]?.stringValue ?? refusal(card.result))
            }
            let answer = parsed?["receiptVersion"] != nil ? (parsed?["entity"] ?? parsed) : parsed
            let size = answer?["sizeBytes"]?.intValue
            let link = answer?["link"]?.stringValue
            let entryID = link.flatMap { link -> String? in
                for prefix in ["orbit-document:", "orbit-drive:"] where link.hasPrefix(prefix) {
                    let id = String(link.dropFirst(prefix.count))
                    return id.isEmpty ? nil : id
                }
                return nil
            }
            return make(.done, sent: size ?? 0, size: size, entryID: entryID)
        }
    }

    private static func json(_ text: String?) -> JSONValue? {
        guard let text, let data = text.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: data)
    }

    private static func refusal(_ text: String?) -> String {
        let line = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init) ?? ""
        return line.isEmpty ? "Couldn't transfer this file" : line
    }

    // MARK: a run of files

    /// The folder every file sits in, as `/a/b/`; `/` when they share none.
    public static func commonFolder(_ paths: [String]) -> String {
        let dirs = paths.map { Array($0.split(separator: "/", omittingEmptySubsequences: true).dropLast()) }
        guard let first = dirs.first else { return "/" }
        var shared: [Substring] = []
        for (i, part) in first.enumerated() {
            guard dirs.allSatisfy({ i < $0.count && $0[i] == part }) else { break }
            shared.append(part)
        }
        return shared.isEmpty ? "/" : "/" + shared.joined(separator: "/") + "/"
    }

    public struct Summary: Equatable, Sendable {
        public let kind: Kind
        public let folder: String
        public let total: Int
        public let done: Int
        public let failed: Int
        public let waiting: Int
        public let stopped: Int
        public let running: File?
        /// Bytes moved by every file so far.
        public let sentBytes: Int
        /// Bytes still to move, when every file not yet done has said its size; otherwise nil.
        public let leftBytes: Int?
        /// 0–1: files done, plus the running file's share. A failed file is behind the bar, not in it.
        public let fraction: Double
        public let finished: Bool
        /// First start to last end, when every call carries its time.
        public let elapsed: TimeInterval?

        /// Every file in, none failed or cut off.
        public var clean: Bool { finished && failed == 0 && stopped == 0 }
    }

    public static func summarize(_ kind: Kind, _ files: [File]) -> Summary {
        func count(_ status: Status) -> Int { files.filter { $0.status == status }.count }
        let running = files.first { $0.status == .running }
        let open = files.filter { $0.status == .running || $0.status == .waiting }
        let leftBytes: Int? = open.allSatisfy({ $0.size != nil })
            ? open.reduce(0) { $0 + (($1.size ?? 0) - $1.sent) } : nil
        let runningShare = running.flatMap { file in file.size.map { Double(file.sent) / Double(max($0, 1)) } } ?? 0
        let starts = files.compactMap(\.startedAt)
        let ends = files.compactMap(\.endedAt)
        var elapsed: TimeInterval?
        if starts.count == files.count, ends.count == files.count, let first = starts.min(), let last = ends.max(),
           last >= first {
            elapsed = last.timeIntervalSince(first)
        }
        let done = count(.done)
        return Summary(kind: kind, folder: commonFolder(files.map(\.path)), total: files.count, done: done,
                       failed: count(.failed), waiting: count(.waiting), stopped: count(.stopped), running: running,
                       sentBytes: files.reduce(0) { $0 + $1.sent }, leftBytes: leftBytes,
                       fraction: files.isEmpty ? 0 : min(1, (Double(done) + runningShare) / Double(files.count)),
                       finished: open.isEmpty, elapsed: elapsed)
    }

    /// Bytes per second over the last few seconds of samples, or nil before two of them half a second apart.
    public static func rate(_ samples: [(at: Date, bytes: Int)], window: TimeInterval = 3) -> Double? {
        guard samples.count >= 2, let last = samples.last else { return nil }
        let first = samples.first { last.at.timeIntervalSince($0.at) <= window } ?? samples[0]
        let span = last.at.timeIntervalSince(first.at)
        guard span >= 0.5 else { return nil }
        return max(0, Double(last.bytes - first.bytes) / span)
    }

    // MARK: words

    public struct Words: Equatable, Sendable {
        public let going: String
        public let went: String
        public let title: String
        public let past: String
        public let couldnt: String
        public let symbol: String
    }

    public static func words(_ kind: Kind) -> Words {
        switch kind {
        case .put: return Words(going: "Uploading", went: "Uploaded", title: "Uploading to Drive", past: "uploaded",
                                couldnt: "Couldn't upload", symbol: "arrow.up")
        case .get: return Words(going: "Downloading", went: "Downloaded", title: "Downloading from Drive",
                                past: "downloaded", couldnt: "Couldn't download", symbol: "arrow.down")
        }
    }

    /// "8 s", "2 min 5 s".
    public static func duration(_ seconds: TimeInterval) -> String {
        let s = max(1, Int(seconds.rounded()))
        return s < 60 ? "\(s) s" : "\(s / 60) min \(s % 60) s"
    }

    /// The card's title: what it is doing, or what it did.
    public static func title(_ summary: Summary) -> String {
        let words = words(summary.kind)
        if !summary.finished { return words.title }
        if summary.clean { return "\(words.went) \(DriveLogic.files(summary.done))" }
        return "\(words.went) \(summary.done) of \(DriveLogic.files(summary.total))"
    }

    /// The bold part of the line under the bar: "Uploading 7 of 15", "Uploading file 7", "14 uploaded, 1 failed".
    public static func counting(_ summary: Summary) -> String {
        let words = words(summary.kind)
        if summary.finished {
            return ["\(summary.done) \(words.past)",
                    summary.failed > 0 ? "\(summary.failed) failed" : nil,
                    summary.stopped > 0 ? "\(summary.stopped) stopped" : nil]
                .compactMap { $0 }.joined(separator: ", ")
        }
        let position = summary.done + summary.failed + 1
        // The agent starts its calls one at a time, so the whole count is known only once a call is waiting behind
        // the one going.
        return summary.waiting > 0 ? "\(words.going) \(position) of \(summary.total)" : "\(words.going) file \(position)"
    }

    /// The bytes after it: "58 MB of 131 MB", "58 MB so far", "131 MB in 26 s".
    public static func bytes(_ summary: Summary) -> String {
        let sent = DriveLogic.formatSize(summary.sentBytes)
        if summary.finished { return sent + (summary.elapsed.map { " in \(duration($0))" } ?? "") }
        if let left = summary.leftBytes, summary.waiting == 0 {
            return "\(sent) of \(DriveLogic.formatSize(summary.sentBytes + left))"
        }
        return "\(sent) so far"
    }

    /// The right of that line: the speed and time left while it goes, "No progress for 21 s" when it stalls, the
    /// average once it is over.
    public static func pace(_ summary: Summary, rate: Double?, stalledFor: TimeInterval?) -> String? {
        if summary.finished {
            guard let elapsed = summary.elapsed, elapsed >= 1 else { return nil }
            return "average \(DriveLogic.rate(Double(summary.sentBytes) / elapsed))"
        }
        if let stalledFor { return "No progress for \(Int(stalledFor)) s" }
        guard let rate, rate > 0 else { return nil }
        let left = summary.waiting == 0 ? summary.leftBytes.flatMap { DriveLogic.timeLeft(bytesLeft: $0, rate: rate) } : nil
        return [DriveLogic.rate(rate), left].compactMap { $0 }.joined(separator: " · ")
    }

    /// A row's size column: "2.6 MB", "3.2 MB of 11 MB", "Waiting", "Stopped", "Failed".
    public static func rowSize(_ file: File) -> String {
        switch file.status {
        case .done: return file.size.map(DriveLogic.formatSize) ?? ""
        case .running:
            guard let size = file.size else { return "" }
            return "\(DriveLogic.formatSize(file.sent)) of \(DriveLogic.formatSize(size))"
        case .waiting: return "Waiting"
        case .stopped: return "Stopped"
        case .failed: return "Failed"
        }
    }

    /// How long after the last new byte the card says the transfer is not moving.
    public static let stallAfter: TimeInterval = 20
    /// Rows a long run shows before "Show all".
    public static let rowsShown = 8

    /// The rows a long run shows: around the file going now, or the ones not done first once it is over.
    public static func shownRows(_ files: [File], all: Bool) -> [File] {
        guard !all, files.count > rowsShown else { return files }
        guard let current = files.firstIndex(where: { $0.status == .running || $0.status == .waiting }) else {
            return Array((files.filter { $0.status != .done } + files.filter { $0.status == .done }).prefix(rowsShown))
        }
        let start = max(0, min(current - 4, files.count - rowsShown))
        return Array(files[start..<(start + rowsShown)])
    }
}
