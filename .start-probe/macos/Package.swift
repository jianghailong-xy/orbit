// swift-tools-version: 5.9
// TEMPORARY evidence probe (see ../README.md): the same probe root as the iPhone app, in a real macOS
// window, photographed by the window server.
import PackageDescription

let package = Package(
    name: "StartProbeMac",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(path: "../../src/macos/OrbitKit"),
    ],
    targets: [
        .executableTarget(
            name: "StartProbeMac",
            dependencies: [.product(name: "OrbitKit", package: "OrbitKit")],
            path: "Sources/StartProbeMac"),
    ]
)
