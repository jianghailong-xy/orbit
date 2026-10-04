import SwiftUI
import OrbitKit
import ImageIO
import UniformTypeIdentifiers
import CoreTransferable

/// Current-worktree bytes, not a Git before/after snapshot. This view deliberately owns its read
/// instead of using the transcript's attachment cache, whose files have different lifetimes.
struct WorktreeFilePreview: View {
    let worktree: WorktreeModel
    let file: SessionChangedFile
    @State private var data: Data?
    @State private var image: PlatformImage?
    @State private var dimensions: String?
    @State private var loading = true
    @State private var failure: WorktreeFileFailure?
    @State private var attempt = 0
    @State private var loadGeneration = 0
    @State private var exporting = false
    @State private var exportError: String?
    @State private var errorTitle = "Couldn't save file"
    @State private var previewTarget: ImagePreviewTarget?
    @Namespace private var previewNS

    private var fileName: String { (file.path as NSString).lastPathComponent }
    private var directory: String { (file.path as NSString).deletingLastPathComponent }
    private var extensionLabel: String { (fileName as NSString).pathExtension.uppercased() }
    private var previewImages: [PreviewImage] {
        image.map { [.inline(id: file.path, image: $0)] } ?? []
    }

    var body: some View {
        VStack(spacing: 0) {
            fileDetails
            Divider()
            if loading {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Loading file…").font(.orbitLabel).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let failure {
                unavailable(failure)
            } else if let image {
                imageContent(image)
            } else {
                unsupportedContent
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle(fileName)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                if let data {
                    share(data)
                        .labelStyle(.iconOnly)
                }
            }
        }
        .task(id: attempt) { await load() }
        .imagePreview($previewTarget, images: previewImages, ns: previewNS)
        .fileExporter(isPresented: $exporting,
                      document: WorktreeFileDocument(data: data ?? Data()),
                      contentType: .data, defaultFilename: fileName) { result in
            if case .failure(let error) = result {
                errorTitle = "Couldn't save file"
                exportError = APIClient.failureReason(error)
            }
        }
        .alert(errorTitle, isPresented: Binding(
            get: { exportError != nil }, set: { if !$0 { exportError = nil } }
        )) {
            Button("OK") { exportError = nil }
        } message: {
            Text(exportError ?? "")
        }
    }

