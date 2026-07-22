import Foundation

/// Stores the JWT per instance (self-hosted means multiple `serverURL`s). The production
/// implementation is the macOS Keychain; tests/Linux use the in-memory one.
public protocol TokenStore: AnyObject, Sendable {
    func token(for serverURL: URL) -> String?
    func setToken(_ token: String?, for serverURL: URL)
    /// The long-lived refresh token, swapped for a fresh access token via `POST /auth/refresh` so an
    /// active client is never forced to re-login. Stored alongside the access token, per host.
    func refreshToken(for serverURL: URL) -> String?
    func setRefreshToken(_ token: String?, for serverURL: URL)
}

/// Non-persistent store for tests, previews, and Linux builds.
public final class InMemoryTokenStore: TokenStore, @unchecked Sendable {
    private var tokens: [String: String] = [:]
    private var refreshTokens: [String: String] = [:]
    private let lock = NSLock()
    public init() {}
    public func token(for serverURL: URL) -> String? {
        lock.lock(); defer { lock.unlock() }
        return tokens[Self.key(serverURL)]
    }
    public func setToken(_ token: String?, for serverURL: URL) {
        lock.lock(); defer { lock.unlock() }
        let k = Self.key(serverURL)
        if let token { tokens[k] = token } else { tokens[k] = nil }
    }
    public func refreshToken(for serverURL: URL) -> String? {
        lock.lock(); defer { lock.unlock() }
        return refreshTokens[Self.key(serverURL)]
    }
    public func setRefreshToken(_ token: String?, for serverURL: URL) {
        lock.lock(); defer { lock.unlock() }
        let k = Self.key(serverURL)
        if let token { refreshTokens[k] = token } else { refreshTokens[k] = nil }
    }
    static func key(_ url: URL) -> String { url.host ?? url.absoluteString }
}

#if canImport(Security)
import Security

/// Keychain-backed token store (one generic-password item per instance host). Shared by the
/// macOS and iOS shells — the Security API is identical on both.
public final class KeychainTokenStore: TokenStore, @unchecked Sendable {
    private let service: String
    public init(service: String = "com.orbit.client") { self.service = service }

    private func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    public func token(for serverURL: URL) -> String? {
        var q = query(account(serverURL))
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func setToken(_ token: String?, for serverURL: URL) {
        let account = account(serverURL)
        SecItemDelete(query(account) as CFDictionary)
        guard let token, let data = token.data(using: .utf8) else { return }
        var add = query(account)
        add[kSecValueData as String] = data
        // Readable after first unlock so a push-launched iOS app can reconnect in the
        // background; device-bound (no iCloud Keychain sync) since this is an auth credential.
        // Harmless on macOS, where the default is already broadly accessible.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }

    public func refreshToken(for serverURL: URL) -> String? {
        var q = query(refreshAccount(serverURL))
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func setRefreshToken(_ token: String?, for serverURL: URL) {
        let account = refreshAccount(serverURL)
        SecItemDelete(query(account) as CFDictionary)
        guard let token, let data = token.data(using: .utf8) else { return }
        var add = query(account)
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }

    private func account(_ url: URL) -> String { url.host ?? url.absoluteString }
    // Separate Keychain account for the refresh token so it lives beside, not on top of, the access
    // token (same host, distinct item).
    private func refreshAccount(_ url: URL) -> String { account(url) + ".refresh" }
}
#endif
