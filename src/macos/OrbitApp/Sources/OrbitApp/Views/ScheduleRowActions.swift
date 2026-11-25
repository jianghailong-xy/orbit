import SwiftUI
import OrbitKit

/// What a Scheduled row stands for, so its swipes and long-press menu know what they act on.
enum ScheduleRowKind {
    case schedule(ScheduleView)
    case run(ScheduleView, ScheduleRunView)
    case draft(ScheduleCard)
    case task(String)
}

/// A Scheduled row's actions, by kind (docs/mocks/scheduled-swipe-ios), described once so the phone's swipes and
/// every platform's long-press / right-click menu are drawn from the same lists:
///   • leading (swipe right): the positive actions. Only a schedule's Pause / Resume fires on a full swipe: it is
///     recorded and undoable, where an accidental Run now would really run and spend a run of the week.
///   • trailing (swipe left): Delete outermost, red, asking first, never on a full swipe; then Change….
///     A run's row offers Stop while it is under way, never Delete — that would delete the whole schedule.
///   • menu: everything, in groups, the destructive one last.
@MainActor
struct ScheduleRowActions {
    /// From the screen edge inward; the first is what a full swipe performs.
    var leading: [RowSwipeAction] = []
    var trailing: [RowSwipeAction] = []
    var leadingFullSwipe = false
    /// The long-press menu's groups, a divider between each.
    var menu: [[RowSwipeAction]] = []

    private typealias SC = ScheduleCopy

    init(_ kind: ScheduleRowKind, model: AppModel, scheduled: ScheduledModel,
         askRename: @escaping (ScheduleView) -> Void,
         askDelete: @escaping (ScheduleView) -> Void, askStop: @escaping (ScheduleRunView) -> Void,
         openTask: @escaping (String) -> Void) {
        switch kind {
        case .schedule(let s):
            let held = s.state == "HELD"
            let toggle = s.state == "PAUSED" || held
                ? RowSwipeAction(title: SC.Actions.resume, systemImage: "play.fill", tint: .green) {
                    Task { await scheduled.resume(s.id) }
                }
                : RowSwipeAction(title: SC.Actions.pause, systemImage: "pause.fill", tint: .orange) {
                    Task { await scheduled.pause(s.id) }
                }
            // A held schedule's Run now is refused until it is resumed (SCHEDULE_HELD).
            let runNow: RowSwipeAction? = held ? nil
                : RowSwipeAction(title: SC.Actions.runNow, systemImage: "bolt.fill", tint: .blue) {
                    Task { await scheduled.runNow(s.id) }
                }
            let change = RowSwipeAction(title: SC.Actions.change, systemImage: "bubble.left.fill", tint: .indigo) {
                scheduled.inspectedID = nil
                model.openChangeConversation(for: s)
            }
            // In the long-press / right-click menu only: the swipes stay Pause / Resume and Delete / Change….
            let rename = RowSwipeAction(title: SC.Actions.rename, systemImage: "pencil", tint: .gray) {
                askRename(s)
            }
            let delete = Self.delete { askDelete(s) }
            let lastSession = (scheduled.detail(s.id)?.lastRun ?? s.lastRun)?.sessionId
            let openLastRun = lastSession.map { session in
                RowSwipeAction(title: SC.Actions.openLastRun, systemImage: "arrow.up.right", tint: .blue) {
                    model.openScheduleRun(sessionID: session)
                }
            }
            leading = [toggle] + [runNow].compactMap { $0 }
            leadingFullSwipe = true
            trailing = [delete, change]
            menu = [[runNow, toggle, rename, change, openLastRun].compactMap { $0 }, [delete]]
        case .run(let s, let run):
            let underWay = ["QUEUED", "RUNNING", "AWAITING_APPROVAL"].contains(run.state)
            let openRun = run.sessionId.map { session in
                RowSwipeAction(title: SC.Actions.openRun, systemImage: "arrow.up.right", tint: .blue) {
                    model.openScheduleRun(sessionID: session)
                }
            }
            let openSchedule = RowSwipeAction(title: SC.Actions.openSchedule, systemImage: "calendar", tint: .blue) {
                model.openSchedule(s.id)
            }
            let stop: RowSwipeAction? = underWay
                ? RowSwipeAction(title: SC.Actions.stop, systemImage: "stop.fill", tint: .red, role: .destructive) {
                    askStop(run)
                }
                : nil
            leading = [openRun].compactMap { $0 }
            trailing = [stop].compactMap { $0 }
            menu = [[openRun, openSchedule].compactMap { $0 }, [stop].compactMap { $0 }]
        case .draft(let card):
            // No Allow here: allowing grants authority, so it is pressed on the card, after reading it.
            let notNow = RowSwipeAction(title: SC.Actions.notNow, systemImage: "xmark", tint: .gray) {
                Task { _ = await scheduled.decline(card) }
            }
            let openConversation = card.askedBySessionId.map { session in
                RowSwipeAction(title: SC.Actions.openConversation, systemImage: "bubble.left", tint: .blue) {
                    model.route(to: .session(session))
                }
            }
            trailing = [notNow]
            menu = [[openConversation].compactMap { $0 }, [notNow]]
        case .task(let id):
            menu = [[RowSwipeAction(title: SC.Actions.open, systemImage: "arrow.up.right", tint: .blue) { openTask(id) }]]
        }
        menu.removeAll { $0.isEmpty }
    }

    private static func delete(_ ask: @escaping () -> Void) -> RowSwipeAction {
        RowSwipeAction(title: SC.Actions.delete, systemImage: "trash", tint: .red, role: .destructive, perform: ask)
    }

    /// The long-press / right-click menu.
    @ViewBuilder var menuContent: some View {
        ForEach(Array(menu.enumerated()), id: \.offset) { index, group in
            if index > 0 { Divider() }
            ForEach(group) { action in
                Button(role: action.role, action: action.perform) {
                    Label(action.title, systemImage: action.systemImage)
                }
                .disabled(!action.isEnabled)
            }
        }
    }
}
