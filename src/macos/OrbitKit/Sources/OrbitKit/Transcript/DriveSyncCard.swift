import Foundation

/// An agent's `drive_sync` call, as its sync's card in the transcript (board docs/mocks/drive-sync-card): the same
/// live progress as the Drive popover, kept current after the agent's turn ends, since the sync runs in the
/// background. The card stays open when the sync ends; Hide folds a clean one to one line.
///
/// Web parity: `src/web/src/lib/driveSyncs.ts` (`driveSyncIdOf`) and
/// `components/drive/DriveSyncCard.tsx`, whose words these are.
public enum DriveSyncCard {
    /// Orbit's sync tool, as every engine's MCP name for it reaches the transcript.
    public static let toolName = "mcp__orbit__drive_sync"
    /// Its name while Drive was called Drive, which stored transcripts and runners already deployed carry.
    public static let documentsToolName = "mcp__orbit__documents_sync"

    /// The sync a call's answer names, or nil for one that names none (a runner from before the card). A runner
    /// that answers with a receipt puts the call's own answer under `entity`, and a refused receipt names nothing.
    public static func syncID(_ result: String?) -> String? {
        guard let data = result?.data(using: .utf8),
              let parsed = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        let receipt = parsed["receiptVersion"] != nil
        if receipt, parsed["ok"] as? Bool == false { return nil }
        let answer = receipt ? (parsed["entity"] as? [String: Any] ?? parsed) : parsed
        guard let id = answer["syncId"] as? String, !id.isEmpty else { return nil }
        return id
    }

    /// Whether a call draws as its sync's card: one that answered, naming its sync. A call still running, refused,
    /// or answered by an older runner stays an ordinary call.
    public static func drawsCard(_ card: ToolCard) -> Bool {
        (card.name == toolName || card.name == documentsToolName) && card.status == .ok && syncID(card.result) != nil
    }

    // MARK: words

    public static let pending = "Syncing to Drive…"
    public static let background = "Background"
    public static let openFolder = "Open folder"
    public static let hide = "Hide"

    /// Whether Hide can fold the card to one line: the sync ended with everything sent.
    public static func folds(_ sync: DriveSync) -> Bool { sync.status == "DONE" && sync.failedCount == 0 }

    public enum Icon: Equatable, Sendable { case running, ok, stopped, bad }

    public static func icon(_ sync: DriveSync) -> Icon {
        if sync.running { return .running }
        if folds(sync) { return .ok }
        return sync.status == "STOPPED" ? .stopped : .bad
    }

    /// The card's heading.
    public static func title(_ sync: DriveSync) -> String {
        if sync.running { return "Syncing to Drive" }
        switch sync.status {
        case "FAILED": return "Sync failed"
        case "STOPPED": return "Sync stopped"
        default:
            if folds(sync) && sync.filesDone == 0 { return "Already up to date" }
            if sync.failedCount > 0 {
                let total = sync.filesTotal ?? sync.filesDone + sync.failedCount
                return "Synced \(sync.filesDone.formatted()) of \(total.formatted()) files"
            }
            return "Synced \(DriveLogic.files(sync.filesDone))"
        }
    }

    /// " in 14 h 6 min", or "" while it runs: how long an ended sync took.
    public static func took(_ sync: DriveSync) -> String {
        guard let ended = sync.endedAt.flatMap(DriveLogic.date), let started = DriveLogic.date(sync.startedAt) else { return "" }
        return " in \(duration(ended.timeIntervalSince(started)))"
    }

    /// "12 s", "3 min 4 s": the web's `durationText`.
    public static func duration(_ seconds: TimeInterval) -> String {
        let s = max(1, Int(seconds.rounded()))
        if s < 60 { return "\(s) s" }
        return "\(s / 60) min \(s % 60) s"
    }

    /// The folded line of a clean end: what leads the destination link, and what follows it.
    public static func foldLine(_ sync: DriveSync) -> (lead: String, rest: String) {
        let trashed = sync.filesDeleted > 0 ? " · \(sync.filesDeleted.formatted()) moved to Trash" : ""
        if sync.filesDone == 0 {
            return ("Already up to date:", " · \(sync.filesSame.formatted()) files checked\(took(sync))\(trashed)")
        }
        let same = sync.filesSame > 0 ? " · \(sync.filesSame.formatted()) already the same" : ""
        return ("Synced \(DriveLogic.files(sync.filesDone)) to",
                " · \(DriveLogic.formatSize(sync.bytesSent))\(took(sync))\(same)\(trashed)")
    }

    /// The stats line under the bar: its bold lead, the rest, and what the right side says.
    public static func stats(_ sync: DriveSync, rate: Double?) -> (lead: String, rest: String, right: String?) {
        switch sync.status {
        case "CHECKING":
            return ("Checking files…", " \(sync.filesSeen.formatted()) so far", nil)
        case "UPLOADING", "STOPPED":
            let files = "\(sync.filesDone.formatted()) of \((sync.filesTotal ?? 0).formatted()) files"
            let bytes = "\(DriveLogic.formatSize(sync.bytesSent)) of \(DriveLogic.formatSize(sync.bytesTotal ?? 0))"
            let stopped = sync.status == "STOPPED"
            let pace = stopped ? nil : rate.map { rate in
                [DriveLogic.rate(rate), sync.bytesTotal.flatMap { DriveLogic.timeLeft(bytesLeft: $0 - sync.bytesSent, rate: rate) }]
                    .compactMap { $0 }.joined(separator: " · ")
            }
            return (files, "\(stopped ? " synced" : "") · \(bytes)", pace)
        default:
            let trashed = sync.filesDeleted > 0 ? " · \(sync.filesDeleted.formatted()) moved to Trash" : ""
            if folds(sync) && sync.filesDone == 0 {
                return ("\(sync.filesSame.formatted()) files checked", "\(took(sync))\(trashed)", nil)
            }
            let lead = sync.failedCount > 0 ? "\(sync.failedCount.formatted()) failed" : DriveLogic.files(sync.filesDone)
            let same = sync.filesSame > 0 ? "\(sync.filesSame.formatted()) already the same" : nil
            return (lead, " · \(DriveLogic.formatSize(sync.bytesSent))\(took(sync))\(trashed)", same)
        }
    }

    /// "↑ charts/q3.png": the file going up now, while it runs.
    public static func current(_ sync: DriveSync) -> String? {
        guard sync.running, let path = sync.currentPath, !path.isEmpty else { return nil }
        return "↑ \(path)"
    }

    /// "4 already the same", "from out/": the line under a running card's stats.
    public static func meta(_ sync: DriveSync) -> [String] {
        guard sync.running else { return [] }
        var parts: [String] = []
        if sync.filesSame > 0 { parts.append("\(sync.filesSame.formatted()) already the same") }
        parts.append("from \(sync.sourceName)/")
        return parts
    }

    /// Failed paths the card shows before "Show all".
    public static let failedShown = 5

    public static func showAll(_ sync: DriveSync) -> String { "Show all \(sync.failedCount.formatted())" }
}
