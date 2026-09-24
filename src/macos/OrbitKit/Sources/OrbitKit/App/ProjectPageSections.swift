import Foundation

/// The words of the project page's remaining web sections, so the phone draws the page the web's
/// narrow layout draws, card for card: the Work overview's two banners (`ProjectPanoramaHeader.tsx`),
/// the coordinator's reachable-conversation body (`ProjectCoordinatorCard.tsx`), Blockers
/// (`ProjectBlockers.tsx`), the Run queue (`ProjectReadyToRun.tsx`), the criteria card's framing
/// (`ProjectAcceptanceCard.tsx`) and Instructions (`ProjectsPage.tsx`).
///
/// Pure and view-free; `ProjectPageCopyParityTests` holds the words to those sources.
extension ProjectPage {

    // MARK: - Work overview: when the work is not moving

    /// Ready work, and nothing starting it.
    public static func stalledOnReady(_ b: ProjectPanoramaBuckets) -> Bool {
        b.ready > 0 && b.running == 0
    }

    public static let stalledTitle = "Dispatch needs attention"

    /// "7 tasks are ready, but nothing is running. Check the assignees' runner and provider."
    public static func stalledSentence(ready: Int) -> String {
        OrbitLinkCopy.stalled(ready: ready) + " Check the assignees' runner and provider."
    }

    /// The web's press goes to its Providers page; this client has none, and an engine signs in on
    /// its runner's page.
    public static let stalledPress = "Check runners"

    /// Every task settled and the goal still open: the in-between state, said out loud.
    public static func wrappingUp(status: ProjectStatus, _ b: ProjectPanoramaBuckets) -> Bool {
        let idle = b.running == 0 && b.ready == 0 && b.blocked == 0
        return status == .open && idle && b.awaitingVerification == 0 && b.failed == 0
            && b.done + b.cancelled > 0
    }

    public static let wrapUpTitle = "Ready to wrap up"

    /// "All 13 tasks are settled. The project stays open until its outcome is confirmed."
    public static func wrapUpSentence(settled: Int) -> String {
        "All \(settled) task\(settled == 1 ? " is" : "s are") settled. The project stays open until its outcome is confirmed."
    }

    // MARK: - Coordinator: a conversation that can be reached

    /// The card's one press: a reply while the conversation is waiting on the reader, otherwise a
    /// way in.
    public static func coordinatorPress(finished: Bool, needsReply: Bool) -> String {
        finished || !needsReply ? "Open coordinator" : "Reply to coordinator"
    }

    /// The box under the rows — the work standing behind the conversation — counted from the
    /// project's OPEN tasks, or said without a number when the read did not count them.
    public static func dispatchNote(openTaskCount: Int?, finished: Bool) -> (heading: String, text: String) {
        let text: String
        if finished {
            switch openTaskCount {
            case nil:
                text = "A completed conversation is told nothing new, and this project still points at it."
            case 0?:
                text = "A completed conversation is told nothing new. No open tasks remain."
            case let n?:
                text = "A completed conversation is told nothing new — and \(n) open task\(n == 1 ? " still points" : "s still point") at it."
            }
            return ("Open work", text)
        }
        switch openTaskCount {
        case nil: text = "Open tasks are coordinated from this conversation."
        case 0?: text = "No open tasks remain."
        case let n?: text = "\(n) open task\(n == 1 ? " is" : "s are") coordinated from this conversation."
        }
        return ("Manual dispatch", text)
    }

    /// Said on a completed conversation, above the press that would start the next one.
    public static let finishedCoordinatorNote =
        "A new coordinator opens empty — this conversation stays completed and readable, and stops being the one this project is coordinated from."

    public static let startNewCoordinator = "Start a new coordinator"

    public static func startNewCoordinatorDetail(finished: Bool) -> String {
        finished
            ? "Opens empty. This conversation stays completed and readable, and stops being the one this project is coordinated from."
            : "Completes this conversation first, then opens an empty one. Nothing is deleted — it stays readable."
    }

    /// Asked before replacing a conversation that is still open: the press ends it.
    public static let replaceCoordinatorQuestion = "Complete this conversation and start a new coordinator?"
    public static let replaceCoordinatorDetail =
        "The current conversation is completed — a turn in flight finishes first — and this project starts coordinating from a new, empty one. Nothing is deleted: the completed conversation stays readable."
    public static let replaceCoordinatorConfirm = "Complete and start a new one"
    public static let replaceCoordinatorKeep = "Keep this coordinator"

