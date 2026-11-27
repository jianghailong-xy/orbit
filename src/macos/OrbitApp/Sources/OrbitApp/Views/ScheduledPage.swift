import SwiftUI
import OrbitKit

// The Scheduled page on a phone (docs/mocks/scheduled-tasks/01-board.png ② ③ ⑧, 02-agent-first.png ③): a timeline
// in the manner of Reminders' Scheduled list — grouped by the day each schedule next runs, the circle its state — a
// detail panel from the bottom for a row, and a line at the end that takes one sentence. The page is the web's
// (`ScheduledPage.tsx`) in behaviour; every word and rule is OrbitKit's. The Mac draws the same rows, detail and
// draft panel in its own columns (ScheduledMacPage.swift, the web board docs/mocks/scheduled-tasks/web/01-board.png).

private typealias SC = ScheduleCopy

/// A row's state as a circle (board 01 ② 2): open is to come, the blue arc runs, a grey tick did nothing new, a
/// green tick found something, red failed, amber is held, dashed is a draft, faint is paused.
struct ScheduleCircleGlyph: View {
    let view: ScheduleDisplay.CircleView
    var size: CGFloat = 22

    var body: some View {
        if view.gauge {
            // A condition's row (condition-triggers board ④ ③): a gauge in place of the circle, amber when it
            // cannot be read, faint when paused.
            Image(systemName: "gauge.with.dots.needle.33percent")
                .font(.title3.weight(.medium))
                .foregroundStyle(view.circle == .held ? Color.orange
                                 : view.circle == .paused ? Color.secondary.opacity(0.5) : Color.accentColor)
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        } else {
            circleBody
        }
    }

    private var circleBody: some View {
        ZStack {
            switch view.circle {
            case .open:
                Circle().strokeBorder(Color.secondary.opacity(0.45), lineWidth: 1.5)
            case .running:
                Circle().strokeBorder(Color.secondary.opacity(0.25), lineWidth: 1.5)
                Circle().trim(from: 0, to: 0.3).stroke(Color.accentColor, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(-90)).padding(1)
            case .done:
                Circle().strokeBorder(Color.secondary.opacity(0.45), lineWidth: 1.5)
            case .new:
                Circle().fill(Color.green)
            case .failed:
                Circle().fill(Color.red)
            case .held:
                Circle().strokeBorder(Color.orange, lineWidth: 1.5)
            case .draft:
                Circle().strokeBorder(Color.secondary.opacity(0.6), style: StrokeStyle(lineWidth: 1.5, dash: [3, 2.5]))
            case .paused:
                Circle().strokeBorder(Color.secondary.opacity(0.22), lineWidth: 1.5)
            case .muted:
                Circle().strokeBorder(Color.secondary.opacity(0.25), lineWidth: 1.5)
            }
            if view.mark == .clock {
                // A queued run: clock hands inside the ring, which is the clock's face.
                ScheduleClockHands()
                    .stroke(markColor, style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
                    .padding(size * 0.2)
            } else if let mark = view.mark {
                Image(systemName: mark == .check ? "checkmark" : "exclamationmark")
                    .font(.orbitMeta.weight(.heavy))
                    .foregroundStyle(markColor)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private var markColor: Color {
        switch view.circle {
        case .new, .failed: return .white
        case .held: return .orange
        case .muted: return Color.secondary.opacity(0.5)
        default: return .secondary
        }
    }
}

/// A clock's two hands, pointing at about four o'clock, for a queued run's circle.
private struct ScheduleClockHands: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.midX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.midX, y: rect.midY))
        path.addLine(to: CGPoint(x: rect.midX + rect.width * 0.32, y: rect.midY + rect.height * 0.2))
        return path
    }
}

extension Color {
    /// The detail panel's ground and its blocks': the grouped greys on a phone, the window's and a control's on a Mac.
    static var schedulePanelFill: Color {
        #if os(iOS)
        Color(uiColor: .systemGroupedBackground)
        #else
        Color.secondary.opacity(0.06)
        #endif
    }

    /// The edge a block and a door have on the Mac's panel (web inspector's bordered blocks); none on a phone.
    static var scheduleCardEdge: Color {
        #if os(iOS)
        Color.clear
        #else
        Color.secondary.opacity(0.25)
        #endif
    }

    static var scheduleCardFill: Color {
        #if os(iOS)
        Color(uiColor: .secondarySystemGroupedBackground)
        #else
        Color(nsColor: .controlBackgroundColor)
        #endif
    }
}

extension ScheduleDisplay.TagTone {
    var color: Color {
        switch self {
        case .new: return .green
        case .fail: return .red
        case .held: return .orange
        case .mute: return .secondary
        }
    }
}

/// "02:00": a row's time column, 24-hour, in the viewer's zone.
func scheduleClock(_ iso: String?) -> String {
    guard let iso, let at = ScheduleDisplay.parse(iso) else { return "" }
    return ScheduleDisplay.localParts(at, timezone: TimeZone.current.identifier).time
}

/// One row of the timeline.
struct ScheduleRowModel: Identifiable {
    let id: String
    let circle: ScheduleDisplay.CircleView
    let title: String
    let line: String
    /// The planned end, on its own line so the row's line never cuts it off.
    var end: String? = nil
    let repeats: Bool
    let time: String
    let draft: Bool
    let paused: Bool
    /// The schedule this row opens, for the Mac's selected row; nil for a draft.
    var scheduleID: String? = nil
    /// A condition's row: the newest reading and its age, where a timed row shows its time (board ④ ②).
    var reading: ConditionDisplay.RowReading? = nil
    /// What the row stands for: its swipes and long-press menu act on it.
    let kind: ScheduleRowKind
    let open: () -> Void
}

