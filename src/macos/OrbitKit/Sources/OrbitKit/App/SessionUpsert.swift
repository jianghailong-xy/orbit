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
    /// background count (and how much of it is work in flight), whether a self-driven turn is
    /// generating, error text — is preserved from this row, which is what makes applying the event
    /// non-destructive; those fields stay the periodic snapshot's job.
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
            // Travelling with the count it qualifies, and overwritten with it: the summary that
            // reports an owner confirmation answered carries a count and no kind, and a row left
            // saying "Waiting for your confirmation" would be pointing at a card that is gone.
            waitingKind: .some(summary.waitingKind),
            // Travelling with the same count, and cleared by the same rule: a summary that says
            // nothing is waiting here has to be able to take the bar's card away with it.
            ownerItems: summary.ownerItems,
            taskId: summary.taskId,
            lastTurnAt: summary.lastTurnAt,
            // The row's nested agent is richer than the summary's (it carries provider + effort, which
            // the composer reads), so it wins; the summary only fills a row that somehow has none.
            agent: agent ?? summary.agent.map {
                SessionAgentRef(id: $0.id, name: $0.name, provider: nil, model: $0.model, effort: nil)
            },
            projectId: summary.projectId,
            projectTitle: summary.projectTitle,
            // The one field here whose absence and whose null mean different things — see the
            // DTO. It travels with the status because it qualifies it: the summary that turns a
            // row FAILED is the same one that has to say the failure is being retried, and the
            // summary that ends the retry is what stops the row saying so.
            retryAt: summary.retryAt
        )
    }

    /// Apply a title the user just typed, so the header and every loaded row show the new name before
    /// the server's `session.updated` (and the next list snapshot) confirm it. See `AppModel.renameSession`.
    func settingTitle(_ title: String) -> Session {
        merging(title: title)
    }

    /// Apply only the projected Project relation. This is safe even for Completed/Trash rows that
    /// the ordinary Open-list summary merge deliberately refuses: rotation/delete still needs to
    /// remove their Coordinator badge immediately.
    func applyingProjectRelation(_ summary: ControlSessionSummary) -> Session {
        merging(projectId: summary.projectId, projectTitle: summary.projectTitle)
    }

    /// Apply an `approval.requested` / `approval.resolved` pending count — the one field those
    /// events carry, and all a row needs to switch between the working spinner and the amber
    /// needs-you cue (see `SessionStatusGlyph`).
    ///
    /// The kind rides with it and is overwritten with it: the event's count is the whole total, so
    /// the event's `waitingKind` is the whole answer to what that total is waiting for — and the
    /// event that reports an owner confirmation answered carries none.
    func settingPendingApprovals(_ count: Int,
                                 waitingKind: SessionWaitingKind? = nil) -> Session {
        merging(pendingApprovals: count, waitingKind: .some(waitingKind))
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
                         // Doubly optional because the summary owns this field outright: `nil`
                         // keeps the row's, `.some(nil)` is the server saying nothing is named any
                         // more, `.some(kind)` names what is waiting.
                         waitingKind: SessionWaitingKind?? = nil,
                         // Doubly optional for the same reason: nil keeps the row's items, and
                         // `.some([])` is the server saying there are none.
                         ownerItems: [SessionOwnerItem]?? = nil,
                         taskId: String? = nil,
                         lastTurnAt: String? = nil,
                         agent: SessionAgentRef? = nil,
                         // Doubly optional: nil preserves an older server's omission; .some(nil)
                         // clears a relation the new server explicitly removed.
                         projectId: String?? = nil,
                         projectTitle: String?? = nil,
                         // Doubly optional so a caller can clear it: `nil` keeps the row's value,
                         // `.some(nil)` writes null. Every other field here means "keep" by nil.
                         retryAt: String?? = nil) -> Session {
        let mergedProjectId = projectId ?? self.projectId
        let mergedProjectTitle = mergedProjectId == nil ? nil : (projectTitle ?? self.projectTitle)
        return Session(id: id,
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
                waitingKind: waitingKind ?? self.waitingKind,
                ownerItems: ownerItems ?? self.ownerItems,
                taskId: taskId ?? self.taskId,
                branch: branch,
                updatedAt: updatedAt,
                model: model,
                permissionMode: permissionMode,
                effort: effort,
                source: source,
                projectId: mergedProjectId,
                // A cleared id always clears its label too, even if a malformed/mixed-version
                // summary omitted projectTitle while explicitly removing the relation.
                projectTitle: mergedProjectTitle,
                lastAssistantText: lastAssistantText,
                lastToolUse: lastToolUse,
                lastUserText: lastUserText,
                runningBgCount: runningBgCount,
                // Read off this row like the fields above: the summary never carries it, so an
                // event must not be able to stop the background glyph breathing mid-job.
                runningBgJobCount: runningBgJobCount,
                engineTurnActive: engineTurnActive,
                error: error,
                endReason: endReason,
                agent: agent ?? self.agent,
                pinnedAt: pinnedAt,
                createdAt: createdAt,
                lastTurnAt: lastTurnAt ?? self.lastTurnAt,
                tags: tags,
                retryAt: retryAt ?? self.retryAt)
    }
}
