import SwiftUI
import UIKit
import OrbitKit

// TEMPORARY evidence probe (see ../../README.md). The real picker (Generated/AgentIdentity.swift,
// copied whole out of the commit under test), the new-session hero and the composer's pool row, over
// the "Team Codex" fixture the shared-pool page probe uses: four people, five keys, the viewer on
// orbit-org-1. One screen per launch (`-screen <name>`, `-dark`).

@main
struct PoolProbeApp: App {
    var body: some Scene {
        WindowGroup { ProbeRoot() }
    }
}

enum ProbeData {
    static func id(_ n: Int) -> String { "0195c0de-0000-7000-8000-\(String(format: "%012d", n))" }
    static let wikova = id(1), zhang = id(2), chen = id(3), lin = id(4)

    /// Team Codex as its people read it. `me` is the viewer: Wikova, whose own key `orbit-org-1` is
    /// the one the server names as next (`SharedPoolKey.next`) — the key the composer will show beside
    /// its gauge. The pool's own `viewerRole` is MEMBER, as the fixture says; Wikova's row in the
    /// people list carries the admin role they created it with.
    static func team(as me: String) -> SharedPool {
        func person(_ userId: String, _ name: String, _ role: SharedPoolRole, keys: Int, sessions: Int,
                    cost: Double) -> SharedPoolPerson {
            SharedPoolPerson(userId: userId, name: name, role: role, creator: userId == wikova, you: userId == me,
                             keys: keys, sessions: sessions, usage: PoolSpend(costUsd: cost))
        }
        func key(_ n: Int, _ label: String, _ hint: String, _ owner: String, _ name: String,
                 state: PoolKeyState = .active, enabled: Bool = true, others: Double,
                 running: Bool = false, next: Bool = false) -> SharedPoolKey {
            SharedPoolKey(id: id(n), label: label, fingerprint: "sk-…\(hint)", state: state, enabled: enabled,
                          shareCap: 50, contributor: PoolKeyContributor(userId: owner, name: name, you: owner == me),
                          usage: PoolSpend(costUsd: others, othersCostUsd: others), running: running, next: next)
        }
        return SharedPool(
            id: id(900), slug: "team-codex", label: "Team Codex", engine: "codex",
            membersCanAdd: true, ownKeyFirst: true, viewerRole: .member,
            window: SharedPoolWindow(start: "2026-09-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z"),
            people: [
                person(wikova, "Wikova", .admin, keys: 2, sessions: 23, cost: 34),
                person(zhang, "Zhang Min", .member, keys: 2, sessions: 19, cost: 30),
                person(chen, "Chen Yu", .member, keys: 1, sessions: 14, cost: 24),
                person(lin, "Lin Wei", .member, keys: 0, sessions: 6, cost: 12),
            ],
            keys: [
                // The server names the next key for whoever reads the pool: the reader's own that can
                // run — Wikova's orbit-org-1.
                key(11, "orbit-org-1", "AB12", wikova, "Wikova", others: 12.40, next: me == wikova),
                key(12, "orbit-org-2", "7K2P", zhang, "Zhang Min", others: 31.00, running: true),
                key(13, "ios-build", "QZ03", chen, "Chen Yu", others: 50.00),
                key(14, "wikova-backup", "M4T7", wikova, "Wikova", state: .invalid, others: 6.20),
                key(15, "zhang-old", "31FD", zhang, "Zhang Min", enabled: false, others: 0),
            ])
    }

    /// A second shared pool with nothing in it: the picker's greyed "No keys" row.
    static let emptyPool = SharedPool(id: id(901), slug: "new-pool", label: "New pool", engine: "codex",
                                      viewerRole: .member, people: [], keys: [])

    static let teamCodex = team(as: wikova)
    static let noKeys = SharedPools.asProviderPool(emptyPool)
    static let claude = ProviderPool(
        id: id(800), slug: "claude-accounts", label: "Claude accounts",
        members: [
            PoolMember(id: id(801), slug: "anthropic", label: "jianghailong.rd@Claude", presetSlug: "anthropic",
                       planUsage: PlanUsageSnapshot(provider: "claude", fiveHour: PlanUsageWindow(utilization: 18)),
                       state: .available, next: true),
            PoolMember(id: id(802), slug: "anthropic-2", label: "orbitd@Claude", presetSlug: "anthropic",
                       planUsage: PlanUsageSnapshot(provider: "claude", fiveHour: PlanUsageWindow(utilization: 62)),
                       state: .available),
        ])