    private var fileDetails: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !directory.isEmpty {
                Label(directory, systemImage: "folder")
                    .font(.orbitLabel).foregroundStyle(.secondary)
                    .lineLimit(2).truncationMode(.middle)
                    .textSelection(.enabled)
            }
            HStack(spacing: 8) {
                Text(extensionLabel.isEmpty ? "FILE" : extensionLabel)
                    .font(.orbitMeta.weight(.semibold))
                    .padding(.horizontal, 6).padding(.vertical, 3)
                    .background(Color.secondary.opacity(0.10), in: RoundedRectangle(cornerRadius: 4))
                if let dimensions { Text(dimensions) }
                if let data {
                    if dimensions != nil { Text("·") }
                    Text(ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file))
                }
            }
            .font(.orbitLabel).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20).padding(.vertical, 14)
    }

    private func imageContent(_ image: PlatformImage) -> some View {
        VStack(spacing: 0) {
            ScrollView {
                Image(platformImage: image)
                    .resizable().scaledToFit()
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .imageTap(openImage, sourceID: file.path, ns: previewNS)
                    .accessibilityLabel(fileName)
                    .padding(16)
            }
            .background(Color.secondary.opacity(0.06))
            Divider()
            HStack(spacing: 12) {
                Text("Scroll to explore").font(.orbitLabel).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                #if os(iOS)
                Button(action: openImage) {
                    Label("Full screen", systemImage: "arrow.up.left.and.arrow.down.right")
                        .font(.orbitLabel.weight(.semibold))
                        .padding(.horizontal, 15).frame(minHeight: 44)
                        .background(Color.accentColor.opacity(0.08), in: Capsule())
                }
                .buttonStyle(.plain).foregroundStyle(Color.accentColor)
                #else
                Button("Open image", systemImage: "arrow.up.forward.app", action: openImage)
                    .font(.orbitLabel)
                #endif
            }
            .padding(.horizontal, 20).padding(.vertical, 12)
        }
    }

    private var unsupportedContent: some View {
        VStack(spacing: 20) {
            Image(systemName: extensionLabel == "ZIP" ? "doc.zipper" : "doc")
                .font(.orbitHeroGlyph).foregroundStyle(.secondary)
            Text("No preview available").font(.orbitHeading(2).weight(.semibold))
            Text(unsupportedDescription)
                .font(.orbitSubtext).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if let data {
                Button { exporting = true } label: {
                    Label(saveTitle, systemImage: "square.and.arrow.down")
                        .font(.orbitProse.weight(.semibold))
                        .padding(.horizontal, 20).padding(.vertical, 12)
                }
                .buttonStyle(.borderedProminent).clipShape(Capsule())
                share(data).font(.orbitSubtext)
            }
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var saveTitle: String {
        #if os(iOS)
        "Save to Files"
        #else
        "Save file"
        #endif
    }

    private var unsupportedDescription: String {
        #if os(iOS)
        "This file can’t be previewed here.\nSave it to Files or open it in another app."
        #else
        "This file can’t be previewed here.\nSave it or open it in another app."
        #endif
    }

    private func unavailable(_ failure: WorktreeFileFailure) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "doc.badge.ellipsis")
                .font(.orbitHeroGlyph).foregroundStyle(.secondary)
            Text(failure.title).font(.orbitHeading(2).weight(.semibold))
            Text(failure.detail).font(.orbitSubtext).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if failure.canRetry {
                Button("Retry", systemImage: "arrow.clockwise") { attempt += 1 }
                    .font(.orbitLabel).buttonStyle(.bordered)
            }
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func share(_ data: Data) -> some View {
        SwiftUI.ShareLink(item: WorktreeSharedFile(data: data, name: fileName),
                          preview: SharePreview(fileName)) {
            Label("Share…", systemImage: "square.and.arrow.up")
        }
    }

    private func openImage() {
        #if os(iOS)
        previewTarget = ImagePreviewTarget(index: 0, id: file.path)
        #else
        if let data, !FileHandoff.deliver(data, named: fileName) {
            errorTitle = "Couldn't open image"
            exportError = "The image could not be opened."
        }
        #endif
    }

    @MainActor
    private func load() async {
        loadGeneration += 1
        let generation = loadGeneration
        data = nil
        image = nil
        dimensions = nil
        failure = nil
        loading = true
        defer { if generation == loadGeneration { loading = false } }
        guard !file.status.uppercased().hasPrefix("D") else {
            failure = .deleted
            return
        }
        do {
            let bytes = try await worktree.readFile(path: file.path)
            try Task.checkCancellation()
            guard generation == loadGeneration else { return }
            data = bytes
            image = PlatformImage(data: bytes)
            if image == nil, AttachmentLink.looksLikeImage(path: file.path) {
                failure = .invalidImage
            }
            if let source = CGImageSourceCreateWithData(bytes as CFData, nil),
               let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
               let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
               let height = properties[kCGImagePropertyPixelHeight] as? NSNumber {
                dimensions = "\(width.intValue) × \(height.intValue)"
            }
        } catch {
            guard !Task.isCancelled, generation == loadGeneration else { return }
            failure = .from(error)
        }
    }
}

private struct WorktreeFileDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.data] }
    let data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws {
        data = configuration.file.regularFileContents ?? Data()
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}

/// Materialize bytes only when the share sheet requests them. Each transfer gets its own directory,
/// preserving the actual filename without replacing another open preview's file of the same name.
private struct WorktreeSharedFile: Transferable {
    let data: Data
    let name: String
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(exportedContentType: .data) { item in
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("orbit-worktree-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent(item.name)
            try item.data.write(to: url, options: .atomic)
            return SentTransferredFile(url)
        }
    }
}
