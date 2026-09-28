import Foundation
import Observation
import OrbitKit

/// The shared pools the account is in (GET /providers/shared-pools): Settings → Providers lists them,
/// and a pool's page is run from here — keys put in, replaced, switched and taken out, the two rules,
/// people added, the pool deleted or left. Every write answers with the pool as it now stands, which
/// replaces the one on screen. Owned by `AppModel`, like the other per-account lists, which reads the
/// list again when the server says a provider changed — another person's key going in, say.
@MainActor
@Observable
final class SharedPoolsModel {
    private(set) var pools: [SharedPool] = []
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

    /// Best-effort, like the providers beside it: a failed read keeps the last good list.
    func load() async {
        loadState.begin()
        do {
            pools = try await api.sharedPools()
            loadState.succeed()
        } catch {
            loadState.fail()
        }
    }

    func addKey(_ pool: SharedPool, _ req: AddPoolKeyRequest) async -> AddPoolKey.Outcome {
        do {
            return .added(adopt(try await api.addPoolKey(poolID: pool.id, req)))
        } catch {
            return AddPoolKey.outcome(of: error, typed: req.apiKey, pool: pool)
        }
    }

    func replaceKey(_ pool: SharedPool, _ key: SharedPoolKey, secret: String) async -> AddPoolKey.Outcome {
        do {
            let updated = try await api.replacePoolKey(poolID: pool.id, keyID: key.id,
                                                       ReplacePoolKeyRequest(apiKey: secret))
            return .added(adopt(updated))
        } catch {
            return AddPoolKey.outcome(of: error, typed: secret, pool: pool)
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

    func addPerson(_ pool: SharedPool, email: String) async -> String? {
        let typed = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty else { return nil }
        return await write { try await self.api.addSharedPoolPerson(pool.id, AddSharedPoolPersonRequest(email: typed)) }
    }

    /// Delete the pool (an admin) or leave it (anyone else): it is gone from this account's list.
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

    @discardableResult
    private func adopt(_ pool: SharedPool) -> SharedPool {
        let key = PublicID.storageKey(pool.id)
        if let at = pools.firstIndex(where: { PublicID.storageKey($0.id) == key }) {
            pools[at] = pool
        } else {
            pools.append(pool)
        }
        return pool
    }
}
