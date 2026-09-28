import Foundation
import OrbitKit

/// Stands in for the `ConsoleModel` that `ComposerView.toolbar` reads: the two members its pool row
/// asks for, and `planUsage` resolved the way `ConsoleModel.planUsage` resolves it on a pool — the
/// account's own quota, never the pool's. Written out rather than cut, because the real model needs
/// the whole app; everything drawn from it (the row and the pill) is the app's own code.
struct PoolComposerStandIn {
    let pool: ProviderPool
    /// A live session's recorded member; nil for a draft, which is what this probe draws.
    let memberID: String?

    var currentPool: ProviderPool? { pool }
    var poolAccount: PoolAccount? { ProviderPools.sessionAccount(in: pool, memberID: memberID) }
    var planUsage: PlanUsageSnapshot? { currentPool != nil ? poolAccount?.member.planUsage : nil }
}
