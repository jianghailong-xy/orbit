import SwiftUI
import UIKit
import OrbitKit

// TEMPORARY evidence probe (see ../../README.md). One screen per launch (`-screen <name>`), drawn by the app's
// own pages — Generated/ProviderPoolViews.swift copied whole — over the boards' data
// (docs/mocks/account-pool-access/): jianghailong's Codex Pool with his two ChatGPT accounts, shared with
// Zhang Min and Lin Wei, its API keys orbit-org-1 (his) and zm-proj (Zhang Min's). His accounts come through
// the real decoder, in the shape GET /providers/pools answers with; who can use it is the shape
// GET /providers/shared-pools[/:id] answers each reader with.

@main
struct AccessProbeApp: App {
    var body: some Scene {
        WindowGroup { ProbeRoot() }
    }
}

enum Boards {
    /// Times relative to the device's own clock, as the server's would be.
    static func at(_ seconds: TimeInterval) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let minute = (Date().timeIntervalSince1970 + seconds) / 60
        return formatter.string(from: Date(timeIntervalSince1970: minute.rounded(.down) * 60))
    }

    static func id(_ n: Int) -> String { "0195c0de-0000-7000-8000-\(String(format: "%012d", n))" }

    static let jiang = id(1), zhang = id(2), lin = id(3), chen = id(4), poolID = id(800)
    static let names = [jiang: "jianghailong", zhang: "Zhang Min", lin: "Lin Wei", chen: "Chen Yu"]

    static func account(_ email: String, plan: String, fingerprint: String, fiveHour: Int, weekly: Int) -> String {
        """
        {"state": "ACTIVE", "email": "\(email)", "plan": "\(plan)", "fingerprint": "\(fingerprint)",
         "lastError": null, "expiresAt": "\(at(9 * 86400))", "linkedAt": "2026-09-28T09:12:00.000Z",
         "usage": {"provider": "codex",
                   "primary": {"utilization": \(fiveHour), "resetsAt": "\(at(3 * 3600 + 28 * 60))", "windowDurationMins": 300},
                   "secondary": {"utilization": \(weekly), "resetsAt": "\(at(4 * 86400 + 4 * 3600))", "windowDurationMins": 10080}},
         "usageUnavailable": null}
        """
    }

    /// His pool as GET /providers/pools serves it to him, through the app's own decoder.
    static func own(id: String = poolID, slug: String = "codex-pool", label: String = "Codex Pool") -> ProviderPool {
        let logins = [account("jianghailong.rd@gmail.com", plan: "plus", fingerprint: "…016a", fiveHour: 6, weekly: 97),
                      account("hl.work@gmail.com", plan: "pro", fingerprint: "…7QX4", fiveHour: 18, weekly: 40)]
        let json = """
        {"id": "\(id)", "slug": "\(slug)", "label": "\(label)", "engine": "codex", "login": \(logins[0]),
         "logins": [\(logins.joined(separator: ","))], "resetsAt": null, "members": [], "unavailable": null}
        """
        return try! JSONDecoder().decode(ProviderPool.self, from: Data(json.utf8))
    }

    /// Who can use the pool and its API keys, as `viewer` reads them; `people` are the ones in it besides
    /// its owner.
    static func access(_ viewer: String, people: [String] = [zhang, lin],
                       keys labels: [String] = ["orbit-org-1", "zm-proj"]) -> SharedPool {
        let usage = [jiang: 2.0, zhang: 5.5, lin: 2.5]
        let sessions = [jiang: 23, zhang: 19, lin: 6]
        func contributor(_ userId: String) -> PoolKeyContributor {
            PoolKeyContributor(userId: userId, name: names[userId] ?? "", you: viewer == userId)
        }
        let keys = [
            SharedPoolKey(id: id(11), label: "orbit-org-1", fingerprint: "sk-…AB12", shareCap: 50,
                          contributor: contributor(jiang), usage: PoolSpend(costUsd: 14, othersCostUsd: 12.4),
                          next: viewer == jiang),
            SharedPoolKey(id: id(12), label: "zm-proj", fingerprint: "sk-…7K2P",
                          contributor: contributor(zhang), usage: PoolSpend(costUsd: 3.1, othersCostUsd: 3.1),
                          running: true, next: viewer == zhang),
        ].filter { labels.contains($0.label) }
        return SharedPool(
            id: poolID, slug: "codex-pool", label: "Codex Pool", engine: "codex", shared: false, ownerHasChatGPT: true,
            membersCanAdd: true, ownKeyFirst: true, viewerRole: viewer == jiang ? .admin : .member,
            window: SharedPoolWindow(start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z"),
            people: ([jiang] + people).map { userId in
                SharedPoolPerson(userId: userId, name: names[userId] ?? "", role: userId == jiang ? .admin : .member,
                                 creator: userId == jiang, you: userId == viewer,
                                 keys: keys.filter { $0.contributor.userId == userId }.count,
                                 sessions: people.isEmpty ? 0 : sessions[userId] ?? 0,
                                 usage: PoolSpend(costUsd: people.isEmpty ? 0 : usage[userId] ?? 0))
            },
            keys: keys)
    }

    /// A pool of Chen Yu's own he added jianghailong to: one of its people, on its keys alone.
    static let chens = SharedPool(
        id: id(900), slug: "chen-codex", label: "Chen’s Codex", engine: "codex", shared: false, ownerHasChatGPT: true,
        viewerRole: .member,
        window: SharedPoolWindow(start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z"),
        people: [SharedPoolPerson(userId: chen, name: "Chen Yu", role: .admin, creator: true, keys: 2),
                 SharedPoolPerson(userId: jiang, name: "jianghailong", you: true)],
        keys: [
            SharedPoolKey(id: id(21), label: "chen-org", fingerprint: "sk-…Q2W8", shareCap: 40,
                          contributor: PoolKeyContributor(userId: chen, name: "Chen Yu"),
                          usage: PoolSpend(costUsd: 9, othersCostUsd: 6.3), next: true),
            SharedPoolKey(id: id(22), label: "chen-ci", fingerprint: "sk-…L0P5",
                          contributor: PoolKeyContributor(userId: chen, name: "Chen Yu")),
        ])

    static let runners: [Runner] = {
        let json = """
        [{"id": "r1", "name": "wikova", "online": true, "engines": [
            {"engine": "claude", "installed": true, "auth": "yes"}, {"engine": "codex", "installed": true, "auth": "yes"},
            {"engine": "kimi", "installed": true, "auth": "yes"}]}]
        """
        return (try? JSONDecoder().decode([Runner].self, from: Data(json.utf8))) ?? []
    }()

    /// Presses that go nowhere: the still screens. The sign-in stops at its notice.
    static let accountActions = CodexPoolActions(
        start: { throw CancellationError() },
        poll: { CodexLoginPoll(status: "PENDING") },
        cancel: {}, signOut: { _ in nil }, refresh: {})

    static let accessActions = PoolAccessActions(
        addKey: { _ in .refused("probe") }, replaceKey: { _, _ in .refused("probe") }, removeKey: { _ in nil },
        switchKey: { _, _ in nil }, setRules: { _ in nil }, share: { _, _ in "" }, keepToSelf: { nil },
        setRole: { _, _ in nil }, removePerson: { _ in nil })

    static func page(own: ProviderPool?, access: SharedPool?) -> CodexPoolPageView {
        CodexPoolPageView(page: CodexPoolPage(own: own, access: access)!,
                          accountActions: own == nil ? nil : accountActions,
                          accessActions: access == nil ? nil : accessActions, exit: { nil })
    }
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
        // His page, shared with Zhang Min and Lin Wei (02, owner).
        case "owner": Pushed { Boards.page(own: Boards.own(), access: Boards.access(Boards.jiang)) }
        // His page while it is his alone (01-D).
        case "alone": Pushed { Boards.page(own: Boards.own(), access: Boards.access(Boards.jiang, people: [], keys: [])) }
        // His alone, with one key in it: what Share says they get (03-4).
        case "alone-key":
            Pushed { Boards.page(own: Boards.own(), access: Boards.access(Boards.jiang, people: [], keys: ["orbit-org-1"])) }
        // Shared before it has an API key (02, the boundary state).
        case "no-key": Pushed { Boards.page(own: Boards.own(), access: Boards.access(Boards.jiang, keys: [])) }
        // The same pool as Zhang Min reads it (02, member).
        case "member": Pushed { Boards.page(own: nil, access: Boards.access(Boards.zhang)) }
        default:
            Pushed(root: "Settings") {
                ProvidersOverviewForm(
                    runners: Boards.runners,
                    pools: [Boards.own(id: Boards.id(801), slug: "my-codex", label: "My Codex"),
                            SharedPools.ownPoolWithAccess(Boards.own(), Boards.access(Boards.jiang))],
                    sharedPools: [Boards.chens], keys: [])
                    .navigationTitle(SettingsPage.providers.title)
            }
        }
    }
}

/// A page one level into Settings' stack, so the bar carries the back button it has in the app.
struct Pushed<Page: View>: View {
    var root: String = SettingsPage.providers.title
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
