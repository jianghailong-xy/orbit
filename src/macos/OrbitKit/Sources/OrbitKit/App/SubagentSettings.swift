import Foundation

// SubAgents settings and the Providers page's Model tiers table (docs/subagent-design.md §7, board
// docs/mocks/subagent/05.png). The wire shapes mirror src/shared/src/dto.ts `SubagentTiersResponse`;
// the words and the small rules both clients draw alike live here so they are testable off Apple.

/// One model of a provider in GET /providers/subagent-tiers: the tiers routeSubagent reads for it.
public struct ProviderModelTier: Codable, Equatable, Sendable, Identifiable {
    public let model: String
    /// The tiers this model fills, lowest first ("S", "M", "L", "XL"). Empty: not routed.
    public let levels: [String]
    /// `catalogue`, `owner`, or nil when nobody has set one.
    public let source: String?
    /// The owner may set or clear it (PATCH /providers/mine/:providerId/model-tier).
    public let editable: Bool
    /// USD per million output tokens, when known.
    public let outputPricePerMTok: Double?

    public var id: String { model }

    public init(model: String, levels: [String], source: String? = nil, editable: Bool = false,
                outputPricePerMTok: Double? = nil) {
        self.model = model
        self.levels = levels
        self.source = source
        self.editable = editable
        self.outputPricePerMTok = outputPricePerMTok
    }

    private enum CodingKeys: String, CodingKey { case model, levels, source, editable, outputPricePerMTok }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        model = try c.decode(String.self, forKey: .model)
        levels = try c.decodeIfPresent([String].self, forKey: .levels) ?? []
        source = try c.decodeIfPresent(String.self, forKey: .source)
        editable = try c.decodeIfPresent(Bool.self, forKey: .editable) ?? false
        outputPricePerMTok = try c.decodeIfPresent(Double.self, forKey: .outputPricePerMTok)
    }
}

/// One provider as the SubAgents settings and the Tier column list it, in the owner's provider order.
public struct ProviderTierRow: Codable, Equatable, Sendable, Identifiable {
    /// What `UserPreferences.subagentBlockedProviders` names.
    public let slug: String
    public let label: String
    /// `builtin`, `key` or `pool`.
    public let kind: String
    /// A key of the owner's own: the id the tier write takes.
    public let providerId: String?
    /// `subscription` or `key`.
    public let billing: String
    public let models: [ProviderModelTier]

    public var id: String { slug }

    public init(slug: String, label: String, kind: String = "key", providerId: String? = nil,
                billing: String = "key", models: [ProviderModelTier] = []) {
        self.slug = slug
        self.label = label
        self.kind = kind
        self.providerId = providerId
        self.billing = billing
        self.models = models
    }

    private enum CodingKeys: String, CodingKey { case slug, label, kind, providerId, billing, models }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        slug = try c.decode(String.self, forKey: .slug)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? slug
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "key"
        providerId = try c.decodeIfPresent(String.self, forKey: .providerId)
        billing = try c.decodeIfPresent(String.self, forKey: .billing) ?? "key"
        models = try c.decodeIfPresent([ProviderModelTier].self, forKey: .models) ?? []
    }
}

/// GET /providers/subagent-tiers
public struct SubagentTiersResponse: Codable, Equatable, Sendable {
    public let providers: [ProviderTierRow]
    public init(providers: [ProviderTierRow]) { self.providers = providers }
}

/// PATCH /providers/mine/:id/model-tier: set or clear (nil, sent as JSON null) the owner's tier for one model.
public struct ProviderModelTierUpdate: Encodable, Sendable {
    public let model: String
    public let tier: String?
    public init(model: String, tier: String?) {
        self.model = model
        self.tier = tier
    }

    private enum CodingKeys: String, CodingKey { case model, tier }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(model, forKey: .model)
        // Explicit null clears: an omitted key would not.
        try c.encode(tier, forKey: .tier)
    }
}

public enum SubagentSettings {
    // MARK: words

