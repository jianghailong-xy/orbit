import SwiftUI
import OrbitKit
#if os(macOS)
import AppKit
import CoreTransferable
import UniformTypeIdentifiers
#endif

// What a version of evidence cites, on its card (docs/orbit-files-design.md §2.6): the file area under
// the standard, the Evidence files page it opens, and the viewer a thumbnail opens. Web's
// `EvidenceFiles.tsx`. Every word and every reading of a row is `EvidenceFiles`, in OrbitKit.
//
// ONLY A RASTER IMAGE IS EVER DRAWN. Every byte here was written by whoever submitted the evidence.
// `EvidenceFiles.isPicture` is the one test for what is asked for as a picture, and everything else, SVG
// and HTML included, is a tile that saves or shares the file. Nothing here opens a file or renders one in
// a web view.

/// The version a page is about. The page reads its list from the console, by this address.
struct EvidenceFilesTarget: Identifiable {
    let taskID: String
    let revision: String
    /// The summaries of its reports are read off these: they need no second request.
    let citations: [EvidenceDecisionCitation]

    var id: String { "\(taskID)#\(revision)" }
}

private struct OpenEvidenceFilesKey: EnvironmentKey {
    static let defaultValue: (EvidenceFilesTarget) -> Void = { _ in }
}

extension EnvironmentValues {
    /// Opens the Evidence files page. Hosted by the console and by the review sheet, the way a receipt's
    /// sheet is: a recycled transcript row cannot dismiss it.
    var openEvidenceFiles: (EvidenceFilesTarget) -> Void {
        get { self[OpenEvidenceFilesKey.self] }
        set { self[OpenEvidenceFilesKey.self] = newValue }
    }
}

// MARK: - a picture, as far as this surface is concerned

private extension AttachmentImageStore {
    /// A listed picture's decoded image, when what its bytes decoded to is a bitmap. The type is only
    /// what the uploader said, and a Mac's `NSImage` also draws SVG and PDF from bytes labelled as
    /// anything.
    func evidencePicture(_ id: String) -> PlatformImage? {
        guard let image = image(for: id) else { return nil }
        #if os(macOS)
        return image.representations.contains { $0 is NSBitmapImageRep } ? image : nil
        #else
        return image
        #endif
    }

    /// Whether a file listed as a picture turned out not to be one: it did not decode, or the server
    /// would not serve it, or it decoded to something other than a bitmap.
    func isNotPicture(_ id: String) -> Bool {
        isResolved(id) && evidencePicture(id) == nil
    }
}

/// A picture's size in pixels, for a file the server has none for: a folder's rows do not record it.
private func pixelSize(_ image: PlatformImage) -> (width: Int, height: Int) {
    #if os(iOS)
    return (Int(image.size.width * image.scale), Int(image.size.height * image.scale))
    #else
    let rep = image.representations.first
    return (rep?.pixelsWide ?? Int(image.size.width), rep?.pixelsHigh ?? Int(image.size.height))
    #endif
}

// MARK: - the tile

/// What fills a tile, on the card and on the page: the picture from its top, where a page keeps what it
/// is about; the dashed grey that takes its place once it has expired; or the file's kind.
private struct EvidenceFileTile: View {
    let file: EvidenceFile
    let store: AttachmentImageStore

    private static let shape = RoundedRectangle(cornerRadius: 8)

