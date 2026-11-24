#if os(macOS)
import SwiftUI
import AppKit
import UniformTypeIdentifiers
import OrbitKit

// Documents on the Mac (board docs/mocks/documents/03-mac.png; 01-ios.png for what it does not draw): a Finder-like
// list with an inspector, the Share Link sheet with the secret warning, Trash and Storage under Documents in the
// sidebar, and the toolbar's uploads ring and popover with the agents' directory syncs. The words are OrbitKit's
// `DocumentsLogic`; the reads and writes are `DocumentsModel`'s.

/// The middle column: the folder's list, Trash's groups or Storage's total, by the sidebar's row.
struct DocumentsContentColumn: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        if let model = app.documents {
            switch model.place {
            case .drive: DocumentsListColumn(model: model)
            case .trash: DocumentsTrashColumn(model: model)
            case .storage: DocumentsStorageColumn(model: model)
            }
        } else {
            ContentUnavailableView(DocumentsLogic.title, systemImage: AppSection.documents.systemImage)
        }
    }
}

/// The right column: the inspector, Trash's summary or Storage's rankings.
struct DocumentsDetailColumn: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        if let model = app.documents {
            switch model.place {
            case .drive: DocumentsInspector(model: model)
            case .trash: DocumentsTrashSummary(model: model)
            case .storage: DocumentsStorageRankings(model: model)
            }
        } else {
            Color.clear
        }
    }
}

// MARK: - the list

