import Foundation
@testable import OrbitKit

/// The pool docs/mocks/account-pool-access/ draws, as the web's own specs build it
/// (pages/ProviderPoolPage.whoCanUseIt.test.tsx, ProviderPoolPage.access.test.tsx): jianghailong's Codex
/// Pool, with his two ChatGPT accounts, shared with Zhang Min and Lin Wei, and its API keys orbit-org-1
/// (his) and zm-proj (Zhang Min's). Each reader reads it as the server answers them — since 2026-10-03 the
/// accounts run the sessions of everyone in the pool, so both readers get the same accounts — `you` on
/// their own row and keys, `next` on the account (the one the server chose; while one can run, no key is)
/// a session of theirs starts on. Built the same way the web's specs build it, so a sentence this client
/// draws from it can be looked up among the sentences those specs expect.
enum PoolAccessBoards {
    static func id(_ n: Int) -> String { PublicID.toPublic("0195c0de-0000-7000-8000-\(String(format: "%012d", n))") }

    static let jiang = id(1), zhang = id(2), lin = id(3), poolID = id(800)
    static let names = [jiang: "jianghailong", zhang: "Zhang Min", lin: "Lin Wei"]

    private static let iso = ISO8601DateFormatter()
    static let inAnHour = iso.string(from: Date().addingTimeInterval(60 * 60))
    static let inThreeDays = iso.string(from: Date().addingTimeInterval(3 * 24 * 60 * 60))

    /// One of jianghailong's ChatGPT accounts, as GET /providers/pools serves it to him.
    static func account(_ email: String, plan: String, fingerprint: String, fiveHour: Double, weekly: Double) -> CodexLogin {
        CodexLogin(state: "ACTIVE", email: email, plan: plan, fingerprint: fingerprint, expiresAt: inThreeDays,
                   linkedAt: "2026-09-28T10:00:00.000Z",
                   usage: PlanUsageSnapshot(
                       provider: "codex",
                       primary: PlanUsageWindow(utilization: fiveHour, resetsAt: inAnHour, windowDurationMins: 300),
                       secondary: PlanUsageWindow(utilization: weekly, resetsAt: inThreeDays, windowDurationMins: 10080)))
    }

    static let accounts = [
        account("jianghailong.rd@gmail.com", plan: "plus", fingerprint: "…016a", fiveHour: 6, weekly: 97),
        account("hl.work@gmail.com", plan: "pro", fingerprint: "…7QX4", fiveHour: 18, weekly: 40),
    ]

    /// The pool as its owner's providers read it — his ChatGPT accounts — drawn as the decoder draws it.
    static func ownPool(_ logins: [CodexLogin] = accounts, label: String = "Codex Pool") -> ProviderPool {
        let drawn = CodexLoginPool.drawn(slug: "codex-pool", logins: logins)
        return ProviderPool(id: poolID, slug: "codex-pool", label: label, resetsAt: drawn.resetsAt,
                            unavailable: drawn.unavailable, members: drawn.members, engine: "codex",
                            login: logins.first, logins: logins)
    }

    /// Who can use the pool, his ChatGPT accounts and its API keys (GET /providers/shared-pools[/:id]), as
    /// `viewer` reads them — the accounts are everybody's to read and to run on since 2026-10-03, so the
    /// same two go to the owner and to the people they added. `people` are the ones in it besides its
    /// owner; `labels` the keys in it.
    static func access(_ viewer: String, people: [String] = [zhang, lin],
                       keys labels: [String] = ["orbit-org-1", "zm-proj"],
                       label: String = "Codex Pool", shared: Bool = false) -> SharedPool {
        let usage = [jiang: 2.0, zhang: 5.5, lin: 2.5]
        let sessions = [jiang: 23, zhang: 19, lin: 6]
        func contributor(_ userId: String) -> PoolKeyContributor {
            PoolKeyContributor(userId: userId, name: names[userId] ?? "", you: viewer == userId)
        }
        let everyKey = [
            SharedPoolKey(id: id(11), label: "orbit-org-1", fingerprint: "sk-…AB12", shareCap: 50,
                          contributor: contributor(jiang), usage: PoolSpend(costUsd: 14, othersCostUsd: 12.4)),
            SharedPoolKey(id: id(12), label: "zm-proj", fingerprint: "sk-…7K2P",
                          contributor: contributor(zhang), usage: PoolSpend(costUsd: 3.1, othersCostUsd: 3.1),
                          running: true),
        ].filter { labels.contains($0.label) }
        let logins = shared ? [] : accounts
        // The server marks the ONE credential the viewer's next session would run on: the account it sorts
        // first (the one with the most room in its week, 97% being "near limit"), while any account can
        // run; a key only once no account can.
        let keyNext = logins.isEmpty
        let keys = everyKey.map { $0.marked(next: keyNext && $0.contributor.you) }
        let drawnLogins = logins.enumerated().map { index, login in
            login.marked(next: index == 1 || logins.count == 1)
        }
        let everyone = [jiang] + people
        return SharedPool(
            id: poolID, slug: "codex-pool", label: label, engine: "codex", shared: shared, logins: drawnLogins,
            membersCanAdd: true, ownKeyFirst: true, viewerRole: viewer == jiang ? .admin : .member,
            window: SharedPoolWindow(start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z"),
            people: everyone.map { userId in
                SharedPoolPerson(userId: userId, name: names[userId] ?? "", role: userId == jiang ? .admin : .member,
                                 creator: userId == jiang, you: userId == viewer,
                                 keys: keys.filter { $0.contributor.userId == userId }.count,
                                 sessions: people.isEmpty ? 0 : sessions[userId] ?? 0,
                                 usage: PoolSpend(costUsd: people.isEmpty ? 0 : usage[userId] ?? 0))
            },
            keys: keys)
    }

    /// His page: his accounts, read with who can use the pool.
    static func ownersPage(people: [String] = [zhang, lin], keys: [String] = ["orbit-org-1", "zm-proj"]) -> CodexPoolPage {
        CodexPoolPage(own: ownPool(), access: access(jiang, people: people, keys: keys))!
    }

    /// The same pool's page as Zhang Min reads it: its people, its owner's accounts and its keys.
    static func zhangsPage(keys: [String] = ["orbit-org-1", "zm-proj"]) -> CodexPoolPage {
        CodexPoolPage(own: nil, access: access(zhang, keys: keys))!
    }

    /// The line under the pool's name, as the web page writes it in one run.
    static func line(_ page: CodexPoolPage) -> String {
        "\(CodexPoolPage.title) · \(page.who)\(page.subtitleRest) · \(page.how)"
    }
}

private extension CodexLogin {
    /// The same account, the next session's or not (the server's own mark on a pool read as one of its
    /// people).
    func marked(next: Bool) -> CodexLogin {
        CodexLogin(state: state, email: email, plan: plan, fingerprint: fingerprint, lastError: lastError,
                   expiresAt: expiresAt, linkedAt: linkedAt, usage: usage, usageUnavailable: usageUnavailable,
                   next: next)
    }
}

private extension SharedPoolKey {
    /// The same key, the next session's or not.
    func marked(next: Bool) -> SharedPoolKey {
        SharedPoolKey(id: id, label: label, fingerprint: fingerprint, state: state, enabled: enabled,
                      shareCap: shareCap, spentUntil: spentUntil, contributor: contributor, usage: usage,
                      running: running, next: next)
    }
}