    var body: some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay(alignment: .top) { face }
            .clipShape(Self.shape)
            .overlay {
                if !EvidenceFiles.isGone(file) { Self.shape.strokeBorder(.primary.opacity(0.08)) }
            }
    }

    @ViewBuilder private var face: some View {
        if EvidenceFiles.isGone(file) {
            expired
        } else if EvidenceFiles.isPicture(file) {
            picture.loadsAttachmentImage(file.id, from: store)
        } else {
            kind
        }
    }

    @ViewBuilder private var picture: some View {
        if let image = store.evidencePicture(file.id) {
            Image(platformImage: image)
                .resizable()
                .scaledToFill()
        } else if store.isNotPicture(file.id) {
            kind
        } else {
            Self.shape.fill(.quaternary)
        }
    }

    private var kind: some View {
        Self.shape.fill(.quaternary)
            .overlay {
                Text(EvidenceFiles.kind(file))
                    .font(.orbitMeta.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .minimumScaleFactor(0.7)
                    .padding(4)
            }
    }

    /// Grey with a dashed outline, the board's: no date when the row went and took it along.
    private var expired: some View {
        Self.shape.fill(.quaternary)
            .overlay {
                Self.shape.strokeBorder(.secondary.opacity(0.6), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
            }
            .overlay {
                VStack(spacing: 0) {
                    Text(EvidenceFiles.fileExpired)
                    if let at = file.expiredAt { Text(EvidenceFiles.expiryDate(at)) }
                }
                .font(.orbitMeta)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .minimumScaleFactor(0.7)
                .padding(4)
            }
    }
}

// MARK: - a report

private struct EvidenceReportMark: View {
    let report: EvidenceTestReport
    /// Nothing to celebrate on a list that has lost its bytes: the mark goes grey.
    let quiet: Bool

    var body: some View {
        Image(systemName: report.failed > 0 ? "xmark.circle.fill" : "checkmark.circle.fill")
            .foregroundStyle(report.failed > 0 ? Color.red : quiet ? Color.secondary : Color.green)
            .accessibilityHidden(true)
    }
}

/// The report's line on the card, with the failed cases it can name. The page has the rest.
private struct EvidenceReportLine: View {
    let report: EvidenceTestReport
    let quiet: Bool

    var body: some View {
        let failed = EvidenceFiles.reportNamesOnCard(report)
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                EvidenceReportMark(report: report, quiet: quiet)
                Text("\(Text(EvidenceFiles.reportFormat(report)).fontWeight(.semibold).foregroundColor(.primary)) · \(EvidenceFiles.reportCounts(report))")
                    .foregroundStyle(.secondary)
            }
            ForEach(Array(failed.names.enumerated()), id: \.offset) { _, name in
                Text(name).lineLimit(1).truncationMode(.middle).padding(.leading, 18)
            }
            if failed.rest > 0 {
                Text(EvidenceFiles.reportNamesMore(failed.rest))
                    .foregroundStyle(.secondary).padding(.leading, 18)
            }
        }
        .font(.orbitLabel)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One report at the top of the page, opening into the cases it failed and skipped.
private struct EvidenceReportBlock: View {
    let report: EvidenceTestReport
    let quiet: Bool
    @State private var open = false

    private var lists: [EvidenceFiles.ReportList] { EvidenceFiles.reportLists(report) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if lists.isEmpty {
                head
            } else {
                Button {
                    PlatformHaptics.tap()
                    open.toggle()
                } label: {
                    head.contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(.isButton)
            }
            if open {
                ForEach(lists) { list in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(EvidenceFiles.reportList(list.word, count: list.count))
                            .font(.orbitMeta.weight(.semibold)).foregroundStyle(.secondary)
                        ForEach(Array(list.names.enumerated()), id: \.offset) { _, name in
                            Text(name).font(.orbitLabel)
                        }
                        // The server keeps twenty names of each: the count is the whole of it.
                        if list.count > list.names.count {
                            Text(EvidenceFiles.reportNamesMore(list.count - list.names.count))
                                .font(.orbitLabel).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.leading, 26)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: ApprovalMetrics.rowRadius))
    }

    private var head: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            EvidenceReportMark(report: report, quiet: quiet).font(.orbitProse)
            VStack(alignment: .leading, spacing: 2) {
                Text(EvidenceFiles.reportTitle(report)).font(.orbitProse.weight(.semibold))
                Text(EvidenceFiles.reportFacts(report)).font(.orbitLabel).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if !lists.isEmpty {
                Image(systemName: open ? "chevron.down" : "chevron.right")
                    .font(.orbitMeta).foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
        }
    }
}

// MARK: - the file area

/// Under the standard on the card: a heading, up to four thumbnails and what a report said. One button,
/// because what it does is one thing: a thumbnail opens the viewer on the page, where the whole set can
/// be paged.
struct EvidenceFilesArea: View {
    let console: ConsoleModel
    let taskID: String
    let revision: String
    let citations: [EvidenceDecisionCitation]
    @Environment(\.openEvidenceFiles) private var openFiles

    /// The board's size on a phone, and web's in a window.
    #if os(iOS)
    private static let side: CGFloat = 56
    #else
    private static let side: CGFloat = 64
    #endif

    var body: some View {
        let read = console.evidenceFileRead(taskID: taskID, revision: revision)
        let quiet = read.list.map(EvidenceFiles.allGone) ?? false
        Button {
            PlatformHaptics.tap()
            openFiles(EvidenceFilesTarget(taskID: taskID, revision: revision, citations: citations))
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                Text(read.list.map { EvidenceFiles.headline($0) } ?? EvidenceFiles.heading)
                    .font(.orbitLabel.bold()).foregroundStyle(.secondary)
                if let list = read.list {
                    tiles(list)
                } else {
                    Text(read.unread ? EvidenceFiles.unread : EvidenceFiles.loading)
                        .font(.orbitLabel).foregroundStyle(.secondary)
                }
                ForEach(Array(EvidenceFiles.testReports(citations).enumerated()), id: \.offset) { _, report in
                    EvidenceReportLine(report: report, quiet: quiet)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // The card and the page read one list, kept on the console: a List re-creates its rows as they
        // scroll, and a read that did not come back gets another go when the row returns.
        .task(id: "\(taskID)#\(revision)") {
            await console.readEvidenceFiles(taskID: taskID, revision: revision)
        }
    }

    private func tiles(_ list: EvidenceFileList) -> some View {
        let onCard = EvidenceFiles.onCard(list)
        return FlowLayout(spacing: 8) {
            ForEach(onCard.shown) { file in
                EvidenceFileTile(file: file, store: console.attachments)
                    .frame(width: Self.side, height: Self.side)
            }
            if onCard.rest > 0 {
                RoundedRectangle(cornerRadius: 8).fill(.quaternary)
                    .overlay {
                        Text(EvidenceFiles.more(onCard.rest))
                            .font(.orbitLabel.weight(.semibold)).foregroundStyle(.secondary)
                    }
                    .frame(width: Self.side, height: Self.side)
            }
        }
    }
}

// MARK: - handing a file on

/// What saving or sharing one file does, for the page's tiles and the viewer. On a phone it is the share
/// sheet, which is where Save to Files is. On a Mac it is the save panel: `FileHandoff` would open a file
/// or show it in a temporary folder, and neither keeps it where the reader wants it.
@MainActor
private enum EvidenceFileHandoff {
    /// False when nothing came of it, which the caller says out loud.
    static func save(_ file: EvidenceFile, store: AttachmentImageStore) async -> Bool {
        guard let data = await store.data(for: file.id), !data.isEmpty else { return false }
        let name = EvidenceFiles.saveName(file)
        #if os(iOS)
        return FileHandoff.deliver(data, named: name)
        #else
        let panel = NSSavePanel()
        panel.nameFieldStringValue = FileHandoff.safeName(name)
        guard panel.runModal() == .OK, let url = panel.url else { return true }
        do {
            try DownloadMark.write(data, to: url)
            return true
        } catch {
            return false
        }
        #endif
    }
}

#if os(macOS)
/// A Mac's share control, whose bytes are read only when a destination asks for them. Marked like every
/// file this app writes out of somebody else's bytes.
private struct EvidenceSharedFile: Transferable {
    let name: String
    let read: @Sendable () async -> Data?

    private struct Unread: Error {}

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(exportedContentType: .data) { item in
            guard let data = await item.read() else { throw Unread() }
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("orbit-evidence-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent(FileHandoff.safeName(item.name))
            try DownloadMark.write(data, to: url)
            return SentTransferredFile(url)
        }
    }
}
#endif

// MARK: - the page

/// Which picture the viewer opens on, among the ones it pages. A snapshot: a page's tile can fail while
/// the viewer is up, and the pager is built around one list.
private struct EvidenceViewerTarget: Identifiable {
    let pictures: [EvidenceFile]
    let index: Int

    var id: String { pictures[index].id }
}

/// The page: which version and how much of it, what its reports said, and every file by the folder it
/// was uploaded in. Presented by whoever hosts `openEvidenceFiles`.
struct EvidenceFilesPage: View {
    @Environment(\.dismiss) private var dismiss
    let console: ConsoleModel
    let target: EvidenceFilesTarget
    @State private var viewing: EvidenceViewerTarget?
    @State private var saveFailed = false

    /// Three tiles across a phone at any width it comes in, as many as fit in a window.
    private static let columns = [GridItem(.adaptive(minimum: 104), spacing: 8)]

    private var read: EvidenceFileRead {
        console.evidenceFileRead(taskID: target.taskID, revision: target.revision)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                content(read)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            }
            .navigationTitle(EvidenceFiles.title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { ApprovalReviewCloseButton { dismiss() } }
        }
        .task { await console.readEvidenceFiles(taskID: target.taskID, revision: target.revision) }
        .alert(EvidenceFiles.downloadFailed, isPresented: $saveFailed) {
            Button("OK") { saveFailed = false }
        }
        #if os(iOS)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .fullScreenCover(item: $viewing) { viewer($0) }
        #else
        .frame(minWidth: 520, minHeight: 560)
        .sheet(item: $viewing) { viewer($0) }
        #endif
    }

    private func viewer(_ target: EvidenceViewerTarget) -> some View {
        EvidenceFileViewer(pictures: target.pictures, startIndex: target.index, store: console.attachments)
    }

    // Lazy all the way down, so a folder of a thousand asks only for what is on screen.
    private func content(_ read: EvidenceFileRead) -> some View {
        LazyVStack(alignment: .leading, spacing: 16) {
            versionLine(read.list)
            let reports = EvidenceFiles.testReports(target.citations)
            let quiet = read.list.map(EvidenceFiles.allGone) ?? false
            ForEach(Array(reports.enumerated()), id: \.offset) { _, report in
                EvidenceReportBlock(report: report, quiet: quiet)
            }
            if let list = read.list {
                ForEach(EvidenceFiles.groups(list.files)) { group in
                    groupView(group, in: list)
                }
                if list.nextOffset != nil { showMore(list, read) }
            } else {
                Text(read.unread ? EvidenceFiles.unread : EvidenceFiles.loading)
                    .font(.orbitLabel).foregroundStyle(.secondary)
            }
        }
    }

    private func versionLine(_ list: EvidenceFileList?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            let revision = EvidenceFiles.revisionLine(target.revision)
            Text(list.map { "\(revision) · \(EvidenceDecisions.receiptTime($0.submittedAt))" } ?? revision)
            Spacer(minLength: 0)
            if let list { Text(EvidenceFiles.count(list)) }
        }
        .font(.orbitLabel).foregroundStyle(.secondary)
    }

    private func groupView(_ group: EvidenceFiles.Group, in list: EvidenceFileList) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(group.name).font(.orbitLabel.weight(.semibold)).foregroundStyle(.secondary)
                Text("\(group.files.count)").font(.orbitLabel).foregroundStyle(.tertiary)
            }
            LazyVGrid(columns: Self.columns, alignment: .leading, spacing: 8) {
                ForEach(group.files) { file in
                    EvidencePageTile(file: file, store: console.attachments,
                                     onView: { view($0, in: list) }, onSave: save)
                }
            }
        }
    }

    private func showMore(_ list: EvidenceFileList, _ read: EvidenceFileRead) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(EvidenceFiles.showing(list.files.count, of: list.fileCount))
                    .font(.orbitLabel).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                Button(EvidenceFiles.showMore) {
                    Task {
                        await console.readMoreEvidenceFiles(taskID: target.taskID, revision: target.revision)
                    }
                }
                .font(.orbitLabel)
                .disabled(read.reading)
            }
            if read.unread {
                Text(EvidenceFiles.unread).font(.orbitLabel).foregroundStyle(.secondary)
            }
        }
    }

    /// The viewer pages the pictures in the order the page shows them. One already known not to draw has
    /// left the set, and shows its kind here.
    private func view(_ file: EvidenceFile, in list: EvidenceFileList) {
        let pictures = EvidenceFiles.pictures(list.files).filter { !console.attachments.isNotPicture($0.id) }
        guard let index = pictures.firstIndex(of: file) else { return }
        PlatformHaptics.tap()
        viewing = EvidenceViewerTarget(pictures: pictures, index: index)
    }

    private func save(_ file: EvidenceFile) {
        PlatformHaptics.tap()
        Task {
            if await !EvidenceFileHandoff.save(file, store: console.attachments) { saveFailed = true }
        }
    }
}

