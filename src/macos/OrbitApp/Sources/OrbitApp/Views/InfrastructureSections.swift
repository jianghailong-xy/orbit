import SwiftUI
import OrbitKit

// The Infrastructure page's own sections (docs/mocks/infrastructure-page/03-ios.png) — Needs you, What
// your agents can run on, Account pools and API keys — around the machines `RunnersListView` lists between
// them. Each draws what it is handed and says what a press means through the closure it is given, so the
// page a phone pushes from Settings and the Mac's section column share them. What the two blocks at the
// top say, and when, is OrbitKit's (`Infrastructure`) — the web's rules, tested there.

/// The lists the page is read from, as `AppModel` holds them: the machines, the pools the account is in
/// and its own — a Codex one with its people and keys read beside its accounts, once they are — and the
/// account's own keys.
struct InfrastructureLists {
    let runners: [Runner]
    let memberPools: [SharedPool]
    let ownPools: [ProviderPool]
    let keys: [ConfiguredProvider]
    /// Every list has had its answer, a failed one included: the two blocks at the top wait for that, as
    /// the web's do — an engine called Not set up before its keys arrived would be wrong.
    let settled: Bool

    @MainActor init(_ model: AppModel) {
        runners = model.runners?.runners ?? []
        memberPools = model.sharedPools?.pools ?? []
        ownPools = (model.agents?.providerPools ?? []).map { pool -> ProviderPool in
            guard CodexLoginPool.isLoginPool(pool),
                  let access = model.sharedPools?.access(pool.id) else { return pool }
            return SharedPools.ownPoolWithAccess(pool, access)
        }
        keys = model.agents?.ownKeys ?? []
        let states = [model.runners?.loadState, model.agents?.poolsState, model.agents?.ownKeysState,
                      model.sharedPools?.loadState]
        settled = states.allSatisfy { state in state.map { $0.hasLoaded || $0.lastLoadFailed } ?? false }
    }

    var attention: [Infrastructure.Attention] {
        Infrastructure.attention(runners: runners, memberPools: memberPools.map(SharedPools.asProviderPool),
                                 ownPools: ownPools)
    }

    var engines: [Infrastructure.Engine] {
        Infrastructure.engines(runners: runners, keys: keys,
                               pools: memberPools.map(SharedPools.asProviderPool) + ownPools)
    }

    /// The account's own Codex pools, whose people and keys are read one by one.
    @MainActor static func codexPoolIDs(_ model: AppModel) -> [String] {
        (model.agents?.providerPools ?? []).filter(CodexLoginPool.isLoginPool).map(\.id)
    }
}

// MARK: - Needs you

/// A line for each thing that waits on a person, in the web's words, each with its way out: an engine
/// signed in again on its page, a machine's record, a pool's page.
struct InfrastructureNeedsYouSection: View {
    let items: [Infrastructure.Attention]
    /// Whether a pool's line opens its page — the Mac has no pool pages, so there the line only says why.
    var opensPools = true
    let open: (Infrastructure.Attention) -> Void

    var body: some View {
        Section {
            ForEach(items) { item in
                InfrastructureAttentionRow(item: item, open: opens(item) ? open : nil)
            }
        } header: {
            RunnerSectionHeader(Infrastructure.needsYou)
        }
    }

    private func opens(_ item: Infrastructure.Attention) -> Bool {
        if case .poolUnavailable = item.kind { return opensPools }
        return true
    }
}

/// One line: a dot, what happened with its names in bold, what it means under it, and its press.
private struct InfrastructureAttentionRow: View {
    let item: Infrastructure.Attention
    let open: ((Infrastructure.Attention) -> Void)?

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(dot)
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(infrastructureBold(item.line, item.names))
                Text(item.detail)
                    .font(.orbitListSubtitle)
                    .foregroundStyle(Color.secondary)
            }
            Spacer(minLength: 8)
            if let open {
                press { open(item) }
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
            }
        }
        .padding(.vertical, 2)
    }

    /// Grey for a machine that is away, amber for the rest — the web's two dots.
    private var dot: Color {
        if case .offline = item.kind { return RunnerInk.idle }
        return Color.orange
    }

    @ViewBuilder private func press(_ action: @escaping () -> Void) -> some View {
        switch item.kind {
        case .signedOut:
            Button(Infrastructure.signIn, action: action)
                .buttonStyle(.borderedProminent)
        case .offline:
            Button(Infrastructure.details, action: action)
                .buttonStyle(.bordered)
        case .poolUnavailable:
            Button(Infrastructure.manage, action: action)
                .buttonStyle(.bordered)
        }
    }
}

/// `text` with each of `names` set in bold, the way the web's lines set them.
func infrastructureBold(_ text: String, _ names: [String]) -> AttributedString {
    var out = AttributedString(text)
    var from = out.startIndex
    for name in names where !name.isEmpty {
        guard let range = out[from...].range(of: name) else { continue }
        out[range].inlinePresentationIntent = .stronglyEmphasized
        from = range.upperBound
    }
    return out
}

// MARK: - What your agents can run on

