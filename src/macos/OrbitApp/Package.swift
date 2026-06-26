// swift-tools-version: 5.9
import PackageDescription

// The SwiftUI app shell (Phase 1). Kept as a separate package from OrbitKit so the
// cross-platform core still builds + tests on Linux CI without dragging in SwiftUI (an
// Apple-only framework). Build/run on macOS:  cd src/macos/OrbitApp && swift run
//
// swift-tools 5.9 → Swift 5 language mode (relaxed concurrency), matching OrbitKit.
let package = Package(
    name: "OrbitApp",
    platforms: [.macOS(.v14)],          // MenuBarExtra/Observation land here; v14 is the floor
    dependencies: [
        .package(path: "../OrbitKit"),
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.0"),
    ],
    targets: [
        .executableTarget(
            name: "OrbitApp",
            dependencies: [
                .product(name: "OrbitKit", package: "OrbitKit"),
                .product(name: "Sparkle", package: "Sparkle"),
            ]
        ),
    ]
)
