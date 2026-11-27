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
    /// The owner may set or clear it: a key's model (PATCH /providers/mine/:providerId/model-tier), or any model
    /// of a built-in engine's catalogue (PATCH /providers/builtin/:slug/model-tier).
    public let editable: Bool
    /// USD per million output tokens, when known.
    public let outputPricePerMTok: Double?
    /// Set on a built-in engine's older family model: the newest model of its family, which routing uses instead.
    public let supersededBy: String?
    /// How well this model completed work, for display only (docs/subagent-design.md §7.1). Absent on an older
    /// server: read as no runs. Pooled over every row of the same `identity`, on any provider or engine.
    public let quality: ModelQuality
    /// Which model this is on any provider or engine: rows with one key are one model. Absent on an older server.
    public let identity: ModelIdentity?

    public var id: String { model }

    public init(model: String, levels: [String], source: String? = nil, editable: Bool = false,
                outputPricePerMTok: Double? = nil, supersededBy: String? = nil, quality: ModelQuality = .none,
                identity: ModelIdentity? = nil) {
        self.model = model
        self.levels = levels
        self.source = source
        self.editable = editable
        self.outputPricePerMTok = outputPricePerMTok
        self.supersededBy = supersededBy
        self.quality = quality
        self.identity = identity
    }

    private enum CodingKeys: String, CodingKey {
        case model, levels, source, editable, outputPricePerMTok, supersededBy, quality, identity
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        model = try c.decode(String.self, forKey: .model)
        levels = try c.decodeIfPresent([String].self, forKey: .levels) ?? []
        source = try c.decodeIfPresent(String.self, forKey: .source)
        editable = try c.decodeIfPresent(Bool.self, forKey: .editable) ?? false
        outputPricePerMTok = try c.decodeIfPresent(Double.self, forKey: .outputPricePerMTok)
        supersededBy = try c.decodeIfPresent(String.self, forKey: .supersededBy)
        quality = (try? c.decodeIfPresent(ModelQuality.self, forKey: .quality)) ?? .none
        identity = try? c.decodeIfPresent(ModelIdentity.self, forKey: .identity)
    }
}

/// Which model a row is on any provider or engine (shared ProviderModelTier.identity): `key` names the model, `name`
/// is its vendor name, nil when none is known.
public struct ModelIdentity: Codable, Equatable, Sendable {
    public let key: String
    public let name: String?

    public init(key: String, name: String? = nil) {
        self.key = key
        self.name = name
    }
}

/// One row of the Model tiers table: a provider's model, placed in its model's block. A block is one model's rows on
/// every provider listing it; the first row names the model and carries its Quality, the rest only their provider.
public struct ModelTierTableRow: Identifiable, Equatable, Sendable {
    public let provider: ProviderTierRow
    public let model: ProviderModelTier
    /// The model's vendor name when known, else its id.
    public let name: String
    /// The row above is the same model.
    public let continues: Bool
    /// The row below is the same model.
    public let continued: Bool
    /// The other providers listing the same model, whose runs its Quality counts too.
    public let pooledWith: [String]

    public var id: String { provider.slug + "\n" + model.model }
}

/// Who rated a model's SubAgent runs: a parent session's own model, and how many ratings it gave (shared ModelQualityRater).
public struct ModelQualityRater: Codable, Equatable, Sendable {
    public let engine: String?
    public let provider: String
    public let model: String?
    /// The model's name as the owner's tables give it; nil when the parent named no model.
    public let label: String?
    public let count: Int

    public init(engine: String? = nil, provider: String, model: String? = nil, label: String? = nil, count: Int) {
        self.engine = engine
        self.provider = provider
        self.model = model
        self.label = label
        self.count = count
    }
}

/// SubAgent runs on a model in the last 90 days and the parents' ratings of them; no average below 5 ratings.
public struct ModelSubagentQuality: Codable, Equatable, Sendable {
    public let averageRating: Double?
    public let ratedCount: Int
    public let runCount: Int
    public let raters: [ModelQualityRater]

    public init(averageRating: Double? = nil, ratedCount: Int = 0, runCount: Int = 0, raters: [ModelQualityRater] = []) {
        self.averageRating = averageRating
        self.ratedCount = ratedCount
        self.runCount = runCount
        self.raters = raters
    }
}

/// Done tasks first run on a model in the last 90 days and how many passed first time; no rate below 10.
public struct ModelTaskQuality: Codable, Equatable, Sendable {
    public let firstPassRate: Double?
    public let firstPassTaskCount: Int
    public let completedTaskCount: Int

    public init(firstPassRate: Double? = nil, firstPassTaskCount: Int = 0, completedTaskCount: Int = 0) {
        self.firstPassRate = firstPassRate
        self.firstPassTaskCount = firstPassTaskCount
        self.completedTaskCount = completedTaskCount
    }
}

