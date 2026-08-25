import Foundation

/// A synchronous, UI-free state machine for coalescing refresh work without overlapping passes.
///
/// The first enqueue while idle starts a run. Call `take()` to claim the work currently pending,
/// perform that pass, then call `finishPass()`. Enqueues that arrive while the pass is in flight are
/// retained for exactly one or more trailing passes; they can never start an overlapping run.
///
/// A full refresh for a target subsumes changed IDs for that same target only when they are claimed
/// by the same `take()`. IDs enqueued after that call belong to a trailing pass, even while the full
/// refresh is still in flight.
public struct CoalescedRefreshQueue<Target: Hashable & Sendable, ID: Hashable & Sendable>: Sendable {
    public struct Pass: Equatable, Sendable {
        public let fullTargets: Set<Target>
        public let changedIDsByTarget: [Target: Set<ID>]

        fileprivate init(fullTargets: Set<Target>, changedIDsByTarget: [Target: Set<ID>]) {
            self.fullTargets = fullTargets
            self.changedIDsByTarget = changedIDsByTarget
        }

        public func changedIDs(for target: Target) -> Set<ID> {
            changedIDsByTarget[target] ?? []
        }

        public var isEmpty: Bool {
            fullTargets.isEmpty && changedIDsByTarget.isEmpty
        }
    }

    private var running = false
    private var pendingFullTargets: Set<Target> = []
    private var pendingChangedIDs: [Target: Set<ID>] = [:]

    public init() {}

    /// Enqueue an authoritative full refresh. Returns true only for the idle-to-running transition;
    /// the caller that receives true owns starting the debounce/worker task.
    @discardableResult
    public mutating func enqueueFull(_ target: Target) -> Bool {
        pendingFullTargets.insert(target)
        return beginIfIdle()
    }

    /// Enqueue a targeted refresh. IDs are deduplicated per target. Returns true under the same
    /// idle-to-running rule as `enqueueFull`.
    @discardableResult
    public mutating func enqueueChanged(_ id: ID, for target: Target) -> Bool {
        pendingChangedIDs[target, default: []].insert(id)
        return beginIfIdle()
    }

    /// Claim the currently pending work while keeping the queue in its running state.
    ///
    /// Full targets remove only the changed IDs captured in this pass. New IDs enqueued after this
    /// method returns are stored in fresh pending state and therefore force a trailing pass.
    public mutating func take() -> Pass {
        let fullTargets = pendingFullTargets
        var changedIDs = pendingChangedIDs
        for target in fullTargets {
            changedIDs.removeValue(forKey: target)
        }

        pendingFullTargets.removeAll(keepingCapacity: true)
        pendingChangedIDs.removeAll(keepingCapacity: true)
        return Pass(fullTargets: fullTargets, changedIDsByTarget: changedIDs)
    }

    /// Finish the claimed pass. Returns true when work arrived in flight and the same worker must
    /// immediately take a trailing pass. Returns false after transitioning the queue back to idle.
    @discardableResult
    public mutating func finishPass() -> Bool {
        guard hasPendingWork else {
            running = false
            return false
        }
        return true
    }

    private var hasPendingWork: Bool {
        !pendingFullTargets.isEmpty || !pendingChangedIDs.isEmpty
    }

    private mutating func beginIfIdle() -> Bool {
        guard !running else { return false }
        running = true
        return true
    }
}