    // MARK: - Blockers

    /// A blocker's tag (who has to act, or what kind of delivery it is) and its headline.
    public struct BlockerHeadline: Equatable, Sendable {
        public let tag: String
        public let tone: TagTone
        public let title: String
    }

    /// The deliveries a machine may not settle, in the web's words.
    private static let blockerReasonHeadlines: [String: BlockerHeadline] = [
        "OUTSIDE_DECLARED_SCOPE": BlockerHeadline(tag: "Needs your approval", tone: .warning,
                                                  title: "Changed files it didn’t declare"),
        "ACCEPTANCE_STANDARD_MOVED": BlockerHeadline(tag: "Standard moved", tone: .warning,
                                                     title: "Its acceptance criterion changed after it started"),
        "CRITERION_EXEMPTION_ARGUED": BlockerHeadline(tag: "Needs your decision", tone: .warning,
                                                      title: "It argues a criterion doesn’t apply to it"),
        "MERGE_REFUSED_BY_GIT": BlockerHeadline(tag: "Merge conflict", tone: .danger, title: "Git refused to merge it"),
    ]

    /// Every other kind is named by its code, beside who has to act on it.
    public static func blockerHeadline(_ blocker: ProjectBlocker) -> BlockerHeadline {
        if let reason = blocker.detail.reason, let known = blockerReasonHeadlines[reason] { return known }
        let tag: (String, TagTone)
        switch blocker.owner {
        case "USER": tag = ("Needs you", .warning)
        case "COORDINATOR": tag = ("Coordinator", .brand)
        default: tag = ("System", .neutral)
        }
        let words = blocker.kind.lowercased().split(separator: "_").joined(separator: " ")
        let title = words.isEmpty ? blocker.kind : words.prefix(1).uppercased() + words.dropFirst()
        return BlockerHeadline(tag: tag.0, tone: tag.1, title: title)
    }