private struct DocumentsListColumn: View {
    @Bindable var model: DocumentsModel
    @State private var renaming: String?
    @State private var renameText = ""
    @State private var moving: [String]?
    @State private var sharing: DocumentsEntry?
    @State private var dropTargeted = false
    @State private var showTray = false
    @FocusState private var renameFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            table
            if dropTargeted { dropBand }
        }
        .overlay {
            if let error = model.loadError, model.listing == nil {
                ContentUnavailableView("Couldn't read this folder", systemImage: "exclamationmark.triangle",
                                       description: Text(error))
            } else if model.listing != nil && model.rows.isEmpty && !model.searching {
                ContentUnavailableView("Nothing here yet", systemImage: "folder",
                                       description: Text("Drop files or folders here, or press Upload."))
            } else if model.loading {
                ProgressView()
            }
        }
        .onDrop(of: [.fileURL], isTargeted: $dropTargeted) { providers in
            Self.loadFileURLs(providers) { urls in model.upload(urls) }
            return true
        }
        .navigationTitle(model.searching ? "Search" : model.folderTitle)
        .searchable(text: $model.searchText, placement: .toolbar, prompt: "Search")
        .onChange(of: model.searchText) { _, _ in model.searchChanged() }
        .toolbar { toolbar }
        .task(id: model.folderID) {
            if model.listing == nil { await model.reload() }
        }
        .sheet(item: Binding(get: { moving.map(MoveRequest.init) }, set: { moving = $0?.ids })) { request in
            DocumentsMoveSheet(model: model, ids: request.ids)
        }
        .sheet(item: $sharing) { entry in
            DocumentsShareSheet(model: model, entry: entry, moveToCurrent: false)
        }
        .accessibilityIdentifier("documents-list")
    }

    private struct MoveRequest: Identifiable {
        let ids: [String]
        var id: String { ids.joined(separator: ",") }
    }

    private var selectedEntries: [DocumentsEntry] { model.rows.filter { model.selection.contains($0.id) } }

    private var table: some View {
        Table(of: DocumentsEntry.self, selection: $model.selection) {
            TableColumn("Name") { entry in nameCell(entry) }
                .width(min: 180, ideal: 280)
            TableColumn(model.searching ? "Folder" : "Last written by") { entry in
                if model.searching {
                    Text(DocumentsLogic.searchFolder(entry.folderPath)).foregroundStyle(.secondary)
                } else if entry.isFolder {
                    Text("—").foregroundStyle(.tertiary)
                } else {
                    DocumentsWriterLabel(model: model, writer: entry.lastWriter)
                }
            }
            .width(min: 120, ideal: 200)
            TableColumn("Size") { entry in
                Text(DocumentsLogic.sizeColumn(entry, folderCount: model.folderCounts[entry.id]))
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            .width(min: 60, ideal: 80)
            TableColumn("Modified") { entry in
                Text(DocumentsLogic.formatWhen(entry.mtime)).foregroundStyle(.secondary)
            }
            .width(min: 70, ideal: 90)
        } rows: {
            ForEach(model.rows) { entry in
                TableRow(entry)
                    .draggable(DocumentsDrag.text(entry.id))
                    .dropDestination(for: String.self) { items in
                        let ids = items.compactMap(DocumentsDrag.id).filter { $0 != entry.id }
                        guard entry.isFolder, !ids.isEmpty else { return }
                        Task { await model.move(ids, to: entry) }
                    }
            }
        }
        .contextMenu(forSelectionType: String.self) { ids in
            rowMenu(ids)
        } primaryAction: { ids in
            guard ids.count == 1, let entry = model.rows.first(where: { $0.id == ids.first }) else { return }
            if entry.isFolder {
                model.open(folder: entry.id)
            } else if model.searching {
                model.reveal(entry)
            }
        }
        .onKeyPress(.return) {
            guard renaming == nil, let entry = selectedEntries.first, selectedEntries.count == 1 else { return .ignored }
            beginRename(entry)
            return .handled
        }
        .onDeleteCommand {
            let ids = Array(model.selection)
            guard !ids.isEmpty else { return }
            Task { await model.moveToTrash(ids) }
        }
    }

    @ViewBuilder
    private func nameCell(_ entry: DocumentsEntry) -> some View {
        HStack(spacing: 6) {
            Image(systemName: DocumentsLogic.systemImage(entry))
                .foregroundStyle(entry.isFolder ? Color.accentColor : .secondary)
                .frame(width: 16)
            if renaming == entry.id {
                TextField("Name", text: $renameText)
                    .textFieldStyle(.plain)
                    .focused($renameFocused)
                    .onSubmit { commitRename(entry) }
                    .onExitCommand { renaming = nil }
            } else {
                Text(entry.name).lineLimit(1).truncationMode(.middle)
                if model.link(of: entry) != nil {
                    Image(systemName: "link").font(.orbitMeta).foregroundStyle(.secondary)
                        .accessibilityLabel("Shared")
                }
            }
            if let upload = model.uploads.first(where: { $0.entryID == nil && $0.state != .done && $0.parentID == model.folderID
                && $0.relativePath == nil && $0.name == entry.name }) {
                ProgressView(value: Double(upload.percent), total: 100).frame(width: 60)
            }
        }
    }

    @ViewBuilder
    private func rowMenu(_ ids: Set<String>) -> some View {
        let entries = model.rows.filter { ids.contains($0.id) }
        if entries.count == 1, let entry = entries.first {
            if entry.isFolder {
                Button("Open") { model.open(folder: entry.id) }
            } else {
                Button("Download") { Task { await model.download(entry) } }
                Button("Share Link…") { sharing = entry }
            }
            if model.searching {
                Button("Show in Folder") { model.reveal(entry) }
            }
            Divider()
            Button("Rename") { beginRename(entry) }
        }
        if !entries.isEmpty {
            Button("Move to…") { moving = entries.map(\.id) }
        }
        Button("New Folder") { Task { await newFolder() } }
        if !entries.isEmpty {
            Divider()
            Button("Move to Trash") { Task { await model.moveToTrash(entries.map(\.id)) } }
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .navigation) {
            Button { model.goBack() } label: { Label("Back", systemImage: "chevron.left") }
                .disabled(model.backStack.isEmpty)
                .help("Back")
            Button { model.goForward() } label: { Label("Forward", systemImage: "chevron.right") }
                .disabled(model.forwardStack.isEmpty)
                .help("Forward")
        }
        ToolbarItemGroup(placement: .primaryAction) {
            if model.trayShown {
                Button { showTray.toggle() } label: {
                    DocumentsProgressRing(fraction: DocumentsLogic.trayTotals(model.uploads, model.syncs).fraction,
                                          finished: DocumentsLogic.trayTotals(model.uploads, model.syncs).allFinished)
                }
                .help("Uploads")
                .accessibilityLabel("Uploads")
                .accessibilityIdentifier("documents-uploads")
                .popover(isPresented: $showTray, arrowEdge: .bottom) {
                    DocumentsUploadsPopover(model: model)
                }
            }
            Button { Task { await newFolder() } } label: { Label("New Folder", systemImage: "folder.badge.plus") }
                .keyboardShortcut("n", modifiers: [.command, .shift])
                .help("New Folder (⇧⌘N)")
                .disabled(model.searching)
            Button { pickUploads() } label: { Label("Upload", systemImage: "square.and.arrow.up") }
                .keyboardShortcut("u", modifiers: .command)
                .help("Upload (⌘U)")
            Button { sharing = selectedEntries.first } label: { Label("Share Link…", systemImage: "link") }
                .disabled(selectedEntries.count != 1 || selectedEntries.first?.isFile != true)
                .help("Share Link…")
            Button { Task { await model.moveToTrash(Array(model.selection)) } } label: {
                Label("Move to Trash", systemImage: "trash")
            }
            .keyboardShortcut(.delete, modifiers: .command)
            .disabled(model.selection.isEmpty)
            .help("Move to Trash (⌘⌫)")
        }
    }

    private var dropBand: some View {
        Text("Drop to upload to \(model.folderTitle)")
            .font(.orbitSubtext.weight(.medium))
            .foregroundStyle(Color.accentColor)
            .frame(maxWidth: .infinity, minHeight: 72)
            .background(Color.accentColor.opacity(0.06))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.accentColor, style: StrokeStyle(lineWidth: 1.5, dash: [5, 4])))
            .padding(8)
    }

    private func beginRename(_ entry: DocumentsEntry) {
        renameText = entry.name
        renaming = entry.id
        DispatchQueue.main.async { renameFocused = true }
    }

    private func commitRename(_ entry: DocumentsEntry) {
        let name = renameText
        renaming = nil
        Task { await model.rename(entry, to: name) }
    }

    private func newFolder() async {
        if let made = await model.newFolder() { beginRename(made) }
    }

    /// The Upload button: files and folders, any size.
    private func pickUploads() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.prompt = "Upload"
        panel.message = "Files or folders, any size, to \(model.folderTitle)"
        guard panel.runModal() == .OK else { return }
        model.upload(panel.urls)
    }

    /// The file URLs a Finder drop carries.
    static func loadFileURLs(_ providers: [NSItemProvider], _ done: @escaping ([URL]) -> Void) {
        var urls: [URL] = []
        let group = DispatchGroup()
        let lock = NSLock()
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            group.enter()
            _ = provider.loadObject(ofClass: URL.self) { url, _ in
                if let url {
                    lock.lock()
                    urls.append(url)
                    lock.unlock()
                }
                group.leave()
            }
        }
        group.notify(queue: .main) { if !urls.isEmpty { done(urls) } }
    }
}

