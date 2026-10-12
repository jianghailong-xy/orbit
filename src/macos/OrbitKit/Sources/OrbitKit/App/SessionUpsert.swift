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
    /// non-destructive; those fields stay the periodic snapshot's job. The rolling recap beside the
    /// previews is carried, and owns its field outright: null in the summary clears the row's.
    func applying(_ summary: ControlSessionSummary) -> Session {
        // The workspace the summary puts the session in. Another than the row's is a move to another
        // workspace (docs/session-folders-move-design.md §5.6), and the lists group rows by
        // `agent.id` — so the row's own agent, which would otherwise win below, would hold the row in
        // the old workspace's list until the next snapshot. The summary's agent is the new one.
        let summaryWorkspace = summary.agentId ?? summary.agent?.id
        let rowWorkspace = agent?.id ?? agentId
        let moved = summaryWorkspace != nil && rowWorkspace != nil && summaryWorkspace != rowWorkspace
        // The summary's agent, or a bare one for the workspace it names when it carries none of its own.
        let summaryAgent = summaryWorkspace.map { id -> SessionAgentRef in
            guard let ref = summary.agent, ref.id == id else {
                return SessionAgentRef(id: id, name: nil, provider: nil, model: nil, effort: nil)
            }
            return SessionAgentRef(id: ref.id, name: ref.name, provider: nil, model: ref.model, effort: ref.effort)
        }
        return merging(
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
            // Overwritten with the same count, by the same rule: the summary that says a review is
            // over (null) is what turns the row from "Under review" to whatever comes next.
            confirmationUnderReview: summary.confirmationUnderReview,
            // Who is waiting on whose reply travels with every summary and is overwritten with it,
            // by `ownerItems`' rule: an empty list is the server saying none is open any more.
            awaitingReplyFrom: summary.awaitingReplyFrom,
            owesReplyTo: summary.owesReplyTo,
            taskId: summary.taskId,
            lastTurnAt: summary.lastTurnAt,
            // Null is a value here, like the previews beside them: the summary is how an already-open
            // list learns the recap a settle just wrote — and how it lets go of one a manual refresh
            // dropped — without waiting for the next snapshot.
            recapText: summary.recapText,
            recapAt: summary.recapAt,
            // The row's nested agent is richer than the summary's (it carries provider + effort, which
            // the composer reads), so it wins while the session stays in that workspace; the summary
            // fills a row that somehow has none, and replaces the agent of a row that moved.
            agent: moved ? summaryAgent : agent ?? summaryAgent,
            projectId: summary.projectId,
            projectTitle: summary.projectTitle,
            projectMembership: summary.projectMembership,
            // The one field here whose absence and whose null mean different things — see the
            // DTO. It travels with the status because it qualifies it: the summary that turns a
            // row FAILED is the same one that has to say the failure is being retried, and the
            // summary that ends the retry is what stops the row saying so.
            retryAt: summary.retryAt,
            // Absent and null differ here too: a move out of a folder reaches the other clients as
            // a null, while an older control plane that never sends the key leaves the row's.
            folderId: summary.folderId
        )
    }

    /// Apply a title the user just typed, so the header and every loaded row show the new name before
    /// the server's `session.updated` (and the next list snapshot) confirm it. See `AppModel.renameSession`.
    func settingTitle(_ title: String) -> Session {
        merging(title: title)
    }

    /// File this row in a folder (nil: in none) before the server confirms the move, so the list and
    /// the Move panel show it there at once — and, written back with the folder it had, put it back
    /// when the server refuses. See `AppModel.moveSession`.
    func settingFolder(_ folderID: String?) -> Session {
        merging(folderId: .some(folderID))
    }

    /// Put this row in another workspace — its id and name, and the model and effort it falls back
    /// to — filed in one of its folders or in none, once the server has moved it there: so it leaves
    /// the list it was moved from at once rather than at the next snapshot, which then brings the
    /// rest of what the move changed. See `AppModel.moveSession(_:to:…)`.
    func settingWorkspace(id: String, name: String, model: String?, effort: String?,
                          folder folderID: String?) -> Session {
        let agent = SessionAgentRef(id: id, name: name, provider: nil, model: model, effort: effort)
        return merging(agentId: id, agent: agent, folderId: .some(folderID))
    }

    /// Apply only the projected Project relation. This is safe even for Completed/Trash rows that
    /// the ordinary Open-list summary merge deliberately refuses: rotation/delete still needs to
    /// remove their Coordinator badge immediately.
    func applyingProjectRelation(_ summary: ControlSessionSummary) -> Session {
        merging(projectId: summary.projectId, projectTitle: summary.projectTitle,
                projectMembership: summary.projectMembership)
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
                         // Doubly optional for the same reason: `.some(nil)` is "none under review".
                         confirmationUnderReview: ConfirmationUnderReview?? = nil,
                         // Doubly optional for the same reason.
                         awaitingReplyFrom: [SessionRequestPeer]?? = nil,
                         owesReplyTo: [SessionRequestPeer]?? = nil,
                         taskId: String? = nil,
                         lastTurnAt: String? = nil,
                         // Doubly optional like `retryAt`: nil keeps the row's recap, `.some(nil)`
                         // is the server saying the session has none, `.some(text)` the one just
                         // written — which travels with its time so the row's label can date it.
                         recapText: String?? = nil,
                         recapAt: String?? = nil,
                         agent: SessionAgentRef? = nil,
                         // Doubly optional: nil preserves an older server's omission; .some(nil)
                         // clears a relation the new server explicitly removed.
                         projectId: String?? = nil,
                         projectTitle: String?? = nil,
                         projectMembership: SessionProjectMembership?? = nil,
                         // Doubly optional so a caller can clear it: `nil` keeps the row's value,
                         // `.some(nil)` writes null. Every other field here means "keep" by nil.
                         retryAt: String?? = nil,
                         // Doubly optional for the same reason: `.some(nil)` is "in no folder".
                         folderId: String?? = nil) -> Session {
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
                // A session's engine never changes, and no summary or event carries it: the row's.
                engine: engine,
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
                recapText: recapText ?? self.recapText,
                recapAt: recapAt ?? self.recapAt,
                runningBgCount: runningBgCount,
                // Read off this row like the fields above: the summary never carries it, so an
                // event must not be able to stop the background glyph breathing mid-job.
                runningBgJobCount: runningBgJobCount,
                // The same: the list's count, which no event carries.
                runningSubagentCount: runningSubagentCount,
                engineTurnActive: engineTurnActive,
                error: error,
                endReason: endReason,
                agent: agent ?? self.agent,
                pinnedAt: pinnedAt,
                createdAt: createdAt,
                lastTurnAt: lastTurnAt ?? self.lastTurnAt,
                tags: tags,
                retryAt: retryAt ?? self.retryAt,
                // Both read off this row like the fields above: the list's summaries and every
                // event never carry which account or key a claim chose.
                poolMemberProviderId: poolMemberProviderId,
                poolKeyId: poolKeyId,
                codexAccount: codexAccount,
                codexAccountPinned: codexAccountPinned,
                claudeAccount: claudeAccount,
                claudeAccountPinned: claudeAccountPinned,
                antigravityAccount: antigravityAccount,
                antigravityAccountPinned: antigravityAccountPinned,
                kimiAccount: kimiAccount,
                kimiAccountPinned: kimiAccountPinned,
                awaitingReplyFrom: awaitingReplyFrom ?? self.awaitingReplyFrom,
                owesReplyTo: owesReplyTo ?? self.owesReplyTo,
                folderId: folderId ?? self.folderId,
                confirmationUnderReview: confirmationUnderReview ?? self.confirmationUnderReview,
                projectMembership: projectMembership ?? self.projectMembership)
    }
}
