#if os(iOS)
import SwiftUI
import UIKit
import PhotosUI
import UniformTypeIdentifiers
import OrbitKit

// Drive on the iPhone (board docs/mocks/drive/01-ios.png, the reference design for every client): the drive's
// top level with Trash and Storage as its last rows, a page per folder pushed on the section's stack, a file's page
// with its preview and who last wrote it, the Move sheet, the share-link sheet with the secret warning, Trash with
// earlier versions, Storage, and the uploads sheet with the agents' directory syncs. The words are OrbitKit's
// (`DriveLogic`); the reads and writes are `DriveModel`'s, shared with the Mac.

/// The pages Drive pushes on its section's stack (`NavNode`), one switch for the phone's shell and the iPad's
/// column.
struct DriveDestination: View {
    let node: NavNode

    var body: some View {
        switch node {
        case .driveFolder(let id, let name): DriveFolderPage(folderID: id, name: name)
        case .driveFile(let id): DriveFilePage(entryID: id)
        case .driveVersions(let id): DriveVersionsPage(entryID: id)
        case .driveTrash: DriveTrashPage()
        case .driveStorage: DriveStoragePage()
        case .taskDetail(let taskID): TaskDetailPage(taskID: taskID)
        case .projectDetail(let projectID, _): ProjectDetailView(projectID: projectID)
        default: EmptyView()
        }
    }
}

// MARK: - a folder (frames 2-3, 6, 8)

/// The drive's top level (`folderID == nil`) or one folder pushed over it.
struct DriveFolderPage: View {
    @Environment(AppModel.self) private var app
    let folderID: String?
    let name: String

    @State private var listing: DriveListing?
    @State private var loadError: String?
    @State private var counts: [String: Int] = [:]
    @State private var searchText = ""
    @State private var found: [DriveEntry]?
    @State private var actions = DriveRowActions()

    private var isRoot: Bool { folderID == nil }
    private var model: DriveModel? { app.drive }

    var body: some View {
        if let model {
            list(model)
        } else {
            ContentUnavailableView(DriveLogic.title, systemImage: AppSection.drive.systemImage)
        }
    }

    private func list(_ model: DriveModel) -> some View {
        let searching = !searchText.trimmingCharacters(in: .whitespaces).isEmpty
        let rows = searching ? (found ?? []) : DriveLogic.sorted(listing?.entries ?? [])
        return List {
            if model.trayShown {
                Section { DriveUploadsBanner(model: model) }
            }
            Section {
                ForEach(rows) { entry in
                    DriveEntryRow(model: model, entry: entry, count: counts[entry.id],
                                      folderTrail: searching ? DriveLogic.searchFolder(entry.folderPath) : nil) {
                        open(entry)
                    }
                    .driveRowActions(entry, model: model, actions: $actions)
                }
            }
            if isRoot && !searching {
                Section {
                    placeRow(.trash, trailing: model.trash.map { DriveLogic.items($0.reduce(0) { $0 + $1.itemCount }) })
                    placeRow(.storage, trailing: model.usage.map { DriveLogic.storageSize($0.totalBytes) })
                } header: {
                    Text(DriveLogic.moreHeading)
                } footer: {
                    Text(DriveLogic.driveFoot)
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay { overlay(model, rows: rows, searching: searching) }
        .navigationTitle(isRoot ? DriveLogic.title : (listing.map { DriveLogic.folderTitle($0.folder) } ?? name))
        .navigationBarTitleDisplayMode(.large)
        .modifier(DriveSearchable(enabled: isRoot, text: $searchText))
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                DriveAddMenu(model: model, folder: listing?.folder, actions: $actions)
                DriveMoreMenu(model: model, actions: $actions)
            }
        }
        .task(id: model.changes) { await load(model) }
        .task(id: searchText) { await search(model) }
        .refreshable { await load(model) }
        .driveActionSheets(model: model, actions: $actions, here: listing?.folder)
    }

    @ViewBuilder
    private func overlay(_ model: DriveModel, rows: [DriveEntry], searching: Bool) -> some View {
        if let loadError, listing == nil {
            ContentUnavailableView("Couldn't read this folder", systemImage: "exclamationmark.triangle",
                                   description: Text(loadError))
        } else if listing == nil && !searching {
            ProgressView()
        } else if rows.isEmpty && !searching && !isRoot {
            ContentUnavailableView(DriveLogic.emptyFolder, systemImage: "folder",
                                   description: Text(DriveLogic.emptyFolderNote))
        } else if searching && found?.isEmpty == true {
            ContentUnavailableView.search(text: searchText)
        }
    }

    private func placeRow(_ place: DrivePlace, trailing: String?) -> some View {
        Button {
            app.push(place == .trash ? .driveTrash : .driveStorage)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: place.systemImage).foregroundStyle(.secondary).frame(width: 24)
                Text(place.title).foregroundStyle(.primary)
                Spacer(minLength: 8)
                if let trailing { Text(trailing).foregroundStyle(.secondary).monospacedDigit() }
                Image(systemName: "chevron.right").font(.orbitLabel.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("drive-\(place.rawValue)")
    }

    private func open(_ entry: DriveEntry) {
        if entry.isFolder {
            app.push(.driveFolder(entryID: entry.id, name: entry.name))
        } else {
            app.push(.driveFile(entryID: entry.id))
        }
    }

    private func load(_ model: DriveModel) async {
        do {
            let read = try await model.read(folder: folderID)
            listing = read
            loadError = nil
            for folder in read.entries.filter(\.isFolder).prefix(60) {
                if let count = await model.count(of: folder) { counts[folder.id] = count }
            }
        } catch {
            loadError = APIClient.failureReason(error)
        }
        if isRoot {
            // The More rows' counts: Trash's items and the account's total.
            await model.loadTrash()
            await model.loadStorage()
        }
    }

    private func search(_ model: DriveModel) async {
        let words = searchText.trimmingCharacters(in: .whitespaces)
        guard !words.isEmpty else {
            found = nil
            return
        }
        try? await Task.sleep(nanoseconds: 250_000_000)
        guard !Task.isCancelled else { return }
        found = (try? await model.search(words)) ?? []
    }
}

/// The drive's search field, on the top level only.
private struct DriveSearchable: ViewModifier {
    let enabled: Bool
    @Binding var text: String

    func body(content: Content) -> some View {
        if enabled {
            content.searchable(text: $text, placement: .navigationBarDrawer(displayMode: .always),
                               prompt: DriveLogic.searchPrompt)
        } else {
            content
        }
    }
}

/// One row: the icon, the name, and its second line — a folder's count and time, a file's writer and time (rule 6)
/// with its size on the right.
struct DriveEntryRow: View {
    let model: DriveModel
    let entry: DriveEntry
    var count: Int?
    /// A search result's folder, which replaces the writer line.
    var folderTrail: String?
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 12) {
                DriveEntryIcon(entry: entry)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Text(entry.name).lineLimit(1).truncationMode(.middle).foregroundStyle(.primary)
                        if model.link(of: entry) != nil {
                            Image(systemName: "link").font(.orbitMeta).foregroundStyle(.secondary)
                                .accessibilityLabel("Shared")
                        }
                    }
                    secondLine.font(.orbitListSubtitle).lineLimit(1)
                }
                Spacer(minLength: 8)
                if entry.isFile {
                    Text(DriveLogic.formatSize(entry.sizeBytes)).font(.orbitSubtext).foregroundStyle(.secondary)
                        .monospacedDigit()
                } else {
                    Image(systemName: "chevron.right").font(.orbitLabel.weight(.semibold)).foregroundStyle(.tertiary)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("drive-row-\(entry.name)")
    }

