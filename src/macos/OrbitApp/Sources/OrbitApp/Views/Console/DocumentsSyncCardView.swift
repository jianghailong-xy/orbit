import SwiftUI
import OrbitKit

/// An agent's `documents_sync` call as its sync's card (board docs/mocks/documents-sync-card): the same live numbers as
/// the Documents popover, kept current after the agent's turn ends, since the sync runs in the background. A sync that
/// ends cleanly folds to one line; failures, a stop and a failed sync stay open. The words are `DocumentsSyncCard`'s.
///
/// Web parity: `src/web/src/components/documents/DocumentsSyncCard.tsx`.
struct DocumentsSyncCardView: View {
    let syncID: String
    @Environment(AppModel.self) private var app
    @State private var open: Bool?
    @State private var allFailed = false

    private var documents: DocumentsModel? { app.documents }
    private var sync: DocumentsSync? { documents?.syncsByID[syncID] }

    var body: some View {
        Group {
            if let sync {
                if DocumentsSyncCard.folds(sync) && !(open ?? false) {
                    folded(sync)
                } else {
                    card(sync)
                }
            } else {
                Text(DocumentsSyncCard.pending).font(.orbitLabel).foregroundStyle(.secondary)
            }
        }
        .task(id: syncID) { await documents?.watchSync(syncID) }
        .accessibilityIdentifier("documents-sync-card")
    }

    // MARK: folded

    private func folded(_ sync: DocumentsSync) -> some View {
        let line = DocumentsSyncCard.foldLine(sync)
        return HStack(spacing: 6) {
            Image(systemName: "checkmark").font(.orbitMeta.weight(.bold)).foregroundStyle(.green)
            Button(line.lead) { open = true }.buttonStyle(.plain).font(.orbitLabel)
            folderLink(sync)
            Text(line.rest).font(.orbitLabel).foregroundStyle(.secondary).lineLimit(1)
        }
    }

    // MARK: open

