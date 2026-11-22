import Foundation

// Settings → Providers → Model routing on the Apple clients (Infrastructure on the Mac): the account's two routing
// switches — Route by tier, and Optimize For under it — then every model with the tier it is routed at beside how its
// SubAgent runs went in the period. Web parity: `pages/settings/ModelRoutingPage.tsx` and `lib/routingReport.ts`,
// whose words these are (`ModelRoutingCopyParityTests` reads them back out of those files). The report's Workflows view
// and its Agent filter are the web's alone.

/// One row of `GET /tasks/model-routing/report/subagents` (shared `SubagentReportGroup`): the SubAgent runs routed at
/// one tier onto one provider and model, workflow calls included.
public struct SubagentReportGroup: Codable, Equatable, Sendable {
    /// `S`…`XL`, `named` when the call named its model, `not-routed` when Route by tier was off.
    public let tier: String
    public let provider: String?
    public let providerLabel: String?
    public let model: String?
    public let modelLabel: String?
    public let runs: Int
    public let workflowCalls: Int
    public let ended: Int
    public let done: Int
    public let costUsd: Double
    public let movedOn: Int
    public let noSize: Int

    public init(tier: String, provider: String?, providerLabel: String? = nil, model: String?, modelLabel: String? = nil,
                runs: Int, workflowCalls: Int = 0, ended: Int = 0, done: Int = 0, costUsd: Double = 0,
                movedOn: Int = 0, noSize: Int = 0) {
        self.tier = tier
        self.provider = provider
        self.providerLabel = providerLabel
        self.model = model
        self.modelLabel = modelLabel
        self.runs = runs
        self.workflowCalls = workflowCalls
        self.ended = ended
        self.done = done
        self.costUsd = costUsd
        self.movedOn = movedOn
        self.noSize = noSize
    }

    private enum CodingKeys: String, CodingKey {
        case tier, provider, providerLabel, model, modelLabel, runs, workflowCalls, ended, done, costUsd, movedOn, noSize
    }

    /// Read leniently: a figure this build cannot read counts as 0 rather than costing the whole report.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tier = try c.decode(String.self, forKey: .tier)
        provider = (try? c.decodeIfPresent(String.self, forKey: .provider)) ?? nil
        providerLabel = (try? c.decodeIfPresent(String.self, forKey: .providerLabel)) ?? nil
        model = (try? c.decodeIfPresent(String.self, forKey: .model)) ?? nil
        modelLabel = (try? c.decodeIfPresent(String.self, forKey: .modelLabel)) ?? nil
        func int(_ key: CodingKeys) -> Int { ((try? c.decodeIfPresent(Int.self, forKey: key)) ?? nil) ?? 0 }
        runs = int(.runs)
        workflowCalls = int(.workflowCalls)
        ended = int(.ended)
        done = int(.done)
        costUsd = ((try? c.decodeIfPresent(Double.self, forKey: .costUsd)) ?? nil) ?? 0
        movedOn = int(.movedOn)
        noSize = int(.noSize)
    }
}

/// `GET /tasks/model-routing/report/subagents?since=&agentId=`: the SubAgents view's rows. Its `workflows` are not read.
public struct SubagentRoutingReport: Decodable, Equatable, Sendable {
    public let subagents: [SubagentReportGroup]
    public init(subagents: [SubagentReportGroup]) { self.subagents = subagents }
    private enum CodingKeys: String, CodingKey { case subagents }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        subagents = try c.decodeIfPresent([SubagentReportGroup].self, forKey: .subagents) ?? []
    }
}

/// The report's period: the web's `REPORT_PERIODS`, Last 30 days by default.
public enum ModelRoutingPeriod: String, CaseIterable, Identifiable, Sendable {
    case last7 = "7d"
    case last30 = "30d"
    case all

    public static let `default`: ModelRoutingPeriod = .last30
    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .last7:  return "Last 7 days"
        case .last30: return "Last 30 days"
        case .all:    return "All time"
        }
    }

    private var days: Int? {
        switch self {
        case .last7:  return 7
        case .last30: return 30
        case .all:    return nil
        }
    }

    /// Where the period starts, as the report's `since`: none for All time.
    public func since(now: Date) -> String? {
        guard let days else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: now.addingTimeInterval(-Double(days) * 86_400))
    }

    /// The period in a sentence's words: `in the last 30 days`, or `yet` for All time.
    public var phrase: String { days.map { "in the last \($0) days" } ?? "yet" }
}

/// How one model's runs went, summed over the report rows that picked it.
public struct RoutingRunFigures: Equatable, Sendable {
    public var runs = 0
    public var ended = 0
    public var done = 0
    public var costUsd: Double = 0
    public var movedOn = 0

    public init() {}

