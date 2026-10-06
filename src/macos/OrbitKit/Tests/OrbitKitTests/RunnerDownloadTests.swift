import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import XCTest
@testable import OrbitKit

/// The macOS app's runner download at enrollment (OrbitApp RunnerControl.installService): which
/// /dl file this Mac asks for, the sha256 it has to match before anything is unpacked, and what a
/// refusal says. The manifest shape is runner-go cmd/release-manifest's.
final class RunnerDownloadTests: XCTestCase {
    /// `printf '#!/bin/sh\necho orbit 0.1.999\n' | gzip -9n` — a stand-in for orbit-darwin-arm64.gz.
    private static let asset = Data(base64Encoded: "H4sIAAAAAAACA1NW1E/KzNMvzuBKTc7IV8gvSsosUTDQM9SztLTkAgAT0kOxHQAAAA==")!
    /// `sha256sum` of those bytes.
    private static let assetSHA256 = "70a7c86a73e760ee6b8236ac1ba095293f864faa96cd82e200166060e1e8baa5"
    private static let manifestURL = URL(string: "https://orbit.test/dl/version.json")!

    private static func manifest(arm64 sha256: String) -> Data {
        Data("""
        {"version":"0.1.999","capabilityRevision":2,"schemaRevision":2,"assets":{
          "darwin-arm64":{"file":"orbit-darwin-arm64.gz","sha256":"\(sha256)"},
          "darwin-x64":{"file":"orbit-darwin-x64.gz","sha256":"\(String(repeating: "b", count: 64))"},
          "linux-x64":{"file":"orbit-linux-x64.gz","sha256":"\(String(repeating: "c", count: 64))"}}}
        """.utf8)
    }

    override func tearDown() {
        RunnerDownloadURLProtocol.handler = nil
        super.tearDown()
    }

    // MARK: which file

    func testEachMacCPUFetchesItsOwnBuild() {
        XCTAssertEqual(RunnerDownload.platformKey(machine: "arm64"), "darwin-arm64")
        XCTAssertEqual(RunnerDownload.platformKey(machine: "x86_64"), "darwin-x64")
        XCTAssertEqual(RunnerDownload.assetName(platformKey: "darwin-arm64"), "orbit-darwin-arm64.gz")
        XCTAssertEqual(RunnerDownload.assetName(platformKey: "darwin-x64"), "orbit-darwin-x64.gz")
        XCTAssertNil(RunnerDownload.platformKey(machine: "ppc"), "a CPU /dl doesn't build for has no asset")
        XCTAssertNil(RunnerDownload.platformKey(machine: ""))
    }

    func testTheDigestIsTheOneForThisMacsPlatform() throws {
        let manifest = Self.manifest(arm64: Self.assetSHA256)
        XCTAssertEqual(try RunnerDownload.expectedSHA256(manifest: manifest, platformKey: "darwin-arm64",
                                                         manifestURL: Self.manifestURL), Self.assetSHA256)
        XCTAssertEqual(try RunnerDownload.expectedSHA256(manifest: manifest, platformKey: "darwin-x64",
                                                         manifestURL: Self.manifestURL),
                       String(repeating: "b", count: 64))
        XCTAssertEqual(try RunnerDownload.expectedSHA256(manifest: Self.manifest(arm64: Self.assetSHA256.uppercased()),
                                                         platformKey: "darwin-arm64", manifestURL: Self.manifestURL),
                       Self.assetSHA256, "an upper-case digest is the same digest")
    }

    /// A control plane older than asset digests publishes none. The runner's own updater installs
    /// anyway; an enrollment has nothing to fall back on, so it installs nothing.
    func testAManifestWithNothingToCheckAgainstIsRefused() {
        let noDigest: [String] = [
            #"{"version":"0.1.213","capabilityRevision":2,"schemaRevision":2}"#,
            #"{"version":"0.1.999","assets":{"linux-x64":{"file":"orbit-linux-x64.gz","sha256":"\#(String(repeating: "c", count: 64))"}}}"#,
            #"{"version":"0.1.999","assets":{"darwin-arm64":{"file":"orbit-darwin-arm64.gz"}}}"#,
            #"{"version":"0.1.999","assets":{"darwin-arm64":{"file":"orbit-darwin-arm64.gz","sha256":"abc123"}}}"#,
            #"{"version":"0.1.999","assets":{"darwin-arm64":{"file":"orbit-darwin-arm64.gz","sha256":"\#(String(repeating: "z", count: 64))"}}}"#,
        ]
        for body in noDigest {
            XCTAssertThrowsError(try RunnerDownload.expectedSHA256(manifest: Data(body.utf8), platformKey: "darwin-arm64",
                                                                   manifestURL: Self.manifestURL), body) { error in
                XCTAssertEqual(error as? RunnerDownloadError, .noDigest(Self.manifestURL, platformKey: "darwin-arm64"))
            }
        }
        for body in ["<html>Not Found</html>", "", #"["darwin-arm64"]"#] {
            XCTAssertThrowsError(try RunnerDownload.expectedSHA256(manifest: Data(body.utf8), platformKey: "darwin-arm64",
                                                                   manifestURL: Self.manifestURL), body) { error in
                XCTAssertEqual(error as? RunnerDownloadError, .unreadableManifest(Self.manifestURL))
            }
        }
    }

