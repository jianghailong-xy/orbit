#if os(macOS)
import SwiftUI
import OrbitKit

// The Scheduled section on the Mac (docs/mocks/scheduled-tasks/web/01-board.png, 02-board.png ⑤): the Mac follows the
// WEB board, not the phone's. The session column holds the timeline — "Scheduled 7", the workspace filter and Show
// past runs, the groups with the web's long row line, and the line at the end — and the detail column is the
// right-hand panel: a row's detail or a draft's create card. Every rule and word is OrbitKit's
// (ScheduleDisplay, ScheduleCopy); the rows, detail panel, draft panel
// and cards are I1's views, shared with the phone (ScheduledPage.swift, ScheduleCards.swift).

private typealias SC = ScheduleCopy

/// The timeline column (web board 01 ① ② ③ ⑤).
struct ScheduledMacPage: View {
    @Environment(AppModel.self) private var model
    @State private var typed = ""
    @State private var asking = false
    @AppStorage("scheduled.quickAddWorkspace") private var chosenWorkspace = ""
    /// The schedule a row's right-click asked to delete, and the run it asked to stop, while the question is up.
    @State private var deleting: ScheduleView?
    @State private var stopping: ScheduleRunView?

    var body: some View {
        Group {
            if let scheduled = model.scheduled {
                content(scheduled)
            }
        }
        .navigationTitle(SC.Page.title)
        // The chat's button at the toolbar's end (board scheduled-chat 01 ①, 4): a third column beside the panel.
        .toolbar {
            ToolbarItem(placement: .primaryAction) { ScheduledChatButton() }
        }
    }