    static func sum(_ groups: [SubagentReportGroup]) -> RoutingRunFigures {
        groups.reduce(into: RoutingRunFigures()) { total, group in
            total.runs += group.runs
            total.ended += group.ended
            total.done += group.done
            total.costUsd += group.costUsd
            total.movedOn += group.movedOn
        }
    }
}

/// One tier a model was routed at: its runs there, and whether that tier is one the model is set to now.
public struct RoutingTierRuns: Equatable, Sendable, Identifiable {
    public let tier: String
    public let figures: RoutingRunFigures
    public let outside: Bool
    public var id: String { tier }
}

/// One row of the Models list: a model as the tier list names it (nil when the list no longer has it, as for a removed
/// key), with the runs routing gave it in the period.
public struct RoutingModelRow: Equatable, Sendable, Identifiable {
    public let key: String
    public let provider: ProviderTierRow?
    public let model: ProviderModelTier?
    public let modelLabel: String
    public let providerLabel: String?
    public let figures: RoutingRunFigures
    /// The tiers it was routed at, S to XL; empty for a row of named or unrouted runs.
    public let tiers: [RoutingTierRuns]
    /// Of its runs, those routed at a tier it is not set to now (all of them for a model with no tier).
    public let outsideRuns: Int
    public var id: String { key }
}

/// The Models list's rows, in its sections.
public struct RoutingSections: Equatable, Sendable {
    /// Every model with a tier, and every model routed at one: most runs first, then the tier list's order.
    public let tiered: [RoutingModelRow]
    /// Runs that named their model, so routing picked no tier.
    public let named: [RoutingModelRow]
    /// Runs routing left alone.
    public let notRouted: [RoutingModelRow]
    /// Models with no tier that ran nothing in the period, folded away.
    public let idle: [RoutingModelRow]

    public var isEmpty: Bool { tiered.isEmpty && named.isEmpty && notRouted.isEmpty && idle.isEmpty }
}

public enum ModelRouting {
    // MARK: words

    public static let title = "Model routing"
    public static let description = "Which tier each model takes SubAgent work at, and how that work went."
    public static let routingHeader = "Routing"
    public static let modelsHeader = "Models"
    public static let period = "Period"
    public static let routedByTier = "Routed by tier"
    public static let calledByName = "Called by name"
    public static let calledByNameNote = "The SubAgent named its model, so no tier was picked."
    public static let notRouted = "Not routed"
    public static let named = "Named"
    public static let noRuns = "No runs"
    public static let ranAt = "Ran at"
    public static let columnRuns = "Runs"
    public static let columnDone = "Done"
    public static let columnCost = "Cost"
    public static let outsideItsTier = "outside its tier"
    public static let retry = "Retry"
    public static let off = "Off"

    /// `▸ No tier, no runs · 3 models`, the folded section's row.
    public static func noTierNoRuns(_ count: Int, open: Bool) -> String {
        "\(open ? "▾" : "▸") No tier, no runs · \(plural(count, "model"))"
    }

    public static func loadFailed(_ reason: String) -> String { "Couldn’t load the report: \(reason)" }

    public static func nothingRan(_ period: ModelRoutingPeriod) -> String { "No SubAgents ran \(period.phrase)." }

    public static let subagentsFoot =
        "Each run counts under the model Orbit picked for it, workflow calls included; Ran at splits its runs by the tier they " +
        "were routed at. Done: ended runs that finished. Moved on: the pick hit a usage limit and the run went on with the " +
        "next model. No size: the call gave no size, so its type's default tier applied. A subscription that reports no " +
        "price adds $0. Preset tiers and prices follow the catalogue. A model with no tier still runs SubAgents, after every " +
        "model whose tier fits."

    /// What Settings' row to the page says of it, as the web's account menu does: Off while Route by tier is off, else
    /// the Optimize For it routes by (Balance for an account that never chose).
    public static func rowValue(_ preferences: UserPreferences?) -> String {
        guard preferences?.smartModelSelection ?? true else { return off }
        return OptimizeFor(stored: preferences?.optimizeFor).label
    }

    // MARK: figures

    public static func plural(_ count: Int, _ word: String) -> String { "\(count) \(word)\(count == 1 ? "" : "s")" }

    public static func costText(_ usd: Double) -> String { String(format: "$%.2f", usd) }

    /// `part` of `whole` as a whole percentage, rounded half up as the web's Math.round; nil when there is no whole.
    public static func percent(_ part: Int, _ whole: Int) -> Int? {
        whole > 0 ? Int((Double(part) / Double(whole) * 100).rounded(.toNearestOrAwayFromZero)) : nil
    }

    /// The Done figure: `75%`, or `—` while none of its runs has ended.
    public static func doneText(_ figures: RoutingRunFigures) -> String {
        percent(figures.done, figures.ended).map { "\($0)%" } ?? "—"
    }

    /// The Cost figure: `$0.42`, or `—` for a model that ran nothing.
    public static func rowCostText(_ figures: RoutingRunFigures) -> String {
        figures.runs == 0 ? "—" : costText(figures.costUsd)
    }

