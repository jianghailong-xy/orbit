import SwiftUI
import OrbitKit

// Settings → Providers → Model routing (Machines & models' on a Mac and an iPad): the account's routing switches, then
// every model with its tier beside how its SubAgent runs went — what the web's ModelRoutingPage draws, in its words.
// Words and rules are OrbitKit's `ModelRouting`; the Tier, Quality and price cells are the old Model tiers table's.

/// The page. The two switches are written the moment they move, each guarded against the account's own value so
/// seeding writes nothing; the period reads the report again.
struct ModelRoutingPage: View {
    @Environment(AppModel.self) private var model

    /// Route by tier. Absent on the server means on.
    @State private var modelRouting = true
    /// Optimize For. Absent on the server means Balance.
    @State private var optimizeFor: OptimizeFor = .balance
    @State private var seeded = false
    @State private var period: ModelRoutingPeriod = .default
    @State private var report: SubagentRoutingReport?
    @State private var reportFailure: String?
    @State private var showsIdle = false

    var body: some View {
        Form {
            Section {
                Toggle(SettingsCopy.smartModelSelection, isOn: $modelRouting)
                    .settingRow("modelRouting")
                SettingChangedLineView(key: "modelRouting")
            } header: {
                VStack(alignment: .leading, spacing: 10) {
                    Text(ModelRouting.description)
                        .font(.orbitListSubtitle)
                        .foregroundStyle(.secondary)
                        .textCase(nil)
                    RunnerSectionHeader(ModelRouting.routingHeader)
                }
            } footer: {
                Text(SettingsCopy.smartModelSelectionHint)
            }
            // Only Route by tier reads it, so it shows only while that is on (owner, 2026-11-20).
            if modelRouting {
                Section {
                    Picker(SettingsCopy.optimizeFor, selection: $optimizeFor) {
                        ForEach(OptimizeFor.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .settingRow("optimizeFor")
                    SettingChangedLineView(key: "optimizeFor")
                } footer: {
                    Text(SettingsCopy.optimizeForHint)
                }
            }
            models
        }
        .formStyle(.grouped)
        .orbitRevealSurface()
        .settingsAnchorScroll()
        .navigationTitle(ModelRouting.title)
        .onAppear(perform: seed)
        .onChange(of: modelRouting) { _, value in
            guard (model.user?.preferences?.smartModelSelection ?? true) != value else { return }
            Task { await model.savePreferences(UpdatePreferencesRequest(modelRouting: value)) }
        }
        .onChange(of: optimizeFor) { _, value in
            guard OptimizeFor(stored: model.user?.preferences?.optimizeFor) != value else { return }
            Task { await model.savePreferences(UpdatePreferencesRequest(optimizeFor: value.rawValue)) }
        }
        .task { await model.agents?.loadSubagentTiers() }
        .task(id: period) { await loadReport() }
    }

    private func seed() {
        guard !seeded else { return }
        seeded = true
        let p = model.user?.preferences
        modelRouting = p?.smartModelSelection ?? true
        optimizeFor = OptimizeFor(stored: p?.optimizeFor)
    }

    private func loadReport() async {
        guard let agents = model.agents else { return }
        do {
            report = try await agents.subagentRoutingReport(period)
            reportFailure = nil
        } catch is CancellationError {
        } catch {
            reportFailure = APIClient.failureReason(error)
        }
    }

    // MARK: Models

    @ViewBuilder private var models: some View {
        let agents = model.agents
        Section {
            Picker(ModelRouting.period, selection: $period) {
                ForEach(ModelRoutingPeriod.allCases) { Text($0.label).tag($0) }
            }
            .accessibilityIdentifier("modelRouting.period")
            #if os(macOS)
            if loaded { columnHeads }
            #endif
            if let failure = reportFailure ?? (agents?.subagentTiersFailed == true ? SubagentSettings.providersLoadFailed : nil) {
                HStack {
                    Text(ModelRouting.loadFailed(failure)).foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                    Button(ModelRouting.retry) {
                        Task {
                            await agents?.loadSubagentTiers()
                            await loadReport()
                        }
                    }
                }
            } else if report == nil || agents?.subagentTiers == nil {
                ProgressView().frame(maxWidth: .infinity)
            } else if sections.isEmpty, report?.subagents.isEmpty != false {
                Text(ModelRouting.nothingRan(period)).foregroundStyle(.secondary)
            }
        } header: {
            RunnerSectionHeader(ModelRouting.modelsHeader)
        } footer: {
            if !loaded { feet }
        }
        if loaded, let agents {
            let rows = self.sections
            let drawn = drawnSections(rows)
            ForEach(drawn, id: \.self) { part in
                Section {
                    switch part {
                    case .tiered:
                        ForEach(rows.tiered) { ModelRoutingRow(agents: agents, row: $0, kind: .tiers) }
                    case .named:
                        ForEach(rows.named) { ModelRoutingRow(agents: agents, row: $0, kind: .named) }
                    case .notRouted:
                        ForEach(rows.notRouted) { ModelRoutingRow(agents: agents, row: $0, kind: .notRouted) }
                    case .idle:
                        Button {
                            showsIdle.toggle()
                        } label: {
                            Text(ModelRouting.noTierNoRuns(rows.idle.count, open: showsIdle))
                                .foregroundStyle(Color.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("modelRouting.idle")
                        if showsIdle {
                            ForEach(rows.idle) { ModelRoutingRow(agents: agents, row: $0, kind: .tiers) }
                        }
                    }
                } header: {
                    switch part {
                    case .tiered:    RunnerSectionHeader(ModelRouting.routedByTier)
                    case .named:     RunnerSectionHeader(ModelRouting.calledByName)
                    case .notRouted: RunnerSectionHeader(ModelRouting.notRouted)
                    case .idle:      EmptyView()
                    }
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        if part == .named { Text(ModelRouting.calledByNameNote) }
                        if part == drawn.last { feet }
                    }
                }
            }
        }
    }

    private enum Part: Hashable { case tiered, named, notRouted, idle }

    private var loaded: Bool {
        reportFailure == nil && report != nil && model.agents?.subagentTiers != nil && !sections.isEmpty
    }

    private var sections: RoutingSections {
        ModelRouting.sections(model.agents?.subagentTiers?.providers ?? [], report?.subagents ?? [])
    }

    private func drawnSections(_ sections: RoutingSections) -> [Part] {
        [(Part.tiered, sections.tiered), (.named, sections.named), (.notRouted, sections.notRouted), (.idle, sections.idle)]
            .filter { !$0.1.isEmpty }.map(\.0)
    }

    #if os(macOS)
    /// The Mac row's columns, as the web table heads them; the runs are the line under each row.
    private var columnHeads: some View {
        HStack(spacing: 10) {
            Text(SubagentSettings.columnProvider).frame(width: 110, alignment: .leading)
            Text(SubagentSettings.columnModel).frame(maxWidth: .infinity, alignment: .leading)
            Text(SubagentSettings.columnTier).frame(width: 230, alignment: .leading)
            Text(SubagentSettings.columnQuality).frame(width: 250, alignment: .leading)
            Text(SubagentSettings.columnPrice).frame(width: 96, alignment: .trailing)
        }
        .font(.orbitLabel)
        .foregroundStyle(.secondary)
    }
    #endif

    private var feet: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(ModelRouting.subagentsFoot)
            Text(SubagentSettings.qualityFooter)
        }
    }
}

/// One model: its provider and name, its tier (a menu where the owner may set it), Quality and price, then the tiers
/// its runs were routed at — a tier it is not set to now in orange — and its runs, share done and cost.
struct ModelRoutingRow: View {
    enum Kind { case tiers, named, notRouted }

