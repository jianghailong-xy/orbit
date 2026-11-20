import AppKit
import SwiftUI

/// The macOS host of the share picker (docs/share-to-orbit-design.md §3.3): the Share menu's
/// "Orbit" item shows `ShareView` over the shared item providers. Its model and view are the iOS
/// extension's own sources (src/ios/OrbitShare, symlinked into this target); build-dmg.sh wraps
/// the `OrbitShare` product into Orbitd.app/Contents/PlugIns/OrbitShare.appex. Cancel cancels the request; Add opens Orbit on the
/// inbox entry and completes it.
final class ShareViewController: NSViewController {
    private let model = ShareModel()

    override func loadView() {
        let host = NSHostingView(rootView: ShareView(
            model: model,
            onCancel: { [weak self] in self?.cancel() },
            onDone: { [weak self] in self?.finish() }))
        host.frame = NSRect(x: 0, y: 0, width: 420, height: 480)
        view = host
        preferredContentSize = host.frame.size
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
            .flatMap { $0.attachments ?? [] }
        Task { await model.load(providers) }
    }

    private func cancel() {
        model.cleanUp()
        extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
    }

    private func finish() {
        extensionContext?.completeRequest(returningItems: nil)
    }
}