/// A row dragged onto a folder carries its id as text, marked so a stray string is not read as one.
enum DocumentsDrag {
    static let prefix = "orbit-documents-entry:"
    static func text(_ id: String) -> String { prefix + id }
    static func id(_ text: String) -> String? { text.hasPrefix(prefix) ? String(text.dropFirst(prefix.count)) : nil }
}

/// "You", "An agent on Orbit Cloud", or "Agent in <session>" as a link to that session (rule 6).
struct DocumentsWriterLabel: View {
    let model: DocumentsModel
    let writer: DocumentsWriter

    var body: some View {
        let name = model.writerName(writer)
        if let session = DocumentsLogic.writerSession(writer) {
            Button(name) { model.openSession?(session) }
                .buttonStyle(.link)
                .lineLimit(1)
                .help("Open the session")
        } else {
            Text(name).foregroundStyle(.secondary).lineLimit(1)
        }
    }
}

/// The toolbar's ring: how much of every upload and sync is in.
struct DocumentsProgressRing: View {
    let fraction: Double
    let finished: Bool

    var body: some View {
        ZStack {
            Circle().stroke(Color.secondary.opacity(0.3), lineWidth: 2.5)
            Circle()
                .trim(from: 0, to: finished ? 1 : max(0.02, fraction))
                .stroke(finished ? Color.green : Color.accentColor, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                .rotationEffect(.degrees(-90))
            if finished {
                Image(systemName: "checkmark").font(.orbitMeta.weight(.bold)).foregroundStyle(.green)
            }
        }
        .frame(width: 16, height: 16)
    }
}

// MARK: - the inspector

private struct DocumentsInspector: View {
    let model: DocumentsModel
    @State private var sharing: (entry: DocumentsEntry, moveToCurrent: Bool)?

    var body: some View {
        Group {
            if let entry = model.inspected {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if entry.isFile { DocumentsPreviewBox(model: model, entry: entry) }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(entry.name).font(.headline).textSelection(.enabled)
                            Text(kindLine(entry)).font(.orbitLabel).foregroundStyle(.secondary)
                        }
                        facts(entry)
                        actions(entry)
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .task(id: "\(entry.id):\(entry.currentVersionId ?? ""):\(entry.seq)") { await model.inspect(entry) }
            } else {
                ContentUnavailableView(model.selection.count > 1 ? DocumentsLogic.items(model.selection.count) : "No selection",
                                       systemImage: "doc.text.magnifyingglass",
                                       description: Text(model.selection.count > 1 ? "" : "Select a file to see it here."))
            }
        }
        .sheet(item: Binding(get: { sharing.map { ShareRequest(entry: $0.entry, moveToCurrent: $0.moveToCurrent) } },
                             set: { sharing = $0.map { ($0.entry, $0.moveToCurrent) } })) { request in
            DocumentsShareSheet(model: model, entry: request.entry, moveToCurrent: request.moveToCurrent)
        }
        .accessibilityIdentifier("documents-inspector")
    }

    private struct ShareRequest: Identifiable {
        let entry: DocumentsEntry
        let moveToCurrent: Bool
        var id: String { entry.id }
    }

    private func kindLine(_ entry: DocumentsEntry) -> String {
        var line = DocumentsLogic.kindLine(entry)
        if case .data(let data)? = model.preview(for: entry),
           DocumentsLogic.preview(name: entry.name, size: entry.sizeBytes) == .picture,
           let rep = NSBitmapImageRep(data: data) {
            line += " · \(rep.pixelsWide) × \(rep.pixelsHigh)"
        }
        return line
    }