/// The timeline's rows, the web's `rowOf`: one builder for the phone and the Mac. `wide` is the Mac's (and the
/// web's) long row line, `scheduleRowLine`; the phone keeps its short line.
enum ScheduleTimelineRows {
    @MainActor
    static func rows(_ group: ScheduleDisplay.TimelineGroup, scheduled: ScheduledModel, now: Date,
                     wide: Bool, openTask: @escaping (String) -> Void = { _ in }) -> [ScheduleRowModel] {
        let runs = scheduled.timelineRuns
        return ScheduleDisplay.collapseMissedItems(group.items).map { entry -> ScheduleRowModel in
            guard case .item(let item) = entry else {
                // A streak of missed slots is one faint row: "4 slots missed, 01:00–04:00".
                guard case .missed(let s, let missedRuns, let at) = entry, let first = missedRuns.first else { fatalError() }
                return ScheduleRowModel(
                    id: "\(group.id)-missed-\(first.id)",
                    circle: ScheduleDisplay.runCircle(state: first.state, newFinding: false),
                    title: s.title,
                    line: ScheduleDisplay.missedText(missedRuns, timezone: scheduled.timezone),
                    repeats: false, time: scheduleClock(at), draft: false, paused: wide,
                    scheduleID: wide ? nil : s.id,
                    kind: .run(s, first),
                    open: { Self.select(s.id, scheduled) })
            }
            switch item {
            case .task(let t):
                return ScheduleRowModel(
                    id: "\(group.id)-\(item.id)",
                    circle: ConditionDisplay.circle(cantRead: t.condition.cantRead),
                    title: t.title, line: ConditionDisplay.taskRowLine(t), repeats: false, time: "",
                    draft: false, paused: false,
                    reading: t.condition.cantRead ? nil : ConditionDisplay.rowReading(t.condition, now: now),
                    kind: .task(t.id),
                    open: { openTask(t.id) })
            case .draft(let card, let at):
                let rule = card.when?.rule ?? .daily(time: "")
                let accessLevel = card.may?.accessLevel ?? "CHECK_ONLY"
                return ScheduleRowModel(
                    id: "\(group.id)-\(item.id)",
                    circle: ScheduleDisplay.scheduleCircle(state: "ACTIVE", consecutiveFailures: 0, draft: true),
                    title: card.title ?? "",
                    line: wide
                        ? ScheduleDisplay.rowLine(rule: rule, workspaceName: card.runsIn?.workspaceName,
                                                  accessLevel: accessLevel, state: "ACTIVE", heldReason: nil, draft: true)
                        : ScheduleDisplay.phoneRowLine(rule: rule, workspaceName: card.runsIn?.workspaceName,
                                                       accessLevel: accessLevel, state: "ACTIVE", heldReason: nil,
                                                       draft: true),
                    repeats: ScheduleDisplay.ruleRepeats(rule), time: scheduleClock(at), draft: true, paused: false,
                    kind: .draft(card),
                    open: {
                        scheduled.inspectedID = nil
                        scheduled.draftPanel = ScheduledModel.DraftPanel(sessionID: card.askedBySessionId ?? card.id,
                                                                         typed: card.intent ?? "")
                    })
            case .run(let s, let run, _):
                let underWay = ["QUEUED", "RUNNING", "AWAITING_APPROVAL"].contains(run.state)
                let facts = ScheduleDisplay.runFindingFacts(run, findings: scheduled.detail(s.id)?.findings ?? [])
                var minutes: Int?
                if run.state == "RUNNING", let started = run.startedAt.flatMap(ScheduleDisplay.parse) {
                    minutes = max(0, Int(now.timeIntervalSince(started) / 60))
                }
                let line: String
                if !underWay {
                    line = ScheduleDisplay.runLine(state: run.state, summary: run.summary, failureReason: run.failureReason,
                                                   reasonText: run.reasonText, notified: facts.notified)
                } else if wide {
                    line = ScheduleDisplay.rowLine(rule: s.rule, workspaceName: s.workspaceName, accessLevel: s.accessLevel,
                                                   state: s.state, heldReason: s.heldReason, agentName: s.agentName,
                                                   runningMinutes: minutes)
                } else {
                    line = ScheduleDisplay.phoneRowLine(rule: s.rule, workspaceName: s.workspaceName,
                                                        accessLevel: s.accessLevel, state: s.state,
                                                        heldReason: s.heldReason, runningMinutes: minutes)
                }
                return ScheduleRowModel(
                    id: "\(group.id)-\(item.id)",
                    circle: ScheduleDisplay.runCircle(state: run.state, newFinding: facts.newFinding),
                    title: s.title,
                    line: line,
                    repeats: underWay && ScheduleDisplay.ruleRepeats(s.rule), time: scheduleClock(run.plannedAt),
                    // A past run is drawn faint, as the web's `is-past` row.
                    draft: false, paused: wide && !underWay, scheduleID: wide ? nil : s.id,
                    kind: .run(s, run),
                    open: { Self.select(s.id, scheduled) })
            case .schedule(let s, let at):
                let inPaused = group.key == .paused
                // A failing schedule is tagged on its own row on the day of its next run (owner 2026-11-19), with
                // that run's time; the circle drops the tag while a run of it is under way.
                let circle = ScheduleDisplay.scheduleCircle(s, runs: runs)
                let time = inPaused ? "" : scheduleClock(at)
                let pausedAt = s.pausedAt.flatMap(ScheduleDisplay.parse) ?? Self.pausedAt(scheduled.detail(s.id))
                if case .when = s.rule {
                    // A WHEN rule (condition-triggers board ④): "↻ When raw used above 90% · HPC", a gauge, and the
                    // newest reading with its age where a timed row has its time; "Can't read" at the head of its group.
                    var parts = [ScheduleDisplay.ruleText(s.rule, form: .long)]
                    if let name = s.workspaceName, !name.isEmpty { parts.append(name) }
                    if s.accessLevel != "CHECK_ONLY" { parts.append(ScheduleDisplay.accessCopy(s.accessLevel).label) }
                    let cantRead = s.condition?.cantRead == true
                    return ScheduleRowModel(
                        id: "\(group.id)-\(item.id)",
                        circle: circle,
                        title: s.title, line: parts.joined(separator: SC.separator), repeats: true,
                        time: "", draft: false, paused: inPaused, scheduleID: s.id,
                        reading: cantRead || inPaused ? nil : s.condition.flatMap { ConditionDisplay.rowReading($0, now: now) },
                        kind: .schedule(s),
                        open: { Self.select(s.id, scheduled) })
                }
                return ScheduleRowModel(
                    id: "\(group.id)-\(item.id)",
                    circle: circle,
                    title: s.title,
                    line: wide
                        ? ScheduleDisplay.rowLine(rule: s.rule, workspaceName: s.workspaceName, accessLevel: s.accessLevel,
                                                  state: s.state, heldReason: s.heldReason, agentName: s.agentName,
                                                  pausedAt: pausedAt, timezone: scheduled.timezone)
                        : ScheduleDisplay.phoneRowLine(rule: s.rule, workspaceName: s.workspaceName,
                                                       accessLevel: s.accessLevel, state: s.state,
                                                       heldReason: s.heldReason, pausedAt: pausedAt,
                                                       timezone: scheduled.timezone),
                    end: ScheduleDisplay.endText(s, now: now, timezone: scheduled.timezone),
                    repeats: ScheduleDisplay.ruleRepeats(s.rule), time: time, draft: false, paused: inPaused,
                    scheduleID: s.id,
                    kind: .schedule(s),
                    open: { Self.select(s.id, scheduled) })
            }
        }
    }

