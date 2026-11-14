// swift-tools-version: 5.9
import PackageDescription

// TEMPORARY evidence probe for P1-03 (Agent Tools): the app's real AgentToolsSheet, copied in from the
// commit under test at run time, hosted in a window on a macOS runner and photographed.
let package = Package(
    name: "AgentToolsProbe",
    platforms: [.macOS(.v14)],
    dependencies: [.package(path: "../../src/macos/OrbitKit")],
    targets: [
        .executableTarget(name: "AgentToolsProbe",
                          dependencies: [.product(name: "OrbitKit", package: "OrbitKit")]),
    ]
)
