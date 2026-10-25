import SwiftUI
import OrbitKit

extension CGFloat {
    /// The folded composer band's one bar (`FoldedBandBar`): thin beside the composer, and still a
    /// capsule a thumb finds.
    static let foldedBandBar: CGFloat = 36
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
/// A phone's composer band folded to one line while the reader goes back through the history (the
/// owner, 2026-10-16: the parking strip and the composer shrink to a thin row, and a tap brings them
/// back). Left, what the composer holds: the draft's first line, or its placeholder. Right, one mark
/// for each of the session's cards (`FoldedBand`), then the jump to the latest, which the bar carries
/// in the floating disc's place while it stands — with an arc turning round it while a turn runs, as
/// the composer's Stop is folded away with the rest. Anything but the jump opens the band where the
/// reader is: no scroll, no keyboard. When the bar stands is `ConsoleView.foldsBand`'s to say.
@available(iOS 26.0, *)
struct FoldedBandBar: View {
    @Environment(AppModel.self) private var app
    let console: ConsoleModel
    /// Open the band where the reader is.
    let open: () -> Void
    /// The floating disc's jump (`TranscriptView.jumpToLatest`).
    let jump: () -> Void

    var body: some View {
        let draft = FoldedBand.draftLine(console.composerText)
        let session = app.session(id: console.sessionID)
        // What holds the branch bar's Merge back, and what the arc says: a turn in flight.
        let turnActive = WorktreeBarLogic.turnActive(status: session?.effectiveRunStatus ?? console.sessionStatus,
                                                     runningSubagents: session?.runningSubagentCount,
                                                     sending: console.sending || console.awaitingReply)
        let tasks = taskCard
        let branch = branchMark(turnActive: turnActive)
        HStack(spacing: 0) {
            Button(action: open) {
                HStack(spacing: 8) {
                    if needsAttention {
                        Image(systemName: "exclamationmark.circle.fill")
                            .font(.orbitLabel)
                            .foregroundStyle(.orange)
                    }
                    Text(draft ?? console.replyContext?.placeholder ?? FoldedBand.placeholder)
                        .font(.orbitSubtext)
                        .foregroundStyle(draft == nil ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.primary))
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 8)
                    marks(tasks: tasks, branch: branch)
                }
                .padding(.leading, 14)
                .padding(.trailing, 6)
                .frame(maxHeight: .infinity)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Show the composer")
            .accessibilityValue(spoken(draft: draft, tasks: tasks, branch: branch))
            jumpButton(turnActive: turnActive)
                .padding(.trailing, 4)
        }
        .frame(height: .foldedBandBar)
        .glassEffect(.regular.interactive(), in: Capsule())
    }

    // MARK: - the marks

    /// One mark per card, in the band's order: Watching, Background processes, Tasks, the branch.
    /// They keep their size; the draft is what gives way.
    private func marks(tasks: SessionTaskCard?, branch: FoldedBand.Branch?) -> some View {
        HStack(spacing: 10) {
            if let watching = app.watches?.summary(for: console.sessionID)?.beyondTasks {
                mark("eye", "\(watching.watches.count)")
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
    private func spoken(draft: String?, tasks: SessionTaskCard?, branch: FoldedBand.Branch?) -> String {
        var parts = [draft ?? "Empty"]
        if needsAttention { parts.append("Needs attention") }
        if let watching = app.watches?.summary(for: console.sessionID)?.beyondTasks {
            parts.append("Watching: \(watching.watches.count)")
        }
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

    // MARK: - the jump

    /// The floating disc's jump at the bar's right end, where the composer keeps Send: a 28pt disc 4pt
    /// in, in a 36pt target.
    private func jumpButton(turnActive: Bool) -> some View {
        Button(action: jump) {
            Image(systemName: "arrow.down")
                .font(.orbitBarGlyph)
                .foregroundStyle(.primary)
                .frame(width: 28, height: 28)
                .background { Circle().fill(.primary.opacity(0.07)) }
                .overlay { if turnActive { TurnArc() } }
                .frame(width: .foldedBandBar, height: .foldedBandBar)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(console.detached ? SessionRecordLink.Copy.jumpToLatest : "Scroll to latest")
        .accessibilityValue(turnActive ? "Working" : "")
    }
}

/// The arc turning round the bar's jump while a turn runs: the latest is still being written below.
/// Held still for Reduce Motion.
private struct TurnArc: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { context in
            let turn = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.2) / 1.2
            Circle()
                .trim(from: 0, to: 0.3)
                .stroke(Color.accentColor, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .rotationEffect(.degrees(turn * 360 - 90))
        }
        .frame(width: 32, height: 32)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
#endif