/// A model's Quality (shared ModelQuality): shown beside its tier, never read by routing.
public struct ModelQuality: Codable, Equatable, Sendable {
    public let subagent: ModelSubagentQuality
    public let tasks: ModelTaskQuality

    public init(subagent: ModelSubagentQuality = .init(), tasks: ModelTaskQuality = .init()) {
        self.subagent = subagent
        self.tasks = tasks
    }

    public static let none = ModelQuality()
}

/// One line of the Quality cell: its figure, or why there is none (muted).
public struct QualityLine: Equatable, Sendable {
    public let text: String
    public let muted: Bool
}

/// The Quality cell (board docs/mocks/model-quality/01-board.png, owner's A1·B1·C1): a SubAgents line and a Tasks line,
/// or "No runs yet" alone when the model has neither; `raters` is the SubAgents line's tooltip.
public struct QualityLines: Equatable, Sendable {
    public let empty: Bool
    public let subagents: QualityLine
    public let raters: String?
    public let tasks: QualityLine
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

/// PATCH /providers/mine/:id/model-tier or /providers/builtin/:slug/model-tier: set or clear (nil, sent as JSON
/// null) the owner's tier for one model.
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
    /// Board docs/mocks/subagent-workflow part 5 (docs/subagent-workflow-design.md §6).
    public static let workflowsTitle = "Workflows"
    public static let workflowsDetail = "Let this agent run a script that starts many SubAgents and wakes it once"
    public static let providers = "Providers"
    public static let providersDetail = "All enabled providers. Block one to keep SubAgents off it."
    public static let edit = "Edit"
    public static let runningAtOnce = "Running at once"
    public static let runningAtOnceDetail = "Per session: delegated SubAgents and workflow calls together"
    public static let providersLoadFailed = "Couldn't load providers"
    public static let saveBlockedFailed = "Couldn't save blocked providers"

    public static let modelTiers = "Model tiers"
    public static let columnProvider = "Provider"
    public static let columnModel = "Model"
    public static let columnTier = "Tier"
    public static let columnPrice = "Price / M out"
    public static let tiersFooter = "Preset tiers and prices follow the catalogue. A model with no tier still "
        + "runs SubAgents, after every model whose tier fits."
    public static let notSet = "Not set"
    public static let allLevels = "S–XL by effort"
    public static let subscription = "Subscription"
    public static let noPrice = "—"
    public static let clear = "Clear"
    /// The tag after a tier the owner set (board 2026-11-20).
    public static let yours = "Yours"
    public static let tierSaveFailed = "Couldn't save the tier"
    public static let columnQuality = "Quality"
    public static let qualitySubagents = "SubAgents"
    public static let qualityTasks = "Tasks"
    public static let notEnoughRatings = "Not enough ratings"
    public static let notEnoughTasks = "Not enough tasks"
    public static let noRunsYet = "No runs yet"
    public static let qualityFooter = "Quality is shown, not used for routing. SubAgents: the parent session's 1–5 rating "
        + "of each result, last 90 days, recent ratings weighed more. Tasks: share of done tasks that passed on their "
        + "first run; runs that hit a usage limit or a model at capacity are left out."

    /// The tiers a model can be given, lowest first.
    public static let tiers = ["S", "M", "L", "XL"]

    // MARK: workspace fields

    public static let defaultMaxRunning = 4
    public static let maxRunningRange = 1...16

    /// A stored count, held to the range the server accepts; absent is the default.
    public static func maxRunning(_ stored: Int?) -> Int {
        min(max(stored ?? defaultMaxRunning, maxRunningRange.lowerBound), maxRunningRange.upperBound)
    }

