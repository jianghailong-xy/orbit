import SwiftUI
import OrbitKit

// TEMPORARY evidence probe (see README.md).
enum ProbeArgs {
    static var dark: Bool { ProcessInfo.processInfo.arguments.contains("-dark") }

    /// Every launch starts signed out. The Keychain keeps a session per host, and every port of the
    /// stub is the same host: an earlier launch's Google sign-in would otherwise skip the login page.
    static func signOut() {
        guard let raw = UserDefaults.standard.string(forKey: "orbit.instance"),
              let url = ServerURL.normalize(raw) else { return }
        let store = KeychainTokenStore()
        store.setToken(nil, for: url)
        store.setRefreshToken(nil, for: url)
    }
}

/// The apps' sign-in gate (RootView in OrbitiOSApp.swift / OrbitApp.swift): the login page until
/// signed in. Past it, a plain page in place of the shell, saying who signed in and whether the
/// session is in the Keychain.
struct ProbeRoot: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.signedIn {
            VStack(spacing: 10) {
                Image(systemName: "checkmark.circle.fill").font(.largeTitle).foregroundStyle(.green)
                Text("Signed in").font(.title.bold())
                Text(model.user?.email ?? "account not read").foregroundStyle(.secondary)
                Text(model.baseURL.flatMap { model.tokenStore.token(for: $0) } == nil
                     ? "No session in the Keychain" : "Session kept in the Keychain")
            }
            .padding(40)
        } else {
            LoginView()
        }
    }
}
