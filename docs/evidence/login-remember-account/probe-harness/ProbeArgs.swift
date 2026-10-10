import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see README.md): what one launch remembers before AppModel reads it, and
// the sign-in gate the real apps put around LoginView.
enum ProbeArgs {
    static func value(_ flag: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    static var dark: Bool { value("-dark") == "1" }

    /// The server under test, as `-orbit.instance` hands it to AppModel.
    static var server: URL {
        ServerURL.normalize(UserDefaults.standard.string(forKey: "orbit.instance") ?? "")
            ?? URL(string: "http://127.0.0.1:8765")!
    }

    /// Seed the remembered accounts through the app's own store, as earlier sign-ins would have left
    /// them. Every launch starts from what it asks for and nothing else, unless `-probe.keep 1`
    /// (a relaunch that reads what the last one left):
    /// - `-probe.account password|google|unknown`: Alex Morgan, on the server under test;
    /// - `-probe.photo 1`: with a photo (avatar.jpg, the same one the stub serves);
    /// - `-probe.other <address>`: Sam Lee, a Google account, on a second domain;
    /// - `-probe.legacy <email>`: the pre-card `orbit.email`.
    static func seed() {
        let store = RememberedAccounts.standard()
        guard value("-probe.keep") != "1" else { return }
        UserDefaults.standard.removeObject(forKey: RememberedAccounts.key)
        try? FileManager.default.removeItem(at: store.directory)
        // A sign-in an earlier launch left in the Keychain would skip the page under test.
        let tokens = KeychainTokenStore()
        tokens.setToken(nil, for: server)
        tokens.setRefreshToken(nil, for: server)

        if let method = value("-probe.account").flatMap(RememberedAccount.Method.init(rawValue:)) {
            store.signedIn(on: server, email: "alex@example.com", name: "Alex Morgan", method: method)
            if value("-probe.photo") == "1",
               let url = Bundle.main.url(forResource: "avatar", withExtension: "jpg"),
               let jpeg = try? Data(contentsOf: url) {
                store.keepPhoto(jpeg, version: "2026-10-10T02:00:00.000Z", on: server)
            }
        }
        if let other = value("-probe.other").flatMap(ServerURL.normalize) {
            store.signedIn(on: other, email: "sam@corp.example", name: "Sam Lee", method: .google)
        }
        // After the sign-ins above, which delete it, as the first sign-in under the cards does.
        if let legacy = value("-probe.legacy") {
            UserDefaults.standard.set(legacy, forKey: RememberedAccounts.legacyEmailKey)
        } else {
            UserDefaults.standard.removeObject(forKey: RememberedAccounts.legacyEmailKey)
        }
    }
}

/// The apps' sign-in gate (OrbitiOSApp / OrbitApp `RootView`), with a stand-in for the signed-in app:
/// who is signed in, and Sign out — the same `logout()` a 401 runs.
struct ProbeRoot: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.signedIn {
            VStack(spacing: 16) {
                Text("Signed in as \(model.user?.name ?? model.user?.email ?? "nobody")")
                    .font(.headline)
                Button("Sign out", role: .destructive) { model.logout() }
                    .buttonStyle(.bordered)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            LoginView()
        }
    }
}