    private var secondLine: Text {
        if let folderTrail { return Text(folderTrail).foregroundStyle(.secondary) }
        if entry.isFolder {
            return Text(DriveLogic.folderLine(count: count, mtime: entry.mtime)).foregroundStyle(.secondary)
        }
        return DriveWriterText.of(model, entry.lastWriter) + Text(DriveLogic.fileLineWhen(entry.mtime))
            .foregroundStyle(.secondary)
    }
}

/// "You", "An agent on Orbit Cloud", or "Agent in" with the session's title in the accent colour (rule 6).
@MainActor
enum DriveWriterText {
    static func of(_ model: DriveModel, _ writer: DriveWriter) -> Text {
        let name = model.writerName(writer)
        let lead = "Agent in "
        guard DriveLogic.writerSession(writer) != nil, name.hasPrefix(lead) else {
            return Text(name).foregroundStyle(.secondary)
        }
        return Text(lead).foregroundStyle(.secondary) + Text(String(name.dropFirst(lead.count))).foregroundStyle(Color.accentColor)
    }
}

/// A row's icon: a blue folder, a picture's own thumbnail-coloured tile, or the file kind's symbol.
struct DriveEntryIcon: View {
    let entry: DriveEntry
    var size: CGFloat = 30

    var body: some View {
        Image(systemName: DriveLogic.systemImage(entry))
            .font(.orbitGlyph)
            .imageScale(.large)
            .foregroundStyle(entry.isFolder ? Color.accentColor : .secondary)
            .frame(width: size, height: size)
    }
}

// MARK: - the + and ⋯ menus, and what a row's long press offers (frame 6)

/// What a row action asked for, held by the page so its sheets and alerts can answer it.
struct DriveRowActions {
    var renaming: DriveEntry?
    var renameText = ""
    var moving: [DriveEntry]?
    var sharing: DriveEntry?
    var newFolder = false
    var newFolderText = ""
    var importing: DriveImport?
    var pickingPhotos = false
    var photos: [PhotosPickerItem] = []
    var uploadsShown = false
    var shareFile: DriveSharedFile?
}

/// Which system picker the + menu opened.
enum DriveImport: Identifiable {
    case files, folder
    var id: Self { self }
    var types: [UTType] { self == .files ? [.item] : [.folder] }
}

/// A downloaded file handed to the share sheet.
struct DriveSharedFile: Identifiable {
    let url: URL
    var id: String { url.path }
}

/// The title bar's +: Upload files, Upload photos, Upload a folder (D3), and New folder.
struct DriveAddMenu: View {
    let model: DriveModel
    let folder: DriveEntry?
    @Binding var actions: DriveRowActions

    var body: some View {
        Menu {
            Button { actions.importing = .files } label: {
                Label(DriveLogic.uploadFiles, systemImage: "square.and.arrow.up")
            }
            Button { actions.pickingPhotos = true } label: {
                Label(DriveLogic.uploadPhotos, systemImage: "photo")
            }
            Button { actions.importing = .folder } label: {
                Label(DriveLogic.uploadFolder, systemImage: "folder")
            }
            Divider()
            Button {
                actions.newFolderText = DriveLogic.newFolderName
                actions.newFolder = true
            } label: {
                Label(DriveLogic.newFolderTitle, systemImage: "folder.badge.plus")
            }
        } label: {
            Image(systemName: "plus")
        }
        .accessibilityLabel("Add")
        .accessibilityIdentifier("drive-add")
        .disabled(folder == nil)
    }
}

/// The title bar's ⋯: the uploads sheet, Trash and Storage.
struct DriveMoreMenu: View {
    @Environment(AppModel.self) private var app
    let model: DriveModel
    @Binding var actions: DriveRowActions

    var body: some View {
        Menu {
            if model.trayShown {
                Button { actions.uploadsShown = true } label: { Label(DriveLogic.uploadsTitle, systemImage: "arrow.up.circle") }
            }
            Button { app.push(.driveTrash) } label: { Label(DriveLogic.trash, systemImage: "trash") }
            Button { app.push(.driveStorage) } label: { Label(DriveLogic.storage, systemImage: "chart.bar") }
        } label: {
            Image(systemName: "ellipsis")
        }
        .accessibilityLabel("More")
        .accessibilityIdentifier("drive-more")
    }
}

extension View {
    /// A row's long-press menu and its swipe to Trash. A folder has the same menu without Download and Share link.
    func driveRowActions(_ entry: DriveEntry, model: DriveModel,
                             actions: Binding<DriveRowActions>) -> some View {
        self
            .contextMenu {
                Button {
                    actions.wrappedValue.renameText = entry.name
                    actions.wrappedValue.renaming = entry
                } label: { Label(DriveLogic.renameTitle, systemImage: "pencil") }
                Button { actions.wrappedValue.moving = [entry] } label: { Label("Move…", systemImage: "folder") }
                if entry.isFile {
                    Button {
                        Task {
                            if let url = await model.downloadForSharing(entry) {
                                actions.wrappedValue.shareFile = DriveSharedFile(url: url)
                            }
                        }
                    } label: { Label("Download", systemImage: "arrow.down.circle") }
                    Button { actions.wrappedValue.sharing = entry } label: { Label("Share link…", systemImage: "link") }
                }
                Divider()
                Button(role: .destructive) {
                    Task { await model.moveToTrash(entries: [entry]) }
                } label: { Label("Move to Trash", systemImage: "trash") }
            }
            .swipeActions(edge: .trailing) {
                Button(role: .destructive) {
                    Task { await model.moveToTrash(entries: [entry]) }
                } label: { Label("Move to Trash", systemImage: "trash") }
            }
    }

    /// The sheets and alerts a page's row actions and + menu open. `here` is the folder new things go into.
    func driveActionSheets(model: DriveModel, actions: Binding<DriveRowActions>,
                               here: DriveEntry?) -> some View {
        modifier(DriveActionSheets(model: model, actions: actions, here: here))
    }
}

private struct DriveActionSheets: ViewModifier {
    let model: DriveModel
    @Binding var actions: DriveRowActions
    let here: DriveEntry?

