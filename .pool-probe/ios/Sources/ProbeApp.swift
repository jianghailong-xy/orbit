import SwiftUI
import UIKit
import OrbitKit

// TEMPORARY evidence probe (see ../../README.md). One screen per launch (`-screen <name>`, `-dark`), drawn
// by the app's own pages — Generated/ProviderPoolViews.swift copied whole — over the pool effect mock 05
// draws: Team Codex (four people, five keys) and Claude accounts, in the shapes the server answers with.

@main
struct PoolProbeApp: App {
    var body: some Scene {
        WindowGroup { ProbeRoot() }
    }
}

enum ProbeData {
    /// 10:04 in Berlin on Monday 28 September 2026: the month's caps come back on Thursday at 02:00.
    static let now = RelativeTime.parse("2026-09-28T08:04:00.000Z")!

    static func id(_ n: Int) -> String { "0195c0de-0000-7000-8000-\(String(format: "%012d", n))" }
    static let wikova = id(1), zhang = id(2), chen = id(3), lin = id(4)

    /// Team Codex as `me` reads it.
    static func team(as me: String, role: SharedPoolRole) -> SharedPool {
        func person(_ userId: String, _ name: String, _ role: SharedPoolRole, keys: Int, sessions: Int,
                    cost: Double) -> SharedPoolPerson {
            SharedPoolPerson(userId: userId, name: name, role: role, creator: userId == wikova, you: userId == me,
                             keys: keys, sessions: sessions, usage: PoolSpend(costUsd: cost))
        }
        func key(_ n: Int, _ label: String, _ hint: String, _ owner: String, _ name: String,
                 state: PoolKeyState = .active, enabled: Bool = true, others: Double,
                 running: Bool = false, next: Bool = false, spentUntil: String? = nil) -> SharedPoolKey {
            SharedPoolKey(id: id(n), label: label, fingerprint: "sk-…\(hint)", state: state, enabled: enabled,
                          shareCap: 50, spentUntil: spentUntil,
                          contributor: PoolKeyContributor(userId: owner, name: name, you: owner == me),
                          usage: PoolSpend(costUsd: others, othersCostUsd: others), running: running, next: next)
        }
        return SharedPool(
            id: id(900), slug: "team-codex", label: "Team Codex", engine: "codex",
            membersCanAdd: true, ownKeyFirst: true, viewerRole: role,
            window: SharedPoolWindow(start: "2026-09-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z"),
            people: [
                person(wikova, "Wikova", .admin, keys: 2, sessions: 23, cost: 34),
                person(zhang, "Zhang Min", .member, keys: 2, sessions: 19, cost: 30),
                person(chen, "Chen Yu", .member, keys: 2, sessions: 14, cost: 24),
                person(lin, "Lin Wei", .member, keys: 0, sessions: 6, cost: 12),
            ],
            keys: [
                // The server names the next key for whoever reads the pool: with "Own key first", the
                // reader's own that can run — Wikova's orbit-org-1, Zhang Min's orbit-org-2.
                key(11, "orbit-org-1", "AB12", wikova, "Wikova", others: 12.40, next: me == wikova),
                key(12, "orbit-org-2", "7K2P", zhang, "Zhang Min", others: 31.00, running: true, next: me == zhang),
                key(13, "ios-build", "QZ03", chen, "Chen Yu", others: 50.00),
                key(14, "wikova-backup", "M4T7", wikova, "Wikova", state: .invalid, others: 6.20),
                key(15, "zhang-old", "31FD", zhang, "Zhang Min", enabled: false, others: 0),
                // P2's mark: OpenAI answered `insufficient_quota` for this one, so no claim picks it
                // before then — the row says "Out of budget · resets Sep 30" and it counts for nobody.
                key(17, "chen-org-2", "5V8N", chen, "Chen Yu", others: 18, spentUntil: "2026-09-30T06:00:00.000Z"),
            ])
    }

