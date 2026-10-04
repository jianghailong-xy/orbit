import Foundation
import Observation
import OrbitKit

/// The Codex pools' people and API keys (GET /providers/shared-pools[/:id]): the shared pools the account
/// is in and the pools of somebody else's own it was added to — Settings → Providers lists them — and, read
/// pool by pool beside their ChatGPT accounts, who can use each Codex pool of the account's own (migration
/// 0358). A pool's page is run from here — keys put in, replaced, switched and taken out, its rule, people
/// added and taken out, the pool deleted or left. Every write answers with the pool as it now stands, which
/// replaces the one on screen. Owned by `AppModel`, like the other per-account lists, which reads them
/// again when the server says a provider changed — another person's key going in, say.
@MainActor
@Observable
final class SharedPoolsModel {
    private(set) var pools: [SharedPool] = []
    /// Who can use each Codex pool of the account's own, by pool: the list above leaves those out — they are
    /// on its providers, with their ChatGPT accounts — so each is read on its own once asked for.
    private(set) var ownAccess: [String: SharedPool] = [:]
    /// How the list fetches have gone, so a failed fetch never reads as "in no pool".
    private(set) var loadState = ListLoadState()

    private let api: APIClient

    init(baseURL: URL, tokenStore: TokenStore) {
        api = APIClient(baseURL: baseURL, tokenStore: tokenStore)
    }

    /// The pool with this id, in either spelling.
    func pool(_ id: String) -> SharedPool? {
        let key = PublicID.storageKey(id)
        return pools.first { PublicID.storageKey($0.id) == key }
    }

    /// Who can use the account's own pool with this id, once read.
    func access(_ id: String) -> SharedPool? { ownAccess[PublicID.storageKey(id)] }

    func pauseMember(_ pool: SharedPool, member: PoolMember, durationMinutes: Int?) async -> String? {
        do {
            try await api.pausePoolMember(poolID: pool.id, memberID: member.id, durationMinutes: durationMinutes)
            adopt(try await api.sharedPool(pool.id))
            return nil
        } catch {
            return APIClient.failureReason(error)
        }
    }

    /// Best-effort, like the providers beside it: a failed read keeps the last good list. The pools of the
    /// account's own read so far are read again with it.
    func load() async {
        loadState.begin()
        do {
            pools = try await api.sharedPools()
            loadState.succeed()
        } catch {
            loadState.fail()
        }
        for pool in Array(ownAccess.values) { await loadAccess(pool.id) }
    }

    /// Who can use one of the account's own Codex pools. Best-effort: a failed read keeps what was read
    /// before, and a pool never read is drawn with its accounts alone.
    func loadAccess(_ poolID: String) async {
        guard let pool = try? await api.sharedPool(poolID) else { return }
        adopt(pool)
    }

    /// The account's own pool went: what was read of who can use it goes with it.
    func forget(_ poolID: String) {
        ownAccess[PublicID.storageKey(poolID)] = nil
    }

    func addKey(_ pool: SharedPool, _ req: AddPoolKeyRequest) async -> AddPoolKey.Outcome {
        do {
            return .added(adopt(try await api.addPoolKey(poolID: pool.id, req)))
        } catch {
            return AddPoolKey.outcome(of: error)
        }
    }

    func replaceKey(_ pool: SharedPool, _ key: SharedPoolKey, secret: String) async -> AddPoolKey.Outcome {
        do {
            let updated = try await api.replacePoolKey(poolID: pool.id, keyID: key.id,
                                                       ReplacePoolKeyRequest(apiKey: secret))
            return .added(adopt(updated))
        } catch {
            return AddPoolKey.outcome(of: error)
        }
    }

    func removeKey(_ pool: SharedPool, _ key: SharedPoolKey) async -> String? {
        await write { try await self.api.removePoolKey(poolID: pool.id, keyID: key.id) }
    }

    func switchKey(_ pool: SharedPool, _ key: SharedPoolKey, on: Bool) async -> String? {
        await write { try await self.api.updatePoolKey(poolID: pool.id, keyID: key.id, UpdatePoolKeyRequest(enabled: on)) }
    }

    func setRules(_ pool: SharedPool, _ change: UpdateSharedPoolRequest) async -> String? {
        await write { try await self.api.updateSharedPool(pool.id, change) }
    }