    func body(content: Content) -> some View {
        content
            .alert(DriveLogic.renameTitle, isPresented: Binding(get: { actions.renaming != nil },
                                                                     set: { if !$0 { actions.renaming = nil } })) {
                TextField("Name", text: $actions.renameText)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Cancel", role: .cancel) { actions.renaming = nil }
                Button("Rename") {
                    if let entry = actions.renaming {
                        let name = actions.renameText
                        Task { await model.rename(entry, to: name) }
                    }
                    actions.renaming = nil
                }
            }
            .alert(DriveLogic.newFolderTitle, isPresented: $actions.newFolder) {
                TextField("Name", text: $actions.newFolderText)
                Button("Cancel", role: .cancel) {}
                Button("Create") {
                    let name = actions.newFolderText
                    Task { _ = await model.createFolder(named: name, in: here) }
                }
            }
            .sheet(item: Binding(get: { actions.moving.map(DriveMoveRequest.init) },
                                 set: { actions.moving = $0?.entries })) { request in
                DrivePhoneMoveSheet(model: model, entries: request.entries)
            }
            .sheet(item: $actions.sharing) { entry in
                DrivePhoneShareSheet(model: model, entry: entry)
            }
            .sheet(isPresented: $actions.uploadsShown) {
                DriveUploadsSheet(model: model)
            }
            .sheet(item: $actions.shareFile) { file in
                DriveActivityView(items: [file.url]).ignoresSafeArea()
            }
            .fileImporter(isPresented: Binding(get: { actions.importing != nil },
                                               set: { if !$0 { actions.importing = nil } }),
                          allowedContentTypes: actions.importing?.types ?? [.item],
                          allowsMultipleSelection: true) { result in
                if case .success(let urls) = result {
                    model.uploadPicked(urls, into: here)
                    actions.uploadsShown = true
                }
            }
            .photosPicker(isPresented: $actions.pickingPhotos, selection: $actions.photos,
                          matching: .any(of: [.images, .videos]))
            .onChange(of: actions.photos) { _, items in
                guard !items.isEmpty else { return }
                actions.photos = []
                Task {
                    var staged: [URL] = []
                    for item in items {
                        if let media = try? await item.loadTransferable(type: DriveStagedMedia.self) {
                            staged.append(media.url)
                        }
                    }
                    guard !staged.isEmpty else { return }
                    model.upload(staged, into: here)
                    actions.uploadsShown = true
                }
            }
    }
}

private struct DriveMoveRequest: Identifiable {
    let entries: [DriveEntry]
    var id: String { entries.map(\.id).joined(separator: ",") }
}

/// A picture or video from Photos, copied into the uploads' staging folder under the name Photos gave it.
struct DriveStagedMedia: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in try stage(received.file) }
        FileRepresentation(importedContentType: .image) { received in try stage(received.file) }
    }

    private static func stage(_ file: URL) throws -> DriveStagedMedia {
        let copy = try DriveModel.stagingSlot().appendingPathComponent(file.lastPathComponent)
        try FileManager.default.copyItem(at: file, to: copy)
        return DriveStagedMedia(url: copy)
    }
}

/// The system share sheet over a downloaded file: Save to Files, AirDrop, another app.
struct DriveActivityView: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

// MARK: - the uploads banner and sheet (frames 8, 16-18)

/// "Uploading 2 of 3 · 6.1 GB of 14.3 GB   Show" over a folder while anything is going up or an agent syncs.
struct DriveUploadsBanner: View {
    let model: DriveModel
    @State private var shown = false

    var body: some View {
        Button { shown = true } label: {
            HStack(spacing: 10) {
                Image(systemName: DriveLogic.trayTotals(model.uploads, model.syncs).allFinished ? "checkmark" : "arrow.up")
                    .foregroundStyle(Color.accentColor)
                Text(DriveLogic.trayTitle(model.uploads, model.syncs))
                    .font(.orbitSubtext.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(DriveLogic.showUploads).font(.orbitSubtext.weight(.semibold)).foregroundStyle(Color.accentColor)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(Color.accentColor.opacity(0.08))
        .sheet(isPresented: $shown) { DriveUploadsSheet(model: model) }
        .accessibilityIdentifier("drive-uploads-banner")
    }
}

/// The phone's form of the web's upload tray: the owner's uploads and the agents' syncs, one row each.
struct DriveUploadsSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let model: DriveModel
    @State private var details: DriveSync?

    var body: some View {
        NavigationStack {
            List {
                if !model.uploads.isEmpty {
                    Section {
                        ForEach(model.uploads) { upload in uploadRow(upload) }
                    } footer: {
                        Text(DriveLogic.uploadsFoot)
                    }
                }
                if !model.syncs.isEmpty {
                    Section {
                        ForEach(model.syncs) { sync in syncRow(sync) }
                    } footer: {
                        Text(DriveLogic.syncFoot)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .overlay {
                if !model.trayShown {
                    ContentUnavailableView(DriveLogic.uploadsTitle, systemImage: "arrow.up.circle")
                }
            }
            .navigationTitle(DriveLogic.uploadsTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if DriveLogic.trayTotals(model.uploads, model.syncs).finished > 0 {
                        Button(DriveLogic.clearFinishedPhone) { model.clearFinished() }
                    }
                }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .sheet(item: $details) { sync in DriveSyncDetailsSheet(model: model, sync: sync) }
        }
        .presentationDetents([.medium, .large])
        .task { await model.loadSyncs() }
    }

    private func uploadRow(_ upload: DriveUploadItem) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: DriveLogic.systemImage(DriveEntry(id: upload.id, parentId: nil, kind: "FILE",
                                                                        name: upload.name)))
                .foregroundStyle(.secondary).frame(width: 28)
            VStack(alignment: .leading, spacing: 4) {
                Text("\(upload.name) → \(DriveLogic.uploadDestination(upload))")
                    .font(.orbitSubtext.weight(.semibold)).lineLimit(1).truncationMode(.middle)
                Text(DriveLogic.uploadStatus(upload)).font(.orbitListSubtitle)
                    .foregroundStyle(upload.state == .failed ? Color.red : .secondary)
                if upload.state != .done && upload.state != .failed {
                    ProgressView(value: Double(upload.percent), total: 100)
                        .tint(upload.state == .paused ? .orange : .accentColor)
                }
            }
            Spacer(minLength: 4)
            switch upload.state {
            case .uploading, .queued:
                Button { model.pauseUpload(upload.id) } label: { Image(systemName: "pause.fill") }
                    .buttonStyle(.borderless).foregroundStyle(.secondary).accessibilityLabel("Pause")
            case .paused:
                Button("Resume") { model.resumeUpload(upload.id) }.buttonStyle(.borderless)
            case .failed:
                Button("Remove") { model.cancelUpload(upload.id) }.buttonStyle(.borderless)
            case .done:
                Image(systemName: "checkmark").foregroundStyle(.green).accessibilityLabel("Uploaded")
            }
        }
        .swipeActions {
            if upload.state != .done {
                Button("Cancel", role: .destructive) { model.cancelUpload(upload.id) }
            }
        }
    }

    private func syncRow(_ sync: DriveSync) -> some View {
        let title = DriveLogic.syncTitle(sync)
        return HStack(alignment: .top, spacing: 12) {
            Image(systemName: "folder.fill").foregroundStyle(Color.accentColor).frame(width: 28)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text("\(title.source) → \(title.destination)").font(.orbitSubtext.weight(.semibold)).lineLimit(1)
                    Spacer(minLength: 4)
                    if sync.running {
                        Label(DriveLogic.agentSync, systemImage: "cloud")
                            .font(.orbitMeta)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Color.accentColor.opacity(0.12), in: Capsule())
                            .foregroundStyle(Color.accentColor)
                    } else if sync.status == "STOPPED" {
                        Text("Stopped").font(.orbitMeta).foregroundStyle(.secondary)
                    } else if DriveLogic.syncHasFailures(sync) {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                            .accessibilityLabel("Synced with failures")
                    } else {
                        Image(systemName: "checkmark").foregroundStyle(.green).accessibilityLabel("Synced")
                    }
                }
                HStack(spacing: 4) {
                    Text(DriveLogic.syncStatus(sync, rate: model.syncRates[sync.id]))
                        .foregroundStyle(DriveLogic.syncHasFailures(sync) ? Color.red : .secondary)
                    if DriveLogic.syncHasFailures(sync) {
                        Button("Details") { details = sync }.buttonStyle(.borderless)
                    }
                }
                .font(.orbitListSubtitle)
                if sync.running || sync.status == "STOPPED" {
                    if let fraction = DriveLogic.syncFraction(sync) {
                        ProgressView(value: fraction).tint(sync.running ? .accentColor : .gray)
                    } else {
                        ProgressView().progressViewStyle(.linear)
                    }
                }
                if (sync.running && sync.currentPath != nil) || sync.session != nil {
                    HStack(spacing: 4) {
                        if sync.running, let path = sync.currentPath {
                            Text(path).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                        }
                        if let session = sync.session {
                            Button(session.title) {
                                dismiss()
                                model.openSession?(session.id)
                            }
                            .buttonStyle(.borderless)
                        }
                    }
                    .font(.orbitListSubtitle)
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            guard !sync.running, let id = sync.destEntryId else { return }
            dismiss()
            app.push(.driveFolder(entryID: id, name: DriveLogic.folderLabel(sync.destPath)))
        }
    }
}

/// What an agent's sync could not send: each path with its error, and the way to the folder it wrote (frame 18).
struct DriveSyncDetailsSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let model: DriveModel
    let sync: DriveSync

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(DriveLogic.syncDetailsSummary(sync)).font(.orbitSubtext)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                }
                Section {
                    ForEach(sync.failed, id: \.self) { failure in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(failure.path).font(.orbitMono)
                            Text(failure.error).font(.orbitListSubtitle).foregroundStyle(.red)
                        }
                    }
                    if let more = DriveLogic.syncMoreFailures(sync) {
                        Text(more).font(.orbitListSubtitle).foregroundStyle(.secondary)
                    }
                } header: {
                    Text(DriveLogic.didntUpload)
                }
                if let id = sync.destEntryId {
                    Section {
                        Button(DriveLogic.openFolder(sync)) {
                            dismiss()
                            app.push(.driveFolder(entryID: id, name: DriveLogic.folderLabel(sync.destPath)))
                        }
                        .frame(maxWidth: .infinity)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(DriveLogic.syncDetailsTitle(sync))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            }
        }
    }
}

