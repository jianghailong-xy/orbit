import SwiftUI
import OrbitKit

/// An agent's run of Drive transfers as one card (board docs/mocks/agent-drive-transfer; web parity:
/// `components/drive/DriveTransferCard.tsx`): while it goes, a bar, the bytes, the speed and the time left, and
/// a row per file grouped by folder; a stall after 20 s with no new byte turns the bar amber. A finished run stays a
/// card, its bar green, with its totals and its files. One file is a line, not a card. The words are OrbitKit's
/// `DriveTransfer`.
struct DriveTransferCardView: View {
    let kind: DriveTransfer.Kind
    let cards: [ToolCard]
    /// Whether the session's turn is at work: a call with no answer in one that is not was cut off.
    let live: Bool
    /// Opens a file an upload made where it lives in Drive; nil where there is no Drive page to open.
    var showInDrive: ((String) -> Void)? = nil

    private struct Sample: Equatable {
        let at: Date
        let bytes: Int
    }

    @State private var samples: [Sample] = []
    @State private var changedAt = Date()
    @State private var showFiles = true
    @State private var allRows = false

    var body: some View {
        let files = cards.map { DriveTransfer.file($0, live: live) }
        let summary = DriveTransfer.summarize(kind, files)
        let moving = live && !summary.finished
        Group {
            if moving {
                // A second's tick while it moves: the speed falls and a stall shows when no count arrives.
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    content(files, summary, now: context.date, moving: true)
                }
            } else {
                content(files, summary, now: Date(), moving: false)
            }
        }
        .onChange(of: summary.sentBytes, initial: true) { _, bytes in record(bytes) }
    }

    private func record(_ bytes: Int) {
        let now = Date()
        guard samples.last?.bytes != bytes else { return }
        changedAt = now
        samples = samples.filter { now.timeIntervalSince($0.at) <= 10 } + [Sample(at: now, bytes: bytes)]
    }

    /// The speed now: a quiet second counts as no bytes, so it falls when the transfer slows.
    private func rate(bytes: Int, now: Date) -> Double? {
        let points = samples.filter { $0.at < now }.map { (at: $0.at, bytes: $0.bytes) } + [(at: now, bytes: bytes)]
        return DriveTransfer.rate(points)
    }

    @ViewBuilder
    private func content(_ files: [DriveTransfer.File], _ summary: DriveTransfer.Summary, now: Date,
                         moving: Bool) -> some View {
        let rate = moving ? rate(bytes: summary.sentBytes, now: now) : nil
        let quiet = now.timeIntervalSince(changedAt)
        let stalled = moving && summary.sentBytes > 0 && samples.last?.bytes == summary.sentBytes
            && quiet >= DriveTransfer.stallAfter
        if files.count == 1 {
            line(files[0], rate: rate)
        } else {
            card(files, summary, rate: rate, stalledFor: stalled ? quiet : nil)
        }
    }

    // MARK: the card

    private func card(_ files: [DriveTransfer.File], _ summary: DriveTransfer.Summary, rate: Double?,
                      stalledFor: TimeInterval?) -> some View {
        let words = DriveTransfer.words(kind)
        let firstEntry = files.first { $0.entryID != nil }?.entryID
        // A run that ended with a failure shows the share that went, green; one cut off is grey.
        let tint: Color = summary.finished ? (summary.clean || summary.failed > 0 ? .green : .secondary)
            : stalledFor != nil ? .orange : .accentColor
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: summary.finished ? (summary.clean ? "checkmark" : "exclamationmark") : words.symbol)
                    .font(.orbitMeta.weight(.bold))
                    .foregroundStyle(summary.finished ? (summary.clean ? Color.green : Color.red)
                                     : kind == .get ? Color.green : Color.accentColor)
                    .frame(width: 20, height: 20)
                    .background((summary.finished ? (summary.clean ? Color.green : Color.red)
                                 : kind == .get ? Color.green : Color.accentColor).opacity(0.14),
                                in: RoundedRectangle(cornerRadius: 5))
                Text(DriveTransfer.title(summary)).font(.orbitLabel.weight(.semibold))
                Text(summary.folder).font(.orbitMono).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 8)
                if summary.finished, kind == .put, let firstEntry, let showInDrive {
                    Button("Show in Drive") { showInDrive(firstEntry) }
                        .transferLinkStyle().font(.orbitLabel)
                }
                Button(showFiles ? "Hide files" : "Show files") { showFiles.toggle() }
                    .transferLinkStyle().font(.orbitLabel)
            }
            VStack(alignment: .leading, spacing: 5) {
                TransferBar(fraction: summary.finished && summary.clean ? 1 : summary.fraction, tint: tint, height: 6)
                    .accessibilityLabel(words.title)
                HStack(spacing: 6) {
                    Text(DriveTransfer.counting(summary)).fontWeight(.semibold)
                        + Text(" · \(DriveTransfer.bytes(summary))").foregroundColor(.secondary)
                    Spacer(minLength: 8)
                    if let pace = DriveTransfer.pace(summary, rate: rate, stalledFor: stalledFor) {
                        Text(pace).foregroundStyle(stalledFor != nil ? Color.orange : Color.secondary)
                    }
                }
                .font(.orbitLabel)
                .monospacedDigit()
            }
            .padding(.top, 8)
            .padding(.bottom, showFiles ? 8 : 0)
            if showFiles {
                Divider()
                fileList(files, folder: summary.folder)
                    .padding(.top, 4)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color.primary.opacity(0.02), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.primary.opacity(0.12)))
        .orbitCardWidth()
        .accessibilityElement(children: .contain)
    }

    private func fileList(_ files: [DriveTransfer.File], folder: String) -> some View {
        let rows = DriveTransfer.shownRows(files, all: allRows)
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { i, file in
                let dir = Self.dir(of: file, under: folder)
                if !dir.isEmpty, i == 0 || Self.dir(of: rows[i - 1], under: folder) != dir {
                    Text(dir).font(.orbitMonoFine).foregroundStyle(.secondary)
                        .padding(.top, 6).padding(.bottom, 1)
                }
                row(file)
            }
            if rows.count < files.count {
                Button("Show all \(files.count)") { allRows = true }
                    .transferLinkStyle().font(.orbitLabel)
                    .padding(.leading, 24).padding(.vertical, 4)
            }
        }
    }

    /// A file's folder under the run's own, as "单幅/"; "" when it sits right in it.
    private static func dir(of file: DriveTransfer.File, under folder: String) -> String {
        guard file.path.hasPrefix(folder) else { return "" }
        let rest = file.path.dropFirst(folder.count)
        guard let slash = rest.lastIndex(of: "/") else { return "" }
        return String(rest[...slash])
    }

    private func row(_ file: DriveTransfer.File) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Self.mark(file.status, kind: kind)
                    .frame(width: 16)
                if file.status == .done, let entry = file.entryID, let showInDrive {
                    Button(file.name) { showInDrive(entry) }
                        .buttonStyle(.plain)
                        .lineLimit(1).truncationMode(.middle)
                        .help("Show in Drive")
                } else {
                    Text(file.name).lineLimit(1).truncationMode(.middle)
                        .foregroundStyle(file.status == .waiting || file.status == .stopped ? Color.secondary : Color.primary)
                }
                Spacer(minLength: 8)
                Text(DriveTransfer.rowSize(file))
                    .font(.orbitMeta).monospacedDigit()
                    .foregroundStyle(file.status == .failed ? Color.red : Color.secondary)
            }
            .font(.orbitLabel)
            if file.status == .running, let size = file.size {
                TransferBar(fraction: Double(file.sent) / Double(max(size, 1)), tint: .accentColor, height: 3)
                    .padding(.leading, 24)
            }
            if file.status == .failed, let error = file.error {
                Text(error).font(.orbitMeta).foregroundStyle(.red)
                    .padding(.leading, 24)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 3)
        .help(file.path)
    }

    @ViewBuilder
    private static func mark(_ status: DriveTransfer.Status, kind: DriveTransfer.Kind) -> some View {
        switch status {
        case .done: Image(systemName: "checkmark").foregroundStyle(.green).font(.orbitMeta.weight(.bold))
        case .failed: Image(systemName: "xmark").foregroundStyle(.red).font(.orbitMeta.weight(.bold))
        case .running: Image(systemName: DriveTransfer.words(kind).symbol).foregroundStyle(Color.accentColor)
            .font(.orbitMeta.weight(.bold))
        case .waiting: Text("·").foregroundStyle(.secondary)
        case .stopped: Text("–").foregroundStyle(.secondary)
        }
    }

    // MARK: one file

    @ViewBuilder
    private func line(_ file: DriveTransfer.File, rate: Double?) -> some View {
        let words = DriveTransfer.words(kind)
        HStack(spacing: 6) {
            switch file.status {
            case .failed:
                Image(systemName: "xmark").foregroundStyle(.red)
                Text("\(words.couldnt) \(file.name): \(file.error ?? "")").foregroundStyle(.red)
            case .done:
                Image(systemName: "checkmark").foregroundStyle(.green)
                Text(words.went)
                if let entry = file.entryID, let showInDrive {
                    Button(file.name) { showInDrive(entry) }.transferLinkStyle()
                } else {
                    Text(file.name)
                }
                Text(Self.doneTail(file)).foregroundStyle(.secondary)
            case .stopped:
                Text("\(words.going) \(file.name) stopped"
                     + (file.size.map { " at \(DriveLogic.formatSize(file.sent)) of \(DriveLogic.formatSize($0))" } ?? ""))
                    .foregroundStyle(.secondary)
            case .running, .waiting:
                Image(systemName: words.symbol).foregroundStyle(Color.accentColor)
                Text("\(words.going) \(file.name)")
                if let size = file.size {
                    Text("· \(DriveLogic.formatSize(file.sent)) of \(DriveLogic.formatSize(size))"
                         + (rate.flatMap { $0 > 0 ? " · \(DriveLogic.rate($0))" : nil } ?? ""))
                        .foregroundStyle(.secondary)
                    TransferBar(fraction: Double(file.sent) / Double(max(size, 1)), tint: .accentColor, height: 4)
                        .frame(width: 96)
                }
            }
        }
        .font(.orbitLabel)
        .monospacedDigit()
        .lineLimit(1)
        .help(file.path)
    }

    /// "· 4.1 MB · 1 s" after a finished file's name.
    private static func doneTail(_ file: DriveTransfer.File) -> String {
        var parts: [String] = []
        if let size = file.size { parts.append(DriveLogic.formatSize(size)) }
        if let start = file.startedAt, let end = file.endedAt, end >= start {
            parts.append(DriveTransfer.duration(end.timeIntervalSince(start)))
        }
        return parts.isEmpty ? "" : "· " + parts.joined(separator: " · ")
    }
}

private extension View {
    /// A press that reads as a link: the Mac's link button, an accent-coloured borderless one on the phone.
    @ViewBuilder
    func transferLinkStyle() -> some View {
        #if os(macOS)
        buttonStyle(.link)
        #else
        buttonStyle(.borderless).foregroundStyle(Color.accentColor)
        #endif
    }
}


/// The card's bar: drawn, not a `ProgressView`, so it keeps its colour whether or not its window is the key one (an
/// inactive window's progress bar is grey), as the web's bar does.
private struct TransferBar: View {
    let fraction: Double
    let tint: Color
    let height: CGFloat

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.08))
                Capsule().fill(tint)
                    .frame(width: geo.size.width * min(1, max(0, fraction)))
                    .animation(.easeOut(duration: 0.4), value: fraction)
            }
        }
        .frame(height: height)
        .accessibilityElement()
        .accessibilityValue("\(Int((min(1, max(0, fraction)) * 100).rounded())) percent")
    }
}
