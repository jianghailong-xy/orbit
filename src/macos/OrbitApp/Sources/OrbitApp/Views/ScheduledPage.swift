#if os(iOS)
import SwiftUI
import OrbitKit

// The Scheduled page on a phone (docs/mocks/scheduled-tasks/01-board.png ② ③ ⑧, 02-agent-first.png ③): a timeline
// in the manner of Reminders' Scheduled list — grouped by the day each schedule next runs, the circle its state — a
// detail panel from the bottom for a row, and a line at the end that takes one sentence. The page is the web's
// (`ScheduledPage.tsx`) in behaviour; every word and rule is OrbitKit's.

private typealias SC = ScheduleCopy

/// A row's state as a circle (board 01 ② 2): open is to come, the blue arc runs, a grey tick did nothing new, a
/// green tick found something, red failed, amber is held, dashed is a draft, faint is paused.
struct ScheduleCircleGlyph: View {
    let view: ScheduleDisplay.CircleView
    var size: CGFloat = 22

    var body: some View {
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
            if let mark = view.mark {
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

private extension ScheduleDisplay.TagTone {
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
private func scheduleClock(_ iso: String?) -> String {
    guard let iso, let at = ScheduleDisplay.parse(iso) else { return "" }
    return ScheduleDisplay.localParts(at, timezone: TimeZone.current.identifier).time
}

/// One row of the timeline.
private struct ScheduleRowModel: Identifiable {
    let id: String
    let circle: ScheduleDisplay.CircleView
    let title: String
    let line: String
    let repeats: Bool
    let time: String
    let draft: Bool
    let paused: Bool
    let open: () -> Void
}

struct ScheduledPage: View {
    @Environment(AppModel.self) private var model
    @State private var typed = ""
    @State private var asking = false
    @State private var chosenWorkspace: String?
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
                case .group(let group):
                    groupHeader(group).listRowSeparator(.hidden)
                case .item(let item):
                    rowView(item)
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
        .toolbar {
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
            for s in scheduled.schedules { await scheduled.loadDetail(s.id) }
        }
        .sheet(isPresented: Binding(get: { scheduled.inspectedID != nil },
                                    set: { if !$0 { scheduled.inspectedID = nil } })) {
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
    }

    /// The page's rows, in order: the head, then the empty page's lead and examples, or each group's header and
    /// rows; the line at the end; a refusal under it.
    private enum PageRow: Identifiable {
        case header
        case lead
        case example(String)
        case group(ScheduleDisplay.TimelineGroup)
        case item(ScheduleRowModel)
        case quickAdd
        case error(String)

        var id: String {
            switch self {
            case .header: return "header"
            case .lead: return "lead"
            case .example(let text): return "example-\(text)"
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
        let empty = scheduled.loaded && scheduled.shownSchedules.isEmpty && scheduled.drafts.isEmpty
            && scheduled.workspaceFilter == nil
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
                Text("\(scheduled.shownSchedules.count)")
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

    /// "Today  Fri, Nov 14"; Needs you in red (board 01 ② 1).
    private func groupHeader(_ group: ScheduleDisplay.TimelineGroup) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(group.title)
                .font(.title3.weight(.bold))
                .foregroundStyle(group.key == .needsYou ? Color.red : group.key == .paused ? Color.secondary : Color.primary)
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
        group.items.map { item -> ScheduleRowModel in
            switch item {
            case .draft(let card, let at):
                let rule = card.when?.rule ?? .daily(time: "")
                return ScheduleRowModel(
                    id: "\(group.id)-\(item.id)",
                    circle: ScheduleDisplay.scheduleCircle(state: "ACTIVE", consecutiveFailures: 0, draft: true),
                    title: card.title ?? "",
                    line: ScheduleDisplay.rowLine(rule: rule, workspaceName: card.runsIn?.workspaceName,
                                                  accessLevel: card.may?.accessLevel ?? "CHECK_ONLY", state: "ACTIVE",
                                                  heldReason: nil, draft: true),
                    repeats: ScheduleDisplay.ruleRepeats(rule), time: scheduleClock(at), draft: true, paused: false,
                    open: {
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
                return ScheduleRowModel(
                    id: "\(group.id)-\(item.id)",
                    circle: ScheduleDisplay.runCircle(state: run.state, newFinding: facts.newFinding),
                    title: s.title,
                    line: underWay
                        ? ScheduleDisplay.rowLine(rule: s.rule, workspaceName: s.workspaceName, accessLevel: s.accessLevel,
                                                  state: s.state, heldReason: s.heldReason, runningMinutes: minutes)
                        : ScheduleDisplay.runLine(state: run.state, summary: run.summary, failureReason: run.failureReason,
                                                  reasonText: run.reasonText, notified: facts.notified),
                    repeats: underWay && ScheduleDisplay.ruleRepeats(s.rule), time: scheduleClock(run.plannedAt),
                    draft: false, paused: false,
                    open: { scheduled.inspectedID = s.id })
            case .schedule(let s, let at):
                let inNeeds = group.key == .needsYou
                let inPaused = group.key == .paused
                let failing = inNeeds && s.state == "ACTIVE" && s.lastRun != nil
                let time: String
                if failing, let last = s.lastRun?.plannedAt { time = scheduleClock(last) }
                else if let at, !inNeeds && !inPaused { time = scheduleClock(at) }
                else { time = "" }
                return ScheduleRowModel(
                    id: "\(group.id)-\(item.id)",
                    circle: inNeeds || inPaused ? ScheduleDisplay.scheduleCircle(s) : .init(.open),
                    title: s.title,
                    line: ScheduleDisplay.rowLine(rule: s.rule, workspaceName: s.workspaceName, accessLevel: s.accessLevel,
                                                  state: s.state, heldReason: s.heldReason,
                                                  pausedAt: pausedAt(scheduled.detail(s.id)),
                                                  timezone: scheduled.timezone),
                    repeats: ScheduleDisplay.ruleRepeats(s.rule), time: time, draft: false, paused: inPaused,
                    open: { scheduled.inspectedID = s.id })
            }
        }
    }

    /// When a schedule was paused: its newest revision that paused it.
    private func pausedAt(_ detail: ScheduleDetailResponse?) -> Date? {
        detail?.history.first { $0.after["state"]?.stringValue == "PAUSED" }.flatMap { ScheduleDisplay.parse($0.createdAt) }
    }

    private func rowView(_ row: ScheduleRowModel) -> some View {
        Button(action: row.open) {
            HStack(alignment: .top, spacing: 12) {
                ScheduleCircleGlyph(view: row.circle).padding(.top, 1)
                VStack(alignment: .leading, spacing: 3) {
                    Text(row.title)
                        .font(.orbitControl)
                        .italic(row.draft)
                        .foregroundStyle(row.draft || row.paused ? .secondary : .primary)
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        if row.repeats { Text("↻").accessibilityHidden(true) }
                        Text(row.line)
                    }
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                }
                Spacer(minLength: 8)
                HStack(spacing: 8) {
                    if let tag = row.circle.tag, row.circle.circle != .done, row.circle.circle != .muted {
                        Text(tag.text).font(.orbitLabel.weight(.semibold)).foregroundStyle(tag.tone.color)
                    }
                    if !row.time.isEmpty {
                        Text(row.time).font(.orbitLabel).foregroundStyle(.secondary).monospacedDigit()
                    }
                }
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("schedule-row")
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

// MARK: - The detail panel (board 01 ③, 02 ③)

/// A schedule's detail, from the bottom: what it does and was asked, notes for the next run, this month's use and
/// the history, with Run now, Pause and Change… (a conversation, not a form). Delete is behind ⋯ and asks first.
struct ScheduleDetailPanel: View {
    @Environment(AppModel.self) private var model
    let scheduleID: String
    @State private var confirmingDelete = false
    @State private var busy = false

    var body: some View {
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
                    Button("Close") { model.scheduled?.inspectedID = nil }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button(SC.Actions.delete, role: .destructive) { confirmingDelete = true }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .accessibilityLabel("More")
                }
            }
            .navigationBarTitleDisplayMode(.inline)
        }
        .task { await model.scheduled?.loadDetail(scheduleID) }
        .orbitConfirmation(SC.Actions.delete, isPresented: $confirmingDelete) {
            Button(SC.Actions.delete, role: .destructive) {
                Task { @MainActor in await model.scheduled?.delete(scheduleID) }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    private func panel(_ scheduled: ScheduledModel, _ s: ScheduleView, _ detail: ScheduleDetailResponse?) -> some View {
        let zone = scheduled.timezone
        let now = Date()
        let lastRun = detail?.lastRun ?? s.lastRun
        let lastFacts = lastRun.map { ScheduleDisplay.runFindingFacts($0, findings: detail?.findings ?? []) }
        let meta = [ScheduleDisplay.ruleText(s.rule, form: .short), s.timezone, s.workspaceName,
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
                    Text(s.title).font(.title2.weight(.bold))
                    HStack(spacing: 4) {
                        if ScheduleDisplay.ruleRepeats(s.rule) { Text("↻") }
                        Text(meta)
                    }
                    .font(.orbitLabel).foregroundStyle(.secondary)
                }
                block {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(SC.Inspector.nextRun).font(.orbitLabel).foregroundStyle(.secondary)
                        Text(next).font(.title2.weight(.bold))
                        if let lastLine {
                            Text(lastLine).font(.orbitLabel).foregroundStyle(.secondary)
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
                historySection(scheduled, s, detail, now: now, zone: zone)
            }
            .padding(16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
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
                .background(prominent ? Color.accentColor : Color(uiColor: .secondarySystemGroupedBackground),
                            in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("schedule-door-\(title)")
    }

    private func block<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(Color(uiColor: .secondarySystemGroupedBackground),
                        in: RoundedRectangle(cornerRadius: 12, style: .continuous))
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
        var id: String {
            switch self {
            case .run(let r): return "run-\(r.id)"
            case .record(let r): return "rev-\(r.revision)"
            }
        }
        var at: String {
            switch self {
            case .run(let r): return r.startedAt ?? r.plannedAt
            case .record(let r): return r.createdAt
            }
        }
    }

    private func historySection(_ scheduled: ScheduledModel, _ s: ScheduleView, _ detail: ScheduleDetailResponse?,
                                now: Date, zone: String) -> some View {
        let entries = ((detail?.recentRuns ?? []).map(HistoryEntry.run) + (detail?.history ?? []).map(HistoryEntry.record))
            .sorted { (ScheduleDisplay.parse($0.at) ?? .distantPast) > (ScheduleDisplay.parse($1.at) ?? .distantPast) }
        return section(SC.Inspector.history) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                    historyRow(entry, scheduled: scheduled, s: s, detail: detail, now: now, zone: zone)
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
        case .run(let run):
            let facts = ScheduleDisplay.runFindingFacts(run, findings: detail?.findings ?? [])
            let view = ScheduleDisplay.runCircle(state: run.state, newFinding: facts.newFinding)
            let late = run.startedAt.flatMap(ScheduleDisplay.parse).map { started in
                ScheduleDisplay.parse(run.plannedAt).map { started.timeIntervalSince($0) > 15 * 60 } ?? false
            } ?? false
            Button {
                if let session = run.sessionId {
                    scheduled.inspectedID = nil
                    model.openScheduleRun(sessionID: session, scheduleID: s.id)
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
                    Text(ScheduleDisplay.recordText(record)).font(.orbitSubtext)
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
                    model.openScheduleRun(sessionID: panel.sessionID, scheduleID: nil)
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
                try? await Task.sleep(nanoseconds: 3_000_000_000)
            }
        }
        .accessibilityIdentifier("schedule-draft-panel")
    }
}
#endif