    @ViewBuilder
    private func facts(_ entry: DocumentsEntry) -> some View {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 10, verticalSpacing: 6) {
            GridRow {
                label("Last written")
                Text(DocumentsLogic.formatWhenLong(entry.lastWriter.at ?? entry.mtime))
            }
            GridRow {
                label("By")
                DocumentsWriterLabel(model: model, writer: entry.lastWriter)
            }
            GridRow {
                label("Path")
                Text(DocumentsLogic.displayPath(model.entryDetails[entry.id]?.path) ?? "…")
                    .textSelection(.enabled)
                    .foregroundStyle(.secondary)
            }
            if entry.isFile {
                GridRow {
                    label("Earlier")
                    earlier(entry)
                }
            }
            if let link = model.link(of: entry) {
                GridRow {
                    label("Shared")
                    HStack(spacing: 6) {
                        Text(DocumentsLogic.sharedLine(link))
                        if !link.root.pinnedIsCurrent {
                            Button("Share This Version") { sharing = (entry, true) }.buttonStyle(.link)
                        }
                    }
                }
            }
        }
        .font(.orbitLabel)
    }

    private func label(_ text: String) -> some View {
        Text(text).foregroundStyle(.secondary).gridColumnAlignment(.leading)
    }

    @ViewBuilder
    private func earlier(_ entry: DocumentsEntry) -> some View {
        let versions = model.earlierVersions(of: entry)
        if versions.isEmpty {
            Text(DocumentsLogic.earlierVersions(0))
        } else {
            Menu(DocumentsLogic.earlierVersions(versions.count)) {
                ForEach(versions) { version in
                    Menu("\(DocumentsLogic.formatWhenLong(version.createdAt)) · \(DocumentsLogic.formatSize(version.sizeBytes)) · \(model.writerName(version.writer))") {
                        Button("Restore as Current") { Task { await model.restoreVersion(version, asCopy: false) } }
                        Button("Restore as Copy") { Task { await model.restoreVersion(version, asCopy: true) } }
                        Button("Download") { Task { await model.download(entry, version: version) } }
                    }
                }
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
        }
    }

    @ViewBuilder
    private func actions(_ entry: DocumentsEntry) -> some View {
        HStack {
            if entry.isFile {
                Button("Download") { Task { await model.download(entry) } }
                Button("Share Link…") { sharing = (entry, false) }
                    .buttonStyle(.borderedProminent)
            } else {
                Button("Open") { model.open(folder: entry.id) }
            }
        }
        .controlSize(.small)
    }
}

/// A picture drawn, a Markdown file rendered as the phone renders it (01-ios frame 5), text as it is written.
private struct DocumentsPreviewBox: View {
    let model: DocumentsModel
    let entry: DocumentsEntry

    var body: some View {
        let kind = DocumentsLogic.preview(name: entry.name, size: entry.sizeBytes)
        Group {
            switch model.preview(for: entry) {
            case .data(let data)?:
                content(kind, data)
            case .failed?:
                placeholder("Couldn't load the preview.")
            case .loading?:
                ProgressView().frame(maxWidth: .infinity, minHeight: 120)
            case nil:
                if kind == .none { icon } else { ProgressView().frame(maxWidth: .infinity, minHeight: 120) }
            }
        }
        .accessibilityIdentifier("documents-preview")
    }

    @ViewBuilder
    private func content(_ kind: DocumentsLogic.Preview, _ data: Data) -> some View {
        switch kind {
        case .picture:
            if let image = NSImage(data: data) {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: 240)
                    .background(Color.black.opacity(0.85), in: RoundedRectangle(cornerRadius: 8))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            } else {
                placeholder("Couldn't load the preview.")
            }
        case .markdown:
            ScrollView {
                MarkdownView(source: String(decoding: data, as: UTF8.self))
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 420)
            .background(.background, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator))
        case .text:
            ScrollView([.vertical, .horizontal]) {
                Text(String(decoding: data, as: UTF8.self))
                    .font(.orbitMono)
                    .textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 320)
            .background(.background, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator))
        case .pdf, .none:
            icon
        }
    }

    private var icon: some View {
        Image(systemName: DocumentsLogic.systemImage(entry))
            .font(.orbitHeroGlyph)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, minHeight: 120)
            .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8))
    }

    private func placeholder(_ text: String) -> some View {
        Text(text).font(.orbitLabel).foregroundStyle(.secondary).frame(maxWidth: .infinity, minHeight: 80)
    }
}

// MARK: - Move

struct DocumentsMoveSheet: View {
    let model: DocumentsModel
    let ids: [String]
    @Environment(\.dismiss) private var dismiss
    /// The folders opened in the sheet, the root first.
    @State private var trail: [DocumentsEntry] = []
    @State private var children: [DocumentsEntry] = []
    @State private var loading = true

