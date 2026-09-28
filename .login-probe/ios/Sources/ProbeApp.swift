import SwiftUI
import UIKit
import OrbitKit

// TEMPORARY evidence probe (see ../../README.md). One screen per launch (`-screen <name>`, `-dark`), drawn
// by the app's own pages — Generated/ProviderPoolViews.swift copied whole — over the data the P3-c boards
// draw: My Codex, a Codex pool of one's own ChatGPT account, decoded from the shape GET /providers/pools
// answers with (so the pool's account is drawn as its member by the real door, ProviderPool's decoder).

@main
struct LoginProbeApp: App {
    var body: some Scene {
        WindowGroup { ProbeRoot() }
    }
}

enum ProbeData {
    /// Times relative to the device's own clock, as the server's would be: the 5h window resets in
    /// 2h13m, the weekly one in 3 days, the code works for 15 minutes.
    static func at(_ seconds: TimeInterval) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let minute = (Date().timeIntervalSince1970 + seconds) / 60
        return formatter.string(from: Date(timeIntervalSince1970: minute.rounded(.down) * 60))
    }

    static func account(state: String = "ACTIVE", primary: Int = 23) -> String {
        """
        {"state": "\(state)", "email": "wikova@orbitd.io", "plan": "pro", "fingerprint": "…7QX4",
         "lastError": null, "expiresAt": "\(at(9 * 86400))", "linkedAt": "2026-09-28T09:12:00.000Z",
         "usage": {"provider": "codex",
                   "primary": {"utilization": \(primary), "resetsAt": "\(at(2 * 3600 + 13 * 60))", "windowDurationMins": 300},
                   "secondary": {"utilization": 41, "resetsAt": "\(at(3 * 86400 + 5 * 3600))", "windowDurationMins": 10080}},
         "usageUnavailable": null}
        """
    }

    /// The pool as GET /providers/pools serves it, through the app's own decoder.
    static func codexPool(_ login: String) -> ProviderPool {
        let json = """
        {"id": "2zQeDGWFFAgN2112jNFD6", "slug": "my-codex", "label": "My Codex", "engine": "codex",
         "createdAt": "2026-09-28T09:10:00.000Z", "updatedAt": "2026-09-28T09:12:00.000Z",
         "login": \(login), "resetsAt": null, "members": [],
         "unavailable": "the pool \\"My Codex\\" has no ChatGPT account signed in — sign in on its page, or pick another provider"}
        """
        return try! JSONDecoder().decode(ProviderPool.self, from: Data(json.utf8))
    }

    static let active = codexPool(account())
    static let spent = codexPool(account(primary: 100))
    static let signedOut = codexPool(account(state: "SIGNED_OUT"))
    static let none = codexPool("null")

    static let attempt = CodexLoginAttempt(verificationUrl: "https://auth.openai.com/codex/device",
                                           userCode: "QX7M-4TZPK", expiresAt: at(15 * 60))
    static var signedInAccount: CodexLogin { active.login! }

    static func id(_ n: Int) -> String { "0195c0de-0000-7000-8000-\(String(format: "%012d", n))" }

    static let team = SharedPool(
        id: id(900), slug: "team-codex", label: "Team Codex", engine: "codex",
        membersCanAdd: true, ownKeyFirst: true, viewerRole: .admin,
        window: SharedPoolWindow(start: "2026-09-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z"),
        people: [
            SharedPoolPerson(userId: id(1), name: "Wikova", role: .admin, creator: true, you: true, keys: 2, sessions: 23,
                             usage: PoolSpend(costUsd: 34)),
            SharedPoolPerson(userId: id(2), name: "Zhang Min", role: .member, keys: 1, sessions: 19, usage: PoolSpend(costUsd: 30)),
            SharedPoolPerson(userId: id(3), name: "Chen Yu", role: .member, keys: 0, sessions: 14, usage: PoolSpend(costUsd: 24)),
            SharedPoolPerson(userId: id(4), name: "Lin Wei", role: .member, keys: 0, sessions: 6, usage: PoolSpend(costUsd: 12)),
        ],
        keys: [
            SharedPoolKey(id: id(11), label: "orbit-org-1", fingerprint: "sk-…AB12", shareCap: 50,
                          contributor: PoolKeyContributor(userId: id(1), name: "Wikova", you: true),
                          usage: PoolSpend(costUsd: 12.4, othersCostUsd: 12.4), next: true),
            SharedPoolKey(id: id(12), label: "orbit-org-2", fingerprint: "sk-…7K2P", shareCap: 50,
                          contributor: PoolKeyContributor(userId: id(2), name: "Zhang Min"),
                          usage: PoolSpend(costUsd: 31, othersCostUsd: 31), running: true),
            SharedPoolKey(id: id(13), label: "ios-build", fingerprint: "sk-…QZ03", shareCap: 50,
                          contributor: PoolKeyContributor(userId: id(3), name: "Chen Yu"),
                          usage: PoolSpend(costUsd: 50, othersCostUsd: 50)),
        ])

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
            {"engine": "kimi", "installed": true, "auth": "no"}]}]
        """
        return (try? JSONDecoder().decode([Runner].self, from: Data(json.utf8))) ?? []
    }()

    static let keys = [
        ConfiguredProvider(slug: "anthropic", label: "jianghailong.rd@Claude", runtime: "claude", presetSlug: "anthropic"),
        ConfiguredProvider(slug: "anthropic-2", label: "orbitd@Claude", runtime: "claude", presetSlug: "anthropic"),
    ]

    /// Presses that go nowhere: the still screens.
    static let still = CodexPoolActions(
        start: { attempt },
        poll: { CodexLoginPoll(status: "PENDING", verificationUrl: attempt.verificationUrl,
                               userCode: attempt.userCode, expiresAt: attempt.expiresAt) },
        cancel: {}, signOut: { nil }, deletePool: { nil }, refresh: {})
}

/// A stand-in server for the live flow: the code, two polls still waiting, then the account.
final class ProbeServer: @unchecked Sendable {
    var polls = 0
    var started = 0
    var cancelled = 0
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
        case "pool": page(ProbeData.active)
        case "pool-spent": page(ProbeData.spent)
        case "pool-out": page(ProbeData.signedOut)
        case "pool-none": page(ProbeData.none)
        case "consent": sheet(ProbeData.none, .consent)
        case "code": sheet(ProbeData.none, .code(url: ProbeData.attempt.verificationUrl, code: ProbeData.attempt.userCode,
                                               expiresAt: ProbeData.attempt.expiresAt))
        case "done": sheet(ProbeData.none, .done(ProbeData.signedInAccount))
        case "expired": sheet(ProbeData.none, .expired)
        case "failed": sheet(ProbeData.none, .failed("the codex CLI gave up (exit 1)"))
        case "dup": sheet(ProbeData.none, .duplicate)
        case "taken": sheet(ProbeData.signedOut, .taken)
        case "again": sheet(ProbeData.signedOut, .consent)
        case "again-code": sheet(ProbeData.signedOut, .code(url: ProbeData.attempt.verificationUrl,
                                                          code: ProbeData.attempt.userCode,
                                                          expiresAt: ProbeData.attempt.expiresAt))
        case "flow": Pushed(root: SettingsPage.providers.title) { FlowScreen(start: ProbeData.none) }
        case "flow-again": Pushed(root: SettingsPage.providers.title) { FlowScreen(start: ProbeData.signedOut) }
        default:
            Pushed(root: "Settings") {
                ProvidersOverviewForm(runners: ProbeData.runners, pools: [ProbeData.active, ProbeData.claude],
                                      sharedPools: [ProbeData.team], keys: ProbeData.keys)
                    .navigationTitle(SettingsPage.providers.title)
            }
        }
    }

    private func page(_ pool: ProviderPool) -> some View {
        Pushed(root: SettingsPage.providers.title) {
            CodexPoolPageView(pool: pool, actions: ProbeData.still)
        }
    }

    private func sheet(_ pool: ProviderPool, _ step: CodexSignIn.Step) -> some View {
        Pushed(root: SettingsPage.providers.title) {
            CodexPoolPageView(pool: pool, actions: ProbeData.still)
                .sheet(isPresented: .constant(true)) {
                    CodexSignInSheet(pool: pool, actions: ProbeData.still, step: step)
                }
        }
    }
}

/// The whole flow, live: the page's own "Sign in with ChatGPT" (or "Sign in again") opens the real
/// sheet, which starts, polls — two answers still waiting, then the account — and hands the page the
/// pool with the account in it. What the stand-in server saw is written on the page's foot for the test.
struct FlowScreen: View {
    let start: ProviderPool
    @State private var pool: ProviderPool?
    @State private var server = ProbeServer()
    @State private var seen = ""

    var body: some View {
        CodexPoolPageView(pool: pool ?? start, actions: CodexPoolActions(
            start: {
                server.started += 1
                try await Task.sleep(for: .milliseconds(300))
                return ProbeData.attempt
            },
            poll: {
                server.polls += 1
                if server.polls < 3 {
                    return CodexLoginPoll(status: "PENDING", verificationUrl: ProbeData.attempt.verificationUrl,
                                          userCode: ProbeData.attempt.userCode, expiresAt: ProbeData.attempt.expiresAt)
                }
                return CodexLoginPoll(status: "CONFIRMED", account: ProbeData.signedInAccount)
            },
            cancel: { server.cancelled += 1 },
            signOut: { nil },
            deletePool: { nil },
            refresh: {
                pool = ProbeData.active
                seen = "server: started \(server.started), polled \(server.polls), cancelled \(server.cancelled)"
            }))
        .safeAreaInset(edge: .bottom) {
            if !seen.isEmpty {
                Text(seen)
                    .font(.orbitMeta)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("probe-server")
            }
        }
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
