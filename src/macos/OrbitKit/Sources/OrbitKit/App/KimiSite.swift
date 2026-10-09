import Foundation

/// Kimi Code's two sign-in sites (web `KIMI_SITE`, RunnerSignIn.tsx). kimi.com and kimi.ai keep
/// separate accounts, and left to itself the CLI signs in on the site its installer came from — so a
/// Kimi sign-in starts by naming the site the account is on, and each page of it says which site it
/// is on. The words are the web's, held to them by `KimiSiteCopyParityTests`.
public enum KimiSite: String, CaseIterable, Sendable, Identifiable {
    case mainlandCN = "mainland-cn"
    case global

    public var id: String { rawValue }

    /// What the user knows the site by.
    public var domain: String {
        switch self {
        case .mainlandCN: return "kimi.com"
        case .global: return "kimi.ai"
        }
    }

    /// Whose accounts it holds, under the domain.
    public var place: String {
        switch self {
        case .mainlandCN: return "Mainland China"
        case .global: return "International"
        }
    }

    public var other: KimiSite { self == .global ? .mainlandCN : .global }

    /// The site a device-flow page belongs to, read off the address the CLI printed rather than the
    /// site asked for: it is the page the user is about to sign in on. Nil for any other host.
    public static func of(url: URL?) -> KimiSite? {
        guard let host = url?.host?.lowercased() else { return nil }
        if host == "kimi.ai" || host.hasSuffix(".kimi.ai") { return .global }
        if host == "kimi.com" || host.hasSuffix(".kimi.com") { return .mainlandCN }
        return nil
    }

    /// What a runner declares when it signs Kimi in on the site a start names (shared
    /// `KIMI_LOGIN_REGION_V1`). One that doesn't runs a bare `kimi login`.
    public static let loginRegionCapability = "kimi-login-region/v1"

    /// Whether `runner` can be told the site (`named`).
    public static func choosable(on runner: Runner?) -> Bool {
        runner?.capabilities?.contains(loginRegionCapability) == true
    }

    /// What a press on `site` names to `runner`. Both sites can always be pressed: kimi.ai is named
    /// always, kimi.com only where the runner can be told a site. One too old to be told signs in where
    /// its CLI decides — kimi.com, on an install Orbit made — so kimi.com goes to it unnamed, and it is
    /// refused kimi.ai in words that say to update it (web RunnerSignIn `kimiSiteToName`).
    public static func named(_ site: KimiSite, on runner: Runner?) -> KimiSite? {
        choosable(on: runner) || site == .global ? site : nil
    }

    /// The site `runner`'s Kimi login is on, as its probe last reported.
    public static func current(on runner: Runner?) -> KimiSite? {
        current(of: runner?.engines?.first(where: { $0.engine == "kimi" }))
    }

    /// The site one engine report says Kimi's login is on — nil for every other engine.
    public static func current(of health: RunnerEngineHealth?) -> KimiSite? {
        guard let health, health.engine == "kimi" else { return nil }
        return health.kimiRegion.flatMap(KimiSite.init(rawValue:))
    }

    /// The site one of Kimi's accounts signed in on, as its probe last reported: each account's own,
    /// since two accounts can be on different sites. Nil before its first sign-in, and for every other
    /// engine's accounts.
    public static func site(of account: RunnerEngineAccount?) -> KimiSite? {
        account?.kimiRegion.flatMap(KimiSite.init(rawValue:))
    }

    /// The site a sign-in card marks Current: that of the login it signs in again — the account's own
    /// (`site(of:)`), Default's being the engine's — and none on a card adding an account, which has no
    /// login yet (web RunnerSignIn `currentSite`).
    public static func current(on runner: Runner?, account: String?, adding: Bool) -> KimiSite? {
        guard !adding else { return nil }
        guard let account, account != CodexAccounts.defaultID else { return current(on: runner) }
        return site(of: runner?.engines?.first { $0.engine == "kimi" }?.accounts?.first { $0.id == account })
    }

    // MARK: words (web RunnerSignIn.tsx)

    public static let question = "Which Kimi account are you signing in with?"
    public static let separateAccounts = "The two sites keep separate accounts — pick the one you signed up on."
    public static let currentMark = "Current"
    public var openPage: String { "Open the \(domain) sign-in page" }
    /// The device code's one press — copy it, open the page it goes into — naming the site.
    public var copyCodeAndOpen: String { "Copy Code & Open \(domain)" }
    public var enterCode: String { "Sign in with your \(domain) account there, then enter this one-time code:" }
    /// The same step on a card adding an account: the account wanted is the new one, on this site.
    public var enterCodeAdding: String {
        "Sign in with the \(domain) account you are adding, then enter this one-time code:"
    }
    public var useInstead: String { "Use \(domain) instead" }
}