// MARK: - a file's page (frames 4-5)

struct DriveFilePage: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let entryID: String
    @State private var actions = DriveRowActions()
    @State private var gone = false

    var body: some View {
        if let model = app.drive, let entry = model.known[entryID] {
            page(model, entry)
        } else if gone {
            ContentUnavailableView(DriveLogic.cardGone(trashed: false), systemImage: "doc")
        } else {
            ProgressView().task { if await app.drive?.entry(entryID) == nil { gone = true } }
        }
    }

    private func page(_ model: DriveModel, _ entry: DriveEntry) -> some View {
        let kind = DriveLogic.preview(name: entry.name, size: entry.sizeBytes)
        return ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                DrivePreview(model: model, entry: entry)
                    .padding(.horizontal, kind == .picture ? 0 : 16)
                VStack(alignment: .leading, spacing: 14) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(entry.name).font(.title2.weight(.bold)).textSelection(.enabled)
                        Text(facts(model, entry)).font(.orbitSubtext).foregroundStyle(.secondary)
                    }
                    VStack(spacing: 0) {
                        writerCard(model, entry)
                        if !model.earlierVersions(of: entry).isEmpty {
                            Divider().padding(.leading, 44)
                            earlierRow(model, entry)
                        }
                    }
                    .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
                    if let link = model.link(of: entry) {
                        Label(DriveLogic.sharedLine(link), systemImage: "link")
                            .font(.orbitListSubtitle).foregroundStyle(.secondary)
                    }
                    HStack(spacing: 10) {
                        Button { download(model, entry) } label: {
                            Text("Download").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("drive-download")
                        Button { actions.sharing = entry } label: {
                            Text("Share link…").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("drive-share-link")
                    }
                    .controlSize(.large)
                }
                .padding(.horizontal, 16)
            }
            .padding(.bottom, 24)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { download(model, entry) } label: { Image(systemName: "square.and.arrow.up") }
                    .accessibilityLabel("Share")
                Menu {
                    Button {
                        actions.renameText = entry.name
                        actions.renaming = entry
                    } label: { Label(DriveLogic.renameTitle, systemImage: "pencil") }
                    Button { actions.moving = [entry] } label: { Label("Move…", systemImage: "folder") }
                    Divider()
                    Button(role: .destructive) {
                        Task {
                            await model.moveToTrash(entries: [entry])
                            dismiss()
                        }
                    } label: { Label("Move to Trash", systemImage: "trash") }
                } label: { Image(systemName: "ellipsis") }
                .accessibilityLabel("More")
                .accessibilityIdentifier("drive-file-more")
            }
        }
        .task(id: "\(model.changes):\(entry.currentVersionId ?? "")") {
            if let fresh = await model.entry(entryID) { await model.inspect(fresh) } else { gone = true }
        }
        .driveActionSheets(model: model, actions: $actions, here: nil)
    }

    private func facts(_ model: DriveModel, _ entry: DriveEntry) -> String {
        var pixels: (Int, Int)?
        if case .data(let data)? = model.preview(for: entry),
           DriveLogic.preview(name: entry.name, size: entry.sizeBytes) == .picture,
           let image = UIImage(data: data)?.cgImage {
            pixels = (image.width, image.height)
        }
        let folder = model.entryDetails[entry.id]?.path.map { DriveLogic.cardTrail($0) }
            .flatMap { $0.split(separator: "›").last.map { $0.trimmingCharacters(in: .whitespaces) } }
        return DriveLogic.fileFacts(entry, pixels: pixels, folder: folder)
    }

    @ViewBuilder
    private func writerCard(_ model: DriveModel, _ entry: DriveEntry) -> some View {
        let session = DriveLogic.writerSession(entry.lastWriter)
        let card = HStack(spacing: 12) {
            Image(systemName: entry.lastWriter.isOwner ? "person.crop.circle.fill"
                  : (session != nil ? "c.circle.fill" : "cloud.circle.fill"))
                .font(.title2)
                .foregroundStyle(session != nil ? Color.primary : .secondary)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(DriveLogic.lastWrittenBy(entry.lastWriter.at ?? entry.mtime))
                    .font(.orbitListSubtitle).foregroundStyle(.secondary)
                Text(model.writerName(entry.lastWriter)).font(.body.weight(.semibold)).foregroundStyle(.primary)
            }
            Spacer(minLength: 8)
            if session != nil {
                Image(systemName: "chevron.right").font(.orbitLabel.weight(.semibold)).foregroundStyle(.tertiary)
            }
        }
        .padding(12)
        .contentShape(Rectangle())
        if let session {
            Button { model.openSession?(session) } label: { card }.buttonStyle(.plain)
        } else {
            card
        }
    }

    private func earlierRow(_ model: DriveModel, _ entry: DriveEntry) -> some View {
        Button { app.push(.driveVersions(entryID: entry.id)) } label: {
            HStack(spacing: 12) {
                Image(systemName: "clock.arrow.circlepath").foregroundStyle(.secondary).frame(width: 28)
                Text(DriveLogic.earlierVersionsTitle).foregroundStyle(.primary)
                Spacer(minLength: 8)
                if let count = DriveLogic.earlierVersionsCount(model.earlierVersions(of: entry).count) {
                    Text(count).foregroundStyle(.secondary)
                }
                Image(systemName: "chevron.right").font(.orbitLabel.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .padding(12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("drive-earlier-versions")
    }

    private func download(_ model: DriveModel, _ entry: DriveEntry) {
        Task {
            if let url = await model.downloadForSharing(entry) { actions.shareFile = DriveSharedFile(url: url) }
        }
    }
}

/// A picture drawn on black edge to edge, Markdown rendered as the Wiki renders it (read-only), text as written, and
/// any other file its icon (frames 4-5).
struct DrivePreview: View {
    let model: DriveModel
    let entry: DriveEntry

    var body: some View {
        let kind = DriveLogic.preview(name: entry.name, size: entry.sizeBytes)
        Group {
            switch model.preview(for: entry) {
            case .data(let data)?:
                content(kind, data)
            case .failed?:
                icon(note: "Couldn't load the preview.")
            case .loading?:
                ProgressView().frame(maxWidth: .infinity, minHeight: 200)
            case nil:
                if kind == .none { icon(note: nil) } else { ProgressView().frame(maxWidth: .infinity, minHeight: 200) }
            }
        }
        .accessibilityIdentifier("drive-preview")
    }

    @ViewBuilder
    private func content(_ kind: DriveLogic.Preview, _ data: Data) -> some View {
        switch kind {
        case .picture:
            if let image = UIImage(data: data) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .padding(.vertical, 20)
                    .frame(maxWidth: .infinity, maxHeight: 420)
                    .background(Color.black)
            } else {
                icon(note: "Couldn't load the preview.")
            }
        case .markdown:
            MarkdownView(source: String(decoding: data, as: UTF8.self))
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
        case .text:
            ScrollView(.horizontal) {
                Text(String(decoding: data, as: UTF8.self))
                    .font(.orbitMono)
                    .textSelection(.enabled)
                    .padding(12)
            }
            .frame(maxWidth: .infinity, maxHeight: 420, alignment: .topLeading)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
        case .pdf, .none:
            icon(note: nil)
        }
    }

    private func icon(note: String?) -> some View {
        VStack(spacing: 8) {
            Image(systemName: DriveLogic.systemImage(entry)).font(.orbitHeroGlyph).foregroundStyle(.secondary)
            if let note { Text(note).font(.orbitLabel).foregroundStyle(.secondary) }
        }
        .frame(maxWidth: .infinity, minHeight: 160)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }
}

// MARK: - earlier versions (frame 12, D17)

struct DriveVersionsPage: View {
    @Environment(AppModel.self) private var app
    let entryID: String
    @State private var shareFile: DriveSharedFile?

    var body: some View {
        let model = app.drive
        let entry = model?.known[entryID]
        List {
            if let model, let entry {
                Section {
                    ForEach(model.earlierVersions(of: entry)) { version in
                        DriveVersionRow(model: model, entry: entry, version: version,
                                            folder: folder(model, entry), shareFile: $shareFile)
                    }
                } footer: {
                    Text(DriveLogic.trashFoot)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(DriveLogic.earlierVersionsTitle)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: model?.changes) {
            if let model, let fresh = await model.entry(entryID) { await model.inspect(fresh) }
        }
        .sheet(item: $shareFile) { file in DriveActivityView(items: [file.url]).ignoresSafeArea() }
    }

    private func folder(_ model: DriveModel, _ entry: DriveEntry) -> String {
        DriveLogic.cardTrail(model.entryDetails[entry.id]?.path).split(separator: "›").last
            .map { $0.trimmingCharacters(in: .whitespaces) } ?? DriveLogic.title
    }
}

/// One earlier version; a tap offers frame 12's choices.
private struct DriveVersionRow: View {
    let model: DriveModel
    let entry: DriveEntry
    let version: DriveVersion
    let folder: String
    @Binding var shareFile: DriveSharedFile?

    var body: some View {
        Menu {
            Text(DriveLogic.versionWhereNow(entry.name, folder: folder))
            Button(DriveLogic.restoreAsCurrent) { Task { await model.restoreVersion(version, asCopy: false) } }
            Button(DriveLogic.restoreAsCopy) { Task { await model.restoreVersion(version, asCopy: true) } }
            Button("Download") { Task { await download() } }
        } label: {
            HStack(spacing: 12) {
                DriveEntryIcon(entry: entry)
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.name).foregroundStyle(.primary)
                    Text(DriveLogic.versionLine(version, writer: model.writerName(version.writer)))
                        .font(.orbitListSubtitle).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func download() async {
        guard let url = await model.downloadForSharing(entry, version: version) else { return }
        shareFile = DriveSharedFile(url: url)
    }
}

// MARK: - Move (frame 7)

struct DrivePhoneMoveSheet: View {
    let model: DriveModel
    let entries: [DriveEntry]
    @Environment(\.dismiss) private var dismiss
    /// The folders opened in the sheet, the root first.
    @State private var trail: [DriveEntry] = []
    @State private var children: [DriveEntry] = []
    @State private var loading = true
    /// A folder made from the sheet's New folder row: selected straight away.
    @State private var made: DriveEntry?
    @State private var naming = false
    @State private var newName = DriveLogic.newFolderName

    private var target: DriveEntry? { made ?? trail.last }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if trail.count > 1 {
                        Button { Task { await open(trail[trail.count - 2].id, back: true) } } label: {
                            Label(DriveLogic.folderTitle(trail[trail.count - 2]), systemImage: "chevron.left")
                        }
                    }
                    ForEach(children) { folder in
                        DriveMoveFolderRow(folder: folder, made: made?.id == folder.id,
                                               moving: entries.contains { $0.id == folder.id }) {
                            made = nil
                            Task { await open(folder.id, back: false) }
                        }
                    }
                    Button {
                        newName = DriveLogic.newFolderName
                        naming = true
                    } label: {
                        Label(DriveLogic.newFolderTitle, systemImage: "folder.badge.plus")
                    }
                    .accessibilityIdentifier("drive-move-new-folder")
                } header: {
                    Text(DriveLogic.trail(trail.map { DriveLogic.folderTitle($0) })).textCase(nil)
                } footer: {
                    Text(DriveLogic.moveFoot)
                }
            }
            .listStyle(.insetGrouped)
            .overlay { if loading { ProgressView() } }
            .safeAreaInset(edge: .bottom) {
                Button {
                    let to = target
                    dismiss()
                    Task { await model.move(entries: entries, to: to?.parentId == nil ? nil : to) }
                } label: {
                    Text(DriveLogic.moveHere(target.map { DriveLogic.folderTitle($0) } ?? DriveLogic.title))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(!canMoveHere)
                .padding(16)
                .background(.bar)
                .accessibilityIdentifier("drive-move-here")
            }
            .navigationTitle(DriveLogic.moveTitle(entries.map(\.name)))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .alert(DriveLogic.newFolderTitle, isPresented: $naming) {
                TextField("Name", text: $newName)
                Button("Cancel", role: .cancel) {}
                Button("Create") {
                    let name = newName
                    Task {
                        guard let folder = await model.createFolder(named: name, in: trail.last) else { return }
                        await open(trail.last?.parentId == nil ? nil : trail.last?.id, back: false)
                        made = folder
                    }
                }
            }
        }
        .task { await open(nil, back: false) }
    }

    private var canMoveHere: Bool {
        guard let here = target else { return false }
        let ancestors = trail.map(\.id) + (made.map { [$0.id] } ?? [])
        return entries.contains { DriveLogic.canMove($0, into: here.id, ancestorsOfTarget: ancestors) }
    }

    private func open(_ id: String?, back: Bool) async {
        loading = true
        defer { loading = false }
        guard let read = await model.folders(in: id) else { return }
        if back {
            trail.removeLast()
        } else if trail.last?.id != read.folder.id {
            trail.append(read.folder)
        }
        children = read.children
    }
}

/// A folder in the Move sheet: a tap opens it; the one just made from the sheet is drawn selected (frame 7 ①).
private struct DriveMoveFolderRow: View {
    let folder: DriveEntry
    let made: Bool
    let moving: Bool
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 12) {
                Image(systemName: made ? "folder.badge.plus" : "folder.fill")
                    .foregroundStyle(made ? Color.green : Color.accentColor).frame(width: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(folder.name).foregroundStyle(.primary)
                    Text(made ? DriveLogic.newFolderTitle : "").font(.orbitListSubtitle).foregroundStyle(.secondary)
                        .opacity(made ? 1 : 0)
                        .frame(height: made ? nil : 0)
                }
                Spacer(minLength: 8)
                Image(systemName: made ? "checkmark" : "chevron.right")
                    .font(.orbitLabel.weight(.semibold))
                    .foregroundStyle(made ? Color.green : Color.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(made ? Color.green.opacity(0.12) : nil)
        .disabled(moving)
    }
}

// MARK: - share link (frames 9-10, D18)

struct DrivePhoneShareSheet: View {
    let model: DriveModel
    let entry: DriveEntry
    @Environment(\.dismiss) private var dismiss
    @State private var phase: Phase = .checking

    enum Phase {
        case checking
        case warn(DriveShareCheck)
        case sharing
        case shared(DriveShareLink, clean: Bool, partialBytes: Int?)
        case failed(String)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    DriveEntryIcon(entry: entry, size: 36)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(entry.name).font(.headline)
                        Text(DriveLogic.formatSize(entry.sizeBytes)).font(.orbitListSubtitle).foregroundStyle(.secondary)
                    }
                }
                content
            }
            .padding(20)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .task { await start() }
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .checking, .sharing:
            Text(DriveLogic.shareDescriptionLong).font(.body)
            HStack(spacing: 8) {
                ProgressView()
                Text(phaseIsChecking ? DriveLogic.checking : DriveLogic.making)
            }
            .font(.orbitSubtext).foregroundStyle(.secondary)
            Button("Cancel") { dismiss() }.frame(maxWidth: .infinity).buttonStyle(.bordered).controlSize(.large)
        case .warn(let check):
            warning(check)
        case .shared(let link, let clean, let partial):
            shared(link, clean: clean, partial: partial)
        case .failed(let message):
            Text("Couldn't share the file: \(message)").font(.orbitSubtext).foregroundStyle(.red)
            Button("Close") { dismiss() }.frame(maxWidth: .infinity).buttonStyle(.bordered).controlSize(.large)
        }
    }

    private var phaseIsChecking: Bool {
        if case .checking = phase { return true }
        return false
    }

    private func warning(_ check: DriveShareCheck) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 8) {
                Label(DriveLogic.secretsHeading, systemImage: "exclamationmark.triangle.fill")
                    .font(.orbitSubtext.weight(.semibold))
                    .foregroundStyle(Color.orange)
                Text(DriveLogic.shareSecretsLead).font(.orbitSubtext)
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(check.warnings, id: \.self) { warning in
                        HStack {
                            Text(DriveLogic.shapeLabel(warning.kind)).font(.orbitSubtext)
                            Spacer(minLength: 8)
                            Text(DriveLogic.warningLine(warning)).font(.orbitMono).foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(12)
                .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 8))
                if check.partial {
                    Text(DriveLogic.partialNote(check.checkedBytes)).font(.orbitListSubtitle).foregroundStyle(.secondary)
                }
            }
            .padding(14)
            .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("drive-share-warning")
            Text(DriveLogic.shareSecretsFoot).font(.orbitListSubtitle).foregroundStyle(.secondary)
            HStack(spacing: 10) {
                Button { dismiss() } label: { Text("Cancel").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered)
                Button { Task { await share(after: check) } } label: {
                    Text("Share anyway").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(.orange)
                .accessibilityIdentifier("drive-share-anyway")
            }
            .controlSize(.large)
        }
    }

    private func shared(_ link: DriveShareLink, clean: Bool, partial: Int?) -> some View {
        let url = model.publicURL(link).absoluteString
        return VStack(alignment: .leading, spacing: 12) {
            Text(DriveLogic.shareDescriptionLong).font(.body)
            if clean {
                Label(DriveLogic.nothingFound, systemImage: "checkmark")
                    .font(.orbitSubtext)
                    .foregroundStyle(Color.green)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.green.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
            }
            if let partial {
                Text(DriveLogic.partialNote(partial)).font(.orbitListSubtitle).foregroundStyle(.secondary)
            }
            HStack(spacing: 8) {
                Image(systemName: "link").foregroundStyle(Color.accentColor)
                Text(url).font(.orbitMono).lineLimit(1).truncationMode(.tail).textSelection(.enabled)
                    .accessibilityIdentifier("drive-share-url")
                Spacer(minLength: 8)
                Button(DriveLogic.copyLink) {
                    UIPasteboard.general.string = url
                    model.onToast?(DriveLogic.linkCopied, entry.name, .success, nil)
                }
                .font(.body.weight(.semibold))
            }
            .padding(12)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 10))
            HStack(spacing: 10) {
                Button(role: .destructive) {
                    Task {
                        await model.stopSharing(link, name: entry.name)
                        dismiss()
                    }
                } label: { Text("Stop sharing").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered)
                Button { dismiss() } label: { Text("Done").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent)
            }
            .controlSize(.large)
            Text(DriveLogic.sharedLinksFoot).font(.orbitListSubtitle).foregroundStyle(.secondary)
        }
    }

    private func start() async {
        if let link = model.link(of: entry), link.root.pinnedIsCurrent {
            phase = .shared(link, clean: false, partialBytes: nil)
            return
        }
        do {
            let check = try await model.shareCheck(entry)
            if check.warnings.isEmpty {
                await share(after: check)
            } else {
                phase = .warn(check)
            }
        } catch {
            phase = .failed(APIClient.failureReason(error))
        }
    }

    private func share(after check: DriveShareCheck) async {
        phase = .sharing
        do {
            let answer = try await model.share(entry)
            let partial = answer.partial ? answer.checkedBytes : (check.partial ? check.checkedBytes : nil)
            phase = .shared(answer.link, clean: check.warnings.isEmpty && answer.warnings.isEmpty, partialBytes: partial)
        } catch {
            phase = .failed(APIClient.failureReason(error))
        }
    }
}

