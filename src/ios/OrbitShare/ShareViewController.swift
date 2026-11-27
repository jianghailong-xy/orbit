import UIKit
import SwiftUI

/// The iOS host of the share picker: hands the shared item providers to `ShareModel` and shows
/// `ShareView`. Cancel cancels the request; Done (after Add) completes it, as does Add once it has
/// opened Orbit.
final class ShareViewController: UIViewController {
    private let model = ShareModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        model.openApp = { [weak self] url in await self?.openContainingApp(url) ?? false }
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

    /// Opens Orbit on `url`. An extension has no supported way to open its app
    /// (`extensionContext.open` is for widgets only), so this walks the responder chain to the
    /// `UIApplication` and calls `open(_:options:completionHandler:)` through the runtime, because
    /// the extension SDK marks it unavailable. iOS 18 made the old `openURL:` a no-op; this one
    /// still opens. Apple may close it in any release: false sends Add to its notification instead.
    private func openContainingApp(_ url: URL) async -> Bool {
        let selector = NSSelectorFromString("openURL:options:completionHandler:")
        var responder: UIResponder? = self
        while let r = responder, !(r is UIApplication) { responder = r.next }
        guard let app = responder, app.responds(to: selector) else { return false }
        typealias Open = @convention(c) (AnyObject, Selector, NSURL, NSDictionary,
                                         (@convention(block) (Bool) -> Void)?) -> Void
        let open = unsafeBitCast(app.method(for: selector), to: Open.self)
        return await withCheckedContinuation { cont in
            open(app, selector, url as NSURL, NSDictionary(), { cont.resume(returning: $0) })
        }
    }
}
