import Foundation

/// Settings → Providers on iOS: where the account's models come from — the web's Providers page in
/// its own three groups and words (`SettingsCopyParityTests` reads them back out of the web source).
/// Adding or editing a key stays on the web; signing an engine in is a runner's page, which each
/// runner row here opens; a pool's row opens the pool's page, where a shared pool is run from.
public enum ProvidersOverview {
    public static let onYourRunners = "On your runners"
    public static let onYourRunnersDetail = "Signed in on the machine itself — a session spends that subscription, nothing to paste."
    public static let accountPools = "Account pools"
    public static let accountPoolsDetail = "Several keys under one name — each session starts on the one with the most room, and moves on when it runs out."
    public static let apiKeys = "Your API keys"
    public static let apiKeysDetail = "On your account and usable from every runner — billed per token."
    public static let noKeys = "No keys yet"
    public static let editOnWeb = "Adding or changing a key happens on the web."
    /// A pool's page when the pool has gone — deleted, or left — as the web page says it.
    public static let poolGone = "That pool no longer exists."

    /// A runner's line: how many of its engines are signed in (web's `summaryOf`, counted over the
    /// engines the page lists), and first that it is offline when it is — the machine can't take
    /// work then, whatever its engines say.
    public static func runnerSummary(_ runner: Runner) -> String {
        guard let engines = runner.engines else { return "Engines not reported" }
        let all = LoginEngine.allCases
        let ready = all.filter { engine in engines.contains { $0.engine == engine.rawValue && $0.signedIn } }.count
        let line = ready == all.count ? "All signed in" : "\(ready) of \(all.count) signed in"
        return runner.online == true ? line : "Offline · \(line)"
    }

    /// A pool's value: why nothing in it can run, when that is so; otherwise how many of its accounts
    /// a session could start on now, in the words a phone gives the web card's head ("2 of 3
    /// available" — the web drops "accounts" at that width to keep the pool's name).
    public static func poolSummary(_ pool: ProviderPool) -> String {
        if let unavailable = pool.unavailable { return unavailable }
        return "\(ProviderPools.readyCount(pool)) of \(pool.members.count) available"
    }

    /// A shared pool's value: how many of its keys a session could start on now.
    public static func sharedPoolSummary(_ pool: SharedPool) -> String {
        "\(SharedPoolPage.availableCount(pool)) of \(pool.keys.count) available"
    }

    /// A shared pool's second line, under its name: "Shared · 4 members".
    public static func sharedPoolLine(_ pool: SharedPool) -> String {
        "Shared · \(SharedPoolPage.plural(pool.people.count, "member"))"
    }
}
