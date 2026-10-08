import Foundation

/// The DeepSeek account balance behind one of the account's own DeepSeek keys, as Settings → Providers
/// and the key's page draw it (web's `DeepSeekBalance.tsx` and `lib/deepseekBalance.ts`). The server
/// asks DeepSeek with the stored key — which never reaches this client — and answers with the balance
/// of the whole account, not what Orbit or a session spent: DeepSeek has no spend API to ask.
///
/// Every amount drawn is DeepSeek's own answer. Until there is one the state is `loading`, and a read
/// that failed is `failed` with why — never a 0 standing in for a number. The words both clients say
/// alike are the web's (`DeepSeekBalanceCopyParityTests` reads them back out of the web source).
public enum DeepSeekBalance {
    // MARK: words

    public static let title = "DeepSeek account balance"
    public static let topUp = "Top up on DeepSeek"
    /// Where DeepSeek takes a top-up. Orbit can't top up for anyone; it only opens the page.
    public static let topUpURL = URL(string: "https://platform.deepseek.com/top_up")!
    public static let total = "Total"
    public static let granted = "Granted"
    public static let toppedUp = "Topped up"
    public static let refresh = "Refresh"
    public static let retry = "Retry"
    public static let updated = "Updated"
    public static let lastTried = "Last tried"
    public static let balance = "Balance"
    public static let unknown = "Unknown"
    public static let checking = "Checking balance…"
    /// A DeepSeek key's row on Settings → Providers when there is no balance to put at its end.
    public static let unavailable = "Unavailable"
    public static let failedTitle = "Couldn't get the balance"
    public static let lowTitle = "Balance too low — DeepSeek calls will fail"
    public static let lowDetail =
        "Every session using a key on this account will fail at its next request. Orbit can't top up for you."
    public static let multiCurrency = "Each currency is a separate balance; DeepSeek doesn't convert between them."
    /// The web's note, in the fewer words a phone's footnote has room for.
    public static let note = "The balance of the whole DeepSeek account this key belongs to — everything using that "
        + "account draws on it, so it isn't what Orbit or a session spent. Granted credit is spent first."
    public static let opensInSafari = "Opens platform.deepseek.com/top_up in Safari."
    public static let noAmountYet = "No amount is shown until DeepSeek answers."
    /// What to do about a rejected key from a phone, which can't change one.
    public static let changeKeyOnWeb = "Change the key on the web, then retry."
    public static let providerHeader = "Provider"
    public static let runsOn = "Runs on"
    public static let defaultModel = "Default model"
    public static let endpoint = "Endpoint"

    // MARK: which keys

    private static let presets: Set<String> = ["deepseek", "deepseek-harness"]

    /// Whether one of the account's own providers (GET /providers/mine) has a DeepSeek account balance:
    /// a stored key of DeepSeek's — one of its two presets, or a custom endpoint on DeepSeek's own
    /// host. The server applies the same test (deepseek-balance.ts) and refuses any other provider.
    public static func applies(to provider: ConfiguredProvider) -> Bool {
        guard provider.hasApiKey == true else { return false }
        if let preset = provider.presetSlug { return presets.contains(preset) }
        guard let base = provider.baseUrl, let host = URL(string: base)?.host else { return false }
        return host.lowercased() == "api.deepseek.com"
    }

    /// The account's own DeepSeek key a row of Settings → Providers stands for — the row that opens the
    /// key's page and ends with its balance. The key list is the pickers' catalogue (GET /providers),
    /// which carries no id or endpoint, so the row is matched by slug among the account's own providers
    /// (GET /providers/mine). Nil for any other row.
    public static func key(for row: ConfiguredProvider, mine: [ConfiguredProvider]) -> ConfiguredProvider? {
        mine.first { $0.slug == row.slug && $0.providerID != nil && applies(to: $0) }
    }

    // MARK: what a read comes to

    public enum Failure: Equatable, Sendable {
        /// DeepSeek refused the key (401/403).
        case keyRejected
        /// DeepSeek was not reached, or not in time.
        case network
        /// DeepSeek answered with an error, or with something that is not a balance.
        case upstream
        /// The request never got an answer from Orbit's server.
        case unreachable
    }

    public enum State: Equatable, Sendable {
        case loading
        /// DeepSeek's balance, one entry per currency; `low` when DeepSeek says the account can't pay
        /// for more requests (`is_available` false).
        case read(balances: [ProviderBalanceAmount], low: Bool, fetchedAt: String, sharedWith: [ProviderBalanceSibling])
        /// No balance: why, in the server's sentence or the request's, and when it was tried.
        case failed(Failure, message: String, triedAt: String?)
    }