    let agents: AgentsModel
    let row: RoutingModelRow
    let kind: Kind

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            #if os(iOS)
            HStack(spacing: 10) {
                Text(row.providerLabel ?? "—").lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                tier.frame(width: 110, alignment: .leading)
                price
            }
            Text(row.modelLabel)
                .font(.orbitListSubtitle.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            if let quality = row.model?.quality {
                ModelQualityCell(quality: quality)
                    .font(.orbitListSubtitle)
                    .padding(.top, 2)
            }
            #else
            HStack(spacing: 10) {
                Text(row.providerLabel ?? "—").lineLimit(1).frame(width: 110, alignment: .leading)
                Text(row.modelLabel)
                    .font(.body.monospaced())
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                tier.frame(width: 230, alignment: .leading)
                Group {
                    if let quality = row.model?.quality { ModelQualityCell(quality: quality) } else { Text("—") }
                }
                .frame(width: 250, alignment: .leading)
                price
            }
            #endif
            if kind == .tiers, let flag = ModelRouting.flag(row) {
                Text(flag)
                    .font(.orbitLabel)
                    .foregroundStyle(.orange)
            }
            figures
        }
        .padding(.vertical, 1)
    }

    private var price: some View {
        Group {
            if let provider = row.provider, let model = row.model {
                Text(SubagentSettings.priceText(model, billing: provider.billing))
                    .foregroundStyle(model.outputPricePerMTok == nil ? .secondary : .primary)
            } else {
                Text(SubagentSettings.noPrice).foregroundStyle(.secondary)
            }
        }
        .monospacedDigit()
        .frame(width: 96, alignment: .trailing)
    }

