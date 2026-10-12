import Foundation

/// Getting the runner onto this Mac the way `orbit upgrade` gets it (runner-go selfupdate.go): read
/// `<instance>/dl/version.json`, download `orbit-<platform>.gz` beside it, and check that file's
/// bytes against the sha256 the manifest publishes for the platform before anything is unpacked
/// (docs/release-process.md, "Runner manifest and asset digests"). The app fetches through
/// `APIClient.downloadRunner`; what it decides with is here and unit-tested.
///
/// One difference from the runner: a manifest that publishes no digest for this platform (a control
/// plane older than asset digests) installs nothing. A runner updating itself still has a working
/// binary to keep; an enrollment has none, and would be starting from bytes nobody vouched for.
public enum RunnerDownload {
    /// The /dl platform key — runner-go's `platformKey` on darwin — for this Mac's CPU as
    /// `uname -m` names it; nil for a CPU /dl has no build for.
    public static func platformKey(machine: String) -> String? {
        switch machine {
        case "arm64", "arm64e": return "darwin-arm64"
        case "x86_64": return "darwin-x64"
        default: return nil
        }
    }

    /// The file under `<instance>/dl/` that holds the runner for `platformKey`.
    public static func assetName(platformKey: String) -> String { "orbit-\(platformKey).gz" }

    /// The sha256 version.json publishes for `platformKey`'s asset, lowercased. `manifestURL` is
    /// only for the error, so it can say which manifest had nothing to check against.
    public static func expectedSHA256(manifest: Data, platformKey: String, manifestURL: URL) throws -> String {
        guard let decoded = try? JSONDecoder().decode(Manifest.self, from: manifest) else {
            throw RunnerDownloadError.unreadableManifest(manifestURL)
        }
        let digest = (decoded.assets?[platformKey]?.sha256 ?? "").lowercased()
        guard digest.count == 64, digest.allSatisfy({ "0123456789abcdef".contains($0) }) else {
            throw RunnerDownloadError.noDigest(manifestURL, platformKey: platformKey)
        }
        return digest
    }

    /// Throws unless `asset` — the downloaded file named `name` — hashes to `expected`.
    public static func verify(_ asset: Data, sha256 expected: String, name: String) throws {
        let actual = sha256Hex(asset)
        guard actual == expected.lowercased() else {
            throw RunnerDownloadError.digestMismatch(asset: name, expected: expected.lowercased(), actual: actual)
        }
    }

