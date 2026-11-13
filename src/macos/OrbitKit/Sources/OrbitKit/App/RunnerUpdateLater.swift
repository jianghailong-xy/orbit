import Foundation

/// Later (docs/runner-update-drain-design.md §2, D1): put the update a runner drains for off for an
/// hour, until tonight 02:00, or until tomorrow 09:00, in the reader's own zone — the web's
/// `runnerUpdateLater.ts`. The Mac draws the web's menu (board 3 ⑦, `RunnerPageCopy`'s words); iOS
/// draws board 5's action sheet, whose words are here.
public enum RunnerUpdateLater {
    public enum Choice: String, CaseIterable, Sendable {
        case hour, tonight, tomorrow
    }

    /// When each choice ends: an hour from now; the next 02:00; 09:00 on the next calendar day.
    public static func until(_ choice: Choice, now: Date, calendar: Calendar = .current) -> Date {
        switch choice {
        case .hour:
            return now.addingTimeInterval(3600)
        case .tonight:
            let today = calendar.date(bySettingHour: 2, minute: 0, second: 0, of: now) ?? now
            return today > now ? today : (calendar.date(byAdding: .day, value: 1, to: today) ?? today)
        case .tomorrow:
            let next = calendar.date(byAdding: .day, value: 1, to: now) ?? now
            return calendar.date(bySettingHour: 9, minute: 0, second: 0, of: next) ?? next
        }
    }

    /// `12:57`, in the calendar's zone.
    public static func clock(_ date: Date, calendar: Calendar = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: date)
    }

    public struct Row: Equatable, Sendable {
        public let choice: Choice
        public let label: String
        /// The menu's clock time beside the label; nil on the sheet, whose labels carry it.
        public let detail: String?
        public let until: Date
    }

    /// The Mac's menu, as the web's: `Postpone 1 hour  until 12:57`, `… tonight  02:00`, `… tomorrow  09:00`.
    public static func menuRows(now: Date, calendar: Calendar = .current) -> [Row] {
        Choice.allCases.map { choice in
            let at = until(choice, now: now, calendar: calendar)
            let time = clock(at, calendar: calendar)
            switch choice {
            case .hour:
                return Row(choice: choice, label: RunnerPageCopy.RUNNER_UPDATE_LATER_HOUR,
                           detail: RunnerPageCopy.runnerUpdateLaterUntil(clock: time), until: at)
            case .tonight:
                return Row(choice: choice, label: RunnerPageCopy.RUNNER_UPDATE_LATER_TONIGHT, detail: time, until: at)
            case .tomorrow:
                return Row(choice: choice, label: RunnerPageCopy.RUNNER_UPDATE_LATER_TOMORROW, detail: time, until: at)
            }
        }
    }

    // MARK: the action sheet (board 5)

    public static let SHEET_HOUR = "In 1 Hour"
    public static func sheetTonight(clock: String) -> String { "Tonight at \(clock)" }
    public static func sheetTomorrow(clock: String) -> String { "Tomorrow at \(clock)" }
    /// The sheet's message: `Postpone the 0.1.254 update on studio-mac. It takes work again right away.`
    public static func sheetMessage(version: String?, machine: String?) -> String {
        let update = version.map { "the \($0) update" } ?? "the update"
        let on = machine.map { " on \($0)" } ?? ""
        return "Postpone \(update)\(on). It takes work again right away."
    }

    /// iOS's sheet: `In 1 Hour`, `Tonight at 02:00`, `Tomorrow at 09:00`.
    public static func sheetRows(now: Date, calendar: Calendar = .current) -> [Row] {
        Choice.allCases.map { choice in
            let at = until(choice, now: now, calendar: calendar)
            let time = clock(at, calendar: calendar)
            switch choice {
            case .hour: return Row(choice: choice, label: SHEET_HOUR, detail: nil, until: at)
            case .tonight: return Row(choice: choice, label: sheetTonight(clock: time), detail: nil, until: at)
            case .tomorrow: return Row(choice: choice, label: sheetTomorrow(clock: time), detail: nil, until: at)
            }
        }
    }

    /// The body of POST /runners/:id/self-update/postpone (shared `RunnerSelfUpdatePostponeRequest`):
    /// the time, and the reader's zone the server caps it in (D2).
    public static func request(until: Date, timeZone: TimeZone = .current) -> RunnerSelfUpdatePostponeRequest {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return RunnerSelfUpdatePostponeRequest(until: iso.string(from: until), timeZone: timeZone.identifier)
    }
}
