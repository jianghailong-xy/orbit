import Foundation

// An app extension's entry is Foundation's NSExtensionMain, which loads NSExtensionPrincipalClass
// (OrbitShare.ShareViewController) and serves the share request. Xcode links extensions with
// `-e _NSExtensionMain`; SwiftPM renames an executable's main and links that, so this main hands
// over instead. NSExtensionMain is exported by Foundation but has no Swift declaration.
@_silgen_name("NSExtensionMain")
private func NSExtensionMain(_ argc: Int32, _ argv: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> Int32

_ = ShareViewController.self   // keep the principal class however the linker strips
exit(NSExtensionMain(CommandLine.argc, CommandLine.unsafeArgv))
