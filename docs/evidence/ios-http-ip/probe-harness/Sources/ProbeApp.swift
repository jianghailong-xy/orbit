import UIKit

/// One HTTP request at launch, one line out, then exit — the whole app. The question it answers is
/// a transport-layer one (may an app carrying this Info.plist reach `http://<ip>` on iOS 17+?),
/// so it is deliberately not the Orbit app: nothing about the shared UI or the login flow can
/// change the answer, and a probe that needs none of it builds in a minute.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        // A plain window so the app is an ordinary foreground app; the probe doesn't draw in it.
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = UIViewController()
        window?.makeKeyAndVisible()
        Probe.run()
        return true
    }
}

private enum Probe {
    static func run() {
        guard let raw = ProcessInfo.processInfo.environment["PROBE_URL"], let url = URL(string: raw) else {
            report("result=failed reason=no-url")
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        URLSession.shared.dataTask(with: request) { _, response, error in
            if let error = error as NSError? {
                // `code=-1022` (NSURLErrorAppTransportSecurityRequiresSecureConnection) is the one
                // this probe exists to tell apart from an ordinary network failure (-1003/-1004).
                report("result=failed domain=\(error.domain) code=\(error.code) desc=\(error.localizedDescription)")
            } else if let http = response as? HTTPURLResponse {
                report("result=ok status=\(http.statusCode)")
            } else {
                report("result=failed reason=no-response")
            }
        }.resume()
    }

    private static func report(_ outcome: String) {
        print("PROBE \(outcome)")
        fflush(stdout)
        exit(0)
    }
}
