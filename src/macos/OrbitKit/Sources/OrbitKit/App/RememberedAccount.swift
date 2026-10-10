import Foundation

// The login page's memory of who signed in last (docs/mocks/login-remember-account/): one account per
// domain, drawn as a card in place of the Email field, with only the way that account got in last time
// under it. It keeps what the card draws — name, email, photo, the way in — and nothing that signs
// anyone in: the password stays with the system's Passwords and the tokens in the Keychain, as before,
// and signing out still revokes.

/// A domain's last signed-in account, as its login card draws it.
public struct RememberedAccount: Codable, Equatable, Sendable {
    /// How the account got in last time: the one way its card offers.
    public enum Method: String, Codable, Sendable {
        case password
        case google
        /// Recorded while already signed in (the first launch after the update), before any sign-in
        /// said how: the card offers every way the server has.
        case unknown
    }

    public var email: String
    public var name: String?
    public var method: Method
    /// The `avatarUpdatedAt` of the photo kept beside the record (`RememberedAccounts.photo`), nil
    /// while none is.
    public var photoVersion: String?

    public init(email: String, name: String? = nil, method: Method, photoVersion: String? = nil) {
        self.email = email
        self.name = name
        self.method = method
        self.photoVersion = photoVersion
    }

    /// The card's first line, and the name in "Sign in as …": the account's name, its email when it
    /// has none.
    public var displayName: String {
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? email : trimmed
    }

    /// Whether `email` is this account's: a sign-in by the same person again.
    func isAccount(_ email: String) -> Bool {
        self.email.lowercased() == email.lowercased()
    }
}

/// Every domain's remembered account: one JSON object in UserDefaults, `[domain: RememberedAccount]`,
/// and each account's photo as a JPEG in `directory`. All of it is in the app's own container, so it
/// goes with the app.
public struct RememberedAccounts {
    /// Where the accounts are kept in `defaults`.
    public static let key = "orbit.rememberedAccounts"
    /// The email of the last password sign-in from before the cards, one key for every server. It
    /// still fills the empty form until the first sign-in under the cards, which deletes it.
    public static let legacyEmailKey = "orbit.email"

    public let defaults: UserDefaults
    /// The photos, one `<domain>.jpg` each.
    public let directory: URL

    public init(defaults: UserDefaults = .standard, directory: URL) {
        self.defaults = defaults
        self.directory = directory
    }

    /// Caches/Orbit/Accounts: a photo is the server's to send again, so the system may purge it, and
    /// the card then draws the initial until the account's next sign-in brings the photo back.
    public static func standard() -> RememberedAccounts {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return RememberedAccounts(directory: caches.appendingPathComponent("Orbit/Accounts", isDirectory: true))
    }

    /// The domain an account belongs to, as the card's third line names it (`SettingsHome.instanceName`):
    /// the host, and the port when there is one. So `orbitd.io` and `https://orbitd.io/` are one domain.
    public static func domain(of server: URL) -> String? {
        SettingsHome.instanceName(server)?.lowercased()
    }

    // MARK: what the page reads

    public func account(on server: URL) -> RememberedAccount? {
        Self.domain(of: server).flatMap { all()[$0] }
    }

    /// The account's photo as a JPEG: nil when it has none, or when the file has been purged.
    public func photo(on server: URL) -> Data? {
        guard account(on: server)?.photoVersion != nil, let file = photoFile(server) else { return nil }
        return try? Data(contentsOf: file)
    }

    /// The pre-card email, while it is still kept.
    public var legacyEmail: String? {
        defaults.string(forKey: Self.legacyEmailKey).flatMap { $0.isEmpty ? nil : $0 }
    }

    /// The email the login page starts from on `server`: its account's, behind the card; else the
    /// pre-card email in the empty form, as before the cards; else none.
    public func email(toShowOn server: URL?) -> String {
        server.flatMap(account(on:))?.email ?? legacyEmail ?? ""
    }

    // MARK: when it is written and forgotten

    /// A sign-in on `server` succeeded: this is the domain's account now, and `method` its way in.
    /// Someone else's account there is replaced, photo and all; the same account again keeps its
    /// photo. The pre-card email goes, as the card now remembers the account.
    public func signedIn(on server: URL, email: String, name: String?, method: RememberedAccount.Method) {
        guard let domain = Self.domain(of: server) else { return }
        var accounts = all()
        let before = accounts[domain]
        let again = before?.isAccount(email) == true
        if !again { removePhoto(server) }
        accounts[domain] = RememberedAccount(email: email, name: name, method: method,
                                             photoVersion: again ? before?.photoVersion : nil)
        save(accounts)
        defaults.removeObject(forKey: Self.legacyEmailKey)
    }