// MARK: - Trash (frames 11-12, D6, D11, D17, rule 3)

struct DriveTrashPage: View {
    @Environment(AppModel.self) private var app
    @State private var deleting: DriveTrashGroup?
    @State private var emptying = false

    var body: some View {
        if let model = app.drive { page(model) }
    }

    private func page(_ model: DriveModel) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let groups = model.trash, !groups.isEmpty {
                    Text(DriveLogic.trashSummary(groups)).font(.orbitSubtext).foregroundStyle(.secondary)
                        .padding(.horizontal, 20).padding(.bottom, 6)
                }
                ForEach(model.trash ?? []) { group in
                    DriveTrashGroupCard(model: model, group: group, deleting: $deleting)
                }
                if model.trash?.isEmpty == false {
                    Text(DriveLogic.trashFoot).font(.orbitListSubtitle).foregroundStyle(.secondary)
                        .padding(.horizontal, 20).padding(.top, 10)
                }
                // What stands in for the groups, in the scroll itself: an overlay on an emptied scroll was not drawn.
                Group {
                    if let error = model.trashError, model.trash == nil {
                        ContentUnavailableView("Couldn't read Trash", systemImage: "exclamationmark.triangle",
                                               description: Text(error))
                    } else if model.trash == nil {
                        ProgressView()
                    } else if model.trash?.isEmpty == true {
                        ContentUnavailableView(DriveLogic.trashEmpty, systemImage: "trash",
                                               description: Text(DriveLogic.trashFoot))
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.top, 80)
            }
            .padding(.vertical, 8)
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(DriveLogic.trash)
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(DriveLogic.emptyTrash, role: .destructive) { emptying = true }
                    .foregroundStyle(.red)
                    .disabled(model.trash?.isEmpty ?? true)
            }
        }
        .task(id: model.changes) { await model.loadTrash() }
        .refreshable { await model.loadTrash() }
        .orbitConfirmation({ _ in "Delete for good?" }, isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                           presenting: deleting) { group in
            Button(DriveLogic.deleteForGood, role: .destructive) { Task { await model.deleteForGood(group) } }
            Button("Cancel", role: .cancel) {}
        } message: { group in
            Text(DriveLogic.deleteForGoodMessage(group) + (model.endsALink(group) ? " " + DriveLogic.endsAShareLink : ""))
        }
        .orbitConfirmation("Empty Trash?", isPresented: $emptying) {
            Button("Empty Trash", role: .destructive) { Task { await model.emptyTrash() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            let groups = model.trash ?? []
            Text(DriveLogic.emptyTrashMessage(groups)
                 + (groups.contains(where: model.endsALink) ? " " + DriveLogic.endsAShareLink : ""))
        }
    }
}