    @MainActor
    private static func select(_ id: String, _ scheduled: ScheduledModel) {
        scheduled.draftPanel = nil
        scheduled.changeDraft = nil
        scheduled.inspectedID = id
    }

    /// When a schedule was paused: its newest revision that paused it.
    private static func pausedAt(_ detail: ScheduleDetailResponse?) -> Date? {
        detail?.history.first { $0.after["state"]?.stringValue == "PAUSED" }.flatMap { ScheduleDisplay.parse($0.createdAt) }
    }
}

#if os(iOS)
struct ScheduledPage: View {
    @Environment(AppModel.self) private var model
    @State private var typed = ""
    @State private var asking = false
    @State private var chosenWorkspace: String?
    /// The schedule a row's swipe or menu asked to delete, and the run it asked to stop, while the question is up.
    @State private var deleting: ScheduleView?
    @State private var stopping: ScheduleRunView?
    /// The schedule a row's menu asked to rename, and the alert's text.
    @State private var renaming: ScheduleView?
    @State private var renameDraft = ""
    /// The round swipe buttons need the compact list (as the session list's do); a regular-width one keeps the system's.
    @Environment(\.horizontalSizeClass) private var hSize
    @State private var rowSwipe = RowSwipeState()
    @FocusState private var typing: Bool

