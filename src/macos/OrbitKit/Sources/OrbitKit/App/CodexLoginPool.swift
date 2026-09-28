import Foundation

/// A Codex pool of the user's own ChatGPT account (migration 0323) on iOS — the web's `withLogin`
/// (lib/codexLogin.ts) and its pool page (`CodexPoolPage` in ProviderPoolPage.tsx) in their words: the
/// one account it runs on, where that account stands, its windows with when each resets, and what its
/// owner — the only person who ever sees the pool — can do about it. `CodexSignInCopyParityTests` holds
/// every word here to the web source.
public enum CodexLoginPool {
    // MARK: drawing it as a pool

    /// A Codex pool of one's own: one ChatGPT account, not a set of member keys.
    public static func isLoginPool(_ pool: ProviderPool) -> Bool {
        pool.engine == "codex" && pool.shared == nil
    }

    /// What the pool head says while nothing can run, in the words it has room for.
    public static let notSignedIn = "Not signed in"
    public static let signedOutWords = "Signed out"

    /// The pool's one member, read off its account, and what the pool says of itself (web's
    /// `withLogin`): why nothing can run, and until when a spent account waits.
    static func drawn(slug: String, login: CodexLogin?, now: Date = Date())
        -> (members: [PoolMember], unavailable: String?, resetsAt: String?) {
        guard let login else { return ([], notSignedIn, nil) }
        let state = state(login, now: now)
        let resetsAt = state == .spent ? spentUntil(login, now: now) ?? nil : nil
        let member = PoolMember(id: "login:\(login.fingerprint)", slug: slug, label: name(login),
                                presetSlug: "openai", enabled: true, planUsage: login.usage,
                                state: state, resetsAt: resetsAt, next: state == .available,
                                login: login)
        return ([member], state == .signedOut ? signedOutWords : nil, resetsAt)
    }

    /// Where the account stands: OpenAI's refusal first, then a used-up window, else it runs.
    public static func state(_ login: CodexLogin, now: Date = Date()) -> PoolMemberState {
        guard login.active else { return .signedOut }
        return spentUntil(login, now: now) == nil ? .available : .spent
    }

    /// Until when a spent account waits: `.some(latest reset)` of the windows it used up — `.some(nil)`
    /// for a spent window that named no reset — and nil while none is spent. A reset already behind
    /// `now` is a reading from before its window turned over: it runs again.
    public static func spentUntil(_ login: CodexLogin, now: Date = Date()) -> String?? {
        guard let rows = login.usage?.rows else { return nil }
        let spent = rows.filter { $0.window.utilization >= 100 }
        guard !spent.isEmpty else { return nil }
        let latest = spent.compactMap(\.window.resetsAt)
            .compactMap { iso in RelativeTime.parse(iso).map { (iso, $0) } }
            .max { $0.1 < $1.1 }
        if let latest, latest.1 <= now { return nil }
        return .some(latest?.0)
    }

    // MARK: the account

    /// What the account is called wherever it is named: its email, when its sign-in carried one.
    public static func name(_ login: CodexLogin) -> String { login.email ?? "ChatGPT account" }

    /// `Plus` for `plus`: the plan as OpenAI's own pages name it.
    static func planName(_ plan: String?) -> String? {
        guard let plan, let first = plan.first else { return nil }
        return first.uppercased() + plan.dropFirst()
    }

    /// The account's second line: `ChatGPT Plus · …AB12`.
    public static func line(_ login: CodexLogin) -> String {
        let plan = planName(login.plan).map { "ChatGPT \($0)" } ?? "ChatGPT"
        return "\(plan) · \(login.fingerprint)"
    }

    /// Each window the account's quota reports, in the order the pages draw them.
    public static func windows(_ login: CodexLogin) -> [PlanUsageRow] { login.usage?.rows ?? [] }

    /// "resets 14:05" under a window's gauge, or nil when it names no reset.
    public static func resets(_ row: PlanUsageRow, now: Date = Date(), timeZone: TimeZone = .current) -> String? {
        guard let iso = row.window.resetsAt,
              let time = ProviderPools.formatResetTime(iso, now: now, timeZone: timeZone) else { return nil }
        return "resets \(time)"
    }

    /// Nothing has read the account's quota yet — which is not a refusal: it runs.
    public static let noQuota = "No quota reported"
    /// Why a signed-out account is out, and what brings it back.
    public static let signedOutReason = "OpenAI signed this account out — sign in again to put it back in the pool."

    // MARK: its page

    public static let pageTitle = "Codex pool"
    public static let justMe = "Just me"
    public static let accountHeader = "Account"
    /// The web page's sentence under the pool's name; on a phone, the Account section's footer.
    public static let accountFooter = "Sessions run on your own ChatGPT account, and its sign-in stays on the Orbit server."
    public static let noAccount = "No account yet — no session can start on this pool until you sign in with ChatGPT."
    public static let signIn = "Sign in with ChatGPT"
    public static let signInAgain = "Sign in again"

    /// The Account header's trailing words (web's `PoolGauge`): the account, named — one account is no
    /// "next" — or, with nothing to run on, when it frees up or why.
    public static func headline(_ pool: ProviderPool, now: Date = Date(), timeZone: TimeZone = .current) -> String {
        if let member = pool.members.first(where: \.next) { return member.label }
        if let unavailable = pool.unavailable { return unavailable }
        return ProviderPools.spentNote(pool, now: now, timeZone: timeZone) ?? "No account can run"
    }

    /// The Providers row's second line: whose pool it is, and the account it runs on.
    public static func overviewLine(_ pool: ProviderPool) -> String {
        guard let login = pool.login else { return justMe }
        return "\(justMe) · \(name(login))"
    }

    /// The Providers row's value: where the account stands, or why there is none to run on.
    public static func overviewValue(_ pool: ProviderPool, now: Date = Date(), timeZone: TimeZone = .current) -> String {
        if let unavailable = pool.unavailable { return unavailable }
        guard let member = pool.members.first else { return notSignedIn }
        return ProviderPools.memberStatus(member, now: now, timeZone: timeZone).label
    }

    // MARK: signing out, deleting

    public static let signOut = "Sign out"
    public static func signOutTitle(_ login: CodexLogin) -> String { "Sign out \(name(login))?" }
    public static let signOutNote = "Its sign-in is deleted from the Orbit server, and no session runs on this pool until you sign in again."
    public static func signedOut(_ login: CodexLogin?) -> String {
        "\(login.map(name) ?? "The account") is signed out"
    }

    public static let deletePool = "Delete pool"
    public static func deleteTitle(_ pool: ProviderPool) -> String { "Delete \(pool.label)?" }
    public static let delete = "Delete"
    public static let deleteNote = "Its ChatGPT sign-in is deleted from the Orbit server with it."
}