    /// "Share": everybody typed added one after another — an address that is no Orbit account's doesn't stop
    /// the rest, and is named once they are in — then the rule, when it changed and the pool has a key it
    /// is about. How it went, in a sentence.
    func share(_ pool: SharedPool, emails: [String], membersCanAdd: Bool) async -> String {
        var missed: [String] = []
        for email in emails {
            do {
                adopt(try await api.addSharedPoolPerson(pool.id, AddSharedPoolPersonRequest(email: email)))
            } catch {
                missed.append(SharePool.missed(email, reason: APIClient.failureReason(error)))
            }
        }
        if !SharePool.noKey(pool) && membersCanAdd != pool.membersCanAdd,
           let failure = await setRules(pool, UpdateSharedPoolRequest(membersCanAdd: membersCanAdd)) {
            return failure
        }
        return SharePool.outcome(pool, missed: missed)
    }

    /// Back to Just me: everybody but its owner taken out, one after another, and their keys and session
    /// tokens with them. Why it stopped, or nil.
    func keepToSelf(_ pool: SharedPool) async -> String? {
        for person in pool.people where !person.creator {
            if let failure = await removePerson(pool, person) { return failure }
        }
        return nil
    }

    func setRole(_ pool: SharedPool, _ person: SharedPoolPerson, _ role: SharedPoolRole) async -> String? {
        await write {
            try await self.api.updateSharedPoolPerson(pool.id, userID: person.userId,
                                                      UpdateSharedPoolPersonRequest(role: role))
        }
    }

    func removePerson(_ pool: SharedPool, _ person: SharedPoolPerson) async -> String? {
        await write { try await self.api.removeSharedPoolPerson(pool.id, userID: person.userId) }
    }

    // MARK: a ChatGPT account of one's own (migration 0371)

    /// A member's own sign-in on a pool its rule lets them join (CodexLoginService): the page to open and
    /// the one-time code, from the server's device sign-in.
    func startCodexLogin(_ pool: SharedPool) async throws -> CodexLoginAttempt {
        try await api.startCodexLogin(poolID: pool.id)
    }

    func pollCodexLogin(_ pool: SharedPool) async throws -> CodexLoginPoll {
        try await api.pollCodexLogin(poolID: pool.id)
    }

    /// Best-effort: a sign-in nobody finishes also runs out on the server by itself.
    func cancelCodexLogin(_ pool: SharedPool) async {
        _ = try? await api.cancelCodexLogin(poolID: pool.id)
    }

    /// Take one's own account out of the pool: the server deletes the sign-in it held, and the pool read
    /// again afterwards. Why it didn't, or nil.
    func signOutCodexLogin(_ pool: SharedPool, _ login: CodexLogin) async -> String? {
        do {
            try await api.signOutCodexLogin(poolID: pool.id, fingerprint: login.fingerprint)
            await load()
            return nil
        } catch {
            return APIClient.failureReason(error)
        }
    }

    /// Delete the pool (its owner) or leave it (anybody else): it is gone from this account's list.
    func exit(_ pool: SharedPool, delete: Bool) async -> String? {
        do {
            if delete {
                try await api.deleteSharedPool(pool.id)
            } else {
                try await api.leaveSharedPool(pool.id)
            }
            let key = PublicID.storageKey(pool.id)
            pools.removeAll { PublicID.storageKey($0.id) == key }
            return nil
        } catch {
            return APIClient.failureReason(error)
        }
    }

    /// A write that answers with the pool: adopted, or why it didn't go through.
    private func write(_ call: () async throws -> SharedPool) async -> String? {
        do {
            adopt(try await call())
            return nil
        } catch {
            return APIClient.failureReason(error)
        }
    }

    /// The pool as the server now reads it, in the list it belongs to: one of the account's own is read
    /// pool by pool (`ownAccess`); every other is listed — the server's own rule for its list.
    @discardableResult
    private func adopt(_ pool: SharedPool) -> SharedPool {
        let key = PublicID.storageKey(pool.id)
        if !pool.shared && SharedPoolPage.ownsPool(pool) {
            ownAccess[key] = pool
        } else if let at = pools.firstIndex(where: { PublicID.storageKey($0.id) == key }) {
            pools[at] = pool
        } else {
            pools.append(pool)
        }
        return pool
    }
}
