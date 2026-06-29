// swift-tools-version: 5.9
import PackageDescription

// OrbitKit — the UI-free core of the Orbit macOS + iOS clients (Phase 0).
//
// One deliberate third-party dependency: apple/swift-markdown, a spec-compliant GFM parser
// (cmark-gfm under the hood) used by the Markdown block parser so tables, nested lists and
// other CommonMark/GFM constructs are handled correctly instead of hand-rolled. It is pure
// Swift API and cross-platform, so the protocol logic (models, SSE parsing, transcript
// reduction, Markdown blocks) still builds and `swift test` runs on Linux CI as well as
// macOS/iOS. Only the concrete URLSession transport and Keychain token store touch platform
// APIs, and those stay guarded. Both the macOS and iOS app shells link this same core.
let package = Package(
    name: "OrbitKit",
    platforms: [.macOS(.v13), .iOS(.v17)],
    products: [
        .library(name: "OrbitKit", targets: ["OrbitKit"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-markdown", from: "0.7.1"),
    ],
    targets: [
        .target(name: "OrbitKit", dependencies: [
            .product(name: "Markdown", package: "swift-markdown"),
        ]),
        .testTarget(name: "OrbitKitTests", dependencies: ["OrbitKit"]),
    ]
)