    private func card(_ sync: DocumentsSync) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            head(sync)
            if sync.status == "FAILED", let error = sync.error {
                Text(error)
                    .font(.orbitLabel).foregroundStyle(.red)
                    .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
            } else {
                summary(sync)
            }
            if !sync.failed.isEmpty { failures(sync) }
        }
        .padding(12)
        .overlay { RoundedRectangle(cornerRadius: 10).stroke(Color.primary.opacity(0.12), lineWidth: 1) }
        .orbitCardWidth()
    }

    private func head(_ sync: DocumentsSync) -> some View {
        HStack(spacing: 8) {
            icon(DocumentsSyncCard.icon(sync))
            Text(DocumentsSyncCard.title(sync)).font(.orbitLabel.weight(.semibold)).lineLimit(1)
            Text(sync.destPath)
                .font(.system(.caption, design: .monospaced)).foregroundStyle(Color.accentColor)
                .padding(.horizontal, 6).padding(.vertical, 1)
                .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 4))
            if sync.running {
                Text(DocumentsSyncCard.background)
                    .font(.orbitMeta.weight(.semibold)).foregroundStyle(Color.accentColor)
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 5))
            }
            Spacer(minLength: 8)
            if sync.destEntryId != nil {
                Button(DocumentsSyncCard.openFolder) { openFolder(sync) }.linkButtonStyle().font(.orbitMeta)
            }
            if DocumentsSyncCard.folds(sync) {
                Button(DocumentsSyncCard.hide) { open = false }.linkButtonStyle().font(.orbitMeta)
            }
        }
    }

    private func icon(_ kind: DocumentsSyncCard.Icon) -> some View {
        let (symbol, tint): (String, Color) = switch kind {
        case .running: ("arrow.triangle.2.circlepath", .accentColor)
        case .ok: ("checkmark", .green)
        case .stopped: ("stop.fill", .secondary)
        case .bad: ("exclamationmark", .red)
        }
        return Image(systemName: symbol)
            .font(.orbitMeta.weight(.bold)).foregroundStyle(tint)
            .frame(width: 22, height: 22)
            .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 6))
    }

    private func summary(_ sync: DocumentsSync) -> some View {
        let stats = DocumentsSyncCard.stats(sync, rate: documents?.syncRates[sync.id])
        return VStack(alignment: .leading, spacing: 5) {
            if sync.status == "CHECKING" {
                SyncBar(fraction: nil, tint: .accentColor)
            } else {
                SyncBar(fraction: barValue(sync),
                        tint: sync.status == "STOPPED" ? .gray : sync.running ? .accentColor : .green)
            }
            HStack(spacing: 0) {
                Text(stats.lead).fontWeight(.semibold)
                Text(stats.rest).foregroundStyle(.secondary)
                Spacer(minLength: 8)
                if let right = stats.right { Text(right).foregroundStyle(.secondary) }
            }
            .font(.orbitMeta).monospacedDigit().lineLimit(1)
            if let current = DocumentsSyncCard.current(sync) {
                Text(current)
                    .font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle)
            }
            let meta = DocumentsSyncCard.meta(sync)
            if !meta.isEmpty {
                Text(meta.joined(separator: "   ")).font(.orbitMeta).foregroundStyle(.tertiary)
            }
        }
    }

    private func barValue(_ sync: DocumentsSync) -> Double {
        if DocumentsSyncCard.folds(sync) || (!sync.running && sync.status != "STOPPED") { return 1 }
        return DocumentsLogic.syncFraction(sync) ?? 0
    }

    private func failures(_ sync: DocumentsSync) -> some View {
        let shown = allFailed ? sync.failed : Array(sync.failed.prefix(DocumentsSyncCard.failedShown))
        return VStack(alignment: .leading, spacing: 4) {
            Divider()
            ForEach(shown, id: \.self) { failure in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("✕").foregroundStyle(.red)
                    Text(failure.path).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 8)
                    Text(failure.error).foregroundStyle(.red).lineLimit(2)
                }
                .font(.orbitMeta)
            }
            if !allFailed && sync.failed.count > shown.count {
                Button(DocumentsSyncCard.showAll(sync)) { allFailed = true }.linkButtonStyle().font(.orbitMeta)
            } else if let more = DocumentsLogic.syncMoreFailures(sync) {
                Text(more).font(.orbitMeta).foregroundStyle(.secondary)
            }
        }
    }

    private func folderLink(_ sync: DocumentsSync) -> some View {
        Button(sync.destPath) { openFolder(sync) }
            .linkButtonStyle().font(.orbitLabel)
            .disabled(sync.destEntryId == nil)
    }

    /// The destination in Documents, from wherever the conversation is.
    private func openFolder(_ sync: DocumentsSync) {
        guard let id = sync.destEntryId, let documents else { return }
        documents.open(folder: id)
        app.selectedSection = .documents
    }
}

/// The card's bar, drawn rather than a `ProgressView`, whose linear style goes grey in a window that is not key: the
/// accent while it runs, green once it ended, grey when stopped (the web card's `drive-xfer-bar`). With no fraction it
/// is the sweeping segment of a sync still counting files.
private struct SyncBar: View {
    let fraction: Double?
    let tint: Color

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.08))
                if let fraction {
                    Capsule().fill(tint).frame(width: geometry.size.width * min(1, max(0, fraction)))
                } else {
                    TimelineView(.animation) { context in
                        let phase = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.4) / 1.4
                        Capsule().fill(tint.opacity(0.8))
                            .frame(width: geometry.size.width * 0.3)
                            .offset(x: geometry.size.width * (phase * 1.3 - 0.3))
                    }
                }
            }
            .clipShape(Capsule())
        }
        .frame(height: 5)
        .accessibilityElement()
        .accessibilityLabel(fraction == nil ? "Checking files" : "Synced")
        .accessibilityValue(fraction.map { "\(Int(($0 * 100).rounded())) percent" } ?? "")
    }
}
