import SwiftUI
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

// Handing a file on to the platform. The app fetches bytes it has no reader for — a document an
// agent wrote, an image the runner is holding behind a path — and the two platforms want different
// things done with them: iOS shows the share sheet (Save to Files, another app, AirDrop), macOS
// opens the file in whichever application owns it when that application can only show it, and
// otherwise shows the file in Finder.
//
// Three surfaces do this now, and all three answer the same kind of tap: a chip for a path on the
// runner that the artifact route can serve, a link to that same kind of file in prose, and a file
// the user attached to a message and tapped. The bytes go into the temporary directory under a name
// the caller supplies, because neither the API nor the artifact route serves one, and an
// extension-less blob gives the share sheet nothing to offer.
//
// Those bytes and that name came from somebody else: an agent, or whoever shared the file. On a Mac
// the application that owns a file can do far more than show it, so a tap opens only what is on the
// list below. Everything else is shown in Finder, and every file written here carries the mark a
// download carries, so macOS still gets its say when somebody opens it from there.

enum FileHandoff {
    #if os(macOS)
    /// The extensions a Mac opens from a tap: pictures, PDFs and plain text, whose applications show
    /// the bytes and do nothing else with them. The same idea as the list in the server's
    /// `user-file-response.ts` and the web's `userFile.ts`, and anything not named here is shown in
    /// Finder. Spelled out rather than asked of `UTType`, whose conformance is too wide to decide
    /// this by: a script conforms to plain text there, and SVG to image.
    private static let opensFromATap: Set<String> = [
        "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "avif", "bmp", "tif", "tiff", "ico",
        "pdf",
        "txt", "text", "md", "markdown", "log",
    ]
    #endif

    /// True once the platform has taken the file. False means nothing came of the tap — the caller
    /// says so out loud, since silence is the whole complaint this exists to answer.
    @MainActor
    @discardableResult
    static func deliver(_ data: Data, named name: String, app: AppModel? = nil) -> Bool {
        guard !data.isEmpty else { return false }
        // A folder of their own: Finder shows it to the reader, and a name somebody else chose cannot
        // land on a file another application keeps in the temporary directory.
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("Orbit Files", isDirectory: true)
        let file = folder.appendingPathComponent(safeName(name))
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try data.write(to: file, options: .atomic)
            #if os(macOS)
            try markAsDownloaded(file)
            #endif
        } catch {
            return false
        }
        #if os(iOS)
        guard let host = frontmostViewController() else { return false }
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        anchorAtBottom(sheet.popoverPresentationController, of: host.view)
        host.present(sheet, animated: true)
        return true
        #elseif os(macOS)
        guard opensFromATap.contains(file.pathExtension.lowercased()) else {
            NSWorkspace.shared.activateFileViewerSelecting([file])
            app?.showToast("Shown in Finder", subtitle: file.lastPathComponent,
                           detail: "Orbit opens only images, PDFs and plain text. Check this file before you open it.",
                           tone: .info)
            return true
        }
        return NSWorkspace.shared.open(file)
        #endif
    }

    #if os(macOS)
    /// The quarantine mark, which every browser leaves on a download: macOS checks a marked file before
    /// anything in it runs, however it comes to be opened.
    private static func markAsDownloaded(_ file: URL) throws {
        var file = file
        var values = URLResourceValues()
        values.quarantineProperties = [
            kLSQuarantineTypeKey as String: kLSQuarantineTypeOtherDownload as String,
            kLSQuarantineAgentNameKey as String: "Orbit",
        ]
        try file.setResourceValues(values)
    }
    #endif

    /// The leaf of whatever name arrives, so a path can never write outside the temporary directory —
    /// and never an empty one, which would name the directory itself.
    private static func safeName(_ name: String) -> String {
        let leaf = name.split(separator: "/").last.map(String.init) ?? ""
        let safe = leaf.replacingOccurrences(of: "\n", with: "").trimmingCharacters(in: .whitespaces)
        return safe.isEmpty ? "orbit-file" : safe
    }
}