    /// While signed in on `server`: the account as the server has it now (`/users/me`). Its name and
    /// email follow, and a photo the account no longer has is deleted. The way in stays as recorded,
    /// `.unknown` when none was (the first launch after the update). Someone other than the recorded
    /// account starts over as `.unknown`.
    public func keep(_ user: User, on server: URL) {
        guard let domain = Self.domain(of: server) else { return }
        var accounts = all()
        let before = accounts[domain]
        var account: RememberedAccount
        if let before, before.isAccount(user.email) {
            account = before
        } else {
            removePhoto(server)
            account = RememberedAccount(email: user.email, method: .unknown)
        }
        account.email = user.email
        account.name = user.name
        if user.avatarUpdatedAt == nil, account.photoVersion != nil {
            removePhoto(server)
            account.photoVersion = nil
        }
        guard account != before else { return }
        accounts[domain] = account
        save(accounts)
    }

    /// The account's photo, fetched or just set, at `version` (`User.avatarUpdatedAt`). Kept only
    /// beside a remembered account.
    public func keepPhoto(_ jpeg: Data, version: String, on server: URL) {
        guard let domain = Self.domain(of: server), let file = photoFile(server) else { return }
        var accounts = all()
        guard var account = accounts[domain] else { return }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try jpeg.write(to: file, options: .atomic)
        } catch {
            return
        }
        account.photoVersion = version
        accounts[domain] = account
        save(accounts)
    }

    /// Remove from this device: the domain's account and its photo, and the pre-card email too when
    /// it names the same account. Every other domain keeps its own.
    public func forget(on server: URL) {
        guard let domain = Self.domain(of: server) else { return }
        var accounts = all()
        guard let gone = accounts.removeValue(forKey: domain) else { return }
        removePhoto(server)
        save(accounts)
        if let legacy = legacyEmail, gone.isAccount(legacy) {
            defaults.removeObject(forKey: Self.legacyEmailKey)
        }
    }

    // MARK: storage

    /// What `defaults` holds; nothing when that can't be read.
    private func all() -> [String: RememberedAccount] {
        guard let data = defaults.data(forKey: Self.key),
              let accounts = try? JSONDecoder().decode([String: RememberedAccount].self, from: data)
        else { return [:] }
        return accounts
    }

    private func save(_ accounts: [String: RememberedAccount]) {
        guard !accounts.isEmpty else {
            defaults.removeObject(forKey: Self.key)
            return
        }
        guard let data = try? JSONEncoder().encode(accounts) else { return }
        defaults.set(data, forKey: Self.key)
    }

    private func photoFile(_ server: URL) -> URL? {
        guard let domain = Self.domain(of: server) else { return nil }
        let ok = Set("abcdefghijklmnopqrstuvwxyz0123456789-_.")
        return directory.appendingPathComponent(String(domain.map { ok.contains($0) ? $0 : "_" }) + ".jpg")
    }

    private func removePhoto(_ server: URL) {
        guard let file = photoFile(server) else { return }
        try? FileManager.default.removeItem(at: file)
    }
}

/// What the login page offers under the account card, or under the Email field when there is none.
public struct LoginWaysIn: Equatable, Sendable {
    /// The Password field and Sign In.
    public var password: Bool
    /// Continue with Google.
    public var google: Bool

    public init(password: Bool, google: Bool) {
        self.password = password
        self.google = google
    }

    /// "or" stands between two ways in, so only when both are offered.
    public var or: Bool { password && google }

    /// - card: how the card's account got in last time; nil for the full form (no remembered account,
    ///   or "Use another account").
    /// - methods: what the page's server offers, `.passwordOnly` until it has answered, so Google is
    ///   never offered before, or without, that server's yes.
    /// - answered: whether `methods` is that server's own answer yet.
    public static func offered(card: RememberedAccount.Method?, methods: SignInMethods,
                               answered: Bool) -> LoginWaysIn {
        switch card {
        case .password:
            return LoginWaysIn(password: true, google: false)
        case .google:
            // Nothing while the server is asked, rather than a password field that would vanish;
            // the password when the server doesn't offer Google, or can't be reached.
            guard answered else { return LoginWaysIn(password: false, google: false) }
            return methods.google ? LoginWaysIn(password: false, google: true)
                                  : LoginWaysIn(password: true, google: false)
        case .unknown, nil:
            return LoginWaysIn(password: true, google: methods.google)
        }
    }
}