    private var moving: [DocumentsEntry] { model.rows.filter { ids.contains($0.id) } }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(moving.count == 1 ? "Move “\(moving[0].name)” to…" : "Move \(DocumentsLogic.items(ids.count)) to…")
                .font(.headline)
            HStack(spacing: 4) {
                Button { Task { await open(trail.count > 1 ? trail[trail.count - 2].id : nil, back: true) } } label: {
                    Image(systemName: "chevron.left")
                }
                .buttonStyle(.borderless)
                .disabled(trail.count <= 1)
                Text(trail.map { DocumentsLogic.folderTitle($0) }.joined(separator: " › "))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
            List {
                ForEach(children) { folder in
                    Button { Task { await open(folder.id, back: false) } } label: {
                        Label(folder.name, systemImage: "folder.fill")
                    }
                    .buttonStyle(.plain)
                    .disabled(ids.contains(folder.id))
                }
            }
            .frame(minHeight: 220)
            .overlay { if loading { ProgressView() } }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Move Here") {
                    let target = trail.last
                    dismiss()
                    Task { await model.move(ids, to: target) }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!canMoveHere)
            }
        }
        .padding(20)
        .frame(width: 440)
        .task { await open(nil, back: false) }
    }

    private var canMoveHere: Bool {
        guard let here = trail.last else { return false }
        let ancestors = trail.map(\.id)
        return moving.contains { DocumentsLogic.canMove($0, into: here.id, ancestorsOfTarget: ancestors) }
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

// MARK: - Share Link (D18, §9)

struct DocumentsShareSheet: View {
    let model: DocumentsModel
    let entry: DocumentsEntry
    let moveToCurrent: Bool
    @Environment(\.dismiss) private var dismiss
    @State private var phase: Phase = .checking

    enum Phase {
        case checking
        case warn(DocumentsShareCheck)
        case sharing
        case shared(DocumentsShareLink, partialBytes: Int?)
        case failed(String)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(moveToCurrent ? DocumentsLogic.shareThisVersionTitle(entry.name) : DocumentsLogic.shareTitle(entry.name))
                .font(.headline)
            Text(DocumentsLogic.shareDescription).font(.orbitLabel).foregroundStyle(.secondary)
            content
            HStack {
                Spacer()
                buttons
            }
        }
        .padding(20)
        .frame(width: 460)
        .task { await start() }
        .accessibilityIdentifier("documents-share-sheet")
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .checking:
            HStack(spacing: 8) { ProgressView().controlSize(.small); Text(DocumentsLogic.checking) }
                .font(.orbitLabel).foregroundStyle(.secondary)
        case .sharing:
            HStack(spacing: 8) { ProgressView().controlSize(.small); Text(DocumentsLogic.making) }
                .font(.orbitLabel).foregroundStyle(.secondary)
        case .warn(let check):
            VStack(alignment: .leading, spacing: 8) {
                Label(DocumentsLogic.secretsHeading, systemImage: "exclamationmark.triangle.fill")
                    .font(.orbitSubtext.weight(.semibold))
                    .foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(check.warnings, id: \.self) { warning in
                        HStack {
                            Text(DocumentsLogic.shapeLabel(warning.kind))
                            Spacer()
                            Text("line \(warning.line)").font(.orbitMono).foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(10)
                .background(.background, in: RoundedRectangle(cornerRadius: 6))
                if check.partial {
                    Text(DocumentsLogic.partialNote(check.checkedBytes)).font(.orbitLabel).foregroundStyle(.secondary)
                }
                Text(DocumentsLogic.secretsFoot).font(.orbitLabel).foregroundStyle(.orange)
            }
            .padding(12)
            .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
            .accessibilityIdentifier("documents-share-warning")
        case .shared(let link, let partial):
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    TextField("Share link", text: .constant(model.publicURL(link).absoluteString))
                        .textFieldStyle(.roundedBorder)
                    Button(DocumentsLogic.copyLink) {
                        PlatformPasteboard.copyString(model.publicURL(link).absoluteString)
                        model.onToast?(DocumentsLogic.linkCopied, entry.name, .success, nil)
                    }
                }
                Text(DocumentsLogic.shareVersionNote).font(.orbitLabel).foregroundStyle(.secondary)
                if let partial {
                    Text(DocumentsLogic.partialNote(partial)).font(.orbitLabel).foregroundStyle(.secondary)
                }
            }
        case .failed(let message):
            Text("Couldn't share the file: \(message)").font(.orbitLabel).foregroundStyle(.red)
        }
    }

    @ViewBuilder
    private var buttons: some View {
        switch phase {
        case .warn(let check):
            // Share Anyway is not the default: Return cancels (board 03-mac ② 2).
            Button("Cancel", role: .cancel) { dismiss() }
                .keyboardShortcut(.defaultAction)
            Button(DocumentsLogic.shareAnyway) { Task { await share(after: check) } }
                .tint(.orange)
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("documents-share-anyway")
        case .shared(let link, _):
            Button(DocumentsLogic.stopSharing, role: .destructive) {
                Task {
                    await model.stopSharing(link, name: entry.name)
                    dismiss()
                }
            }
            Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
        case .failed:
            Button("Close") { dismiss() }.keyboardShortcut(.defaultAction)
        case .checking, .sharing:
            Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
        }
    }

    private func start() async {
        if !moveToCurrent, let link = model.link(of: entry), link.root.pinnedIsCurrent {
            phase = .shared(link, partialBytes: nil)
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

    private func share(after check: DocumentsShareCheck) async {
        phase = .sharing
        do {
            let answer = try await model.share(entry)
            let partial = answer.partial ? answer.checkedBytes : (check.partial ? check.checkedBytes : nil)
            phase = .shared(answer.link, partialBytes: partial)
        } catch {
            phase = .failed(APIClient.failureReason(error))
        }
    }
}

// MARK: - the uploads popover (03-mac ④, 01-ios 16-18)

struct DocumentsUploadsPopover: View {
    let model: DocumentsModel
    @State private var details: DocumentsSync?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(DocumentsLogic.trayTitle(model.uploads, model.syncs)).font(.orbitSubtext.weight(.semibold))
                Spacer()
                if DocumentsLogic.trayTotals(model.uploads, model.syncs).finished > 0 {
                    Button(DocumentsLogic.clearFinished) { model.clearFinished() }.buttonStyle(.link)
                }
            }
            .padding(12)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(model.syncs) { sync in
                        syncRow(sync)
                        Divider()
                    }
                    ForEach(model.uploads) { upload in
                        uploadRow(upload)
                        Divider()
                    }
                }
            }
            .frame(maxHeight: 380)
        }
        .frame(width: 320)
        .sheet(item: $details) { sync in DocumentsSyncDetailsSheet(model: model, sync: sync) }
        .accessibilityIdentifier("documents-uploads-popover")
    }

    private func uploadRow(_ upload: DocumentsUploadItem) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Text(upload.name).font(.orbitLabel.weight(.semibold)).lineLimit(1).truncationMode(.middle)
                Text("→ \(DocumentsLogic.uploadDestination(upload))").font(.orbitLabel).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                switch upload.state {
                case .uploading, .queued:
                    Button("Pause") { model.pauseUpload(upload.id) }.buttonStyle(.link)
                case .paused:
                    Button("Resume") { model.resumeUpload(upload.id) }.buttonStyle(.link)
                case .failed:
                    Button("Remove") { model.cancelUpload(upload.id) }.buttonStyle(.link)
                case .done:
                    Image(systemName: "checkmark").foregroundStyle(.green).accessibilityLabel("Uploaded")
                }
            }
            if upload.state != .done && upload.state != .failed {
                ProgressView(value: Double(upload.percent), total: 100)
            }
            Text(DocumentsLogic.uploadStatus(upload)).font(.orbitMeta)
                .foregroundStyle(upload.state == .failed ? Color.red : .secondary)
            if upload.state == .paused {
                Button("Cancel Upload") { model.cancelUpload(upload.id) }.buttonStyle(.link).font(.orbitMeta)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private func syncRow(_ sync: DocumentsSync) -> some View {
        let title = DocumentsLogic.syncTitle(sync)
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Text(title.source).font(.orbitLabel.weight(.semibold))
                Text("→ \(title.destination)").font(.orbitLabel).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                if sync.running {
                    Label(DocumentsLogic.agentSync, systemImage: "cloud")
                        .font(.orbitMeta)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Color.accentColor.opacity(0.12), in: Capsule())
                        .foregroundStyle(Color.accentColor)
                } else if sync.status == "STOPPED" {
                    Text("Stopped").font(.orbitMeta).foregroundStyle(.secondary)
                } else if DocumentsLogic.syncHasFailures(sync) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                        .accessibilityLabel("Synced with failures")
                } else {
                    Image(systemName: "checkmark").foregroundStyle(.green).accessibilityLabel("Synced")
                }
            }
            if sync.running || sync.status == "STOPPED" {
                if let fraction = DocumentsLogic.syncFraction(sync) {
                    ProgressView(value: fraction)
                } else {
                    ProgressView().progressViewStyle(.linear)
                }
            }
            HStack(spacing: 4) {
                Text(DocumentsLogic.syncStatus(sync, rate: model.syncRates[sync.id])).font(.orbitMeta)
                    .foregroundStyle(.secondary)
                if DocumentsLogic.syncHasFailures(sync) && (!sync.failed.isEmpty || sync.failedCount > 0) {
                    Button("Details…") { details = sync }.buttonStyle(.link).font(.orbitMeta)
                }
            }
            if (sync.running && sync.currentPath != nil) || sync.session != nil {
                HStack(spacing: 4) {
                    if sync.running, let path = sync.currentPath {
                        Text(path).font(.orbitMeta).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    }
                    if let session = sync.session {
                        Button(session.title) { model.openSession?(session.id) }.buttonStyle(.link).font(.orbitMeta)
                    }
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .contentShape(Rectangle())
        .onTapGesture { model.openSyncFolder(sync) }
    }
}