/// One Trash group: the folder it was deleted from and when, Restore all, and its rows (rule 3); tapping a row offers
/// what can be done with it (frame 12's three choices).
private struct DriveTrashGroupCard: View {
    let model: DriveModel
    let group: DriveTrashGroup
    @Binding var deleting: DriveTrashGroup?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(DriveLogic.trashHeading(group).uppercased())
                    .font(.orbitListSubtitle).foregroundStyle(.secondary)
                Spacer(minLength: 8)
                Button(DriveLogic.restoreAll) {
                    Task {
                        if group.version != nil {
                            await model.restoreVersion(of: group, asCopy: false)
                        } else {
                            await model.restore(group)
                        }
                    }
                }
                .font(.orbitSubtext)
                .accessibilityIdentifier("drive-restore-all")
            }
            .padding(.horizontal, 20)
            VStack(spacing: 0) {
                ForEach(rows, id: \.entry.id) { row in
                    if row.entry.id != rows.first?.entry.id { Divider().padding(.leading, 58) }
                    menu(row)
                }
            }
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
            .padding(.horizontal, 16)
        }
        .padding(.top, 14)
    }

    private struct Row {
        let entry: DriveEntry
        let version: Bool
    }

    private var rows: [Row] {
        (group.version.map { [Row(entry: $0.entry, version: true)] } ?? []) + group.items.map { Row(entry: $0, version: false) }
    }

    private func menu(_ row: Row) -> some View {
        Menu {
            if row.version {
                Text(DriveLogic.versionWhereNow(row.entry.name, folder: DriveLogic.groupTitle(group)))
                Button(DriveLogic.restoreAsCurrent) { Task { await model.restoreVersion(of: group, asCopy: false) } }
                Button(DriveLogic.restoreAsCopy) { Task { await model.restoreVersion(of: group, asCopy: true) } }
            } else {
                Button("Restore") { Task { await model.restore(row.entry, of: group) } }
            }
            Divider()
            Button(DriveLogic.deleteForGood, role: .destructive) { deleting = group }
        } label: {
            label(row)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("drive-trash-row-\(row.entry.name)")
    }

    private func label(_ row: Row) -> some View {
        let writer = model.writerName(group.actor)
        let line = row.version
            ? DriveLogic.trashVersionLine(group, writer: writer)
            : DriveLogic.trashLine(row.entry, in: group, writer: writer,
                                       // A group's count includes the folder itself (rm -rf is one row).
                                       folderCount: row.entry.isFolder && group.items.count == 1 ? max(0, group.itemCount - 1) : nil)
        let size = row.version ? DriveLogic.formatSize(group.version?.sizeBytes ?? 0)
            : (row.entry.isFile ? DriveLogic.formatSize(row.entry.sizeBytes) : "")
        return HStack(spacing: 12) {
            DriveEntryIcon(entry: row.entry)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.entry.name).foregroundStyle(.primary).lineLimit(1).truncationMode(.middle)
                Text(line).font(.orbitListSubtitle).foregroundStyle(.secondary).multilineTextAlignment(.leading)
            }
            Spacer(minLength: 8)
            Text(size).font(.orbitSubtext).foregroundStyle(.secondary).monospacedDigit()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }
}