    /// The work a blocker is about, and for a moved standard, where that standard stands now.
    public static func blockerSubjectLine(_ blocker: ProjectBlocker) -> String? {
        var parts: [String] = []
        if let title = blocker.subjectTitle, !title.isEmpty { parts.append(title) }
        if blocker.detail.reason == "ACCEPTANCE_STANDARD_MOVED", let ordinal = blocker.criterionOrdinal,
           let revision = blocker.criterionRevision {
            parts.append("criterion \(ordinal) is now revision \(revision)")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// The files, short enough for one line: the first whole, the next by name when it sits in the
    /// same directory, the rest counted.
    public static func blockerPathsLine(_ paths: [String]) -> String? {
        guard let first = paths.first else { return nil }
        let folder = first.range(of: "/", options: .backwards).map { String(first[..<$0.upperBound]) } ?? ""
        let shown = paths.prefix(2).enumerated().map { index, path -> String in
            let rest = String(path.dropFirst(folder.count))
            return index > 0 && !folder.isEmpty && path.hasPrefix(folder) && !rest.contains("/") ? rest : path
        }
        let hidden = paths.count - shown.count
        return (shown + (hidden > 0 ? ["+\(hidden)"] : [])).joined(separator: " · ")
    }

    /// "since 34d": how long it has stood.
    public static func blockerSince(_ firstSeenAt: String?, now: Date) -> String {
        guard let at = firstSeenAt.flatMap(RelativeTime.parse) else { return "since just now" }
        let elapsed = now.timeIntervalSince(at)
        if elapsed < 60 { return "since just now" }
        if elapsed < 3_600 { return "since \(Int(elapsed / 60))m" }
        if elapsed < 86_400 { return "since \(Int(elapsed / 3_600))h" }
        return "since \(Int(elapsed / 86_400))d"
    }

    /// How one blocker ended, and when: "Auto-resolved — its condition no longer holds (08-21 16:12)".
    public static func blockerResolution(_ blocker: ProjectBlocker, timeZone: TimeZone = .current) -> String {
        let when = blocker.resolvedAt.flatMap(RelativeTime.parse).map { " (\(shortTime($0, timeZone)))" } ?? ""
        let note = blocker.resolutionNote?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        switch blocker.resolvedBy {
        case "AUTO": return "Auto-resolved — \(note.isEmpty ? "its condition no longer holds" : note)\(when)"
        case "USER": return "Resolved by you — \(note.isEmpty ? "no reason was recorded" : note)\(when)"
        case "COORDINATOR": return "Resolved by the coordinator\(note.isEmpty ? "" : " — \(note)")\(when)"
        default: return "Resolved\(when)"
        }
    }

    private static func shortTime(_ date: Date, _ timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let c = calendar.dateComponents([.month, .day, .hour, .minute], from: date)
        return String(format: "%02d-%02d %02d:%02d", c.month ?? 0, c.day ?? 0, c.hour ?? 0, c.minute ?? 0)
    }

    public static func blockersOpen(_ count: Int) -> String { "\(count) open" }

    /// "Who not in team · 合并 TasksView 的两个独立轮询循环": a blocker named for its dialog and its
    /// resolved row.
    public static func blockerName(_ blocker: ProjectBlocker) -> String {
        [blockerHeadline(blocker).title, blocker.subjectTitle ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// One resolved row: the blocker, then how it ended.
    public static func blockerResolvedLine(_ blocker: ProjectBlocker, timeZone: TimeZone = .current) -> String {
        "\(blockerName(blocker)) — \(blockerResolution(blocker, timeZone: timeZone))"
    }

    /// "4 resolved · latest: Auto-resolved — its condition no longer holds (08-21 16:12)"; nil when
    /// none were.
    public static func blockersResolvedSummary(_ blockers: ProjectBlockers,
                                               timeZone: TimeZone = .current) -> String? {
        guard blockers.resolvedCount > 0, let latest = blockers.resolved.first else { return nil }
        return "\(blockers.resolvedCount) resolved · latest: \(blockerResolution(latest, timeZone: timeZone))"
    }

    /// What the resolve dialog says under its title: which blocker, and that the reason is kept.
    public static func resolveBlockerMessage(_ blocker: ProjectBlocker) -> String {
        "\(blockerName(blocker))\n\n\(resolveBlockerNote)."
    }

    public static let resolveBlockerPress = "Resolve…"
    public static let resolveBlockerTitle = "Resolve this blocker"
    public static let resolveBlockerQuestion = "Why is it no longer blocking?"
    public static let resolveBlockerNote = "Recorded with your name and this reason"
    public static let resolveBlockerConfirm = "Resolve"
    /// The server's limit on the reason.
    public static let blockerReasonLimit = 2000

    // MARK: - Run queue

    /// "7 ready · sorted by work unblocked".
    public static func queueSummary(_ q: ProjectReadyToRun) -> String {
        var parts: [String] = []
        if q.runningCount > 0 { parts.append("\(q.runningCount) running") }
        if q.queuedCount > 0 { parts.append("\(q.queuedCount) queued") }
        parts.append("\(q.readyCount) ready")
        if q.pausedCount > 0 { parts.append("\(q.pausedCount) ready in paused lists") }
        let active = q.runningCount + q.queuedCount > 0
        let ranking: String
        if q.impactTruncated != nil {
            ranking = active ? "active first · remaining tasks in stable order" : "stable order"
        } else {
            ranking = active ? "ready tasks sorted by work unblocked" : "sorted by work unblocked"
        }
        return (parts + [ranking]).joined(separator: " · ")
    }

    /// The line under the rows.
    public static func queueHelp(_ q: ProjectReadyToRun) -> String {
        var parts: [String] = []
        if q.runningCount + q.queuedCount > 0 { parts.append("Active tasks stay here until their run ends.") }
        if q.readyCount > 0 { parts.append("Ready tasks can start now.") }
        if q.pausedCount > 0 {
            parts.append("Paused candidates meet every other run requirement; resume their task list to make Run available.")
        }
        return parts.joined(separator: " ")
    }

    public static let queueEmpty =
        "No tasks are ready, running, or otherwise ready inside a paused task list. A task appears here when its prerequisites are complete and it has an assigned workspace."

    public static func queueImpactTruncated(maxTasks: Int) -> (title: String, detail: String) {
        ("Impact ranking not computed",
         "This project has more than \(maxTasks) unfinished tasks, so tasks are shown without downstream impact ranking.")
    }

    /// A row's state line: "Prerequisites complete", "Waiting for runner", "Work in progress",
    /// "List paused · Backlog".
    public static func queueRowState(_ item: ProjectReadyToRun.Item) -> String {
        switch item.runState {
        case .running: return "Work in progress"
        case .queued: return "Waiting for runner"
        case .paused:
            guard let title = item.pausedList?.title, !title.isEmpty else { return "List paused" }
            return "List paused · \(title)"
        case .ready: return "Prerequisites complete"
        }
    }

    /// What starting it releases: "Unblocks 3 tasks", or why that was not ranked.
    public static func queueImpact(_ item: ProjectReadyToRun.Item) -> String {
        guard let n = item.downstreamBlocked else {
            switch item.runState {
            case .ready: return "Ready now"
            case .paused: return "Ready after resume"
            default: return "Impact not ranked"
            }
        }
        return "Unblocks \(n) \(n == 1 ? "task" : "tasks")"
    }

    public static let runPress = "Run"
    public static let runPressStarting = "Starting"
    public static let openRunSession = "Open session"
    public static let resumeListPress = "Resume list"
    /// Recorded with the resume, so the list's history says where it came from.
    public static let resumeListNote = "Resumed from the project Run queue"

    /// The row's state when it has no press of its own.
    public static func queueRowTag(_ state: ProjectReadyToRun.RunState) -> String {
        switch state {
        case .running: return "Running"
        case .paused: return "Paused"
        default: return "Queued"
        }
    }

    public static func resumeListQuestion(_ list: ProjectReadyToRun.PausedList) -> String {
        "Resume “\(list.title)”?"
    }

    /// What resuming the WHOLE list would set loose, before it is pressed.
    public static func resumeListDetail(_ item: ProjectReadyToRun.Item) -> String {
        guard let list = item.pausedList else { return "This task list must be resumed before the task can run." }
        let eligible = "\(list.readyCount) otherwise-ready \(list.readyCount == 1 ? "task" : "tasks")"
        let auto = list.autoRunReadyCount
        let immediate = auto > 0
            ? " \(auto) \(auto == 1 ? "is" : "are") configured to auto-run and may start immediately."
            : ""
        return "This removes the pause from the entire list. \(eligible) will become eligible.\(immediate) Other automatic or scheduled work in the list can also dispatch once resumed."
    }

    // MARK: - Acceptance criteria, as the card frames them

    /// How many rows the card lists before it says how many more there are: four on a phone, twelve
    /// where there is room.
    public static let criteriaPreviewCompact = 4
    public static let criteriaPreviewRegular = 12

    public static func criteriaStanding(count: Int) -> String {
        "\(count) \(count == 1 ? "criterion" : "criteria") stated. Whether one is met is read off the work filed under it; nothing in Orbit judges the criteria themselves."
    }

    public static let noCriteria = "No criteria are stated for this project."

    /// The press that shows the rest, and what it says about what is hidden; nil when nothing is.
    public static func criteriaDisclosure(total: Int, limit: Int, expanded: Bool,
                                          compact: Bool) -> (press: String, meta: String)? {
        guard total > limit else { return nil }
        let press = expanded
            ? "Show first \(limit) criteria"
            : (compact ? "View all \(total) criteria" : "Show all \(total) criteria")
        return (press, expanded ? "Showing all \(total) criteria" : "\(total - limit) more not shown")
    }

    public static let criteriaOutcomeNote = "Tasks track process · Nothing judges these criteria."
    public static let howItsChecked = "How it's checked"

    // MARK: - Instructions

    public static let instructionsHeading = "Instructions"
    public static let noInstructions = "No instructions set"

    // MARK: - Tasks

    /// A row's tags inside its band. The lane tag goes when the band's heading already says it
    /// ("Ready · can start now" under "Ready · can start now", "Failed" under "Failed · …"); one that
    /// says more ("Ready · automatic dispatch") stays.
    public static func rowTags(_ task: ProjectTaskRow, heading: String, ref: String?,
                               upstreamRef: String?) -> [Tag] {
        var tags: [Tag] = []
        if let lane = workTag(task), lane.text != heading, !heading.hasPrefix(lane.text + " · ") {
            tags.append(lane)
        }
        if let line = integrationTag(task, ref: ref, upstreamRef: upstreamRef) { tags.append(line) }
        return tags
    }
}
