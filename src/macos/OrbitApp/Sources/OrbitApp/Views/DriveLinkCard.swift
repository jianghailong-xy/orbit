import SwiftUI
import OrbitKit

/// A reply's `orbit-document:<id>` link drawn as the drive file it names (docs/mocks/drive, 01-ios ⑮, D21): its
/// icon, name, folder and size, read live so a later overwrite shows, and a tap opens it in Drive. A file that has
/// since moved to Trash or gone says so instead of breaking. Not evidence: an agent still cites a file by file_upload.
struct DriveLinkCard: View {
    @Environment(AppModel.self) private var app: AppModel?
    let entryID: String
    let label: String
    @State private var read: Read = .loading

    private enum Read: Equatable {
        case loading
        case found(DriveEntry)
        case gone(trashed: Bool)
    }

    var body: some View {
        Group {
            switch read {
            case .found(let entry) where entry.trashedAt == nil:
                Button { app?.openDriveEntry(entry) } label: {
                    card(icon: DriveLogic.systemImage(entry), name: entry.name, line: DriveLogic.cardLine(entry),
                         live: true)
                }
                .buttonStyle(.plain)
            case .found:
                card(icon: "doc", name: label, line: DriveLogic.cardGone(trashed: true), live: false)
            case .gone(let trashed):
                card(icon: "doc", name: label.isEmpty ? "File" : label, line: DriveLogic.cardGone(trashed: trashed),
                     live: false)
            case .loading:
                card(icon: "doc", name: label.isEmpty ? "File" : label, line: " ", live: false).redacted(reason: .placeholder)
            }
        }
        .task(id: entryID) {
            guard let drive = app?.drive else { return }
            if let entry = await drive.entry(entryID) {
                read = .found(entry)
            } else {
                read = .gone(trashed: false)
            }
        }
        .accessibilityIdentifier("drive-link-card")
    }

    private func card(icon: String, name: String, line: String, live: Bool) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.orbitGlyph)
                .imageScale(.large)
                .foregroundStyle(live ? Color.accentColor : .secondary)
                .frame(width: 32, height: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(.orbitSubtext.weight(.semibold)).foregroundStyle(live ? Color.primary : .secondary)
                    .lineLimit(1).truncationMode(.middle)
                Text(line).font(.orbitListSubtitle).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 8)
            if live { Image(systemName: "chevron.right").font(.orbitLabel.weight(.semibold)).foregroundStyle(.tertiary) }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.separator))
        .contentShape(Rectangle())
    }
}