    /// A routed row's Ran at: the tiers its runs were routed at with their counts (`S 3 · L 1`), or `No runs`.
    public static func ranAtText(_ row: RoutingModelRow) -> String {
        row.figures.runs == 0 || row.tiers.isEmpty ? noRuns : row.tiers.map { "\($0.tier) \($0.figures.runs)" }.joined(separator: " · ")
    }

    /// The warning under a routed model whose runs went to a tier it is not set to now; nil when none did.
    public static func flag(_ row: RoutingModelRow) -> String? {
        guard row.outsideRuns > 0 else { return nil }
        if let model = row.model, model.levels.isEmpty {
            return "No tier set, but routed \(plural(row.outsideRuns, "time"))"
        }
        let outside = row.tiers.filter(\.outside).map(\.tier).joined(separator: " · ")
        return "\(plural(row.outsideRuns, "run")) at \(outside), outside \(SubagentSettings.tierText(row.model?.levels ?? []))"
    }

    // MARK: the join

    private static func rowKey(_ provider: String?, _ model: String?) -> String { "\(provider ?? "")\n\(model ?? "")" }

    /// The tier list and the report, joined on provider slug and model id (web `routingSections`): a report row names
    /// the provider and model routing picked, which are the tier list's slug and model.
    public static func sections(_ providers: [ProviderTierRow], _ groups: [SubagentReportGroup]) -> RoutingSections {
        var listed: [String: (provider: ProviderTierRow, model: ProviderModelTier, order: Int)] = [:]
        var listedOrder: [String] = []
        for provider in providers {
            for model in provider.models {
                let key = rowKey(provider.slug, model.model)
                guard listed[key] == nil else { continue }
                listed[key] = (provider, model, listedOrder.count)
                listedOrder.append(key)
            }
        }

        var routed: [String: [SubagentReportGroup]] = [:], routedOrder: [String] = []
        var named: [String: [SubagentReportGroup]] = [:], namedOrder: [String] = []
        var notRouted: [String: [SubagentReportGroup]] = [:], notRoutedOrder: [String] = []
        for group in groups {
            let key = rowKey(group.provider, group.model)
            switch group.tier {
            case "named":
                if named[key] == nil { namedOrder.append(key) }
                named[key, default: []].append(group)
            case "not-routed":
                if notRouted[key] == nil { notRoutedOrder.append(key) }
                notRouted[key, default: []].append(group)
            default:
                if routed[key] == nil { routedOrder.append(key) }
                routed[key, default: []].append(group)
            }
        }

        func row(_ key: String, _ picked: [SubagentReportGroup]) -> RoutingModelRow {
            let entry = listed[key]
            let first = picked.first
            let levels = entry?.model.levels
            let tiers: [RoutingTierRuns] = SubagentSettings.tiers.compactMap { tier in
                let at = picked.filter { $0.tier == tier }
                // A model the list no longer has cannot be said to be outside its tier.
                return at.isEmpty ? nil
                    : RoutingTierRuns(tier: tier, figures: .sum(at), outside: levels.map { !$0.contains(tier) } ?? false)
            }
            return RoutingModelRow(
                key: key, provider: entry?.provider, model: entry?.model,
                modelLabel: first?.modelLabel ?? entry?.model.model ?? "No model",
                providerLabel: entry?.provider.label ?? first?.providerLabel,
                figures: .sum(picked), tiers: tiers,
                outsideRuns: tiers.reduce(0) { $0 + ($1.outside ? $1.figures.runs : 0) })
        }
        func order(_ key: String) -> Int { listed[key]?.order ?? Int.max }
        // Stable, as the web's Array.sort is: most runs first, then the tier list's order.
        func byRuns(_ rows: [RoutingModelRow]) -> [RoutingModelRow] {
            rows.enumerated().sorted { a, b in
                if a.element.figures.runs != b.element.figures.runs { return a.element.figures.runs > b.element.figures.runs }
                let oa = order(a.element.key), ob = order(b.element.key)
                return oa != ob ? oa < ob : a.offset < b.offset
            }.map(\.element)
        }

        var tiered: [RoutingModelRow] = []
        var idle: [RoutingModelRow] = []
        for key in listedOrder where routed[key] == nil {
            guard let entry = listed[key] else { continue }
            let ranAtAll = named[key] != nil || notRouted[key] != nil
            if !entry.model.levels.isEmpty { tiered.append(row(key, [])) }
            else if !ranAtAll { idle.append(row(key, [])) }
        }
        for key in routedOrder { tiered.append(row(key, routed[key] ?? [])) }
        return RoutingSections(
            tiered: byRuns(tiered),
            named: byRuns(namedOrder.map { row($0, named[$0] ?? []) }),
            notRouted: byRuns(notRoutedOrder.map { row($0, notRouted[$0] ?? []) }),
            idle: idle)
    }
}