    #if os(macOS) || os(Linux)
    /// Unpacks a verified `orbit-<platform>.gz` to `binFile`, executable. The binary is written
    /// beside `binFile` and renamed over it, so nothing half-written is ever at `binFile` and a
    /// runner still running the old file keeps it. Unpacked by the system gzip, as install.sh does.
    public static func unpack(_ gzip: Data, to binFile: URL) throws {
        let fm = FileManager.default
        let dir = binFile.deletingLastPathComponent()
        let pid = ProcessInfo.processInfo.processIdentifier
        let archive = dir.appendingPathComponent(".\(binFile.lastPathComponent)-download-\(pid).gz")
        let staged = dir.appendingPathComponent("\(binFile.lastPathComponent).new-\(pid)")
        defer {
            try? fm.removeItem(at: archive)
            try? fm.removeItem(at: staged)
        }
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        try gzip.write(to: archive)
        guard fm.createFile(atPath: staged.path, contents: nil) else {
            throw RunnerDownloadError.unpackFailed("couldn't create \(staged.path)")
        }
        let output = try FileHandle(forWritingTo: staged)
        defer { try? output.close() }
        let errors = Pipe()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/gzip")
        process.arguments = ["-dc", archive.path]
        process.standardOutput = output
        process.standardError = errors
        try process.run()
        let stderr = errors.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let detail = String(decoding: stderr, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            throw RunnerDownloadError.unpackFailed(detail.isEmpty ? "gzip exited \(process.terminationStatus)" : detail)
        }
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: staged.path)
        guard rename(staged.path, binFile.path) == 0 else {
            throw RunnerDownloadError.unpackFailed("couldn't replace \(binFile.path): \(String(cString: strerror(errno)))")
        }
    }
    #endif

    /// SHA-256 (FIPS 180-4) as lowercase hex. Written out rather than taken from CryptoKit, which
    /// Linux doesn't have, so the code the Linux test run checks is the code the app runs.
    public static func sha256Hex(_ data: Data) -> String {
        var hash: [UInt32] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                              0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
        var message = [UInt8](data)
        let bitCount = UInt64(message.count) * 8
        message.append(0x80)
        message.append(contentsOf: [UInt8](repeating: 0, count: (64 + 56 - message.count % 64) % 64))
        for shift in stride(from: 56, through: 0, by: -8) {
            message.append(UInt8(truncatingIfNeeded: bitCount >> UInt64(shift)))
        }
        var w = [UInt32](repeating: 0, count: 64)
        for block in stride(from: 0, to: message.count, by: 64) {
            for t in 0..<16 {
                var word: UInt32 = 0
                for byte in message[(block + t * 4)..<(block + t * 4 + 4)] { word = word << 8 | UInt32(byte) }
                w[t] = word
            }
            for t in 16..<64 {
                let s0: UInt32 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >> 3)
                let s1: UInt32 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >> 10)
                w[t] = w[t - 16] &+ s0 &+ w[t - 7] &+ s1
            }
            var a = hash[0], b = hash[1], c = hash[2], d = hash[3]
            var e = hash[4], f = hash[5], g = hash[6], h = hash[7]
            for t in 0..<64 {
                let s1: UInt32 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
                let choice: UInt32 = (e & f) ^ (~e & g)
                let t1: UInt32 = h &+ s1 &+ choice &+ roundConstants[t] &+ w[t]
                let s0: UInt32 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
                let majority: UInt32 = (a & b) ^ (a & c) ^ (b & c)
                let t2: UInt32 = s0 &+ majority
                h = g; g = f; f = e; e = d &+ t1
                d = c; c = b; b = a; a = t1 &+ t2
            }
            for (i, value) in [a, b, c, d, e, f, g, h].enumerated() { hash[i] = hash[i] &+ value }
        }
        return hash.map { word -> String in
            let hex = String(word, radix: 16)
            return String(repeating: "0", count: 8 - hex.count) + hex
        }.joined()
    }

    private static func rotr(_ x: UInt32, _ n: UInt32) -> UInt32 { x >> n | x << (32 - n) }

    private static let roundConstants: [UInt32] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]

    /// The part of `/dl/version.json` this reads (runner-go `Manifest.Assets`).
    private struct Manifest: Decodable {
        struct Asset: Decodable { let sha256: String? }
        let assets: [String: Asset]?
    }
}

/// Why the runner wasn't installed. Each sentence says what failed and where; the runner manager
/// shows it beside its Try Again button.
public enum RunnerDownloadError: Error, Equatable, LocalizedError {
    /// This Mac's CPU has no build under /dl.
    case unsupportedMachine(String)
    /// No answer at all: offline, DNS, TLS, a dropped connection.
    case unreachable(URL)
    /// An answer, but not the file.
    case http(URL, status: Int)
    /// version.json isn't a runner manifest.
    case unreadableManifest(URL)
    /// version.json publishes no sha256 for this platform.
    case noDigest(URL, platformKey: String)
    /// The download's bytes aren't the ones version.json describes.
    case digestMismatch(asset: String, expected: String, actual: String)
    /// A verified download that couldn't be unpacked or put in place.
    case unpackFailed(String)

    public var errorDescription: String? {
        switch self {
        case .unsupportedMachine(let machine):
            return "Orbit publishes no runner for this Mac's processor (\(machine))."
        case .unreachable(let url):
            return "Couldn't reach \(url.absoluteString) to download the runner. Check the connection, then try again."
        case .http(let url, let status):
            return "Couldn't download the runner: \(url.absoluteString) answered HTTP \(status)."
        case .unreadableManifest(let url):
            return "Couldn't download the runner: \(url.absoluteString) isn't a runner release manifest."
        case .noDigest(let url, let platformKey):
            return "The runner wasn't installed: \(url.absoluteString) publishes no sha256 for \(platformKey), "
                + "so the download can't be verified. Update the Orbit server, then try again."
        case .digestMismatch(let asset, let expected, let actual):
            return "The runner wasn't installed: \(asset) failed verification. Its sha256 is \(actual), "
                + "but version.json lists \(expected). Try again in a moment."
        case .unpackFailed(let detail):
            return "The runner was downloaded but couldn't be installed: \(detail)"
        }
    }
}
