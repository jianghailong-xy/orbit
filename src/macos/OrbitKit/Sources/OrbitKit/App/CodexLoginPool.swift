import Foundation

/// A Codex pool of the user's own ChatGPT accounts (migration 0323) on iOS — the web's `withLogin`
/// (lib/codexLogin.ts) and its pool page (`CodexPoolPage` in ProviderPoolPage.tsx) in their words: every
/// account it holds, where each one stands, its windows with when each resets, and what its owner — the
/// only person who ever sees the pool — can do about them. `CodexSignInCopyParityTests` holds every word
/// here to the web source.
public enum CodexLoginPool {
    // MARK: drawing it as a pool

    /// A Codex pool of one's own: ChatGPT accounts, not a set of member keys.
    public static func isLoginPool(_ pool: ProviderPool) -> Bool {
        pool.engine == "codex" && pool.shared == nil
    }

    /// What the pool head says while nothing can run, in the words it has room for.
    public static let notSignedIn = "Not signed in"
    public static let signedOutWords = "Signed out"

    /// Every account the pool holds, oldest first (web's `poolLogins`): the server's `logins`, and — from
    /// an older server, which names only one — the pool's `login` as that one.
    public static func logins(_ pool: ProviderPool) -> [CodexLogin] {
        logins(pool.logins, login: pool.login)
    }

    static func logins(_ logins: [CodexLogin]?, login: CodexLogin?) -> [CodexLogin] {
        logins ?? login.map { [$0] } ?? []
    }

    /// The pool's members, one per account it holds, and what the pool says of itself (web's
    /// `withLogin`): why nothing can run, and until when a spent account waits.
    static func drawn(slug: String, logins: [CodexLogin], now: Date = Date())
        -> (members: [PoolMember], unavailable: String?, resetsAt: String?) {
        guard !logins.isEmpty else { return ([], notSignedIn, nil) }
        let members = logins.enumerated().map { index, login in
            member(slug: slug, login: login, first: index == 0, now: now)
        }
        // Only ever a mark of the pool as a whole: the EARLIEST of the spent accounts' resets — one
        // account freeing up is enough for work to continue.
        let resetsAt = members.compactMap(\.resetsAt)
            .min { (RelativeTime.parse($0) ?? .distantFuture) < (RelativeTime.parse($1) ?? .distantFuture) }
        return (members, members[0].state == .signedOut ? signedOutWords : nil, resetsAt)
    }

    /// One of the pool's accounts as a member of it. The first is the account its sessions run on — the
    /// server's `login` — so it is the one a session starting now uses, and the row that says NEXT.
    private static func member(slug: String, login: CodexLogin, first: Bool, now: Date) -> PoolMember {
        let state = state(login, now: now)
        return PoolMember(id: "login:\(login.fingerprint)", slug: slug, label: name(login),
                          presetSlug: "openai", enabled: true, planUsage: login.usage, state: state,
                          resetsAt: state == .spent ? spentUntil(login, now: now) ?? nil : nil,
                          next: first && state == .available, login: login)
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

    /// Whether the account's row wears NEXT (`SharedPoolPage.nextChip`, web's `LoginRow`): with one
    /// account there is nothing to choose between, so the mark would say nothing.
    public static func showsNext(_ member: PoolMember, in pool: ProviderPool) -> Bool {
        member.next && pool.members.count > 1
    }

    // MARK: its page

    public static let pageTitle = "Codex pool"
    public static let justMe = "Just me"
    /// The Accounts card's head, beside how many accounts the pool holds.
    public static let accountsHeader = "Accounts"
    /// The web page's sentence under the pool's name, after whose it is and how many of its accounts can
    /// run (`summary`); on a phone, the Accounts section's footer.
    public static let accountsFooter = "Each session starts on the account whose quota resets soonest, and stays on it until that one runs out."
    public static let noAccount = "No account yet — no session can start on this pool until you sign in with ChatGPT."
    /// Always on the page: a pool of one's own takes one account after another, and a signed-out one
    /// comes back from its row (`signInAgain`).
    public static let addAccount = "Add account"
    public static let signInAgain = "Sign in again"

    /// Whose the pool is and how many of its accounts a session could start on now — "Just me · 2 of 2
    /// accounts available", the web card's head and the page's line under the pool's name alike.
    public static func summary(_ pool: ProviderPool) -> String {
        "\(justMe) · \(ProviderPools.pageSubtitle(pool))"
    }

    /// The Providers row's value: the head's gauge (web's `PoolGauge`) less the account's name, which a
    /// phone's row has no room for — the tightest window of the account the next session starts on — or,
    /// with none to start on, when the first frees up or why.
    public static func overviewValue(_ pool: ProviderPool, now: Date = Date(), timeZone: TimeZone = .current) -> String {
        ProviderPools.headGauge(pool)?.label ?? ProviderPools.headline(pool, now: now, timeZone: timeZone)
    }

    // MARK: signing out, deleting

    public static let signOut = "Sign out"
    /// The row's sign-out mark, named for a screen reader.
    public static func signOutLabel(_ login: CodexLogin) -> String { "Sign out \(name(login))" }
    public static func signOutTitle(_ login: CodexLogin) -> String { "Sign out \(name(login))?" }
    /// What signing one account out does: with others in the pool it keeps running on them, said in the
    /// plural when more than one stays; the only one, and nothing runs on the pool.
    public static func signOutNote(_ pool: ProviderPool) -> String {
        let others = pool.members.count - 1
        guard others > 0 else {
            return "Its sign-in is deleted from the Orbit server, and no session runs on this pool until you sign in again."
        }
        return "Its sign-in is deleted from the Orbit server, and no session runs on it until you sign in again — "
            + "\(pool.label) keeps running on its other account\(others == 1 ? "" : "s")."
    }
    public static func signedOut(_ login: CodexLogin) -> String { "\(name(login)) is signed out" }

    public static let deletePool = "Delete pool"
    public static func deleteTitle(_ pool: ProviderPool) -> String { "Delete \(pool.label)?" }
    public static let delete = "Delete"
    public static func deleteNote(_ pool: ProviderPool) -> String {
        "Its ChatGPT sign-in\(logins(pool).count == 1 ? " is" : "s are") deleted from the Orbit server with it."
    }
}