    var body: some View {
        Group {
            if let scheduled = model.scheduled {
                content(scheduled)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
    }

    private func content(_ scheduled: ScheduledModel) -> some View {
        @Bindable var scheduled = scheduled
        let now = Date()
        let groups = scheduled.timeline(now: now)
        return List {
            // One flat ForEach over the page's rows, headers included: the shape every List here keeps
            // (ListRowShapeTests), no `if` and no second ForEach under it.
            ForEach(pageRows(scheduled, groups: groups, now: now)) { row in
                switch row {
                case .header:
                    header(scheduled).listRowSeparator(.hidden)
                case .lead:
                    Text(SC.Empty.lead)
                        .font(.orbitSubtext).foregroundStyle(.secondary)
                        .listRowSeparator(.hidden)
                case .example(let example):
                    Button { typed = example } label: {
                        Text(example).font(.orbitSubtext).foregroundStyle(Color.accentColor)
                            .multilineTextAlignment(.leading)
                    }
                    .buttonStyle(.plain)
                case .waiting(let item):
                    ScheduleWaitingCardView(item: item).listRowSeparator(.hidden)
                case .condition(let item):
                    ConditionWaitingCardView(item: item).listRowSeparator(.hidden)
                case .group(let group):
                    groupHeader(group).listRowSeparator(.hidden)
                case .item(let item):
                    rowView(item, scheduled)
                case .quickAdd:
                    quickAdd(scheduled).listRowSeparator(.hidden)
                case .error(let text):
                    Text(text).font(.orbitLabel).foregroundStyle(.red).listRowSeparator(.hidden)
                }
            }
        }
        .listStyle(.plain)
        .softTopEdgeEffect()
        .environment(\.defaultMinListRowHeight, 0)
        .rowSwipeList(rowSwipe)
        // A row's Delete and Stop ask first, as the detail panel's ⋯ → Delete does.
        .orbitConfirmation({ ScheduleDisplay.deleteTitle($0.title) },
                           isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                           presenting: deleting) { schedule in
            Button(SC.DeleteConfirm.confirm, role: .destructive) {
                Task { @MainActor in await scheduled.delete(schedule.id) }
            }
            Button(SC.DeleteConfirm.cancel, role: .cancel) {}
        } message: { _ in
            Text(SC.DeleteConfirm.body)
        }
        .orbitConfirmation({ _ in SC.StopConfirm.title },
                           isPresented: Binding(get: { stopping != nil }, set: { if !$0 { stopping = nil } }),
                           presenting: stopping) { run in
            Button(SC.StopConfirm.confirm, role: .destructive) {
                Task { @MainActor in await scheduled.stop(runID: run.id, scheduleID: run.scheduleId) }
            }
            Button(SC.StopConfirm.cancel, role: .cancel) {}
        } message: { _ in
            Text(SC.StopConfirm.body)
        }
        .scheduleRenameAlert($renaming, draft: $renameDraft)
        .toolbar {
            // The chat (board scheduled-chat 01 part 4 ①): a sheet on a phone, the third column on a wide iPad.
            ToolbarItem(placement: .topBarTrailing) { ScheduledChatButton() }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Toggle(SC.Page.showPastRuns, isOn: $scheduled.showPastRuns)
                } label: {
                    Image(systemName: "ellipsis")
                }
                .accessibilityLabel("More")
            }
        }
        .task {
            await scheduled.load()
            // A server that sends the window's runs with the list needs no other read to draw the page.
            if scheduled.listRuns == nil {
                for s in scheduled.schedules { await scheduled.loadDetail(s.id) }
            }
        }
        .sheet(isPresented: Binding(get: { scheduled.inspectedID != nil },
                                    set: { if !$0 { scheduled.inspectedID = nil; scheduled.inspectedFromChat = false } })) {
            if let id = scheduled.inspectedID {
                ScheduleDetailPanel(scheduleID: id)
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
            }
        }
        .sheet(item: $scheduled.draftPanel) { panel in
            ScheduleDraftPanel(panel: panel)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        // The draft change conversation (board 03-change ② 3): a page of its own, back to Scheduled.
        .fullScreenCover(item: $scheduled.changeDraft) { draft in
            ScheduleChangePage(scheduleID: draft.scheduleID)
        }
    }

    /// The page's rows, in order: the head, then the empty page's lead and examples, or each group's header and
    /// rows; the line at the end; a refusal under it.
    private enum PageRow: Identifiable {
        case header
        case lead
        case example(String)
        case waiting(ScheduleWaitingItem)
        case condition(ConditionWaitingItem)
        case group(ScheduleDisplay.TimelineGroup)
        case item(ScheduleRowModel)
        case quickAdd
        case error(String)

        var id: String {
            switch self {
            case .header: return "header"
            case .lead: return "lead"
            case .example(let text): return "example-\(text)"
            case .waiting(let item): return "waiting-\(item.id)"
            case .condition(let item): return "condition-\(item.id)"
            case .group(let group): return "group-\(group.id)"
            case .item(let row): return row.id
            case .quickAdd: return "quick-add"
            case .error: return "error"
            }
        }
    }

    private func pageRows(_ scheduled: ScheduledModel, groups: [ScheduleDisplay.TimelineGroup],
                          now: Date) -> [PageRow] {
        var out: [PageRow] = [.header]
        // A condition's items (the can't-read card and the 30-day question, condition-triggers board ⑥ ①) and a
        // scheduled task's (failed, held, a run's approval, a run asking for more), whole, under the head: each answers
        // at its own door. There is no Waiting on you sheet (docs/mocks/waiting-on-you-removal; the owner, 2026-11-16);
        // the run's session draws its own.
        out += (model.ownerRequests?.conditionItems ?? []).map(PageRow.condition)
        out += (model.ownerRequests?.scheduleItems ?? []).map(PageRow.waiting)
        let empty = scheduled.loaded && scheduled.shownSchedules.isEmpty && scheduled.drafts.isEmpty
            && scheduled.shownWaitingTasks.isEmpty && scheduled.workspaceFilter == nil
        if empty {
            out += [.lead, .quickAdd] + SC.Empty.examples.map(PageRow.example)
        } else {
            for group in groups {
                out.append(.group(group))
                out += rows(group, scheduled: scheduled, now: now).map(PageRow.item)
            }
            out.append(.quickAdd)
        }
        if let error = scheduled.errorText { out.append(.error(error)) }
        return out
    }

    /// "Scheduled 6" in the boards' blue, and the workspace filter under it (board 01 ②).
    private func header(_ scheduled: ScheduledModel) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(SC.Page.title)
                    .font(.largeTitle.weight(.bold))
                    .foregroundStyle(Color.accentColor)
                Spacer()
                Text("\(scheduled.shownSchedules.count + scheduled.shownWaitingTasks.count)")
                    .font(.largeTitle.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("scheduled-count")
            }
            Menu {
                Button(SC.Page.allWorkspaces) { scheduled.workspaceFilter = nil }
                ForEach(scheduled.workspaces, id: \.id) { w in
                    Button(w.name) { scheduled.workspaceFilter = w.id }
                }
            } label: {
                HStack(spacing: 4) {
                    Text(scheduled.workspaceFilter.flatMap { id in scheduled.workspaces.first { $0.id == id }?.name }
                         ?? SC.Page.allWorkspaces)
                    Image(systemName: "chevron.down").font(.caption2.weight(.semibold))
                }
                .font(.orbitLabel)
                .foregroundStyle(.primary)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .overlay(Capsule().strokeBorder(Color.secondary.opacity(0.35)))
            }
        }
        .padding(.top, 4)
    }

    /// "Today  Fri, Nov 14"; Paused grey.
    private func groupHeader(_ group: ScheduleDisplay.TimelineGroup) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(group.title)
                .font(.title3.weight(.bold))
                .foregroundStyle(group.key == .paused ? Color.secondary : Color.primary)
            if let subtitle = group.subtitle {
                Text(subtitle).font(.orbitSubtext).foregroundStyle(Color.secondary)
            }
            Spacer()
        }
        .textCase(nil)
        .padding(.top, 6)
    }

    private func rows(_ group: ScheduleDisplay.TimelineGroup, scheduled: ScheduledModel,
                      now: Date) -> [ScheduleRowModel] {
        ScheduleTimelineRows.rows(group, scheduled: scheduled, now: now, wide: false,
                                  openTask: { id in model.route(to: .task(id)) })
    }

    private func rowView(_ row: ScheduleRowModel, _ scheduled: ScheduledModel) -> some View {
        swipeable(Button(action: row.open) {
            HStack(alignment: .top, spacing: 12) {
                ScheduleCircleGlyph(view: row.circle).padding(.top, 1)
                VStack(alignment: .leading, spacing: 3) {
                    // The title's line carries the tag and the time at its end (board 01 ②: "Failed ×3  02:00").
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(row.title)
                            .font(.orbitControl)
                            .italic(row.draft)
                            .foregroundStyle(row.draft || row.paused ? .secondary : .primary)
                            .lineLimit(2)
                        Spacer(minLength: 6)
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            if let tag = row.circle.tag, row.circle.circle != .done, row.circle.circle != .muted {
                                Text(tag.text).font(.orbitMeta.weight(.semibold)).foregroundStyle(tag.tone.color)
                            }
                            if let reading = row.reading {
                                // "6.9% · 1 min ago": how far from firing, and whether the probe is still alive.
                                (Text(reading.value).font(.orbitLabel.weight(.semibold)).foregroundColor(.primary)
                                 + Text(reading.age.map { "\(SC.separator)\($0)" } ?? "").font(.orbitLabel)
                                    .foregroundColor(.secondary))
                                    .monospacedDigit()
                                    .accessibilityIdentifier("schedule-row-reading")
                            } else if !row.time.isEmpty {
                                Text(row.time).font(.orbitLabel).foregroundStyle(.secondary).monospacedDigit()
                            }
                        }
                        .lineLimit(1)
                        .fixedSize()
                    }
                    // One line, the phone's short grammar; the tail gives way if it must.
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        if row.repeats { Text("↻").accessibilityHidden(true) }
                        Text(row.line).truncationMode(.tail)
                    }
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    // The planned end on its own line: "until 23:00 today · 3 runs left" is never the part cut off.
                    if let end = row.end {
                        Text(end).font(.orbitLabel).foregroundStyle(.secondary).accessibilityIdentifier("schedule-row-end")
                    }
                }
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("schedule-row"), row, scheduled)
    }

    /// The row's swipes and long-press menu, by its kind (`ScheduleRowActions`), on the row the List hosts: a
    /// `Button` does not pass them up from its label. iOS 26's compact list draws the session list's round buttons;
    /// elsewhere the system's.
    @ViewBuilder
    private func swipeable<V: View>(_ content: V, _ row: ScheduleRowModel, _ scheduled: ScheduledModel) -> some View {
        let actions = ScheduleRowActions(row.kind, model: model, scheduled: scheduled,
                                         askRename: { s in
                                             // Seeded in the action that presents the alert (SessionRenameAlert).
                                             renameDraft = s.title
                                             renaming = s
                                         },
                                         askDelete: { deleting = $0 }, askStop: { stopping = $0 },
                                         openTask: { id in model.route(to: .task(id)) })
        if #available(iOS 26.0, *), hSize == .compact, !(actions.leading.isEmpty && actions.trailing.isEmpty) {
            content
                .contextMenu { actions.menuContent }
                .circleSwipeActions(id: row.id, leading: actions.leading, trailing: actions.trailing,
                                    leadingFullSwipe: actions.leadingFullSwipe)
        } else {
            content
                .swipeActions(edge: .leading, allowsFullSwipe: actions.leadingFullSwipe) {
                    ForEach(actions.leading) { swipeButton($0) }
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    ForEach(actions.trailing) { swipeButton($0) }
                }
                .contextMenu { actions.menuContent }
        }
    }

    /// A system swipe button: tinted, never `.destructive`, which would take the row away before Delete's or
    /// Stop's question is answered.
    private func swipeButton(_ action: RowSwipeAction) -> some View {
        Button(action: action.perform) { Label(action.title, systemImage: action.systemImage) }
            .tint(action.tint)
            .disabled(!action.isEnabled)
    }

    /// The line at the end (board 01 ② 3, ⑧): one sentence and the workspace it goes to. Not a form: an agent sets
    /// the schedule up from it in an ordinary conversation, and its card comes back here as a draft.
    private func quickAdd(_ scheduled: ScheduledModel) -> some View {
        let agents = model.orderedAgents
        let workspace = agents.first { $0.id == chosenWorkspace } ?? agents.first { $0.id == model.selectedAgentID }
            ?? agents.first
        return HStack(spacing: 10) {
            Image(systemName: "plus.circle.fill")
                .font(.title3)
                .foregroundStyle(Color.accentColor)
            TextField(SC.QuickAdd.placeholder, text: $typed)
                .font(.orbitControl)
                .focused($typing)
                .submitLabel(.send)
                .disabled(asking)
                .onSubmit {
                    let sentence = typed.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !sentence.isEmpty, let workspace else { return }
                    asking = true
                    Task { @MainActor in
                        if await scheduled.ask(sentence, workspaceID: workspace.id) { typed = "" }
                        asking = false
                    }
                }
                .accessibilityIdentifier("schedule-quick-add")
            if let workspace {
                Menu {
                    ForEach(agents) { agent in
                        Button(agent.name) { chosenWorkspace = agent.id }
                    }
                } label: {
                    Text(workspace.name)
                        .font(.orbitLabel)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .overlay(Capsule().strokeBorder(Color.secondary.opacity(0.35)))
                }
            }
        }
        .padding(.vertical, 6)
    }
}