    public static func state(_ reading: ProviderBalanceReading?) -> State {
        guard let reading else { return .loading }
        switch reading {
        case .unreachable(let why):
            return .failed(.unreachable, message: why, triedAt: nil)
        case .answered(let answer):
            if answer.ok {
                // A read with no currency in it is no balance at all — never an empty, or zero, one.
                guard let balances = answer.balances, !balances.isEmpty, let available = answer.isAvailable else {
                    return .failed(.upstream, message: failedTitle, triedAt: answer.fetchedAt)
                }
                return .read(balances: balances, low: !available, fetchedAt: answer.fetchedAt,
                             sharedWith: answer.sharedWith ?? [])
            }
            let failure: Failure
            switch answer.reason {
            case "KEY_REJECTED": failure = .keyRejected
            case "NETWORK": failure = .network
            default: failure = .upstream
            }
            return .failed(failure, message: answer.message ?? failedTitle, triedAt: answer.fetchedAt)
        }
    }

    /// What a failure says: the server's sentence about what happened, then — for a rejected key —
    /// what to do about it from here.
    public static func detail(_ failure: Failure, message: String) -> String {
        failure == .keyRejected ? "\(message) \(changeKeyOnWeb)" : message
    }

    /// What a DeepSeek key's row says at its end on Settings → Providers: the total — every currency,
    /// red once the account can't pay — or "Unavailable", orange, when there is no balance to show.
    /// Nothing while it loads.
    public static func rowValue(_ state: State) -> PoolStatus? {
        switch state {
        case .loading:
            return nil
        case .read(let balances, let low, _, _):
            let totals = balances.map { amount($0.totalBalance, currency: $0.currency) }
            return PoolStatus(label: totals.joined(separator: " · "), tone: low ? .danger : .neutral)
        case .failed:
            return PoolStatus(label: unavailable, tone: .warning)
        }
    }

    /// The footnote's last line about the other providers holding the same key, in three parts so
    /// their names can be set in bold: "Same DeepSeek account as ", "DeepSeek Harness", " — both show
    /// this balance." Nil when no other provider holds it.
    public static func sameAccount(_ siblings: [ProviderBalanceSibling]) -> (lead: String, names: String, tail: String)? {
        guard let last = siblings.last else { return nil }
        let names = siblings.count == 1
            ? last.label
            : siblings.dropLast().map(\.label).joined(separator: ", ") + " and " + last.label
        let tail = siblings.count == 1 ? " — both show this balance." : " — all show this balance."
        return (lead: "Same DeepSeek account as ", names: names, tail: tail)
    }

    // MARK: amounts and times

    /// An amount as DeepSeek wrote it, with two decimals and its currency's sign: "¥110.00", "$5.00",
    /// "¥12,345.60", or "12.30 EUR" for a currency without one here (web's `formatBalance`).
    public static func amount(_ value: String, currency: String) -> String {
        let text = Double(value).map(twoDecimals) ?? value
        switch currency {
        case "CNY": return "¥\(text)"
        case "USD": return "$\(text)"
        default: return "\(text) \(currency)"
        }
    }

    private static func twoDecimals(_ number: Double) -> String {
        let fixed = String(format: "%.2f", Swift.abs(number))
        let parts = fixed.split(separator: ".", maxSplits: 1)
        var whole = String(parts[0])
        var grouped = ""
        while whole.count > 3 {
            grouped = "," + whole.suffix(3) + grouped
            whole = String(whole.dropLast(3))
        }
        return (number < 0 ? "-" : "") + whole + grouped + "." + (parts.count > 1 ? parts[1] : "00")
    }

    /// One currency's granted and topped-up shares of its bar, each 0…1.
    public struct Split: Equatable, Sendable {
        public let granted: Double
        public let toppedUp: Double
    }

    /// The shares of one currency's bar — nil when DeepSeek's two parts add up to nothing to split.
    public static func split(_ amount: ProviderBalanceAmount) -> Split? {
        guard let granted = Double(amount.grantedBalance), let toppedUp = Double(amount.toppedUpBalance),
              granted >= 0, toppedUp >= 0, granted + toppedUp > 0 else { return nil }
        return Split(granted: granted / (granted + toppedUp), toppedUp: toppedUp / (granted + toppedUp))
    }

    /// "Just now", "2 min ago", "3 h ago", "2 d ago": when the server last asked DeepSeek (web's
    /// `balanceAgo`, as a value rather than inside a sentence).
    public static func ago(_ iso: String, now: Date = Date()) -> String {
        guard let date = RelativeTime.parse(iso) else { return unknown }
        let minutes = Int(now.timeIntervalSince(date) / 60)
        if minutes < 1 { return "Just now" }
        if minutes < 60 { return "\(minutes) min ago" }
        let hours = minutes / 60
        return hours < 24 ? "\(hours) h ago" : "\(hours / 24) d ago"
    }

    // MARK: the key itself

    /// The engine a DeepSeek key's sessions run on, as Providers names it.
    public static func engine(of provider: ConfiguredProvider) -> String {
        switch provider.runtime {
        case "dsh": return "DeepSeek Harness"
        case "codex": return "Codex"
        default: return "Claude Code"
        }
    }

    /// The host a key's endpoint is on — `api.deepseek.com` — which is all of it a phone's row has room for.
    public static func endpointHost(_ provider: ConfiguredProvider) -> String? {
        provider.baseUrl.flatMap { URL(string: $0)?.host }
    }
}