/// What an agent's sync could not send: each path with its error, and what to do next (01-ios frame 18).
private struct DocumentsSyncDetailsSheet: View {
    let model: DocumentsModel
    let sync: DocumentsSync
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(DocumentsLogic.syncDetailsTitle(sync)).font(.headline)
            Text(DocumentsLogic.syncDetailsSummary(sync)).font(.orbitLabel).foregroundStyle(.secondary)
            List {
                ForEach(sync.failed, id: \.self) { failure in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(failure.path).font(.orbitMono)
                        Text(failure.error).font(.orbitMeta).foregroundStyle(.secondary)
                    }
                }
            }
            .frame(minHeight: 140)
            if let more = DocumentsLogic.syncMoreFailures(sync) {
                Text(more).font(.orbitMeta).foregroundStyle(.secondary)
            }
            HStack {
                Spacer()
                if sync.destEntryId != nil {
                    Button(DocumentsLogic.openFolder(sync)) {
                        model.openSyncFolder(sync)
                        dismiss()
                    }
                }
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 480)
    }
}

// MARK: - Trash (D6, D11, D17, rule 3)

private struct DocumentsTrashColumn: View {
    let model: DocumentsModel
    @State private var deleting: DocumentsTrashGroup?
    @State private var emptying = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let error = model.trashError, model.trash == nil {
                    Text("Couldn't read Trash: \(error)").foregroundStyle(.red)
                } else if let groups = model.trash, groups.isEmpty {
                    Text(DocumentsLogic.trashEmpty).foregroundStyle(.secondary).frame(maxWidth: .infinity, minHeight: 120)
                }
                ForEach(model.trash ?? []) { group in
                    groupCard(group)
                }
            }
            .padding(12)
        }
        .overlay { if model.trash == nil && model.trashError == nil { ProgressView() } }
        .navigationTitle(DocumentsLogic.trash)
        .navigationSubtitle(model.trash.map(DocumentsLogic.trashSummary) ?? "")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Empty Trash…", role: .destructive) { emptying = true }
                    .foregroundStyle(.red)
                    .disabled(model.trash?.isEmpty ?? true)
            }
        }
        .task { await model.loadTrash() }
        .orbitConfirmation({ _ in "Delete for good?" }, isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                           presenting: deleting) { group in
            Button("Delete Immediately", role: .destructive) { Task { await model.deleteForGood(group) } }
            Button("Cancel", role: .cancel) {}
        } message: { group in
            Text(DocumentsLogic.deleteForGoodMessage(group) + (model.endsALink(group) ? " " + DocumentsLogic.endsAShareLink : ""))
        }
        .orbitConfirmation("Empty Trash?", isPresented: $emptying) {
            Button("Empty Trash", role: .destructive) { Task { await model.emptyTrash() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            let groups = model.trash ?? []
            Text(DocumentsLogic.emptyTrashMessage(groups)
                 + (groups.contains(where: model.endsALink) ? " " + DocumentsLogic.endsAShareLink : ""))
        }
        .accessibilityIdentifier("documents-trash")
    }

    private func groupCard(_ group: DocumentsTrashGroup) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: group.version == nil ? "folder.fill" : "clock.arrow.circlepath")
                    .foregroundStyle(group.version == nil ? Color.accentColor : .secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(DocumentsLogic.groupTitle(group)).font(.orbitSubtext.weight(.semibold))
                    Text(DocumentsLogic.groupSubtitle(group, writer: model.writerName(group.actor)))
                        .font(.orbitMeta).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Restore All") {
                    Task {
                        if group.version != nil { await model.restoreVersion(of: group, asCopy: false) } else { await model.restore(group) }
                    }
                }
                .controlSize(.small)
                Menu {
                    Button("Delete Immediately…", role: .destructive) { deleting = group }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .accessibilityLabel("More for the group from \(DocumentsLogic.groupTitle(group))")
            }
            .padding(10)
            Divider()
            if let version = group.version {
                itemRow(icon: DocumentsLogic.systemImage(version.entry), name: version.entry.name, note: "earlier version",
                        size: DocumentsLogic.formatSize(version.sizeBytes))
                    .contextMenu {
                        Button("Restore") { Task { await model.restoreVersion(of: group, asCopy: false) } }
                        Button("Restore as Copy") { Task { await model.restoreVersion(of: group, asCopy: true) } }
                        Divider()
                        Button("Delete Immediately…", role: .destructive) { deleting = group }
                    }
            }
            ForEach(group.items) { item in
                itemRow(icon: DocumentsLogic.systemImage(item), name: item.name, note: nil,
                        size: item.isFile ? DocumentsLogic.formatSize(item.sizeBytes) : "")
                    .contextMenu {
                        Button("Restore") { Task { await model.restore(item, of: group) } }
                        Divider()
                        Button("Delete Immediately…", role: .destructive) { deleting = group }
                    }
            }
        }
        .background(.background, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator))
    }

    private func itemRow(icon: String, name: String, note: String?, size: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon).foregroundStyle(.secondary).frame(width: 16)
            Text(name).lineLimit(1).truncationMode(.middle)
            if let note { Text("· \(note)").foregroundStyle(.secondary) }
            Spacer()
            Text(size).foregroundStyle(.secondary).monospacedDigit()
        }
        .font(.orbitLabel)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .contentShape(Rectangle())
    }
}