#endif

#if os(iOS)
/// Rename… on the phone (§8.4, board schedule-rename 01-board-2): the system alert with one field, the current name
/// in it and selected, Save off while it is empty or unchanged. As `SessionRenameAlert`, the draft is the caller's,
/// seeded in the action that presents the alert.
private struct ScheduleRenameAlert: ViewModifier {
    @Environment(AppModel.self) private var model
    @Binding var renaming: ScheduleView?
    @Binding var draft: String

    func body(content: Content) -> some View {
        content
            .alert(SC.RenameAlert.title,
                   isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } }),
                   presenting: renaming) { schedule in
                TextField(SC.History.fields["title"] ?? "", text: $draft)
                Button(SC.RenameAlert.cancel, role: .cancel) {}
                Button(SC.RenameAlert.save) {
                    guard let title = ScheduleDisplay.renameTitle(draft, from: schedule.title) else { return }
                    Task { @MainActor in await model.scheduled?.rename(schedule.id, title: title) }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(ScheduleDisplay.renameTitle(draft, from: schedule.title) == nil)
            } message: { _ in
                Text(SC.RenameAlert.body)
            }
            // SwiftUI has no way to select an alert field's text; UIKit says when it starts editing.
            .onReceive(NotificationCenter.default.publisher(for: UITextField.textDidBeginEditingNotification)) { note in
                guard renaming != nil, let field = note.object as? UITextField else { return }
                DispatchQueue.main.async { field.selectAll(nil) }
            }
    }
}

private extension View {
    func scheduleRenameAlert(_ renaming: Binding<ScheduleView?>, draft: Binding<String>) -> some View {
        modifier(ScheduleRenameAlert(renaming: renaming, draft: draft))
    }
}
#endif

// MARK: - The detail panel (board 01 ③, 02 ③)

/// A schedule's detail, from the bottom: what it does and was asked, notes for the next run, this month's use and
/// the history, with Run now, Pause and Change… (a conversation, not a form). Delete is behind ⋯ and asks first.
struct ScheduleDetailPanel: View {
    @Environment(AppModel.self) private var model
    let scheduleID: String
    @State private var confirmingDelete = false
    @State private var busy = false
    #if os(iOS)
    @State private var renaming: ScheduleView?
    @State private var renameDraft = ""
    #endif