/// A row per engine, Ready with what can pay for it now — its machines, its keys with their models, its
/// pools — or Not set up, with the way to install it on a machine.
struct InfrastructureEnginesSection: View {
    let engines: [Infrastructure.Engine]
    /// Install on a machine: that engine's page on the first machine online, or registering one.
    let install: (LoginEngine) -> Void

    var body: some View {
        Section {
            ForEach(engines) { sources in
                InfrastructureEngineRow(sources: sources) { install(sources.engine) }
            }
        } header: {
            RunnerSectionHeader(Infrastructure.enginesTitle)
        } footer: {
            Text(Infrastructure.enginesDetail)
        }
    }
}

private struct InfrastructureEngineRow: View {
    let sources: Infrastructure.Engine
    let install: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ProviderMark(provider: sources.engine.rawValue, size: 28, label: sources.engine.displayName)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(sources.engine.displayName)
                        .font(.headline)
                    InfrastructureStateChip(ready: sources.ready)
                }
                if sources.ready {
                    if !sources.machines.isEmpty {
                        line(Infrastructure.subscription, sources.machines.joined(separator: ", "))
                    }
                    if !sources.keys.isEmpty {
                        line(Infrastructure.apiKey, keys)
                    }
                    if !sources.pools.isEmpty {
                        line(Infrastructure.pool, sources.pools.joined(separator: ", "))
                    }
                } else {
                    Text(Infrastructure.nothingCanPay)
                        .font(.orbitListSubtitle)
                        .foregroundStyle(Color.secondary)
                    Button(Infrastructure.installOnAMachine, action: install)
                        .font(.orbitListSubtitle)
                        .buttonStyle(.borderless)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
    }

    /// "Anthropic (Claude) Claude Opus 5, DeepSeek DeepSeek V4 Pro": each key, and its model set apart.
    private var keys: AttributedString {
        typealias Colour = AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute
        var out = AttributedString()
        for (index, key) in sources.keys.enumerated() {
            if index > 0 { out += AttributedString(", ") }
            out += AttributedString(key.label)
            if let model = key.model {
                var tag = AttributedString(" " + model)
                tag[Colour.self] = Color.secondary.opacity(0.75)
                out += tag
            }
        }
        return out
    }

    /// "Subscription · Mac Studio ×2, HPC", its source's name in bold.
    private func line(_ source: String, _ names: String) -> some View {
        line(source, AttributedString(names))
    }

    private func line(_ source: String, _ names: AttributedString) -> some View {
        var lead = AttributedString(source)
        lead.inlinePresentationIntent = .stronglyEmphasized
        return Text(lead + AttributedString(" · ") + names)
            .font(.orbitListSubtitle)
            .foregroundStyle(Color.secondary)
    }
}

/// Ready in green, Not set up in grey — the web card's tag.
private struct InfrastructureStateChip: View {
    let ready: Bool

    var body: some View {
        Text(ready ? Infrastructure.ready : Infrastructure.notSetUp)
            .font(.orbitMeta.weight(.semibold))
            .foregroundStyle(ready ? RunnerInk.green : Color.secondary)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(ready ? RunnerInk.green.opacity(0.12) : Color.primary.opacity(0.065),
                        in: RoundedRectangle(cornerRadius: 5, style: .continuous))
    }
}

// MARK: - Account pools

/// The pools the account is in, then its own: a row each, saying where it stands. A row opens the pool's
/// page where there is one to open (`open` set) — not on the Mac, which has no pool pages.
struct InfrastructurePoolsSection: View {
    let memberPools: [SharedPool]
    let ownPools: [ProviderPool]
    let open: ((NavNode) -> Void)?

    var body: some View {
        if !memberPools.isEmpty || !ownPools.isEmpty {
            Section {
                ForEach(memberPools) { pool in
                    row(NavNode.sharedPool(poolID: pool.id)) {
                        CodexPoolRowLabel(pool: SharedPools.asProviderPool(pool))
                    }
                }
                ForEach(ownPools) { pool in
                    row(NavNode.accountPool(poolID: pool.id)) {
                        if ProviderPools.runsCodex(pool) {
                            CodexPoolRowLabel(pool: pool)
                        } else {
                            PoolRowLabel(engine: "claude", title: pool.label, line: nil,
                                         value: ProvidersOverview.poolSummary(pool))
                        }
                    }
                }
            } header: {
                RunnerSectionHeader(ProvidersOverview.accountPools)
            } footer: {
                Text(ProvidersOverview.accountPoolsDetail)
            }
        }
    }

    /// A row that pushes its pool's page — a `Button`, as every row the page pushes is — or only says.
    @ViewBuilder private func row<Label: View>(_ page: NavNode, @ViewBuilder label: () -> Label) -> some View {
        if let open {
            Button { open(page) } label: {
                HStack(spacing: 8) {
                    label()
                    RunnerChevron()
                }
                .foregroundStyle(Color.primary)
                .contentShape(Rectangle())
            }
            .runnerRowButtonStyle()
        } else {
            label()
        }
    }
}