    static let admin = team(as: wikova, role: .admin)
    static let member = team(as: zhang, role: .member)

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

    static let actions = SharedPoolActions(
        addKey: { _ in .refused("probe") },
        replaceKey: { _, _ in .refused("probe") },
        removeKey: { _ in nil },
        switchKey: { _, _ in nil },
        setRules: { _ in nil },
        addPerson: { _ in nil },
        setRole: { _, _ in nil },
        removePerson: { _ in nil },
        deletePool: { nil },
        leavePool: { nil })
}

struct ProbeRoot: View {
    private var args: [String] { ProcessInfo.processInfo.arguments }

    private var screen: String {
        guard let at = args.firstIndex(of: "-screen"), at + 1 < args.count else { return "providers" }
        return args[at + 1]
    }

    var body: some View {
        content
            .preferredColorScheme(args.contains("-dark") ? .dark : .light)
    }

    @ViewBuilder private var content: some View {
        switch screen {
        case "pool":
            Pushed(root: SettingsPage.providers.title) { adminPage }
        case "pool-member":
            Pushed(root: SettingsPage.providers.title) {
                SharedPoolPageView(pool: ProbeData.member, actions: ProbeData.actions)
            }
        case "add-consent":
            Pushed(root: SettingsPage.providers.title) {
                adminPage.sheet(isPresented: .constant(true)) {
                    AddPoolKeySheet(pool: ProbeData.admin, step: .consent) { _, _, _ in .refused("probe") }
                }
            }
        case "add-form":
            Pushed(root: SettingsPage.providers.title) {
                adminPage.sheet(isPresented: .constant(true)) {
                    AddPoolKeySheet(pool: ProbeData.admin, step: .form, name: "wikova-org-1",
                                    key: "sk-proj-9tRkQm2Zx8VbN4Lc7Hd39E4D", limit: "50") { _, _, _ in .refused("probe") }
                }
            }
        case "add-done":
            Pushed(root: SettingsPage.providers.title) {
                adminPage.sheet(isPresented: .constant(true)) {
                    AddPoolKeySheet(pool: ProbeData.admin, step: .done(label: "wikova-org-1", fingerprint: "sk-…9E4D")) { _, _, _ in
                        .refused("probe")
                    }
                }
            }
        case "add-dup":
            Pushed(root: SettingsPage.providers.title) {
                adminPage.sheet(isPresented: .constant(true)) {
                    AddPoolKeySheet(pool: ProbeData.admin, step: .duplicate(AddPoolKey.AddedBy(name: "Chen Yu"))) { _, _, _ in
                        .refused("probe")
                    }
                }
            }
        case "replace":
            Pushed(root: SettingsPage.providers.title) {
                adminPage.sheet(isPresented: .constant(true)) {
                    AddPoolKeySheet(pool: ProbeData.admin, replacing: ProbeData.admin.keys[3]) { _, _, _ in .refused("probe") }
                }
            }
        case "claude-pool":
            Pushed(root: SettingsPage.providers.title) {
                AccountPoolPageView(pool: ProbeData.claude, now: ProbeData.now)
            }
        default:
            Pushed(root: "Settings") {
                ProvidersOverviewForm(runners: ProbeData.runners, pools: [ProbeData.claude],
                                      sharedPools: [ProbeData.admin], keys: ProbeData.keys)
                    .navigationTitle(SettingsPage.providers.title)
            }
        }
    }

    private var adminPage: some View {
        SharedPoolPageView(pool: ProbeData.admin, actions: ProbeData.actions)
    }
}

/// A page one level into Settings' stack, so the bar carries the back button it has in the app.
struct Pushed<Page: View>: View {
    let root: String
    @ViewBuilder let page: () -> Page
    @State private var path = ["page"]

    var body: some View {
        NavigationStack(path: $path) {
            Text(root)
                .navigationTitle(root)
                .navigationBarTitleDisplayMode(.inline)
                .navigationDestination(for: String.self) { _ in page() }
        }
    }
}