    @ViewBuilder private var tier: some View {
        if let provider = row.provider, let model = row.model {
            ModelTierCell(agents: agents, provider: provider, model: model)
        } else {
            Text("—").foregroundStyle(.secondary)
        }
    }

    /// `Ran at  S 3 · L 1    4 runs · 75% done · $0.42`.
    private var figures: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(ModelRouting.ranAt).foregroundStyle(.secondary)
            ranAt
            Spacer(minLength: 8)
            if row.figures.runs > 0 {
                Text([ModelRouting.plural(row.figures.runs, "run"),
                      "\(ModelRouting.doneText(row.figures)) \(ModelRouting.columnDone.lowercased())",
                      ModelRouting.rowCostText(row.figures)].joined(separator: " · "))
                    .monospacedDigit()
            }
        }
        .font(.orbitLabel)
        .lineLimit(1)
    }

    @ViewBuilder private var ranAt: some View {
        switch kind {
        case .named:     Text(ModelRouting.named).foregroundStyle(.secondary)
        case .notRouted: Text(ModelRouting.notRouted).foregroundStyle(.secondary)
        case .tiers:
            if row.figures.runs == 0 || row.tiers.isEmpty {
                Text(ModelRouting.noRuns).foregroundStyle(.secondary)
            } else {
                tiersText
                .monospacedDigit()
                .accessibilityLabel(ModelRouting.ranAt + " " + row.tiers.map {
                    "\($0.tier) \($0.figures.runs)" + ($0.outside ? " (\(ModelRouting.outsideItsTier))" : "")
                }.joined(separator: ", "))
            }
        }
    }

    /// `S 3 · L 1`, a tier the model is not set to now in orange.
    private var tiersText: Text {
        var text: Text?
        for tier in row.tiers {
            let part: Text = Text("\(tier.tier) \(tier.figures.runs)")
                .foregroundStyle(tier.outside ? Color.orange : Color.primary)
            if let sofar = text {
                text = sofar + Text(" · ").foregroundStyle(Color.secondary) + part
            } else {
                text = part
            }
        }
        return text ?? Text(ModelRouting.noRuns)
    }
}

/// A model's Tier cell: the tier it is routed at — a menu where the owner may set it — and the Yours tag on one they set.
struct ModelTierCell: View {
    let agents: AgentsModel
    let provider: ProviderTierRow
    let model: ProviderModelTier
    @Environment(AppModel.self) private var app

    var body: some View {
        HStack(spacing: 6) {
            control
            if SubagentSettings.showsYours(model) {
                // A tier the owner set (board 2026-11-20).
                Text(SubagentSettings.yours)
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 5)
                    .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.secondary.opacity(0.35)))
                    .fixedSize()
            }
        }
    }

    @ViewBuilder private var control: some View {
        let text = Text(SubagentSettings.modelTierText(model))
            .foregroundStyle(SubagentSettings.tierIsOlder(model) ? Color.secondary
                : SubagentSettings.tierIsUnset(model.levels) ? Color.orange : Color.primary)
            // "Older · uses <model>" is longer than a phone's Tier column: it wraps there.
            .multilineTextAlignment(.leading)
        if let path = SubagentSettings.tierPath(provider, model) {
            Menu {
                ForEach(SubagentSettings.tiers, id: \.self) { tier in
                    Button(tier) { write(path, tier) }
                }
                if SubagentSettings.menuOffersClear(provider, model) {
                    Button(SubagentSettings.clear, role: .destructive) { write(path, nil) }
                }
            } label: {
                HStack(spacing: 3) {
                    text
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                }
            }
            .menuStyle(.button)
            .buttonStyle(.borderless)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("tier.\(provider.slug).\(model.model)")
        } else {
            text
        }
    }

    private func write(_ path: String, _ tier: String?) {
        Task {
            if let failure = await agents.setModelTier(path: path, model: model.model, tier: tier) {
                app.showToast(failure, tone: .error)
            }
        }
    }
}