/// A Codex pool's row, by who reads it (web's `PoolCard` head): its name — SHARED once anybody but its
/// owner can use it — then whose it is and how many keys the reader can run on, or "Just me" and how many
/// of its accounts can run, and at its end the head's gauge, where the reader has one.
struct CodexPoolRowLabel: View {
    let pool: ProviderPool

    var body: some View {
        let value = ProvidersOverview.codexPoolValue(pool)
        PoolRowLabel(engine: "codex", title: pool.label, shared: ProvidersOverview.isShared(pool),
                     line: ProvidersOverview.codexPoolLine(pool), value: value?.label, valueTone: value?.tone)
    }
}

/// A pool's row: its engine's mark and its name — and a line under it, where it has one — and at its
/// end how many of its accounts a session could start on now, or the gauge a Codex pool's head reads, in
/// that gauge's tone.
struct PoolRowLabel: View {
    let engine: String
    let title: String
    var shared = false
    let line: String?
    let value: String?
    var valueTone: PoolStatus.Tone? = nil

    var body: some View {
        LabeledContent {
            if let value {
                if let valueTone {
                    Text(value)
                        .foregroundStyle(PoolTone.color(valueTone))
                } else {
                    Text(value)
                }
            }
        } label: {
            HStack(spacing: 12) {
                ProviderMark(provider: engine, size: 26)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(title)
                            .lineLimit(1)
                        if shared {
                            PoolChip(text: CodexPoolPage.sharedChip, brand: true)
                        }
                    }
                    if let line {
                        Text(line)
                            .font(.orbitListSubtitle)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}

/// The colours a pool's status words and people are drawn in: web's tag colours, in the effect mock's
/// inks on light (system green/orange/red on their own washes read too faint) and the system colours on
/// dark.
enum PoolTone {
    static func color(_ tone: PoolStatus.Tone) -> Color {
        switch tone {
        case .success: return Color(light: Color(red: 0.141, green: 0.541, blue: 0.239), dark: .green)   // #248A3D
        case .brand: return .accentColor
        case .warning: return Color(light: Color(red: 0.702, green: 0.353, blue: 0), dark: .orange)      // #B35A00
        case .danger: return Color(light: Color(red: 0.788, green: 0.149, blue: 0.106), dark: .red)      // #C9261B
        case .neutral: return .secondary
        }
    }

    static func hex(_ hex: String) -> Color {
        guard let c = TagChipColor.components(hex: hex) else { return .gray }
        return Color(red: c.red, green: c.green, blue: c.blue)
    }
}

// MARK: - API keys

/// The account's own keys, each with the model a session on it starts on — and Disabled for one that is
/// switched off. A DeepSeek key's row ends with its account's balance, and opens the key's page where
/// there is one to open (`open` set) — not on the Mac. Keys are added and changed on the web.
struct InfrastructureKeysSection: View {
    let keys: [ConfiguredProvider]
    /// Each DeepSeek key's balance by provider id, as last read.
    var balances: [String: ProviderBalanceReading] = [:]
    var open: ((NavNode) -> Void)? = nil

    var body: some View {
        Section {
            if keys.isEmpty {
                Text(ProvidersOverview.noKeys).foregroundStyle(.secondary)
            }
            ForEach(keys) { key in
                if let id = DeepSeekBalance.key(for: key, mine: keys)?.providerID {
                    if let open {
                        Button { open(.providerDetail(providerID: id)) } label: {
                            HStack(spacing: 8) {
                                row(key, balance: balances[id])
                                RunnerChevron()
                            }
                            .foregroundStyle(Color.primary)
                            .contentShape(Rectangle())
                        }
                        .runnerRowButtonStyle()
                    } else {
                        row(key, balance: balances[id])
                    }
                } else {
                    row(key, balance: nil)
                }
            }
        } header: {
            RunnerSectionHeader(ProvidersOverview.apiKeys)
        } footer: {
            Text(ProvidersOverview.apiKeysDetail + " " + ProvidersOverview.editOnWeb)
        }
    }

    /// A key's name over its model, and at its end Disabled — or, for a DeepSeek key that is on, its
    /// account's balance once one is read, in the tone of what it comes to.
    private func row(_ key: ConfiguredProvider, balance: ProviderBalanceReading?) -> some View {
        LabeledContent {
            if key.enabled == false {
                Text(Infrastructure.disabled)
            } else if let balance, let value = DeepSeekBalance.rowValue(DeepSeekBalance.state(balance)) {
                Text(value.label)
                    .foregroundStyle(PoolTone.color(value.tone))
                    .monospacedDigit()
            }
        } label: {
            HStack(spacing: 12) {
                ProviderMark(provider: key.slug, size: 26, brandKey: key.presetSlug, label: key.label)
                VStack(alignment: .leading, spacing: 1) {
                    Text(Infrastructure.keyLabel(key.label, presetSlug: key.presetSlug))
                        .lineLimit(1)
                    if let model = Infrastructure.defaultModel(key) {
                        Text(model)
                            .font(.orbitListSubtitle)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}