    // MARK: sha256

    func testSHA256IsTheStandardOne() {
        let vectors: [(String, String)] = [
            ("", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
            ("abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
            ("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
             "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"),
        ]
        for (text, digest) in vectors {
            XCTAssertEqual(RunnerDownload.sha256Hex(Data(text.utf8)), digest, text)
        }
        // Around the padding: up to 55 bytes the length fits in the last block, from 56 it needs another.
        let lengths: [(Int, String)] = [
            (55, "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318"),
            (56, "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a"),
            (63, "7d3e74a05d7db15bce4ad9ec0658ea98e3f06eeecf16b4c6fff2da457ddc2f34"),
            (64, "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb"),
            (65, "635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0"),
            (119, "31eba51c313a5c08226adf18d4a359cfdfd8d2e816b13f4af952f7ea6584dcfb"),
            (120, "2f3d335432c70b580af0e8e1b3674a7c020d683aa5f73aaaedfdc55af904c21c"),
            (1_000_000, "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"),
        ]
        for (count, digest) in lengths {
            XCTAssertEqual(RunnerDownload.sha256Hex(Data(repeating: UInt8(ascii: "a"), count: count)), digest,
                           "\(count) × a")
        }
        XCTAssertEqual(RunnerDownload.sha256Hex(Self.asset), Self.assetSHA256)
    }

    func testADownloadThatMatchesItsDigestVerifies() {
        XCTAssertNoThrow(try RunnerDownload.verify(Self.asset, sha256: Self.assetSHA256, name: "orbit-darwin-arm64.gz"))
        XCTAssertNoThrow(try RunnerDownload.verify(Self.asset, sha256: Self.assetSHA256.uppercased(),
                                                   name: "orbit-darwin-arm64.gz"))
    }

    func testOneChangedByteFailsVerification() {
        var tampered = Self.asset
        tampered[tampered.count - 1] ^= 0x01
        XCTAssertThrowsError(try RunnerDownload.verify(tampered, sha256: Self.assetSHA256,
                                                       name: "orbit-darwin-arm64.gz")) { error in
            XCTAssertEqual(error as? RunnerDownloadError,
                           .digestMismatch(asset: "orbit-darwin-arm64.gz", expected: Self.assetSHA256,
                                           actual: RunnerDownload.sha256Hex(tampered)))
        }
        XCTAssertNotEqual(RunnerDownload.sha256Hex(tampered), Self.assetSHA256)
    }

    // MARK: through APIClient, against a stub /dl

    func testTheManifestIsReadThenItsAssetDownloadedAndVerified() async throws {
        let log = RunnerDownloadRequestLog()
        RunnerDownloadURLProtocol.handler = { request in
            log.record(request)
            switch request.url?.path {
            case "/orbit/dl/version.json": return (200, Self.manifest(arm64: Self.assetSHA256))
            case "/orbit/dl/orbit-darwin-arm64.gz": return (200, Self.asset)
            default: return (404, Data())
            }
        }
        let gzip = try await client("https://orbit.test/orbit").downloadRunner(platformKey: "darwin-arm64")
        XCTAssertEqual(gzip, Self.asset)
        XCTAssertEqual(log.paths, ["/orbit/dl/version.json", "/orbit/dl/orbit-darwin-arm64.gz"])
    }

    func testATamperedDownloadIsRefused() async {
        var bytes = Self.asset
        bytes[10] ^= 0xff
        let tampered = bytes
        RunnerDownloadURLProtocol.handler = { request in
            if request.url?.lastPathComponent == "version.json" { return (200, Self.manifest(arm64: Self.assetSHA256)) }
            return (200, tampered)
        }
        do {
            _ = try await client().downloadRunner(platformKey: "darwin-arm64")
            XCTFail("a download that doesn't match version.json was accepted")
        } catch {
            XCTAssertEqual(error as? RunnerDownloadError,
                           .digestMismatch(asset: "orbit-darwin-arm64.gz", expected: Self.assetSHA256,
                                           actual: RunnerDownload.sha256Hex(tampered)))
        }
    }

    func testNothingToCheckAgainstMeansNothingIsDownloaded() async {
        let log = RunnerDownloadRequestLog()
        RunnerDownloadURLProtocol.handler = { request in
            log.record(request)
            if request.url?.lastPathComponent == "version.json" {
                return (200, Data(#"{"version":"0.1.213","capabilityRevision":2,"schemaRevision":2}"#.utf8))
            }
            return (200, Self.asset)
        }
        do {
            _ = try await client().downloadRunner(platformKey: "darwin-arm64")
            XCTFail("a runner with no published digest was accepted")
        } catch {
            XCTAssertEqual(error as? RunnerDownloadError, .noDigest(Self.manifestURL, platformKey: "darwin-arm64"))
        }
        XCTAssertEqual(log.paths, ["/dl/version.json"], "the binary is never fetched")
    }

    func testAMissingFileIsNamedWithItsStatus() async {
        RunnerDownloadURLProtocol.handler = { request in
            if request.url?.lastPathComponent == "version.json" { return (200, Self.manifest(arm64: Self.assetSHA256)) }
            return (404, Data("Not Found".utf8))
        }
        do {
            _ = try await client().downloadRunner(platformKey: "darwin-arm64")
            XCTFail("a 404 was installed")
        } catch {
            XCTAssertEqual(error as? RunnerDownloadError,
                           .http(URL(string: "https://orbit.test/dl/orbit-darwin-arm64.gz")!, status: 404))
        }
    }

    // MARK: what a refusal says

    func testEveryRefusalSaysWhatFailedAndWhere() {
        let asset = URL(string: "https://orbit.test/dl/orbit-darwin-arm64.gz")!
        let sentences: [(RunnerDownloadError, [String])] = [
            (.unsupportedMachine("ppc"), ["ppc"]),
            (.unreachable(Self.manifestURL), ["https://orbit.test/dl/version.json", "try again"]),
            (.http(asset, status: 404), ["https://orbit.test/dl/orbit-darwin-arm64.gz", "HTTP 404"]),
            (.unreadableManifest(Self.manifestURL), ["https://orbit.test/dl/version.json"]),
            (.noDigest(Self.manifestURL, platformKey: "darwin-arm64"),
             ["wasn't installed", "https://orbit.test/dl/version.json", "no sha256 for darwin-arm64",
              "Update the Orbit server"]),
            (.digestMismatch(asset: "orbit-darwin-arm64.gz", expected: Self.assetSHA256, actual: "0123abcd"),
             ["wasn't installed", "orbit-darwin-arm64.gz failed verification", Self.assetSHA256, "0123abcd"]),
            (.unpackFailed("gzip: not in gzip format"), ["gzip: not in gzip format"]),
        ]
        for (error, parts) in sentences {
            let sentence = error.errorDescription ?? ""
            for part in parts { XCTAssertTrue(sentence.contains(part), "\(sentence) — missing \(part)") }
        }
    }

    // MARK: unpacking (macOS + Linux: the system gzip)

    #if os(macOS) || os(Linux)
    func testUnpackPutsAnExecutableBinaryInPlaceOfTheOldOne() throws {
        let dir = try scratchDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let bin = dir.appendingPathComponent("bin/orbit")
        try FileManager.default.createDirectory(at: bin.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("old runner".utf8).write(to: bin)

        try RunnerDownload.unpack(Self.asset, to: bin)

        XCTAssertEqual(try String(contentsOf: bin, encoding: .utf8), "#!/bin/sh\necho orbit 0.1.999\n")
        let mode = try FileManager.default.attributesOfItem(atPath: bin.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(mode?.intValue, 0o755)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: bin.deletingLastPathComponent().path),
                       ["orbit"], "nothing staged is left behind")
    }

    func testUnpackMakesTheBinDirectoryOnAFreshMac() throws {
        let dir = try scratchDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let bin = dir.appendingPathComponent("bin/orbit")
        try RunnerDownload.unpack(Self.asset, to: bin)
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: bin.path))
    }

    func testAnArchiveGzipCannotReadLeavesTheOldBinary() throws {
        let dir = try scratchDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let bin = dir.appendingPathComponent("orbit")
        try Data("old runner".utf8).write(to: bin)

        XCTAssertThrowsError(try RunnerDownload.unpack(Data("not a gzip stream\n".utf8), to: bin)) { error in
            guard case .unpackFailed(let detail)? = error as? RunnerDownloadError else {
                return XCTFail("unexpected \(error)")
            }
            XCTAssertFalse(detail.isEmpty)
        }
        XCTAssertEqual(try String(contentsOf: bin, encoding: .utf8), "old runner")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path), ["orbit"])
    }
    #endif

    // MARK: helpers

    private func client(_ base: String = "https://orbit.test") -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RunnerDownloadURLProtocol.self]
        return APIClient(baseURL: URL(string: base)!, tokenStore: InMemoryTokenStore(),
                         session: URLSession(configuration: configuration))
    }

    private func scratchDirectory() throws -> URL {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("orbit-dl-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
}

/// Serves /dl from `handler`: a status and the raw bytes.
private final class RunnerDownloadURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: (@Sendable (URLRequest) -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let (status, body) = Self.handler?(request) ?? (500, Data())
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// The paths requested, in order.
private final class RunnerDownloadRequestLog: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []

    func record(_ request: URLRequest) {
        lock.lock()
        storage.append(request.url?.path ?? "")
        lock.unlock()
    }

    var paths: [String] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}