// MARK: - Storage (frame 13, D13, D19)

struct DriveStoragePage: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        if let model = app.drive { page(model) }
    }

    private func page(_ model: DriveModel) -> some View {
        List {
            if let usage = model.usage {
                Section { total(usage) }
            }
            if let storage = model.storage {
                Section {
                    valueRow(DriveLogic.everythingElse, detail: DriveLogic.everythingElseNote,
                             value: model.usage.map { DriveLogic.storageSize($0.otherBytes) } ?? "")
                    valueRow(DriveLogic.storedFiles,
                             detail: DriveLogic.storageFull(storage) ? DriveLogic.storageFullNote : nil,
                             value: DriveLogic.storedValue(storage))
                } header: {
                    Text(DriveLogic.otherStorage)
                } footer: {
                    Text(DriveLogic.storageFoot)
                }
                if !storage.projects.isEmpty {
                    Section(DriveLogic.largestProjects) {
                        ForEach(storage.projects) { project in
                            rankRow(project.title, bytes: project.bytes) { app.openProjectSessions(project.id, inColumn: false) }
                        }
                    }
                }
                if !storage.tasks.isEmpty {
                    Section(DriveLogic.largestTasks) {
                        ForEach(storage.tasks) { task in
                            rankRow(task.title, bytes: task.bytes) { app.route(to: .task(task.id)) }
                        }
                    }
                }
                if !storage.weeks.isEmpty {
                    Section(DriveLogic.addedEachWeek) {
                        ForEach(storage.weeks.reversed()) { week in
                            rankRow(DriveLogic.weekLabel(week.weekStart), bytes: week.bytes, open: nil)
                        }
                    }
                }
            } else if let error = model.storageError {
                Text("Couldn't read this: \(error)").foregroundStyle(.red)
            }
        }
        .listStyle(.insetGrouped)
        .overlay { if model.usage == nil && model.storageError == nil { ProgressView() } }
        .navigationTitle(DriveLogic.storage)
        .navigationBarTitleDisplayMode(.large)
        .task(id: model.changes) { await model.loadStorage() }
        .refreshable { await model.loadStorage() }
    }

    private func total(_ usage: DriveUsage) -> some View {
        let bar = DriveLogic.storageBar(usage)
        let legend = DriveLogic.storageLegend(usage)
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(DriveLogic.storageSize(usage.totalBytes)).font(.orbitFigure)
                Spacer(minLength: 8)
                Text(DriveLogic.inThisAccount).font(.orbitSubtext).foregroundStyle(.secondary)
            }
            GeometryReader { proxy in
                HStack(spacing: 0) {
                    Rectangle().fill(Color.accentColor).frame(width: proxy.size.width * bar.drive)
                    Rectangle().fill(Color.accentColor.opacity(0.45)).frame(width: proxy.size.width * bar.trash)
                    Rectangle().fill(Color.secondary.opacity(0.45)).frame(width: proxy.size.width * bar.other)
                    Spacer(minLength: 0)
                }
                .background(Color.secondary.opacity(0.15))
                .clipShape(Capsule())
            }
            .frame(height: 10)
            HStack(spacing: 12) {
                legendItem(legend[0], Color.accentColor)
                legendItem(legend[1], Color.accentColor.opacity(0.45))
                legendItem(legend[2], Color.secondary.opacity(0.45))
            }
            if let warning = DriveLogic.storeWarning(usage) {
                Text(warning).font(.orbitListSubtitle).foregroundStyle(.orange)
            }
        }
        .padding(.vertical, 6)
    }

    private func legendItem(_ text: String, _ color: Color) -> some View {
        HStack(spacing: 4) {
            RoundedRectangle(cornerRadius: 2).fill(color).frame(width: 8, height: 8)
            Text(text).font(.orbitMeta).foregroundStyle(.secondary)
        }
    }

    private func valueRow(_ title: String, detail: String?, value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                if let detail { Text(detail).font(.orbitListSubtitle).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 8)
            Text(value).foregroundStyle(.secondary).monospacedDigit().multilineTextAlignment(.trailing)
        }
    }

    @ViewBuilder
    private func rankRow(_ name: String, bytes: Int, open: (() -> Void)?) -> some View {
        let line = HStack {
            Text(name).lineLimit(1).foregroundStyle(.primary)
            Spacer(minLength: 8)
            Text(DriveLogic.storageSize(bytes)).foregroundStyle(.secondary).monospacedDigit()
            if open != nil {
                Image(systemName: "chevron.right").font(.orbitLabel.weight(.semibold)).foregroundStyle(.tertiary)
            }
        }
        .contentShape(Rectangle())
        if let open {
            Button(action: open) { line }.buttonStyle(.plain)
        } else {
            line
        }
    }
}