    static let runners: [Runner] = {
        let json = """
        [{"id": "r1", "name": "wikova", "online": true, "engines": [
            {"engine": "claude", "installed": true, "auth": "yes"}, {"engine": "codex", "installed": true, "auth": "yes"},
            {"engine": "kimi", "installed": true, "auth": "yes"}]},
         {"id": "r2", "name": "workstation", "online": true, "engines": [
            {"engine": "claude", "installed": true, "auth": "yes"}, {"engine": "codex", "installed": true, "auth": "no"},
            {"engine": "kimi", "installed": true, "auth": "no"}]},
         {"id": "r3", "name": "longdeMac-mini.local", "online": true, "engines": [
            {"engine": "claude", "installed": true, "auth": "yes"}, {"engine": "codex", "installed": false, "auth": "no"},
            {"engine": "kimi", "installed": false, "auth": "no"}]},
         {"id": "r4", "name": "workstation-gpu", "online": true, "engines": [
            {"engine": "claude", "installed": true, "auth": "no"}, {"engine": "codex", "installed": true, "auth": "no"},
            {"engine": "kimi", "installed": false, "auth": "no"}]}]
        """
        return (try? JSONDecoder().decode([Runner].self, from: Data(json.utf8))) ?? []
    }()

    static let keys = [
        ConfiguredProvider(slug: "anthropic", label: "jianghailong.rd@Claude", runtime: "claude", presetSlug: "anthropic"),
        ConfiguredProvider(slug: "anthropic-2", label: "orbitd@Claude", runtime: "claude", presetSlug: "anthropic"),
        ConfiguredProvider(slug: "deepseek", label: "DeepSeek", runtime: "claude", presetSlug: "deepseek"),
    ]

    /// The real picker's contents, built the way `NewSessionView.providerChoices` builds them — over
    /// the real adapter and the runner's own catalogue, so what is drawn is what the draft would offer.
    static func choices(pools: [ProviderPool]) -> [ProviderChoice] {
        SessionProviderChoices.choices(
            configured: keys + ProviderPools.asProviders(pools),
            catalog: runners.first?.modelCatalog,
            engines: runners.first?.engines,
            pools: pools)
    }

    static var teamPool: ProviderPool { SharedPools.asProviderPool(teamCodex) }
}

struct ProbeRoot: View {
    private var args: [String] { ProcessInfo.processInfo.arguments }

    private var screen: String {
        guard let at = args.firstIndex(of: "-screen"), at + 1 < args.count else { return "picker" }
        return args[at + 1]
    }

    var body: some View {
        content.preferredColorScheme(args.contains("-dark") ? .dark : .light)
    }

    @ViewBuilder private var content: some View {
        switch screen {
        case "hero":
            HeroShot()
        case "composer":
            ComposerShot()
        case "picker-nokeys":
            // The same picker with a pool nobody can start on: the server's "No keys", greyed.
            ProviderSwitchSheet(
                choices: ProbeData.choices(pools: [ProbeData.teamPool, ProbeData.noKeys]),
                currentSlug: "claude", agentName: "orbit") { _ in }
        default:
            // The core evidence: the picker as it opens when the draft is already on the shared pool.
            ProviderSwitchSheet(
                choices: ProbeData.choices(pools: [ProbeData.teamPool, ProbeData.claude]),
                currentSlug: "team-codex", agentName: "orbit") { _ in }
        }
    }
}

/// The new-session hero on the shared pool, drawn from the real `ProviderMark` (the app's own, copied
/// whole) with the labels the real hero resolves: `NewSessionView`'s hero block, minus the app around
/// it. The mark, the name, the chevron and the two lines are that block's own arrangement and type;
/// the real app target in this same project hosts the real `NewSessionView` for comparison.
struct HeroShot: View {
    private var choice: ProviderChoice {
        ProbeData.choices(pools: [ProbeData.teamPool]).first { $0.slug == "team-codex" }!
    }

    /// `NewSessionView.heroSubtitle`'s resolution, over this draft's provider and catalogue.
    private var modelLine: String {
        let catalog = ProbeData.runners.first?.modelCatalog
        let configured = ProbeData.keys + ProviderPools.asProviders([ProbeData.teamPool])
        let model = AgentDefaults.defaultModel(for: "team-codex", catalog: catalog, configured: configured)
        return AgentDefaults.friendlyName(model, for: "team-codex", catalog: catalog, configured: configured)
    }

    var body: some View {
        VStack(spacing: 18) {
            VStack(spacing: 14) {
                ProviderMark(provider: choice.slug, size: 68,
                             brandKey: choice.brandKey, label: choice.label,
                             poolSize: choice.poolSize, poolUnit: choice.poolUnit)
                HStack(spacing: 7) {
                    Text(choice.label)
                        .font(.title.weight(.bold)).foregroundStyle(.primary).lineLimit(1)
                    Image(systemName: "chevron.down").font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
            VStack(spacing: 5) {
                Text("Send a task to get started.")
                    .font(.callout).foregroundStyle(.secondary)
                Text(modelLine).font(.footnote).foregroundStyle(.tertiary).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 24)
    }
}

/// The composer's foot on the shared pool is drawn by `ComposerShot`, which lives in the generated
/// `ComposerPieces.swift` next to the two pieces it draws (gen.py appends it there).
