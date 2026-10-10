import Foundation
import XCTest
@testable import OrbitKit

/// The login page's remembered account (docs/mocks/login-remember-account/): one per domain, what is
/// kept, when it is written and when it is forgotten, and what the page offers under its card.
final class RememberedAccountTests: XCTestCase {
    private var suite = ""
    private var defaults: UserDefaults!
    private var directory: URL!
    private var store: RememberedAccounts!

    private let orbitd = URL(string: "https://orbitd.io")!
    private let selfHosted = URL(string: "http://10.0.0.5:3000")!
    private let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])

    override func setUp() {
        suite = "remembered-accounts-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(suite, isDirectory: true)
        store = RememberedAccounts(defaults: defaults, directory: directory)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: directory)
    }

    private func user(_ email: String, name: String? = nil, photo: String? = nil) -> User {
        User(id: "id-\(email)", email: email, name: name, role: nil, createdAt: nil, preferences: nil,
             avatarUpdatedAt: photo)
    }

    private func photoFiles() -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []).sorted()
    }

    // MARK: - One account per domain

    func testAPasswordSignInIsRememberedUnderItsDomain() {
        store.signedIn(on: orbitd, email: "alex@example.com", name: "Alex Morgan", method: .password)
        XCTAssertEqual(store.account(on: orbitd),
                       RememberedAccount(email: "alex@example.com", name: "Alex Morgan", method: .password))
        XCTAssertNil(store.account(on: selfHosted), "another domain has its own, and here none")
    }

    func testAGoogleSignInIsRememberedToo() {
        store.signedIn(on: orbitd, email: "alex@example.com", name: "Alex Morgan", method: .google)
        XCTAssertEqual(store.account(on: orbitd)?.method, .google)
        XCTAssertEqual(store.account(on: orbitd)?.displayName, "Alex Morgan")
    }

    func testEachDomainKeepsItsOwnLastAccount() {
        store.signedIn(on: orbitd, email: "alex@example.com", name: "Alex Morgan", method: .password)
        store.signedIn(on: selfHosted, email: "sam@corp.example", name: "Sam", method: .google)
        XCTAssertEqual(store.account(on: orbitd)?.email, "alex@example.com")
        XCTAssertEqual(store.account(on: selfHosted)?.email, "sam@corp.example")

        // Signing in as someone else on one domain changes only that one.
        store.signedIn(on: orbitd, email: "bob@example.com", name: nil, method: .password)
        XCTAssertEqual(store.account(on: orbitd)?.email, "bob@example.com")
        XCTAssertEqual(store.account(on: selfHosted)?.email, "sam@corp.example")
    }

    /// The domain is what the card's third line says: the host, and the port when there is one —
    /// however the address was typed.
    func testTheDomainIsTheHostAndPortTheCardNames() throws {
        XCTAssertEqual(RememberedAccounts.domain(of: orbitd), "orbitd.io")
        XCTAssertEqual(RememberedAccounts.domain(of: selfHosted), "10.0.0.5:3000")
        let typed = try XCTUnwrap(ServerURL.normalize("orbitd.io"))
        XCTAssertEqual(RememberedAccounts.domain(of: typed), SettingsHome.instanceName(orbitd))

        store.signedIn(on: try XCTUnwrap(URL(string: "https://OrbitD.io/")), email: "alex@example.com",
                       name: nil, method: .password)
        XCTAssertEqual(store.account(on: typed)?.email, "alex@example.com")
        XCTAssertEqual(store.account(on: orbitd)?.email, "alex@example.com")
        XCTAssertNil(store.account(on: try XCTUnwrap(URL(string: "https://orbitd.io:8443"))),
                     "another port is another server")
    }

    // MARK: - Written: sign-ins

    func testSomeoneElseSigningInReplacesTheAccountAndItsPhoto() {
        store.signedIn(on: orbitd, email: "alex@example.com", name: "Alex Morgan", method: .google)
        store.keepPhoto(jpeg, version: "v1", on: orbitd)
        XCTAssertEqual(store.photo(on: orbitd), jpeg)

        store.signedIn(on: orbitd, email: "bob@example.com", name: "Bob", method: .password)
        XCTAssertEqual(store.account(on: orbitd),
                       RememberedAccount(email: "bob@example.com", name: "Bob", method: .password))
        XCTAssertNil(store.photo(on: orbitd))
        XCTAssertEqual(photoFiles(), [], "Alex's photo is deleted with Alex")
    }

    func testTheSameAccountSigningInAgainKeepsItsPhoto() {
        store.signedIn(on: orbitd, email: "alex@example.com", name: "Alex Morgan", method: .password)
        store.keepPhoto(jpeg, version: "v1", on: orbitd)

        store.signedIn(on: orbitd, email: "Alex@Example.com", name: "Alex Morgan", method: .google)
        XCTAssertEqual(store.account(on: orbitd)?.method, .google, "the way in is the latest one")
        XCTAssertEqual(store.account(on: orbitd)?.photoVersion, "v1")
        XCTAssertEqual(store.photo(on: orbitd), jpeg)
    }

    // MARK: - Written: while signed in

    func testWhileSignedInTheCardFollowsTheAccount() {
        store.signedIn(on: orbitd, email: "alex@example.com", name: "Alex Morgan", method: .password)

        store.keep(user("alex@example.com", name: "Alex M.", photo: "v1"), on: orbitd)
        store.keepPhoto(jpeg, version: "v1", on: orbitd)
        XCTAssertEqual(store.account(on: orbitd),
                       RememberedAccount(email: "alex@example.com", name: "Alex M.", method: .password,
                                         photoVersion: "v1"),
                       "the name follows; the way in stays as recorded")
        XCTAssertEqual(store.photo(on: orbitd), jpeg)

        // The photo was removed: its file goes, and the card draws the initial.
        store.keep(user("alex@example.com", name: "Alex M.", photo: nil), on: orbitd)
        XCTAssertNil(store.account(on: orbitd)?.photoVersion)
        XCTAssertNil(store.photo(on: orbitd))
        XCTAssertEqual(photoFiles(), [])
    }

    /// Signed in when the update arrives: the account is recorded from `/users/me`, and nobody has said
    /// how it got in yet.
    func testTheFirstLaunchAfterTheUpdateRecordsTheAccountWithAnUnknownWayIn() {
        defaults.set("old@example.com", forKey: RememberedAccounts.legacyEmailKey)
        store.keep(user("alex@example.com", name: "Alex Morgan", photo: "v1"), on: orbitd)
        XCTAssertEqual(store.account(on: orbitd),
                       RememberedAccount(email: "alex@example.com", name: "Alex Morgan", method: .unknown))
        XCTAssertEqual(store.legacyEmail, "old@example.com", "not a sign-in: the pre-card email stays")

        store.keepPhoto(jpeg, version: "v1", on: orbitd)
        XCTAssertEqual(store.photo(on: orbitd), jpeg)
    }

    func testKeepingSomeoneElseThanTheRecordedAccountStartsOver() {
        store.signedIn(on: orbitd, email: "alex@example.com", name: "Alex Morgan", method: .google)
        store.keepPhoto(jpeg, version: "v1", on: orbitd)

        store.keep(user("bob@example.com", name: "Bob", photo: "v9"), on: orbitd)
        XCTAssertEqual(store.account(on: orbitd),
                       RememberedAccount(email: "bob@example.com", name: "Bob", method: .unknown))
        XCTAssertNil(store.photo(on: orbitd), "never Alex's photo on Bob's card")
    }

    func testAPhotoIsKeptOnlyBesideARememberedAccount() {
        store.keepPhoto(jpeg, version: "v1", on: orbitd)
        XCTAssertNil(store.account(on: orbitd))
        XCTAssertNil(store.photo(on: orbitd))
        XCTAssertEqual(photoFiles(), [])
    }

    func testAPurgedPhotoLeavesTheCardItsInitial() throws {
        store.signedIn(on: orbitd, email: "alex@example.com", name: "Alex Morgan", method: .password)
        store.keepPhoto(jpeg, version: "v1", on: orbitd)
        try FileManager.default.removeItem(at: directory)
        XCTAssertNil(store.photo(on: orbitd))
        XCTAssertEqual(store.account(on: orbitd)?.email, "alex@example.com", "the account itself is not lost")
    }

    // MARK: - Forgotten

    func testRemoveFromThisDeviceForgetsOnlyThatDomain() {
        store.signedIn(on: orbitd, email: "alex@example.com", name: "Alex Morgan", method: .password)
        store.keepPhoto(jpeg, version: "v1", on: orbitd)
        store.signedIn(on: selfHosted, email: "sam@corp.example", name: "Sam", method: .google)
        store.keepPhoto(jpeg, version: "v2", on: selfHosted)

        store.forget(on: orbitd)
        XCTAssertNil(store.account(on: orbitd))
        XCTAssertNil(store.photo(on: orbitd))
        XCTAssertEqual(store.account(on: selfHosted)?.email, "sam@corp.example")
        XCTAssertEqual(store.photo(on: selfHosted), jpeg)
        XCTAssertEqual(photoFiles(), ["10.0.0.5_3000.jpg"])
    }

    func testRemoveAlsoDropsThePreCardEmailWhenItNamesTheSameAccount() {
        store.keep(user("alex@example.com"), on: orbitd)
        defaults.set("ALEX@example.com", forKey: RememberedAccounts.legacyEmailKey)
        store.forget(on: orbitd)
        XCTAssertNil(store.legacyEmail)

        store.keep(user("alex@example.com"), on: orbitd)
        defaults.set("someone@example.com", forKey: RememberedAccounts.legacyEmailKey)
        store.forget(on: orbitd)
        XCTAssertEqual(store.legacyEmail, "someone@example.com", "another account's email is not this one to forget")
    }

    /// Sign out and a 401 both leave the record alone: nothing in them reaches the store, so the only
    /// ways out are the ones above. A failed sign-in never calls `signedIn`.
    func testOnlyRemoveForgets() {
        store.signedIn(on: orbitd, email: "alex@example.com", name: "Alex Morgan", method: .password)
        store.forget(on: selfHosted)
        XCTAssertEqual(store.account(on: orbitd)?.email, "alex@example.com")
    }

    // MARK: - The pre-card email

    func testThePreCardEmailFillsTheEmptyFormUntilTheFirstSignIn() {
        defaults.set("old@example.com", forKey: RememberedAccounts.legacyEmailKey)
        XCTAssertEqual(store.email(toShowOn: orbitd), "old@example.com")
        XCTAssertEqual(store.email(toShowOn: selfHosted), "old@example.com", "one key for every server, as before")

        store.signedIn(on: selfHosted, email: "sam@corp.example", name: "Sam", method: .password)
        XCTAssertNil(store.legacyEmail)
        XCTAssertNil(defaults.object(forKey: RememberedAccounts.legacyEmailKey), "the old key is deleted")
        XCTAssertEqual(store.email(toShowOn: selfHosted), "sam@corp.example", "behind the card")
        XCTAssertEqual(store.email(toShowOn: orbitd), "", "an empty form")
        XCTAssertEqual(store.email(toShowOn: nil), "")
    }

    // MARK: - What is stored

    /// Only what the card draws: no password, no token, nothing else.
    func testOnlyWhatTheCardDrawsIsStored() throws {
        store.signedIn(on: orbitd, email: "alex@example.com", name: "Alex Morgan", method: .password)
        store.keepPhoto(jpeg, version: "2026-10-10T02:00:00.000Z", on: orbitd)
        let data = try XCTUnwrap(defaults.data(forKey: RememberedAccounts.key))
        let stored = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: [String: Any]])
        XCTAssertEqual(Array(stored.keys), ["orbitd.io"])
        XCTAssertEqual(Set(try XCTUnwrap(stored["orbitd.io"]).keys), ["email", "name", "method", "photoVersion"])
        XCTAssertEqual(stored["orbitd.io"]?["method"] as? String, "password")
        XCTAssertEqual(photoFiles(), ["orbitd.io.jpg"])
    }

    func testStorageThatCantBeReadIsNoAccount() {
        defaults.set(Data("not json".utf8), forKey: RememberedAccounts.key)
        XCTAssertNil(store.account(on: orbitd))
        store.signedIn(on: orbitd, email: "alex@example.com", name: nil, method: .password)
        XCTAssertEqual(store.account(on: orbitd)?.email, "alex@example.com")
    }

    func testTheLastAccountGoneLeavesNothingBehind() {
        store.signedIn(on: orbitd, email: "alex@example.com", name: nil, method: .password)
        store.forget(on: orbitd)
        XCTAssertNil(defaults.object(forKey: RememberedAccounts.key))
    }

    func testTheCardNamesTheAccountByItsNameElseItsEmail() {
        XCTAssertEqual(RememberedAccount(email: "alex@example.com", name: "Alex Morgan", method: .password).displayName,
                       "Alex Morgan")
        XCTAssertEqual(RememberedAccount(email: "alex@example.com", method: .password).displayName, "alex@example.com")
        XCTAssertEqual(RememberedAccount(email: "alex@example.com", name: "  ", method: .google).displayName,
                       "alex@example.com")
    }

    // MARK: - What the page offers under the card

    private let google = SignInMethods(password: true, google: true, googleSignup: false)

    func testAPasswordAccountIsOfferedOnlyItsPassword() {
        for methods in [google, .passwordOnly] {
            for answered in [false, true] {
                let ways = LoginWaysIn.offered(card: .password, methods: methods, answered: answered)
                XCTAssertEqual(ways, LoginWaysIn(password: true, google: false))
                XCTAssertFalse(ways.or)
            }
        }
    }

    func testAGoogleAccountIsOfferedOnlyGoogleOnceTheServerSaysSo() {
        XCTAssertEqual(LoginWaysIn.offered(card: .google, methods: google, answered: true),
                       LoginWaysIn(password: false, google: true))
        // While the server is asked: nothing, rather than a password field that would vanish.
        XCTAssertEqual(LoginWaysIn.offered(card: .google, methods: .passwordOnly, answered: false),
                       LoginWaysIn(password: false, google: false))
        // A server without Google, or one that can't be reached (read as password only).
        XCTAssertEqual(LoginWaysIn.offered(card: .google, methods: .passwordOnly, answered: true),
                       LoginWaysIn(password: true, google: false))
    }

    /// An account recorded while signed in, and the full form: as the page was before the cards.
    func testAnUnknownWayInAndTheFullFormOfferEverythingTheServerHas() {
        for card in [RememberedAccount.Method.unknown, nil] {
            let both = LoginWaysIn.offered(card: card, methods: google, answered: true)
            XCTAssertEqual(both, LoginWaysIn(password: true, google: true))
            XCTAssertTrue(both.or)
            XCTAssertEqual(LoginWaysIn.offered(card: card, methods: .passwordOnly, answered: false),
                           LoginWaysIn(password: true, google: false))
            XCTAssertEqual(LoginWaysIn.offered(card: card, methods: .passwordOnly, answered: true),
                           LoginWaysIn(password: true, google: false))
        }
    }

    /// GoogleSignInWiringTests' rule, kept under the card: no Google before, or without, the server's
    /// yes — and an answer that isn't this server's (the one before a switch) is no yes.
    func testGoogleIsNeverOfferedWithoutTheServersYes() {
        let noGoogle = [SignInMethods.passwordOnly, SignInMethods(password: true, google: false, googleSignup: true)]
        for card in [RememberedAccount.Method.password, .google, .unknown, nil] {
            for methods in noGoogle {
                for answered in [false, true] {
                    XCTAssertFalse(LoginWaysIn.offered(card: card, methods: methods, answered: answered).google,
                                   "\(String(describing: card)) \(methods) answered=\(answered)")
                }
            }
            XCTAssertFalse(LoginWaysIn.offered(card: card, methods: google, answered: false).google,
                           "\(String(describing: card)): another server's yes")
        }
    }
}
