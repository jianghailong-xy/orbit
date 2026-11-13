import SwiftUI
import OrbitKit

extension CGFloat {
    /// The folded composer band's pill (`FoldedBandBar`): small, as Safari's folded address bar is,
    /// and still a capsule a thumb finds.
    static let foldedBandPill: CGFloat = 30
    /// How far the pill stands off the screen's bottom edge — over the home indicator, inside the
    /// strip the screen's own bottom inset keeps, as Safari's folded bar does.
    static let foldedBandPillFoot: CGFloat = 22
}

/// The band behind its bar while it is folded (`ConsoleView.foldsBand`): no height, faded, out of
/// reach and out of VoiceOver's — but still there, so an open list, the branch bar's sheet host and
/// the composer's own field keep their state, as the typing fold keeps them (`TypingFold`). Never
/// cut to its frame: folded it is invisible, and glass cut at a frame loses its rim and shadow.
struct ComposerBandFold: ViewModifier {
    let folded: Bool

    func body(content: Content) -> some View {
        content
            .frame(height: folded ? 0 : nil, alignment: .bottom)
            .opacity(folded ? 0 : 1)
            .allowsHitTesting(!folded)
            .accessibilityHidden(folded)
    }
}

#if os(iOS)
/// A phone's composer band folded to one small pill while the reader goes back through the history
/// (the owner, 2026-10-16: the parking strip and the composer shrink to a thin row, and a tap brings
/// them back; 2026-11-11: like Safari's address bar, one centred pill that says one thing). It leads
/// with a blue dot while a turn runs, and an orange mark when something in the band waits on the
/// reader; then a draft not yet sent, or else one mark for each of the session's cards
/// (`FoldedBand`), or else the composer's placeholder. It carries no jump: the floating disc is back
/// once the band opens. A tap opens the band where the reader is: no scroll, no keyboard. When the
/// pill stands is `ConsoleView.foldsBand`'s to say.
@available(iOS 26.0, *)
struct FoldedBandBar: View {
    @Environment(AppModel.self) private var app
    let console: ConsoleModel
    /// Open the band where the reader is.
    let open: () -> Void

