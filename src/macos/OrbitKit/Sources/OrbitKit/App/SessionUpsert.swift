import Foundation

// Folding a control-plane event into a loaded list row, without refetching the list.
//
// The user-scoped stream (`GET /api/events`) ships `session.created` / `session.updated` with a
// `ControlSessionSummary` that is deliberately field-aligned with a `GET /sessions` row, so a client
// can apply it directly (decision Q2 in docs/realtime-control-plane-stream.md). The native clients
// originally ignored it and refetched the whole list per event, which meant the cost of watching the
// list scaled with how many sessions were running — the summary is what makes that unnecessary.
//
// Pure and UI-free so the merge rules (which fields the event owns, and which the list query alone
// knows) are unit-tested on Linux rather than inferred from a running app. See `AppModel.apply`.

public extension Session {
    /// Fold a `session.created` / `session.updated` summary into this row.
    ///
    /// Only the fields the summary carries are replaced. Everything the slim payload omits — the
    /// preview line (`lastAssistantText` / `lastToolUse` / `lastUserText`), tags, pin, runner,
    /// background count, whether a self-driven turn is generating, error text — is preserved from
    /// this row, which is what makes applying the event non-destructive; those fields stay the
    /// periodic snapshot's job.
    func applying(_ summary: ControlSessionSummary) -> Session {
        merging(
            // A summary with no title means "still untitled" (the naming pass hasn't run), not
            // "cleared" — so it never overwrites a title this row already has.
            title: summary.title,
            status: summary.status,
            runStatus: summary.runStatus,
            sessionState: summary.sessionState,
            runState: summary.runState,
            // `effectiveLifecycleState` filters `.unknown`, so an older/odd control plane can't
            // overwrite a known location with a placeholder.
            lifecycleState: summary.effectiveLifecycleState,
            capabilities: summary.capabilities,
            agentId: summary.agentId,
            pendingApprovals: summary.pendingApprovals,
            lastTurnAt: summary.lastTurnAt,
            // The row's nested agent is richer than the summary's (it carries provider + effort, which
            // the composer reads), so it wins; the summary only fills a row that somehow has none.
            agent: agent ?? summary.agent.map {
                SessionAgentRef(id: $0.id, name: $0.name, provider: nil, model: $0.model, effort: nil)
            }
        )
    }

    /// Apply an `approval.requested` / `approval.resolved` pending count — the one field those
    /// events carry, and all a row needs to switch between the working spinner and the amber
    /// needs-you cue (see `SessionStatusGlyph`).
    func settingPendingApprovals(_ count: Int) -> Session {
        merging(pendingApprovals: count)
    }

    /// Rebuild this row with the subset of fields a control event can change; `nil` means "keep what
    /// the row has". One place spells out `Session`'s initializer — every field is `let`, so applying
    /// an event has to construct a new value, and repeating that per call site is copies to keep in
    /// sync as the DTO grows.
    private func merging(title: String? = nil,
                         status: RunStatus? = nil,
                         runStatus: RunStatus? = nil,
                         sessionState: SessionState? = nil,
                         runState: SessionRunState? = nil,
                         lifecycleState: SessionLifecycleState? = nil,
                         capabilities: SessionCapabilities? = nil,
                         agentId: String? = nil,
                         pendingApprovals: Int? = nil,
                         lastTurnAt: String? = nil,
                         agent: SessionAgentRef? = nil) -> Session {
        Session(id: id,
                title: title ?? self.title,
                status: status ?? self.status,
                runStatus: runStatus ?? self.runStatus,
                sessionState: sessionState ?? self.sessionState,
                runState: runState ?? self.runState,
                lifecycleState: lifecycleState ?? self.lifecycleState,
                completedAt: completedAt,
                deletedAt: deletedAt,
                capabilities: capabilities ?? self.capabilities,
                agentId: agentId ?? self.agentId,
                assignedRunnerId: assignedRunnerId,
                provider: provider,
                pendingApprovals: pendingApprovals ?? self.pendingApprovals,
                branch: branch,
                updatedAt: updatedAt,
                model: model,
                permissionMode: permissionMode,
                effort: effort,
                source: source,
                lastAssistantText: lastAssistantText,
                lastToolUse: lastToolUse,
                lastUserText: lastUserText,
                runningBgCount: runningBgCount,
                engineTurnActive: engineTurnActive,
                error: error,
                endReason: endReason,
                agent: agent ?? self.agent,
                pinnedAt: pinnedAt,
                createdAt: createdAt,
                lastTurnAt: lastTurnAt ?? self.lastTurnAt,
                tags: tags)
    }
}
