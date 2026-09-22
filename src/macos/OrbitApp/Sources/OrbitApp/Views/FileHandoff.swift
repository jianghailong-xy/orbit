import SwiftUI
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

// Handing a file on to the platform. The app fetches bytes it has no reader for — a document an
// agent wrote, an image the runner is holding behind a path — and the two platforms want different
// things done with them: iOS shows the share sheet (Save to Files, another app, AirDrop), macOS
// opens the file in whichever application owns it.
//
// Three surfaces do this now, and all three answer the same kind of tap: a chip for a path on the
// runner that the artifact route can serve, a link to that same kind of file in prose, and a file
// the user attached to a message and tapped. The bytes go into the temporary directory under a name
// the caller supplies, because neither the API nor the artifact route serves one, and an
// extension-less blob gives the share sheet nothing to offer.

enum FileHandoff {
    /// True once the platform has taken the file. False means nothing came of the tap — the caller
    /// says so out loud, since silence is the whole complaint this exists to answer.
    @MainActor
    @discardableResult
    static func deliver(_ data: Data, named name: String) -> Bool {
        guard !data.isEmpty else { return false }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(safeName(name))
        do {
            try data.write(to: file, options: .atomic)
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
        return NSWorkspace.shared.open(file)
        #endif
    }

    /// The leaf of whatever name arrives, so a path can never write outside the temporary directory —
    /// and never an empty one, which would name the directory itself.
    private static func safeName(_ name: String) -> String {
        let leaf = name.split(separator: "/").last.map(String.init) ?? ""
        let safe = leaf.replacingOccurrences(of: "\n", with: "").trimmingCharacters(in: .whitespaces)
        return safe.isEmpty ? "orbit-file" : safe
    }
}