    var body: some View {
        let draft = FoldedBand.draftLine(console.composerText)
        let session = app.session(id: console.sessionID)
        // What holds the branch bar's Merge back, and what the dot says: a turn in flight.
        let turnActive = WorktreeBarLogic.turnActive(status: session?.effectiveRunStatus ?? console.sessionStatus,
                                                     runningSubagents: session?.runningSubagentCount,
                                                     sending: console.sending || console.awaitingReply)
        let tasks = taskCard
        let branch = branchMark(turnActive: turnActive)
        let lead = FoldedBand.lead(draft: draft, hasMarks: watching != nil || !console.state.background.isEmpty
                                   || tasks != nil || branch != nil)
        Button(action: open) {
            HStack(spacing: 8) {
                if turnActive {
                    Circle().fill(Color.accentColor).frame(width: 7, height: 7)
                }
                if needsAttention {
                    Image(systemName: "exclamationmark.circle.fill")
                        .font(.orbitLabel)
                        .foregroundStyle(.orange)
                }
                switch lead {
                case .draft(let words):
                    Image(systemName: "pencil").font(.orbitMeta).foregroundStyle(.secondary)
                    Text(words)
                        .font(.orbitLabel)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                case .marks:
                    marks(tasks: tasks, branch: branch)
                case .placeholder:
                    Text(console.replyContext?.placeholder ?? FoldedBand.placeholder)
                        .font(.orbitLabel)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, 13)
            .frame(height: .foldedBandPill)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: Capsule())
        .accessibilityLabel("Show the composer")
        .accessibilityValue(spoken(draft: draft, turnActive: turnActive, tasks: tasks, branch: branch))
    }

    // MARK: - the marks

    private var watching: Int? {
        app.watches?.summary(for: console.sessionID)?.beyondTasks?.watches.count
    }

    /// One mark per card, in the band's order: Watching, Background processes, Tasks, the branch.
    private func marks(tasks: SessionTaskCard?, branch: FoldedBand.Branch?) -> some View {
        HStack(spacing: 10) {
            if let watching {
                mark("eye", "\(watching)")
            }
            if !console.state.background.isEmpty {
                mark("terminal", FoldedBand.processes(console.state.background))
            }
            if let tasks {
                let part = FoldedBand.tasks(tasks)
                mark("checkmark.square", part.text, tint: part.failed ? .red : nil)
            }
            if let branch {
                switch branch {
                case .landed(let words):
                    // The merge slot's own chip (`WTChip`).
                    Text(words).font(.orbitLabel.weight(.semibold)).foregroundStyle(.green)
                case .merging:
                    Text(FoldedBand.merging).font(.orbitLabel).foregroundStyle(.secondary)
                case .changes(let added, let deleted):
                    // The branch bar's own count (`WorktreeBar.statView`).
                    (Text("+\(added)").foregroundStyle(.green) + Text(" −\(deleted)").foregroundStyle(.red))
                        .font(.orbitMono)
                }
            }
        }
        .lineLimit(1)
        .fixedSize()
    }

    /// A card's glyph — the one its own line leads with — and its count.
    private func mark(_ symbol: String, _ count: String, tint: Color? = nil) -> some View {
        HStack(spacing: 4) {
            Image(systemName: symbol).font(.orbitMeta)
            Text(count)
                .font(.orbitLabel)
                .monospacedDigit()
                .foregroundStyle(tint.map { AnyShapeStyle($0) } ?? AnyShapeStyle(.secondary))
        }
        .foregroundStyle(.secondary)
    }

    /// The Tasks card's own reading (`CreatedTasksCard`): the tasks created here and those the
    /// session's watches wait on.
    private var taskCard: SessionTaskCard? {
        let watched = app.watches?.summary(for: console.sessionID)?
            .watchedTasks { app.tasks?.item($0.targetResourceId)?.title }
        return SessionTaskCard(created: console.createdTasks.snapshot, watched: watched ?? [])
    }

    /// The branch bar's reading (`WorktreeBar`): shown only where the bar is, and a landing only where
    /// its slot shows the merge control, which carries the landing's chip.
    private func branchMark(turnActive: Bool) -> FoldedBand.Branch? {
        guard let d = console.worktree.detail, let tracked = d.branch else { return nil }
        let files = d.changedFiles ?? []
        guard WorktreeBarLogic.mode(isolationStatus: d.isolationStatus, branch: d.branch,
                                    changedFileCount: files.count, mergeStatus: d.mergeStatus,
                                    commitStatus: d.commitStatus,
                                    hasMergeRecovery: d.mergeRecovery != nil) == .worktree else { return nil }
        let added = files.reduce(0) { $0 + max(0, $1.additions) }
        let deleted = files.reduce(0) { $0 + max(0, $1.deletions) }
        let primary = WorktreeBarLogic.primary(worktreeDirty: d.worktreeDirty,
                                               committed: !console.sessionStatus.isLive, turnActive: turnActive)
        guard primary == .merge else {
            return added + deleted > 0 ? .changes(added: added, deleted: deleted) : nil
        }
        return FoldedBand.branch(mergeStatus: d.mergeStatus, branchMerged: d.branchMerged,
                                 mergeTarget: d.mergeTarget, targets: d.mergeTargets ?? [],
                                 diverged: (d.worktreeBranch.map { !$0.isEmpty && $0 != tracked }) ?? false,
                                 recovering: d.mergeRecovery != nil && d.mergeRecoverySupported == true,
                                 added: added, deleted: deleted)
    }

    /// A card the band shows now and then, about the message being sent — the managed runner's
    /// state, a run that never started, an engine to repair, the error line, a hand-off — or the
    /// branch bar's failure or held merge: something is waiting in the band.
    private var needsAttention: Bool {
        if console.managed?.showsBanner == true || console.runStart != nil
            || console.queuedDshRepair != nil || console.queuedAntigravityRepair != nil
            || console.statusMessage != nil || console.handedOverSessionID != nil
            || console.composerRunConflict != nil {
            return true
        }
        guard let d = console.worktree.detail else { return false }
        return d.mergeRecovery != nil
            || WorktreeBarLogic.failureMessage(mergeStatus: d.mergeStatus, mergeError: d.mergeError,
                                               commitStatus: d.commitStatus, commitError: d.commitError) != nil
    }

    /// What VoiceOver reads for the bar: the draft, then each card's count.
    private func spoken(draft: String?, turnActive: Bool, tasks: SessionTaskCard?,
                        branch: FoldedBand.Branch?) -> String {
        var parts = [draft ?? "Empty"]
        if turnActive { parts.append("Working") }
        if needsAttention { parts.append("Needs attention") }
        if let watching { parts.append("Watching: \(watching)") }
        if !console.state.background.isEmpty {
            parts.append("Background processes: \(FoldedBand.processes(console.state.background))")
        }
        if let tasks { parts.append("\(SessionCreatedTasksCopy.title): \(FoldedBand.tasks(tasks).text)") }
        switch branch {
        case .landed(let words): parts.append(words)
        case .merging: parts.append(FoldedBand.merging)
        case .changes(let added, let deleted): parts.append("\(added) lines added, \(deleted) removed")
        case nil: break
        }
        return parts.joined(separator: ", ")
    }
}
#endif