    private func content(_ scheduled: ScheduledModel) -> some View {
        let now = Date()
        let groups = scheduled.timeline(now: now)
        let empty = scheduled.loaded && scheduled.shownSchedules.isEmpty && scheduled.drafts.isEmpty
            && scheduled.shownWaitingTasks.isEmpty && scheduled.workspaceFilter == nil
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                header(scheduled)
                // A condition's items and a scheduled task's, whole, under the head: each answers at its own door. There is
                // no Waiting on you sheet (docs/mocks/waiting-on-you-removal; the owner, 2026-11-16).
                ForEach(model.ownerRequests?.conditionItems ?? []) { item in
                    ConditionWaitingCardView(item: item).padding(.vertical, 6)
                }
                ForEach(model.ownerRequests?.scheduleItems ?? []) { item in
                    ScheduleWaitingCardView(item: item).padding(.vertical, 6)
                }
                if empty {
                    // Empty (board ⑤): the lead, the line, and three examples a click puts on the line.
                    Text(SC.Empty.lead)
                        .font(.orbitSubtext).foregroundStyle(.secondary)
                        .padding(.top, 10).padding(.bottom, 14)
                    quickAdd(scheduled)
                    ForEach(SC.Empty.examples, id: \.self) { example in
                        Button { typed = example } label: {
                            Text("“\(example)”").font(.orbitSubtext).foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.vertical, 7)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        Divider()
                    }
                } else {
                    tools(scheduled)
                    ForEach(groups) { group in
                        groupHeader(group)
                        ForEach(ScheduleTimelineRows.rows(group, scheduled: scheduled, now: now, wide: true,
                                                          openTask: { id in model.route(to: .task(id)) })) { row in
                            rowView(row, scheduled, selected: row.scheduleID.map {
                                PublicID.storageKey($0) == scheduled.inspectedID.map(PublicID.storageKey)
                            } ?? false)
                        }
                    }
                    quickAdd(scheduled).padding(.top, 18)
                }
                if let error = scheduled.errorText {
                    Text(error).font(.orbitLabel).foregroundStyle(.red).padding(.top, 6)
                }
            }
            .padding(.horizontal, 24)
            .padding(.top, 14)
            .padding(.bottom, 28)
        }
        .task {
            await scheduled.load()
            // A server that sends the window's runs with the list needs no other read to draw the page.
            if scheduled.listRuns == nil {
                for s in scheduled.schedules { await scheduled.loadDetail(s.id) }
            }
        }
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
        .accessibilityIdentifier("scheduled-mac-page")
    }

    /// "Scheduled" in the boards' blue and the count at the right (Reminders' head).
    private func header(_ scheduled: ScheduledModel) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(SC.Page.title)
                .font(.largeTitle.weight(.bold))
                .foregroundStyle(Color.accentColor)
            Spacer()
            Text("\(scheduled.shownSchedules.count + scheduled.shownWaitingTasks.count)")
                .font(.largeTitle.weight(.regular))
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("scheduled-count")
        }
    }

    /// The workspace filter on the left, Show past runs on the right (web board ① ④).
    private func tools(_ scheduled: ScheduledModel) -> some View {
        @Bindable var scheduled = scheduled
        let label = scheduled.workspaceFilter.flatMap { id in scheduled.workspaces.first { $0.id == id }?.name }
            ?? SC.Page.allWorkspaces
        return HStack {
            Menu {
                Button(SC.Page.allWorkspaces) { scheduled.workspaceFilter = nil }
                ForEach(scheduled.workspaces, id: \.id) { w in
                    Button(w.name) { scheduled.workspaceFilter = w.id }
                }
            } label: {
                Text("\(label) ▾").font(.orbitLabel)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .padding(.horizontal, 8).padding(.vertical, 3)
            .overlay(Capsule().strokeBorder(Color.secondary.opacity(0.35)))
            .accessibilityIdentifier("scheduled-filter")
            Spacer()
            Toggle(SC.Page.showPastRuns, isOn: $scheduled.showPastRuns)
                .toggleStyle(.switch)
                .controlSize(.mini)
                .font(.orbitLabel)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("scheduled-show-past-runs")
        }
        .padding(.top, 6)
    }

    /// "Today  Fri, Nov 14"; Paused grey (web board ① 2–3).
    private func groupHeader(_ group: ScheduleDisplay.TimelineGroup) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(group.title)
                .font(.title3.weight(.bold))
                .foregroundStyle(group.key == .paused ? Color.secondary : Color.primary)
            if let subtitle = group.subtitle {
                Text(subtitle).font(.orbitSubtext).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.top, 20).padding(.bottom, 6)
    }

    /// One row: the state circle, the title with its tag and time at the end, and the long line under it. The row a
    /// panel is open for is tinted, as the web's selected row.
    private func rowView(_ row: ScheduleRowModel, _ scheduled: ScheduledModel, selected: Bool) -> some View {
        // The phone's long-press menu on a right-click (ScheduleRowActions); the Mac has no row swipes.
        let actions = ScheduleRowActions(row.kind, model: model, scheduled: scheduled,
                                         askRename: { s in
                                             // The schedule's detail opens, its title already a field.
                                             scheduled.draftPanel = nil
                                             scheduled.changeDraft = nil
                                             scheduled.inspectedID = s.id
                                             scheduled.renamingID = s.id
                                         },
                                         askDelete: { deleting = $0 }, askStop: { stopping = $0 },
                                         openTask: { id in model.route(to: .task(id)) })
        return Button(action: row.open) {
            HStack(alignment: .top, spacing: 10) {
                ScheduleCircleGlyph(view: row.circle, size: 18).padding(.top, 1)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(row.title)
                            .font(.orbitControl)
                            .italic(row.draft)
                            .foregroundStyle(row.draft || row.paused ? .secondary : .primary)
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        if let tag = row.circle.tag, row.circle.circle != .done, row.circle.circle != .muted {
                            Text(tag.text).font(.orbitMeta.weight(.semibold)).foregroundStyle(tag.tone.color)
                                .fixedSize()
                        }
                        if let reading = row.reading {
                            // A condition's row (condition-triggers board ④ ②): "6.9% · 1 min ago" where a timed row
                            // has its time, how far from firing and whether the probe is still alive.
                            (Text(reading.value).font(.orbitLabel.weight(.semibold)).foregroundColor(.primary)
                             + Text(reading.age.map { "\(SC.separator)\($0)" } ?? "").font(.orbitLabel)
                                .foregroundColor(.secondary))
                                .monospacedDigit()
                                .fixedSize()
                                .accessibilityIdentifier("schedule-row-reading")
                        } else if !row.time.isEmpty {
                            Text(row.time).font(.orbitLabel).foregroundStyle(.secondary).monospacedDigit()
                                .fixedSize()
                        }
                    }
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        if row.repeats { Text("↻").accessibilityHidden(true) }
                        Text(row.line).truncationMode(.tail)
                    }
                    .font(.orbitLabel)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    // The planned end on its own line, so the 400 pt column never cuts it off.
                    if let end = row.end {
                        Text(end).font(.orbitLabel).foregroundStyle(.secondary).accessibilityIdentifier("schedule-row-end")
                    }
                }
            }
            .padding(.vertical, 7).padding(.horizontal, 8)
            .background(selected ? Color.accentColor.opacity(0.12) : Color.clear,
                        in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(alignment: .bottom) {
                Rectangle().fill(Color.secondary.opacity(0.18)).frame(height: 0.5)
                    .padding(.leading, 36).opacity(selected ? 0 : 1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, -8)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("schedule-row")
        .contextMenu { actions.menuContent }
    }

    /// The line at the end (web board ③): one sentence and the workspace it goes to, ↵ asks. Not a form: an agent sets
    /// the schedule up from it in an ordinary conversation, and its card comes back here as a draft.
    private func quickAdd(_ scheduled: ScheduledModel) -> some View {
        let agents = model.orderedAgents
        let workspace = agents.first { $0.id == chosenWorkspace }
            ?? agents.first { $0.id == scheduled.workspaceFilter } ?? agents.first
        return HStack(spacing: 10) {
            Image(systemName: "plus.circle.fill")
                .font(.title3)
                .foregroundStyle(Color.accentColor)
            TextField(SC.QuickAdd.placeholder, text: $typed)
                .textFieldStyle(.plain)
                .font(.orbitControl)
                .disabled(asking)
                .onSubmit {
                    let sentence = typed.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !sentence.isEmpty, let workspace else { return }
                    asking = true
                    Task { @MainActor in
                        if await scheduled.ask(sentence, workspaceID: workspace.id) {
                            typed = ""
                            chosenWorkspace = workspace.id
                            scheduled.inspectedID = nil
                        }
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
                    Text("\(workspace.name) ▾").font(.orbitLabel)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .padding(.horizontal, 8).padding(.vertical, 3)
                .overlay(Capsule().strokeBorder(Color.secondary.opacity(0.35)))
                .accessibilityIdentifier("schedule-quick-add-workspace")
            }
            if !typed.isEmpty {
                Text(SC.QuickAdd.hint).font(.orbitMeta).foregroundStyle(.secondary).fixedSize()
            }
        }
        .padding(.vertical, 8)
        .overlay(alignment: .bottom) {
            Rectangle().fill(typed.isEmpty ? Color.secondary.opacity(0.25) : Color.accentColor).frame(height: 1)
        }
    }
}

/// The detail panel's title while it is renamed (§8.4, board schedule-rename ②): a field in place. Return or
/// leaving it saves the trimmed text; Esc, an empty field or unchanged text saves nothing.
struct ScheduleTitleField: View {
    let title: String
    let save: (String) -> Void
    let done: () -> Void

    @State private var draft: String
    /// The name the field opened with: left as it was, it saves nothing even if renamed elsewhere meanwhile.
    @State private var opened: String
    @State private var finished = false
    @FocusState private var focused: Bool

    init(title: String, save: @escaping (String) -> Void, done: @escaping () -> Void) {
        self.title = title
        self.save = save
        self.done = done
        _draft = State(initialValue: title)
        _opened = State(initialValue: title)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            TextField(SC.History.fields["title"] ?? "", text: $draft)
                .textFieldStyle(.plain)
                .font(.title2.weight(.bold))
                .padding(.horizontal, 6).padding(.vertical, 3)
                .background(Color.scheduleCardFill, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Color.accentColor, lineWidth: 2))
                .focused($focused)
                .onSubmit { finish(saving: true) }
                .onExitCommand { finish(saving: false) }
                .onChange(of: draft) { _, text in
                    if text.count > 200 { draft = String(text.prefix(200)) }
                }
                .accessibilityIdentifier("schedule-title-field")
            Text(SessionFolderCopy.editHint).font(.orbitMeta).foregroundStyle(.secondary)
        }
        // On the next turn of the run loop, after a menu that asked for the field has given focus back.
        .onAppear { DispatchQueue.main.async { focused = true } }
        .onChange(of: focused) { was, now in
            if was && !now { finish(saving: true) }
        }
        // A click on another row keeps this field focused until the panel goes.
        .onDisappear { finish(saving: true) }
    }

    private func finish(saving: Bool) {
        guard !finished else { return }
        finished = true
        if saving, let renamed = ScheduleDisplay.renameTitle(draft, from: opened) { save(renamed) }
        done()
    }
}

/// The detail column beside the timeline shows a schedule's detail or a draft's create card.
struct ScheduledMacDetail: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let scheduled = model.scheduled, let draft = scheduled.changeDraft {
            // The draft change conversation (board 03-change ③): the Mac draws it in this panel, as the web does.
            ScheduleChangePage(scheduleID: draft.scheduleID)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .id(draft.scheduleID)
        } else if let scheduled = model.scheduled, let id = scheduled.inspectedID {
            ScheduleDetailPanel(scheduleID: id)
                .id(id)
        } else if let scheduled = model.scheduled, let panel = scheduled.draftPanel {
            ScheduleDraftPanel(panel: panel)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .background(Color.schedulePanelFill)
                .id(panel.sessionID)
        } else {
            ContentUnavailableView(SC.Page.title, systemImage: AppSection.scheduled.systemImage,
                                   description: Text("Select a scheduled task to see its details."))
        }
    }
}
#endif