// MARK: - the composer's picker (frame 14, D21, D22)

/// Add from Drive: browse the drive (opening on the session's project folder when there is one) and pick files;
/// what goes into the message is each file's path on the agent's mount.
struct DrivePickerSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    /// The session's project, whose folder the picker opens on.
    let project: (id: String, title: String)?
    let pick: ([String]) -> Void

    /// The folders opened, the root first.
    @State private var trail: [DriveEntry] = []
    @State private var entries: [DriveEntry] = []
    @State private var picked: [String: String] = [:]
    @State private var order: [String] = []
    @State private var searchText = ""
    @State private var found: [DriveEntry]?
    @State private var loading = true

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if trail.count > 1 && !searching {
                        Button { Task { await open(trail[trail.count - 2], back: true) } } label: {
                            Label(DriveLogic.folderTitle(trail[trail.count - 2]), systemImage: "chevron.left")
                        }
                    }
                    ForEach(rows) { entry in row(entry) }
                } header: {
                    if !searching {
                        Text(DriveLogic.trail(trail.map { DriveLogic.folderTitle($0) })).textCase(nil)
                    }
                } footer: {
                    Text(DriveLogic.pickerFoot)
                }
            }
            .listStyle(.insetGrouped)
            .overlay { if loading { ProgressView() } }
            .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .always),
                        prompt: DriveLogic.searchPrompt)
            .navigationTitle(DriveLogic.pickerTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(DriveLogic.pickerAdd(order.count)) {
                        pick(order.compactMap { picked[$0] })
                        dismiss()
                    }
                    .disabled(order.isEmpty)
                    .accessibilityIdentifier("drive-picker-add")
                }
            }
            .task { await start() }
            .task(id: searchText) { await search() }
        }
    }

    private var searching: Bool { !searchText.trimmingCharacters(in: .whitespaces).isEmpty }

    private var rows: [DriveEntry] { searching ? (found ?? []).filter(\.isFile) : entries }

    @ViewBuilder
    private func row(_ entry: DriveEntry) -> some View {
        if let model = app.drive {
            let chosen = picked[entry.id] != nil
            Button {
                if entry.isFolder {
                    Task { await open(entry, back: false) }
                } else if chosen {
                    picked[entry.id] = nil
                    order.removeAll { $0 == entry.id }
                } else {
                    picked[entry.id] = searching
                        ? DriveLogic.agentPath(entryPath: entry.path, name: entry.name)
                        : DriveLogic.agentPath(folders: trail.dropFirst().map(\.name), name: entry.name)
                    order.append(entry.id)
                }
            } label: {
                HStack(spacing: 12) {
                    DriveEntryIcon(entry: entry)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(entry.name).foregroundStyle(.primary).lineLimit(1).truncationMode(.middle)
                        if entry.isFile {
                            (searching ? Text(DriveLogic.searchFolder(entry.folderPath)).foregroundStyle(.secondary)
                             : DriveWriterText.of(model, entry.lastWriter) + Text(DriveLogic.fileLineWhen(entry.mtime))
                                .foregroundStyle(.secondary))
                                .font(.orbitListSubtitle).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 8)
                    if entry.isFolder {
                        Image(systemName: "chevron.right").font(.orbitLabel.weight(.semibold)).foregroundStyle(.tertiary)
                    } else if chosen {
                        Image(systemName: "checkmark").foregroundStyle(Color.accentColor)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .listRowBackground(chosen ? Color.accentColor.opacity(0.1) : nil)
        }
    }

    private func start() async {
        guard let model = app.drive, let root = try? await model.read(folder: nil) else {
            loading = false
            return
        }
        trail = [root.folder]
        entries = DriveLogic.sorted(root.entries)
        loading = false
        if let project, let folder = DriveLogic.projectFolder(root.entries, projectID: project.id, title: project.title) {
            await open(folder, back: false)
        }
    }

    private func open(_ folder: DriveEntry, back: Bool) async {
        guard let model = app.drive else { return }
        loading = true
        defer { loading = false }
        guard let read = try? await model.read(folder: folder.parentId == nil ? nil : folder.id) else { return }
        if back {
            trail.removeLast()
        } else {
            searchText = ""
            trail.append(read.folder)
        }
        entries = DriveLogic.sorted(read.entries)
    }

    private func search() async {
        let words = searchText.trimmingCharacters(in: .whitespaces)
        guard !words.isEmpty, let model = app.drive else {
            found = nil
            return
        }
        try? await Task.sleep(nanoseconds: 250_000_000)
        guard !Task.isCancelled else { return }
        found = (try? await model.search(words)) ?? []
    }
}
#endif