    var body: some View {
        #if os(iOS)
        NavigationStack {
            Group {
                if let scheduled = model.scheduled, let s = scheduled.schedule(scheduleID) {
                    panel(scheduled, s, scheduled.detail(scheduleID))
                } else {
                    ProgressView()
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if model.scheduled?.inspectedFromChat == true {
                        // Opened from a change line in the chat's sheet: ‹ Chat goes back to the conversation (board 4 ③).
                        Button { model.backToScheduledChat() } label: {
                            HStack(spacing: 3) {
                                Image(systemName: "chevron.left").fontWeight(.semibold)
                                Text(ScheduledChatCopy.back)
                            }
                        }
                        .accessibilityIdentifier("schedule-back-to-chat")
                    } else {
                        Button("Close") { model.scheduled?.inspectedID = nil }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button {
                            guard let s = model.scheduled?.schedule(scheduleID) else { return }
                            renameDraft = s.title
                            renaming = s
                        } label: {
                            Label(SC.Actions.rename, systemImage: "pencil")
                        }
                        Divider()
                        Button(role: .destructive) { confirmingDelete = true } label: {
                            Label(SC.Actions.delete, systemImage: "trash")
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .accessibilityLabel("More")
                }
            }
            .navigationBarTitleDisplayMode(.inline)
        }
        .modifier(ScheduleDeleteQuestion(scheduleID: scheduleID, asking: $confirmingDelete))
        .scheduleRenameAlert($renaming, draft: $renameDraft)
        #else
        // The Mac's right-hand panel (web board 01 ②): no bar of its own — the doors carry ⋯ beside Change…, as
        // the web's inspector does, and the panel closes when another row or nothing is chosen.
        Group {
            if let scheduled = model.scheduled, let s = scheduled.schedule(scheduleID) {
                panel(scheduled, s, scheduled.detail(scheduleID))
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .modifier(ScheduleDeleteQuestion(scheduleID: scheduleID, asking: $confirmingDelete))
        #endif
    }
}

/// Delete asks first (web `SCHEDULE_COPY.deleteConfirm`), on both the phone's panel and the Mac's.
private struct ScheduleDeleteQuestion: ViewModifier {
    @Environment(AppModel.self) private var model
    let scheduleID: String
    @Binding var asking: Bool

    func body(content: Content) -> some View {
        content
        .task(id: scheduleID) { await model.scheduled?.loadDetail(scheduleID) }
        .orbitConfirmation(ScheduleDisplay.deleteTitle(model.scheduled?.schedule(scheduleID)?.title ?? ""),
                           isPresented: $asking) {
            Button(SC.DeleteConfirm.confirm, role: .destructive) {
                Task { @MainActor in await model.scheduled?.delete(scheduleID) }
            }
            Button(SC.DeleteConfirm.cancel, role: .cancel) {}
        } message: {
            Text(SC.DeleteConfirm.body)
        }
    }
}

extension ScheduleDetailPanel {
    private func panel(_ scheduled: ScheduledModel, _ s: ScheduleView, _ detail: ScheduleDetailResponse?) -> some View {
        let zone = scheduled.timezone
        let now = Date()
        let lastRun = detail?.lastRun ?? s.lastRun
        let lastFacts = lastRun.map { ScheduleDisplay.runFindingFacts($0, findings: detail?.findings ?? []) }
        let conditionID = s.rule.conditionId ?? s.condition?.id
        let condition = scheduled.condition(conditionID)
        // A WHEN rule has no time, so its zone says nothing.
        let meta = [ScheduleDisplay.ruleText(s.rule, form: .short), conditionID == nil ? s.timezone : nil, s.workspaceName,
                    ScheduleDisplay.accessCopy(s.accessLevel).label]
            .compactMap { $0 }.joined(separator: SC.separator)
        let next: String = s.nextDueAt.flatMap(ScheduleDisplay.parse)
            .map { ScheduleDisplay.whenText($0, now: now, timezone: zone) } ?? "—"
        var lastLine: String?
        if let lastRun {
            let at = ScheduleDisplay.parse(lastRun.startedAt ?? lastRun.plannedAt)
                .map { ScheduleDisplay.whenText($0, now: now, timezone: zone) } ?? ""
            let what = ScheduleDisplay.runLine(state: lastRun.state, summary: lastRun.summary,
                                               failureReason: lastRun.failureReason, reasonText: lastRun.reasonText,
                                               notified: lastFacts?.notified ?? false)
            lastLine = [SC.Inspector.last, at, what].joined(separator: SC.separator)
        }
        return ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 4) {
                    #if os(macOS)
                    if scheduled.renamingID.map(PublicID.storageKey) == PublicID.storageKey(s.id) {
                        ScheduleTitleField(
                            title: s.title,
                            save: { title in Task { @MainActor in await scheduled.rename(s.id, title: title) } },
                            done: {
                                // Another row's Rename… may already have taken it.
                                if scheduled.renamingID.map(PublicID.storageKey) == PublicID.storageKey(s.id) {
                                    scheduled.renamingID = nil
                                }
                            })
                    } else {
                        Text(s.title).font(.title2.weight(.bold))
                            .onTapGesture { scheduled.renamingID = s.id }
                            .help(SC.Actions.rename)
                    }
                    #else
                    Text(s.title).font(.title2.weight(.bold))
                    #endif
                    HStack(spacing: 4) {
                        if ScheduleDisplay.ruleRepeats(s.rule) { Text("↻") }
                        Text(meta)
                    }
                    .font(.orbitLabel).foregroundStyle(.secondary)
                }
                if let end = ScheduleDisplay.endText(s, now: now, timezone: zone) {
                    block {
                        Text(SC.End.endLabel + SC.separator + end).font(.orbitLabel).foregroundStyle(.secondary)
                            .accessibilityIdentifier("schedule-end-line")
                    }
                }
                if conditionID != nil {
                    // A WHEN rule (condition-triggers board ⑥ ② ③): how far the reading is from firing, and how it
                    // is checked, in place of the next run.
                    if let condition {
                        ConditionBlocksView(condition: condition, timezone: zone, now: now)
                    } else {
                        ProgressView().frame(maxWidth: .infinity)
                    }
                    if let lastLine {
                        Text(lastLine).font(.orbitLabel).foregroundStyle(.secondary).padding(.leading, 4)
                    }
                } else {
                    block {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(SC.Inspector.nextRun).font(.orbitLabel).foregroundStyle(.secondary)
                            Text(next).font(.title2.weight(.bold))
                            if let lastLine {
                                Text(lastLine).font(.orbitLabel).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                HStack(spacing: 10) {
                    doorButton(SC.Actions.runNow, prominent: true) { await scheduled.runNow(s.id) }
                    if s.state == "PAUSED" || s.state == "HELD" {
                        doorButton(SC.Actions.resume) { await scheduled.resume(s.id) }
                    } else {
                        doorButton(SC.Actions.pause) { await scheduled.pause(s.id) }
                    }
                    doorButton(SC.Actions.change) {
                        scheduled.inspectedID = nil
                        model.openChangeConversation(for: s)
                    }
                    #if os(macOS)
                    // The web inspector's ⋯ beside Change…: Rename…, and Delete, which asks first.
                    Menu {
                        Button(SC.Actions.rename) { scheduled.renamingID = s.id }
                        Divider()
                        Button(SC.Actions.delete, role: .destructive) { confirmingDelete = true }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .padding(.horizontal, 10).padding(.vertical, 9)
                    .background(Color.scheduleCardFill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Color.scheduleCardEdge))
                    .accessibilityLabel("More")
                    #endif
                }
                .disabled(busy)
                if let error = scheduled.errorText {
                    Text(error).font(.orbitLabel).foregroundStyle(.red)
                }
                section(SC.Inspector.whatWasAsked) {
                    Text(s.intent).font(.orbitSubtext)
                }
                if let note = s.note, !note.isEmpty {
                    section(SC.Inspector.notesForNextRun) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(note).font(.orbitSubtext)
                            if let lastRun, let at = ScheduleDisplay.parse(lastRun.plannedAt) {
                                Text(ScheduleDisplay.fill(SC.Inspector.leftByRunOf,
                                                          ["date": ScheduleDisplay.dateText(at, timezone: zone)]))
                                .font(.orbitLabel).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                section(SC.Inspector.thisMonth) {
                    VStack(alignment: .leading, spacing: 4) {
                        if let usage = detail?.usage {
                            Text(ScheduleDisplay.usageText(runs: usage.runs, minutes: usage.minutes)).font(.orbitSubtext)
                        }
                        Text(ScheduleDisplay.allowedText(runsPerWeek: s.envelope.runsPerWeek,
                                                         runLimitMinutes: s.envelope.runLimitMinutes))
                            .font(.orbitLabel).foregroundStyle(.secondary)
                    }
                }
                historySection(scheduled, s, detail, condition: condition, now: now, zone: zone)
            }
            .padding(16)
        }
        .task(id: conditionID) { if let conditionID { await scheduled.loadCondition(conditionID) } }
        .background(Color.schedulePanelFill)
        .accessibilityIdentifier("schedule-detail-panel")
    }

    private func doorButton(_ title: String, prominent: Bool = false, _ action: @escaping () async -> Void) -> some View {
        Button {
            busy = true
            Task { @MainActor in
                await action()
                busy = false
            }
        } label: {
            Text(title).font(.orbitControl.weight(.medium)).frame(maxWidth: .infinity).padding(.vertical, 9)
                .foregroundStyle(prominent ? Color.white : Color.accentColor)
                .background(prominent ? Color.accentColor : Color.scheduleCardFill,
                            in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(prominent ? Color.clear : Color.scheduleCardEdge))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("schedule-door-\(title)")
    }

    private func block<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(Color.scheduleCardFill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.scheduleCardEdge))
    }

    private func section<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased()).font(.orbitLabel).foregroundStyle(.secondary).padding(.leading, 4)
            block(content)
        }
    }

    private enum HistoryEntry: Identifiable {
        case run(ScheduleRunView)
        case record(ScheduleChangeRecord)
        /// A condition's line (board ⑥ ③): Fired, Ready again; a FIRED's run is drawn by its line, not twice.
        case event(ConditionEventView, ConditionDisplay.HistoryLine, index: Int)
        /// Consecutive MISSED slots, newest first, as one line (design §9.2).
        case missed([ScheduleRunView])
        var id: String {
            switch self {
            case .missed(let runs): return "missed-\(runs[0].id)"
            case .run(let r): return "run-\(r.id)"
            case .record(let r): return "rev-\(r.revision)"
            case .event(let e, _, let index): return "event-\(index)-\(e.at)"
            }
        }
        var at: String {
            switch self {
            case .missed(let runs): return runs[0].plannedAt
            case .run(let r): return r.startedAt ?? r.plannedAt
            case .record(let r): return r.createdAt
            case .event(let e, _, _): return e.at
            }
        }
    }

    private func historySection(_ scheduled: ScheduledModel, _ s: ScheduleView, _ detail: ScheduleDetailResponse?,
                                condition: ConditionView?, now: Date, zone: String) -> some View {
        let events: [HistoryEntry] = (condition?.events ?? []).enumerated().compactMap { index, e in
            condition.flatMap { ConditionDisplay.historyLine(e, condition: $0) }.map { HistoryEntry.event(e, $0, index: index) }
        }
        let firedRuns = Set((condition?.events ?? []).compactMap { $0.runId.map(PublicID.storageKey) })
        let runs = (detail?.recentRuns ?? []).filter { !firedRuns.contains(PublicID.storageKey($0.id)) }
        let sorted = (runs.map(HistoryEntry.run) + events + (detail?.history ?? []).map(HistoryEntry.record))
            .sorted { (ScheduleDisplay.parse($0.at) ?? .distantPast) > (ScheduleDisplay.parse($1.at) ?? .distantPast) }
        // Consecutive missed slots, with nothing else between them, read as one line.
        let entries = sorted.reduce(into: [HistoryEntry]()) { out, entry in
            guard case .run(let run) = entry, run.state == "MISSED" else { return out.append(entry) }
            switch out.last {
            case .missed(let streak)?: out[out.count - 1] = .missed(streak + [run])
            case .run(let last)? where last.state == "MISSED": out[out.count - 1] = .missed([last, run])
            default: out.append(entry)
            }
        }
        return section(SC.Inspector.history) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                    historyRow(entry, scheduled: scheduled, s: s, detail: detail, now: now, zone: zone)
                        .accessibilityIdentifier("schedule-history-row")
                        .padding(.top, index > 0 ? 16 : 0)
                        .overlay(alignment: .top) { Divider().padding(.top, 8).opacity(index > 0 ? 1 : 0) }
                }
            }
        }
    }

    @ViewBuilder
    private func historyRow(_ entry: HistoryEntry, scheduled: ScheduledModel, s: ScheduleView,
                            detail: ScheduleDetailResponse?, now: Date, zone: String) -> some View {
        let when = ScheduleDisplay.parse(entry.at).map { ScheduleDisplay.whenText($0, now: now, timezone: zone) } ?? ""
        switch entry {
        case .missed(let runs):
            VStack(alignment: .leading, spacing: 2) {
                Text(when).font(.orbitSubtext)
                Text(ScheduleDisplay.missedText(runs, timezone: zone)).font(.orbitLabel).foregroundStyle(.secondary)
            }
            .accessibilityIdentifier("schedule-history-missed")
        case .event(let event, let line, _):
            let run = line.runId.flatMap { id in
                detail?.recentRuns.first { PublicID.storageKey($0.id) == PublicID.storageKey(id) }
            }
            let at = ScheduleDisplay.parse(event.at).map {
                "\(ScheduleDisplay.dateText($0, timezone: zone)) \(ScheduleDisplay.localParts($0, timezone: zone).time)"
            } ?? ""
            let sub = [at, run.map { ScheduleDisplay.capitalizedRunOf(plannedAt: $0.plannedAt, timezone: zone) }]
                .compactMap { $0 }.joined(separator: SC.separator)
            Button {
                if let session = run?.sessionId {
                    model.openScheduleRun(sessionID: session)
                }
            } label: {
                HStack(alignment: .center, spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(line.text).font(.orbitSubtext)
                        Text(sub).font(.orbitLabel).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 6)
                    if line.runId != nil {
                        Text(line.chip).font(.orbitMeta.weight(.medium)).foregroundStyle(Color.accentColor)
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(Color.accentColor.opacity(0.12), in: Capsule())
                    } else {
                        chip(line.chip, tone: .mute)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(run?.sessionId == nil)
        case .run(let run):
            let facts = ScheduleDisplay.runFindingFacts(run, findings: detail?.findings ?? [])
            let view = ScheduleDisplay.runCircle(state: run.state, newFinding: facts.newFinding)
            let late = run.startedAt.flatMap(ScheduleDisplay.parse).map { started in
                ScheduleDisplay.parse(run.plannedAt).map { started.timeIntervalSince($0) > 15 * 60 } ?? false
            } ?? false
            Button {
                if let session = run.sessionId {
                    model.openScheduleRun(sessionID: session)
                }
            } label: {
                HStack(alignment: .center, spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(when + (late ? "\(SC.separator)\(SC.Inspector.late)" : "")).font(.orbitSubtext)
                        Text(ScheduleDisplay.runLine(state: run.state, summary: run.summary,
                                                     failureReason: run.failureReason, reasonText: run.reasonText,
                                                     notified: facts.notified))
                            .font(.orbitLabel).foregroundStyle(.secondary).lineLimit(2)
                    }
                    Spacer(minLength: 6)
                    if let tag = view.tag { chip(tag.text, tone: tag.tone) }
                    if run.sessionId != nil {
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(run.sessionId == nil)
        case .record(let record):
            let who = ScheduleDisplay.historyWho(changedBy: record.changedBy, before: record.before, after: record.after)
            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(ScheduleDisplay.renamedText(record) ?? ScheduleDisplay.recordText(record)).font(.orbitSubtext)
                    if let asked = record.askedText {
                        // Asked in the schedule's change conversation (§8.2): the person's words, and the way back.
                        HStack(spacing: 0) {
                            Text("“\(asked)”")
                            if let sessionID = record.sessionId {
                                Text(SC.separator)
                                Button(SC.ChangeConversation.conversation) {
                                    model.route(to: .session(sessionID))
                                }
                                .buttonStyle(.plain)
                                .foregroundStyle(Color.accentColor)
                            }
                        }
                        .font(.orbitLabel).foregroundStyle(.secondary)
                        .accessibilityIdentifier("schedule-history-asked")
                    }
                    Text(when).font(.orbitLabel).foregroundStyle(.secondary)
                }
                Spacer(minLength: 6)
                chip(who.text, tone: who.who == "USER" || who.who == "ALLOWED" ? .new : .mute)
                if ScheduleDisplay.recordUndoable(record) {
                    Button(SC.Actions.undo) {
                        Task { @MainActor in await scheduled.undo(s.id, revision: record.revision) }
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.accentColor)
                }
            }
        }
    }

    private func chip(_ text: String, tone: ScheduleDisplay.TagTone) -> some View {
        Text(text)
            .font(.orbitMeta.weight(.medium))
            .foregroundStyle(tone == .mute ? Color.secondary : tone.color)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background((tone == .mute ? Color.secondary : tone.color).opacity(0.12), in: Capsule())
    }
}

// MARK: - The draft panel (board 01 ⑧ ②)

/// What one sentence on the quick-add line became: "You typed: …", the create card its agent drafted (Create is
/// all there is to it), and the conversation to talk it over in.
struct ScheduleDraftPanel: View {
    @Environment(AppModel.self) private var model
    let panel: ScheduledModel.DraftPanel

    var body: some View {
        let scheduled = model.scheduled
        let card = scheduled?.draft(forSession: panel.sessionID)
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let card {
                    if let workspace = card.runsIn?.workspaceName {
                        Text(ScheduleDisplay.fill(SC.Inspector.draftMeta, ["workspace": workspace]))
                            .font(.orbitLabel).foregroundStyle(.secondary)
                    }
                    Text("“\(card.intent ?? panel.typed)”").font(.orbitSubtext).foregroundStyle(.secondary)
                    ScheduleCreateCardView(card: card, decide: { allow in
                        guard let scheduled else { return .refused(ScheduledModel.unreachable) }
                        let result = allow ? await scheduled.allow(card) : await scheduled.decline(card)
                        if result == .done { scheduled.draftPanel = nil }
                        return result
                    })
                } else {
                    Text("“\(panel.typed)”").font(.orbitSubtext).foregroundStyle(.secondary)
                    ProgressView().frame(maxWidth: .infinity)
                }
                Button(SC.Actions.openConversation) {
                    scheduled?.draftPanel = nil
                    model.route(to: .session(panel.sessionID))
                }
                .frame(maxWidth: .infinity)
                .foregroundStyle(Color.accentColor)
            }
            .padding(16)
        }
        .task(id: panel.sessionID) {
            // The agent drafts the card in its conversation; read until it is there.
            while !Task.isCancelled, scheduled?.draft(forSession: panel.sessionID) == nil {
                await scheduled?.load()
                await VisibilityGate.app.pause(3)   // not while the app cannot be seen (§4 R3)
            }
        }
        .accessibilityIdentifier("schedule-draft-panel")
    }
}