private struct DocumentsTrashSummary: View {
    let model: DocumentsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(DocumentsLogic.trash, systemImage: "trash").font(.headline)
            if let groups = model.trash {
                Text(DocumentsLogic.trashSummary(groups)).foregroundStyle(.secondary)
            }
            Text(DocumentsLogic.trashFoot).font(.orbitLabel).foregroundStyle(.secondary)
            Text("Right-click an item to restore it alone, or as a copy for an earlier version.")
                .font(.orbitLabel).foregroundStyle(.secondary)
            Spacer()
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Storage (D13, D19)

private struct DocumentsStorageColumn: View {
    let model: DocumentsModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let usage = model.usage {
                    total(usage)
                } else if model.storageError == nil {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 120)
                }
                if let storage = model.storage {
                    card {
                        row("Everything else", detail: DocumentsLogic.everythingElseNote,
                            value: model.usage.map { DocumentsLogic.storageSize($0.otherBytes) } ?? "")
                        Divider()
                        row("Stored files", detail: DocumentsLogic.storageFull(storage) ? DocumentsLogic.storageFullNote : nil,
                            value: DocumentsLogic.storedValue(storage))
                    }
                } else if let error = model.storageError {
                    Text("Couldn't read this: \(error)").font(.orbitLabel).foregroundStyle(.red)
                }
            }
            .padding(16)
        }
        .navigationTitle(DocumentsLogic.storage)
        .task { await model.loadStorage() }
        .accessibilityIdentifier("documents-storage")
    }

    private func total(_ usage: DocumentsUsage) -> some View {
        let bar = DocumentsLogic.storageBar(usage)
        let legend = DocumentsLogic.storageLegend(usage)
        return card {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(DocumentsLogic.storageSize(usage.totalBytes)).font(.orbitFigure)
                    Text("in this account").font(.orbitLabel).foregroundStyle(.secondary)
                }
                GeometryReader { proxy in
                    HStack(spacing: 0) {
                        Rectangle().fill(Color.accentColor).frame(width: proxy.size.width * bar.documents)
                        Rectangle().fill(Color.accentColor.opacity(0.45)).frame(width: proxy.size.width * bar.trash)
                        Rectangle().fill(Color.secondary.opacity(0.45)).frame(width: proxy.size.width * bar.other)
                        Spacer(minLength: 0)
                    }
                    .background(Color.secondary.opacity(0.15))
                    .clipShape(Capsule())
                }
                .frame(height: 10)
                HStack(spacing: 14) {
                    legendItem(legend[0], Color.accentColor)
                    legendItem(legend[1], Color.accentColor.opacity(0.45))
                    legendItem(legend[2], Color.secondary.opacity(0.45))
                }
                if let warning = DocumentsLogic.storeWarning(usage) {
                    Text(warning).font(.orbitLabel).foregroundStyle(.orange)
                }
            }
            .padding(12)
        }
    }

    private func legendItem(_ text: String, _ color: Color) -> some View {
        HStack(spacing: 4) {
            RoundedRectangle(cornerRadius: 2).fill(color).frame(width: 8, height: 8)
            Text(text).font(.orbitMeta).foregroundStyle(.secondary)
        }
    }

    private func row(_ title: String, detail: String?, value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.orbitLabel)
                if let detail { Text(detail).font(.orbitMeta).foregroundStyle(.secondary) }
            }
            Spacer()
            Text(value).font(.orbitLabel).foregroundStyle(.secondary).monospacedDigit()
        }
        .padding(10)
    }

    private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) { content() }
            .background(.background, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator))
    }
}

