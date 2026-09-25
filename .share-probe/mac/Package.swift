// swift-tools-version: 5.9
import PackageDescription

// TEMPORARY evidence probe (see ../README.md): the real ShareSheet on macOS, against a stub server.
let package = Package(
    name: "ShareProbe",
    platforms: [.macOS(.v14)],
    dependencies: [.package(path: "../../src/macos/OrbitKit")],
    targets: [
        .executableTarget(name: "ShareProbe",
                          dependencies: [.product(name: "OrbitKit", package: "OrbitKit")]),
    ]
)