/// A tile on the page. A picture opens the viewer and any other file with bytes is saved, because neither
/// an SVG nor a page may be opened. An expired one does neither, and says what it was.
private struct EvidencePageTile: View {
    let file: EvidenceFile
    let store: AttachmentImageStore
    let onView: (EvidenceFile) -> Void
    let onSave: (EvidenceFile) -> Void

    var body: some View {
        let name = EvidenceFiles.name(file)
        let picture = EvidenceFiles.isPicture(file) && !store.isNotPicture(file.id)
        VStack(alignment: .leading, spacing: 4) {
            if EvidenceFiles.isGone(file) {
                EvidenceFileTile(file: file, store: store)
            } else {
                Button {
                    if picture { onView(file) } else { onSave(file) }
                } label: {
                    EvidenceFileTile(file: file, store: store).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(picture ? name : EvidenceFiles.downloadName(name))
                .help(picture ? name : EvidenceFiles.downloadName(name))
            }
            if !picture {
                VStack(alignment: .leading, spacing: 1) {
                    Text(EvidenceFiles.saveName(file)).lineLimit(1).truncationMode(.middle)
                    Text(EvidenceFiles.facts(file)).foregroundStyle(.secondary)
                }
                .font(.orbitMeta)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

// MARK: - the viewer

/// The pictures of a version, one at a time: which one of how many, then under it its path, size,
/// dimensions and the first eight of its sha256, with the way to keep it at the corner.
///
/// On a phone the paging is `ImagePagerView`, so a swipe, a pinch, a drag down and the long press behave
/// as in every other viewer of the app. A Mac has no such pager (its thumbnails open nothing elsewhere):
/// it pages by the arrows, on screen or on the keyboard.
private struct EvidenceFileViewer: View {
    @Environment(\.dismiss) private var dismiss
    let pictures: [EvidenceFile]
    let store: AttachmentImageStore
    private let startIndex: Int
    @State private var index: Int
    @State private var handingOn = false
    @State private var saveFailed = false

    /// A dot a picture while they fit a line and mean something. The position says it either way.
    private static let dotsUpTo = 12

    init(pictures: [EvidenceFile], startIndex: Int, store: AttachmentImageStore) {
        self.pictures = pictures
        self.startIndex = startIndex
        self.store = store
        _index = State(initialValue: startIndex)
    }

    private var file: EvidenceFile { pictures[index] }

    var body: some View {
        VStack(spacing: 0) {
            bar
            pager.frame(maxWidth: .infinity, maxHeight: .infinity)
            dots
            caption
        }
        .background(Color.black.ignoresSafeArea())
        .environment(\.colorScheme, .dark)
        .alert(EvidenceFiles.downloadFailed, isPresented: $saveFailed) {
            Button("OK") { saveFailed = false }
        }
        #if os(macOS)
        .frame(minWidth: 720, minHeight: 560)
        #endif
    }

    private var bar: some View {
        ZStack {
            Text(EvidenceFiles.position(index + 1, of: pictures.count))
                .font(.orbitProse.weight(.semibold)).monospacedDigit()
                .foregroundStyle(.white)
            HStack {
                Button("Done") { dismiss() }
                    .buttonStyle(.plain)
                    .font(.orbitProse)
                    .foregroundStyle(Color.accentColor)
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
    }

    @ViewBuilder private var pager: some View {
        #if os(iOS)
        ImagePagerView(images: pictures.map { .attachment(id: $0.id, attachmentID: $0.id) },
                       startIndex: startIndex, onPage: { index = $0 })
            .environment(store)
        #else
        ZStack {
            Group {
                if let image = store.evidencePicture(file.id) {
                    Image(platformImage: image).resizable().scaledToFit()
                } else if store.isNotPicture(file.id) {
                    Image(systemName: "photo").font(.orbitHeroGlyph).foregroundStyle(.white.opacity(0.4))
                } else {
                    ProgressView()
                }
            }
            .loadsAttachmentImage(file.id, from: store)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            HStack {
                arrow("chevron.left", key: .leftArrow, to: index - 1)
                Spacer(minLength: 0)
                arrow("chevron.right", key: .rightArrow, to: index + 1)
            }
            .padding(.horizontal, 12)
        }
        #endif
    }

    #if os(macOS)
    private func arrow(_ symbol: String, key: KeyEquivalent, to page: Int) -> some View {
        Button { index = page } label: {
            Image(systemName: symbol)
                .font(.orbitHeading(2)).foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(.white.opacity(0.16), in: Circle())
        }
        .buttonStyle(.plain)
        .keyboardShortcut(key, modifiers: [])
        .disabled(!pictures.indices.contains(page))
        .opacity(pictures.indices.contains(page) ? 1 : 0.3)
    }
    #endif

    @ViewBuilder private var dots: some View {
        if pictures.count > 1, pictures.count <= Self.dotsUpTo {
            HStack(spacing: 8) {
                ForEach(pictures.indices, id: \.self) { page in
                    Circle()
                        .fill(page == index ? Color.white : Color.white.opacity(0.3))
                        .frame(width: 7, height: 7)
                }
            }
            .padding(.vertical, 12)
            .accessibilityHidden(true)
        }
    }

    /// The row's size when it recorded one, the picture's own when the bytes are in.
    private var facts: String {
        if let width = file.width, let height = file.height {
            return EvidenceFiles.facts(file, width: width, height: height)
        }
        let size = store.evidencePicture(file.id).map(pixelSize)
        return EvidenceFiles.facts(file, width: size?.width, height: size?.height)
    }

    private var caption: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(EvidenceFiles.name(file))
                    .font(.orbitMono).foregroundStyle(.white)
                    .lineLimit(2).truncationMode(.middle)
                Text(facts).font(.orbitLabel).foregroundStyle(.white.opacity(0.6))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            keep
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
    }

    @ViewBuilder private var keep: some View {
        #if os(iOS)
        keepButton("Share…", symbol: "square.and.arrow.up")
        #else
        keepButton(EvidenceFiles.download, symbol: "square.and.arrow.down")
        let shown = file
        let store = self.store
        SwiftUI.ShareLink(item: EvidenceSharedFile(name: EvidenceFiles.saveName(shown),
                                                   read: { await store.data(for: shown.id) }),
                          preview: SharePreview(EvidenceFiles.saveName(shown))) {
            Image(systemName: "square.and.arrow.up").font(.orbitControlGlyph).foregroundStyle(.white)
        }
        .buttonStyle(.plain)
        .help("Share…")
        #endif
    }

    private func keepButton(_ label: String, symbol: String) -> some View {
        Button {
            let shown = file
            handingOn = true
            Task {
                if await !EvidenceFileHandoff.save(shown, store: store) { saveFailed = true }
                handingOn = false
            }
        } label: {
            Group {
                if handingOn {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: symbol).font(.orbitControlGlyph).foregroundStyle(.white)
                }
            }
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(handingOn)
        .accessibilityLabel(label)
        .help(label)
    }
}