    /// What the Workflows switch shows: it follows SubAgents, since every call of a workflow is a SubAgent, so it reads
    /// off (and cannot be turned on) while SubAgents is off, and its own stored value otherwise.
    public static func workflowsOn(subagentsEnabled: Bool, workflowsEnabled: Bool) -> Bool {
        subagentsEnabled && workflowsEnabled
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

    /// The table's rows, one block per model, as web's Model routing draws them: each model's rows right after its first,
    /// in the order the first came. A row with no identity (an older server) is a block of its own.
    public static func tableRows(_ providers: [ProviderTierRow]) -> [ModelTierTableRow] {
        let listed = providers.flatMap { provider in provider.models.map { (provider, $0) } }
        let key = { (provider: ProviderTierRow, model: ProviderModelTier) in model.identity?.key ?? provider.slug + "\n" + model.model }
        var order: [String] = []
        var blocks: [String: [(ProviderTierRow, ProviderModelTier)]] = [:]
        for (provider, model) in listed {
            let k = key(provider, model)
            if blocks[k] == nil { order.append(k) }
            blocks[k, default: []].append((provider, model))
        }
        return order.flatMap { k -> [ModelTierTableRow] in
            let block = blocks[k]!
            var labels: [String] = []
            for (provider, _) in block where !labels.contains(provider.label) { labels.append(provider.label) }
            return block.enumerated().map { index, entry in
                ModelTierTableRow(provider: entry.0, model: entry.1, name: entry.1.identity?.name ?? entry.1.model,
                                  continues: index > 0, continued: index < block.count - 1,
                                  pooledWith: labels.filter { $0 != entry.0.label })
            }
        }
    }

    /// Under a model's Quality: how many providers its figures count, said only where there is a figure to explain.
    public static func pooledText(_ lines: QualityLines, pooledWith: [String]) -> String? {
        if pooledWith.isEmpty || lines.empty || (lines.subagents.muted && lines.tasks.muted) { return nil }
        return "Pooled across \(pooledWith.count + 1) providers"
    }

    /// The pooled line's tooltip: the other providers by name.
    public static func pooledTip(_ pooledWith: [String]) -> String {
        "Runs on " + pooledWith.joined(separator: ", ") + " are counted too"
    }

    /// A model's Tier cell: "Not set", "S–XL by effort", or the levels joined ("L · XL").
    public static func tierText(_ levels: [String]) -> String {
        if levels.isEmpty { return notSet }
        if Set(levels) == Set(tiers) { return allLevels }
        return levels.joined(separator: " · ")
    }

    /// A model's Tier cell: `tierText`, but an older family member reads "Older · uses <newest>" in place of Not set.
    public static func modelTierText(_ model: ProviderModelTier) -> String {
        if model.levels.isEmpty, let newest = model.supersededBy { return "Older · uses \(newest)" }
        return tierText(model.levels)
    }

    /// Whether the Tier cell warns: a model with no tier ranks after every tiered one.
    public static func tierIsUnset(_ levels: [String]) -> Bool { levels.isEmpty }

    /// Whether the Tier cell reads Older (grey, not a warning): no tier of its own, a newer family member routed instead.
    public static func tierIsOlder(_ model: ProviderModelTier) -> Bool { model.levels.isEmpty && model.supersededBy != nil }

    /// A model's Price / M out cell.
    public static func priceText(_ model: ProviderModelTier, billing: String) -> String {
        if let price = model.outputPricePerMTok { return "$" + String(format: "%.2f", price) }
        return billing == "subscription" ? subscription : noPrice
    }

    /// Whether the tier menu offers Clear: a key's model with a tier, or a built-in engine's model the owner tiered
    /// (a catalogue tier there has nothing to clear).
    public static func menuOffersClear(_ provider: ProviderTierRow, _ model: ProviderModelTier) -> Bool {
        provider.kind == "builtin" ? model.source == "owner" : !model.levels.isEmpty
    }

    /// Where a model's tier is written: a built-in engine's catalogue, or a key of the owner's own; nil when the
    /// model's tier is not the owner's to set.
    public static func tierPath(_ provider: ProviderTierRow, _ model: ProviderModelTier) -> String? {
        guard model.editable else { return nil }
        if provider.kind == "builtin" { return "providers/builtin/\(provider.slug)/model-tier" }
        return provider.providerId.map { "providers/mine/\($0)/model-tier" }
    }

    /// Whether the Tier cell carries the Yours tag: a tier the owner set.
    public static func showsYours(_ model: ProviderModelTier) -> Bool { model.source == "owner" }

    /// A model's Quality cell, as web's qualityLines reads it: "4.2 · 18 rated of 40" and "82% first pass · 34 tasks",
    /// each "Not enough …" below its minimum, and "Rated by Opus 5.5 (18)" for the tooltip where there is an average.
    public static func qualityLines(_ quality: ModelQuality) -> QualityLines {
        let subagent = quality.subagent
        let tasks = quality.tasks
        let raters = subagent.raters.map { "\($0.label ?? $0.provider) (\($0.count))" }.joined(separator: " · ")
        let subagents: QualityLine = subagent.averageRating.map {
            QualityLine(text: String(format: "%.1f", $0) + " · \(subagent.ratedCount) rated of \(subagent.runCount)", muted: false)
        } ?? QualityLine(text: notEnoughRatings, muted: true)
        let taskLine: QualityLine = tasks.firstPassRate.map {
            QualityLine(text: "\(Int(($0 * 100).rounded()))% first pass · \(tasks.completedTaskCount) tasks", muted: false)
        } ?? QualityLine(text: notEnoughTasks, muted: true)
        return QualityLines(
            empty: subagent.runCount == 0 && tasks.completedTaskCount == 0,
            subagents: subagents,
            raters: subagent.averageRating != nil && !raters.isEmpty ? "Rated by " + raters : nil,
            tasks: taskLine)
    }
}
