import UIKit
import SwiftUI

/// The iOS host of the share picker: hands the shared item providers to `ShareModel` and shows
/// `ShareView`. Cancel cancels the request; Done (after Add) completes it.
final class ShareViewController: UIViewController {
    private let model = ShareModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: ShareView(
            model: model,
            onCancel: { [weak self] in self?.cancel() },
            onDone: { [weak self] in self?.finish() }))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)

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