private struct DocumentsStorageRankings: View {
    @Environment(AppModel.self) private var app
    let model: DocumentsModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let storage = model.storage {
                    section("Largest projects", storage.projects.map { RankRow(id: $0.id, name: $0.title, bytes: $0.bytes) }) { id in
                        app.openProjectSessions(id, inColumn: true)
                    }
                    section("Largest tasks", storage.tasks.map { RankRow(id: $0.id, name: $0.title, bytes: $0.bytes) }) { id in
                        app.route(to: .task(id))
                    }
                    section("Added each week",
                            storage.weeks.reversed().map { RankRow(id: $0.id, name: DocumentsLogic.weekLabel($0.weekStart), bytes: $0.bytes) },
                            open: nil)
                }
            }
            .padding(16)
        }
    }

    private struct RankRow: Identifiable {
        let id: String
        let name: String
        let bytes: Int
    }

    @ViewBuilder
    private func section(_ title: String, _ rows: [RankRow],
                         open: ((String) -> Void)?) -> some View {
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                Text(title).font(.orbitLabel.weight(.semibold)).padding(10)
                Divider()
                ForEach(rows) { row in
                    Button { open?(row.id) } label: {
                        HStack {
                            Text(row.name).lineLimit(1)
                            Spacer()
                            Text(DocumentsLogic.storageSize(row.bytes)).foregroundStyle(.secondary).monospacedDigit()
                            if open != nil { Image(systemName: "chevron.right").foregroundStyle(.tertiary) }
                        }
                        .font(.orbitLabel)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(open == nil)
                }
            }
            .background(.background, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator))
        }
    }
}
#endif