    public static let groupTitle = "SubAgents"
    public static let enabledTitle = "SubAgents"
    public static let enabledDetail = "Let this agent hand work to other providers in the same folder"
    public static let optimizeFor = "Optimize For"
    public static let providers = "Providers"
    public static let providersDetail = "All enabled providers. Block one to keep SubAgents off it."
    public static let edit = "Edit"
    public static let runningAtOnce = "Running at once"
    public static let runningAtOnceDetail = "Per session, foreground and background together"
    public static let providersLoadFailed = "Couldn't load providers"
    public static let saveBlockedFailed = "Couldn't save blocked providers"

    public static let modelTiers = "Model tiers"
    public static let columnProvider = "Provider"
    public static let columnModel = "Model"
    public static let columnTier = "Tier"
    public static let columnPrice = "Price / M out"
    public static let tiersFooter = "Preset tiers and prices follow the catalogue. A custom endpoint's model "
        + "stays out of automatic routing until it has a tier."
    public static let notSet = "Not set"
    public static let allLevels = "S–XL by effort"
    public static let subscription = "Subscription"
    public static let noPrice = "—"
    public static let clear = "Clear"
    public static let tierSaveFailed = "Couldn't save the tier"

    /// The tiers a model can be given, lowest first.
    public static let tiers = ["S", "M", "L", "XL"]

    // MARK: workspace fields

    /// `modelRoutingOptimizeFor`'s values, in the segmented control's order.
    public enum OptimizeFor: String, CaseIterable, Identifiable, Sendable {
        case cost, balance, intelligence
        public var id: String { rawValue }
        public var label: String {
            switch self {
            case .cost: return "Cost"
            case .balance: return "Balance"
            case .intelligence: return "Intelligence"
            }
        }
        /// An absent or unknown value reads as Cost, the server's default.
        public init(stored: String?) { self = OptimizeFor(rawValue: stored ?? "") ?? .cost }
    }

    public static let defaultMaxRunning = 4
    public static let maxRunningRange = 1...16

    /// A stored count, held to the range the server accepts; absent is the default.
    public static func maxRunning(_ stored: Int?) -> Int {
        min(max(stored ?? defaultMaxRunning, maxRunningRange.lowerBound), maxRunningRange.upperBound)
    }

    // MARK: providers

    /// How many of the listed providers SubAgents may use — every one not blocked.
    public static func allowedCount(_ providers: [ProviderTierRow], blocked: [String]) -> Int {
        let set = Set(blocked)
        return providers.filter { !set.contains($0.slug) }.count
    }

    /// The Providers row's button: "5 of 6 · Edit".
    public static func providersButton(_ providers: [ProviderTierRow], blocked: [String]) -> String {
        "\(allowedCount(providers, blocked: blocked)) of \(providers.count) · \(edit)"
    }

    /// The blocked list after one provider's switch moves: on removes it, off adds it (once).
    public static func blocked(_ blocked: [String], slug: String, allowed: Bool) -> [String] {
        let rest = blocked.filter { $0 != slug }
        return allowed ? rest : rest + [slug]
    }

    // MARK: tiers table

    /// The providers the Model tiers table lists: those with at least one model.
    public static func tableProviders(_ providers: [ProviderTierRow]) -> [ProviderTierRow] {
        providers.filter { !$0.models.isEmpty }
    }

    /// A model's Tier cell: "Not set", "S–XL by effort", or the levels joined ("L · XL").
    public static func tierText(_ levels: [String]) -> String {
        if levels.isEmpty { return notSet }
        if Set(levels) == Set(tiers) { return allLevels }
        return levels.joined(separator: " · ")
    }

    /// Whether the Tier cell warns: a model with no tier stays out of automatic routing.
    public static func tierIsUnset(_ levels: [String]) -> Bool { levels.isEmpty }

    /// A model's Price / M out cell.
    public static func priceText(_ model: ProviderModelTier, billing: String) -> String {
        if let price = model.outputPricePerMTok { return "$" + String(format: "%.2f", price) }
        return billing == "subscription" ? subscription : noPrice
    }

    /// Whether the tier menu offers Clear: only where a tier is set.
    public static func menuOffersClear(_ levels: [String]) -> Bool { !levels.isEmpty }
}
