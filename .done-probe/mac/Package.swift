// swift-tools-version: 5.9
import PackageDescription

// TEMPORARY evidence probe (see ../README.md): the real closing cards (`ProjectDoneCards.swift`,
// copied in from the commit under test by run.sh) drawn on macOS in real windows.
let package = Package(
    name: "DoneProbe",
    platforms: [.macOS(.v14)],
    dependencies: [.package(path: "../../src/macos/OrbitKit")],
    targets: [
        .executableTarget(name: "DoneProbe",
                          dependencies: [.product(name: "OrbitKit", package: "OrbitKit")]),
    ]
)
