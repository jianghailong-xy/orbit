import Foundation
#if os(macOS)
import CoreServices
#endif

/// The quarantine mark, which every browser leaves on a download: macOS checks a marked file before
/// anything in it runs, however it comes to be opened.
///
/// Whatever the app writes out of bytes and a name that came from somebody else carries it, and a file
/// that cannot be marked goes no further: it is taken back, because where it was written a double-click
/// would run it unchecked. iOS has no such mark, and its share sheet is the system's own.
///
/// Here rather than beside the views that write those files so that `swift test` on a Mac can put a mark
/// on a real file and read it back (`DownloadMarkTests`): OrbitApp has no test target.
public enum DownloadMark {
    public static func apply(to file: URL) throws {
        #if os(macOS)
        var file = file
        var values = URLResourceValues()
        values.quarantineProperties = [
            kLSQuarantineTypeKey as String: kLSQuarantineTypeOtherDownload as String,
            kLSQuarantineAgentNameKey as String: "Orbit",
        ]
        try file.setResourceValues(values)
        #endif
    }

    /// Writes the bytes and marks the file.
    public static func write(_ data: Data, to file: URL) throws {
        try data.write(to: file, options: .atomic)
        try markOrTakeBack(file)
    }

    /// What a save panel's write comes to: the file it wrote, marked. Throws what the panel failed with,
    /// or what stopped the mark.
    public static func finishSaving(_ saved: Result<URL, Error>) throws {
        try markOrTakeBack(saved.get())
    }

    static func markOrTakeBack(_ file: URL, mark: (URL) throws -> Void = apply(to:)) throws {
        do {
            try mark(file)
        } catch {
            try? FileManager.default.removeItem(at: file)
            throw error
        }
    }
}
