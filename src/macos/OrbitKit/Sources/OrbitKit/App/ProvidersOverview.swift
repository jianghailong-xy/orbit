import Foundation

/// Settings → Providers on iOS: where the account's models come from, read-only — the web's
/// Providers page in its own three groups and words (`SettingsCopyParityTests` reads them back out
/// of the web source). Adding or editing a key stays on the web; signing an engine in is a runner's
/// page, which each runner row here opens.
public enum ProvidersOverview {
    public static let onYourRunners = "On your runners"
    public static let onYourRunnersDetail = "Signed in on the machine itself — a session spends that subscription, nothing to paste."
    public static let accountPools = "Account pools"
    public static let accountPoolsDetail = "Several Claude subscriptions under one name — each session starts on the account with the most room in its 5-hour window."
    public static let apiKeys = "Your API keys"
    public static let apiKeysDetail = "On your account and usable from every runner — billed per token."
    public static let noKeys = "No keys yet"
    public static let editOnWeb = "Adding or changing a key happens on the web."

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

    /// A pool's line: why nothing in it can run, when that is so; otherwise how many accounts it holds.
    public static func poolSummary(_ pool: ProviderPool) -> String {
        if let unavailable = pool.unavailable { return unavailable }
        let n = pool.members.count
        return "\(n) account\(n == 1 ? "" : "s")"
    }
}
