import Foundation

/// The rules that turn the schedule doors' shapes into what the Apple clients draw: the timeline's groups, a
/// row's circle, a rule in words, the Costs line, an envelope card's Now / Asked, who made a change, and the
/// Waiting on you cards. Each mirrors the function of the same name in `src/shared/src/schedule.ts` (the web's
/// rules), and the contract's `boardPhrases` hold both to the boards' words (ScheduleDisplayTests).
///
/// Pure and Foundation-only, so it runs in the Linux `swift test`.
public enum ScheduleDisplay {
    private typealias C = ScheduleCopy

    public static let weekdayOrder = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]

    /// Fill `{name}` placeholders; a placeholder with no value is left as it is, so a missing value shows.
    public static func fill(_ template: String, _ values: [String: String]) -> String {
        var out = ""
        var rest = Substring(template)
        while let open = rest.firstIndex(of: "{") {
            out += rest[..<open]
            let after = rest[rest.index(after: open)...]
            guard let close = after.firstIndex(of: "}") else {
                out += rest[open...]
                return out
            }
            let key = String(after[..<close])
            let isWord = !key.isEmpty && key.allSatisfy { $0.isLetter || $0.isNumber || $0 == "_" }
            if isWord, let value = values[key] {
                out += value
            } else {
                out += rest[open...close]
            }
            rest = after[after.index(after: close)...]
        }
        out += rest
        return out
    }

    static func capitalize(_ text: String) -> String {
        guard let first = text.first else { return text }
        return first.uppercased() + text.dropFirst()
    }

    static func lowerFirst(_ text: String) -> String {
        guard let first = text.first else { return text }
        return first.lowercased() + text.dropFirst()
    }

    // MARK: - Time, in the viewer's zone

    /// One instant read on a zone's calendar.
    public struct LocalParts: Equatable, Sendable {
        /// Days since 1970-01-01 of the local calendar date: two dates' difference is a count of days.
        public let dayNumber: Int
        public let month: Int
        public let day: Int
        public let weekday: String
        public let time: String
    }

    public static func parse(_ iso: String) -> Date? {
        RelativeTime.parse(iso)
    }

    public static func localParts(_ at: Date, timezone: String) -> LocalParts {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: timezone) ?? TimeZone(identifier: "UTC")!
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute, .weekday], from: at)
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        let midnight = utc.date(from: DateComponents(year: c.year, month: c.month, day: c.day)) ?? at
        let dayNumber = Int((midnight.timeIntervalSince1970 / 86_400).rounded())
        // Calendar's weekday: 1 is Sunday.
        let weekday = weekdayOrder[((c.weekday ?? 1) + 5) % 7]
        return LocalParts(dayNumber: dayNumber, month: c.month ?? 1, day: c.day ?? 1, weekday: weekday,
                          time: String(format: "%02d:%02d", (c.hour ?? 0) % 24, c.minute ?? 0))
    }

    /// "Nov 14".
    public static func dateText(_ at: Date, timezone: String) -> String {
        let p = localParts(at, timezone: timezone)
        return fill(C.Dates.day, ["month": C.months[p.month - 1], "day": String(p.day)])
    }

    /// "Fri, Nov 14".
    public static func dayWithWeekdayText(_ at: Date, timezone: String) -> String {
        let p = localParts(at, timezone: timezone)
        return fill(C.Dates.dayWithWeekday, ["weekday": C.weekdaysShort[p.weekday] ?? p.weekday,
                                              "month": C.months[p.month - 1], "day": String(p.day)])
    }

    /// "Today", "Tomorrow", "Monday" within the coming week, else "Nov 24".
    public static func dayText(_ at: Date, now: Date, timezone: String) -> String {
        let p = localParts(at, timezone: timezone)
        let offset = p.dayNumber - localParts(now, timezone: timezone).dayNumber
        if offset == 0 { return C.Dates.today }
        if offset == 1 { return C.Dates.tomorrow }
        if offset > 1 && offset < 7 { return C.weekdays[p.weekday] ?? p.weekday }
        return fill(C.Dates.day, ["month": C.months[p.month - 1], "day": String(p.day)])
    }

    /// "Today 02:00", "Tomorrow 09:00", "Monday 09:00", "Nov 24 09:00".
    public static func whenText(_ at: Date, now: Date, timezone: String) -> String {
        fill(C.Dates.at, ["day": dayText(at, now: now, timezone: timezone),
                          "time": localParts(at, timezone: timezone).time])
    }

    /// A slot that has passed, inside a sentence: "Monday 09:00" within the last week, else "Nov 10, 09:00".
    public static func pastWhenText(_ at: Date, now: Date, timezone: String) -> String {
        let p = localParts(at, timezone: timezone)
        let back = localParts(now, timezone: timezone).dayNumber - p.dayNumber
        if back >= 0 && back < 7 { return fill(C.Dates.at, ["day": C.weekdays[p.weekday] ?? p.weekday, "time": p.time]) }
        return "\(dateText(at, timezone: timezone)), \(p.time)"
    }

    /// "First run tomorrow" / "First run Monday".
    public static func firstRunText(_ at: Date, now: Date, timezone: String, inline: Bool = false) -> String {
        let day = dayText(at, now: now, timezone: timezone)
        let lowered = day == C.Dates.today ? C.Dates.todayLower : day == C.Dates.tomorrow ? C.Dates.tomorrowLower : day
        return fill(inline ? C.CreateCard.firstRunInline : C.CreateCard.firstRun, ["day": lowered])
    }

    // MARK: - A press that failed

    /// What a failed press on a schedule says. The server's own sentence when it sent one; otherwise it names what
    /// went wrong, so a reply this app could not read (Orbit was reached and may have done it) never reads as
    /// "Couldn't reach Orbit".
    public static func pressFailure(_ error: Error) -> String {
        switch error {
        case APIError.http(let status, let body):
            if let body, let data = body.data(using: .utf8),
               let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let message = object["message"] as? String, !message.isEmpty {
                return message
            }
            return fill(PressFailure.refused, ["status": String(status)])
        case APIError.unauthorized: return PressFailure.signedOut
        case APIError.invalidResponse, is DecodingError: return PressFailure.unreadable
        default: return PressFailure.unreachable
        }
    }

    public enum PressFailure {
        public static let unreachable = "Couldn't reach Orbit. Try again."
        public static let unreadable = "Orbit answered, but this version of the app couldn't read the reply. "
            + "Update the app; the card shows what Orbit did."
        public static let refused = "Orbit couldn't do this (error {status}). Try again."
        public static let signedOut = "You're signed out. Sign in and try again."
    }

    // MARK: - Rules and costs

    public enum RuleForm: Sendable { case short, long }

    /// "Daily 10:00", "Mondays 10:00", "Weekdays at 09:00", "Mon, Thu 10:00", "Once" (short);
    /// "Every day at 02:00", "Every Monday at 09:00", "Weekdays at 09:00", "Every Mon, Thu at 10:00" (long).
    public static func ruleText(_ rule: ScheduleRule, form: RuleForm = .short) -> String {
        let short = form == .short
        let daily = short ? C.Rules.shortDaily : C.Rules.longDaily
        switch rule {
        case .when(_, _, let condition):
            // "Raw used above 90%" (short), "When raw used above 90%" (long): shared SCHEDULE_CONDITION_COPY.rules.
            return short
                ? fill(ScheduleConditionCopy.rulesShort, ["condition": condition.text])
                : fill(ScheduleConditionCopy.rulesLong, ["condition": lowerFirst(condition.text)])
        case .once: return short ? C.Rules.shortOnce : C.Rules.longOnce
        case .daily(let time): return fill(daily, ["time": time])
        case .every(let minutes, let time, let until, let weekdays):
            return everyText(minutes: minutes, time: time, until: until, weekdays: weekdays)
        case .weekly(let time, let weekdays):
            let days = weekdayOrder.filter { weekdays.contains($0) }
            if days.count == 7 { return fill(daily, ["time": time]) }
            if days.count == 5, ["MON", "TUE", "WED", "THU", "FRI"].allSatisfy(days.contains) {
                return fill(short ? C.Rules.shortWeekdays : C.Rules.longWeekdays, ["time": time])
            }
            if days.count == 1, let d = days.first {
                return short
                    ? fill(C.Rules.shortWeekday, ["weekdays": C.weekdaysPlural[d] ?? d, "time": time])
                    : fill(C.Rules.longWeekday, ["weekday": C.weekdays[d] ?? d, "time": time])
            }
            let list = days.map { C.weekdaysShort[$0] ?? $0 }.joined(separator: C.Rules.daysSeparator)
            return fill(short ? C.Rules.shortDays : C.Rules.longDays, ["days": list, "time": time])
        }
    }

    /// An EVERY rule's sentence, the same in both forms: "Every 30 min, 09:00–18:00, Mon–Fri", "Every hour",
    /// "Every 2 hours from 08:00, weekends"; seven weekdays are left unsaid.
    static func everyText(minutes: Int, time: String, until: String?, weekdays: [String]) -> String {
        let e = C.Every.self
        let interval = minutes < 60 ? fill(e.minutes, ["count": String(minutes)])
            : minutes == 60 ? e.hour : fill(e.hours, ["count": String(minutes / 60)])
        let text: String
        if let until { text = fill(e.window, ["interval": interval, "time": time, "until": until]) }
        else if time == "00:00" { text = interval }
        else { text = fill(e.from, ["interval": interval, "time": time]) }
        let days = weekdayOrder.filter { weekdays.contains($0) }
        if days.count == 7 { return text }
        let named: String
        if days.count == 5, ["MON", "TUE", "WED", "THU", "FRI"].allSatisfy(days.contains) { named = e.workweek }
        else if days.count == 2, days.contains("SAT"), days.contains("SUN") { named = e.weekend }
        else { named = days.map { C.weekdaysShort[$0] ?? $0 }.joined(separator: C.Rules.daysSeparator) }
        return fill(e.days, ["rule": text, "days": named])
    }

    /// A schedule's planned end as one line: "until 18:00 today", "until Nov 25", "3 runs left", or both joined by
    /// the separator. Nil when it has no end.
    public static func endText(endAt: String?, maxRuns: Int?, runsLeft: Int?, now: Date, timezone: String) -> String? {
        var parts: [String] = []
        if let at = endAt.flatMap(parse) {
            let day = dayText(at, now: now, timezone: timezone)
            let time = localParts(at, timezone: timezone).time
            let when = day == C.Dates.today ? fill(C.End.today, ["time": time])
                : day == C.Dates.tomorrow ? fill(C.End.tomorrow, ["time": time])
                : dateText(at, timezone: timezone)
            parts.append(fill(C.End.until, ["when": when]))
        }
        if let maxRuns {
            let left = runsLeft ?? maxRuns
            parts.append(left == 1 ? C.End.runLeft : fill(C.End.runsLeft, ["count": String(left)]))
        }
        return parts.isEmpty ? nil : parts.joined(separator: C.separator)
    }

    public static func endText(_ schedule: ScheduleView, now: Date, timezone: String) -> String? {
        endText(endAt: schedule.endAt, maxRuns: schedule.maxRuns, runsLeft: schedule.runsLeft, now: now, timezone: timezone)
    }

    /// "16 slots missed, 01:00–08:30": consecutive MISSED runs as one line.
    public static func missedText(_ runs: [ScheduleRunView], timezone: String) -> String {
        let times = runs.compactMap { parse($0.plannedAt) }.sorted()
        guard let first = times.first, let last = times.last else { return fill(C.End.missed, ["count": String(runs.count), "from": "", "to": ""]) }
        let a = localParts(first, timezone: timezone), b = localParts(last, timezone: timezone)
        if a.month == b.month && a.day == b.day {
            return fill(C.End.missed, ["count": String(runs.count), "from": a.time, "to": b.time])
        }
        return fill(C.End.missedDated, ["count": String(runs.count), "fromDate": dateText(first, timezone: timezone), "from": a.time,
                                        "toDate": dateText(last, timezone: timezone), "to": b.time])
    }

    /// A run list, newest first, with each streak of two or more MISSED runs in a row (nothing else between them)
    /// gathered into one entry; a single MISSED run stays a run.
    public enum MissedCollapsed: Equatable, Sendable {
        case run(ScheduleRunView)
        case missed([ScheduleRunView])
    }

    public static func collapseMissed(_ runs: [ScheduleRunView]) -> [MissedCollapsed] {
        var out: [MissedCollapsed] = []
        var streak: [ScheduleRunView] = []
        func close() {
            if streak.count == 1 { out.append(.run(streak[0])) } else if !streak.isEmpty { out.append(.missed(streak)) }
            streak = []
        }
        for run in runs {
            if run.state == "MISSED" { streak.append(run) } else { close(); out.append(.run(run)) }
        }
        close()
        return out
    }

    /// A timeline group's item, or a streak of two or more MISSED runs of one schedule drawn as one row.
    public enum TimelineRowItem: Equatable, Sendable {
        case item(TimelineItem)
        case missed(ScheduleView, runs: [ScheduleRunView], at: String)
    }

    /// The web's `scheduleCollapseMissed`: per schedule, consecutive MISSED runs (in planned order, nothing else of
    /// that schedule between them) become one row at the streak's last time; a single missed run stays a run.
    public static func collapseMissedItems(_ items: [TimelineItem]) -> [TimelineRowItem] {
        var bySchedule: [String: [(TimelineItem, ScheduleRunView)]] = [:]
        for item in items {
            if case .run(let s, let run, _) = item { bySchedule[s.id, default: []].append((item, run)) }
        }
        var streakOf: [String: [(TimelineItem, ScheduleRunView)]] = [:]
        for list in bySchedule.values {
            let sorted = list.sorted { (parse($0.1.plannedAt) ?? .distantPast) < (parse($1.1.plannedAt) ?? .distantPast) }
            var streak: [(TimelineItem, ScheduleRunView)] = []
            func close() {
                if streak.count > 1 { for m in streak { streakOf[m.0.id] = streak } }
                streak = []
            }
            for entry in sorted {
                if entry.1.state == "MISSED" { streak.append(entry) } else { close() }
            }
            close()
        }
        var out: [TimelineRowItem] = []
        var done: Set<String> = []
        for item in items {
            guard case .run(let s, _, _) = item, let streak = streakOf[item.id] else { out.append(.item(item)); continue }
            let key = streak[0].0.id
            if !done.insert(key).inserted { continue }
            out.append(.missed(s, runs: streak.map(\.1), at: streak[streak.count - 1].0.at ?? ""))
        }
        return out
    }

    /// Whether a row shows the repeat mark (↻) before its rule: a one-off does not.
    public static func ruleRepeats(_ rule: ScheduleRule) -> Bool {
        if case .once = rule { return false }
        return true
    }

    /// "7 runs a week", "1 run a week".
    public static func runsPerWeekText(_ runsPerWeek: Int) -> String {
        fill(runsPerWeek == 1 ? C.Costs.runsOne : C.Costs.runsOther, ["count": String(runsPerWeek)])
    }

    /// The Costs line, "Up to 7 runs a week, 30 min each", with the part the card sets in bold.
    public struct CostsParts: Equatable, Sendable {
        public let text: String
        public let before: String
        public let emphasis: String
        public let after: String
    }

    public static func costsParts(runsPerWeek: Int, runLimitMinutes: Int) -> CostsParts {
        let emphasis = runsPerWeekText(runsPerWeek)
        let text = fill(C.Costs.upTo, ["runs": emphasis, "minutes": String(runLimitMinutes)])
        guard let range = text.range(of: emphasis) else {
            return CostsParts(text: text, before: text, emphasis: "", after: "")
        }
        return CostsParts(text: text, before: String(text[..<range.lowerBound]), emphasis: emphasis,
                          after: String(text[range.upperBound...]))
    }

    public static func costsText(runsPerWeek: Int, runLimitMinutes: Int) -> String {
        costsParts(runsPerWeek: runsPerWeek, runLimitMinutes: runLimitMinutes).text
    }

    /// "Allowed: up to 7 runs a week, 30 min each", under This month.
    public static func allowedText(runsPerWeek: Int, runLimitMinutes: Int) -> String {
        fill(C.Costs.allowed, ["costs": fill(C.Costs.upToLower, ["runs": runsPerWeekText(runsPerWeek),
                                                                 "minutes": String(runLimitMinutes)])])
    }

    /// "14 runs · 41 min".
    public static func usageText(runs: Int, minutes: Int) -> String {
        fill(runs == 1 ? C.Inspector.usageOne : C.Inspector.usageOther,
             ["runs": String(runs), "minutes": String(minutes)])
    }

    public static func accessCopy(_ level: String) -> ScheduleAccessCopy {
        C.access[level] ?? ScheduleAccessCopy(label: level, detail: "", brief: "")
    }

    /// "Check only · reads and reports, edits nothing": the create card's May line.
    public static func mayText(_ level: String) -> String {
        let a = accessCopy(level)
        return "\(a.label)\(C.separator)\(a.detail)"
    }

    /// "Claude", "Codex": an engine id as the card names it.
    public static func engineName(_ engine: String) -> String { capitalize(engine) }

    /// "apiserver · Codex agent".
    public static func runsInText(workspaceName: String, engine: String?) -> String {
        guard let engine, !engine.isEmpty else { return workspaceName }
        return fill(C.CreateCard.runsInEngine, ["workspace": workspaceName, "engine": engineName(engine)])
    }

    /// The create card's last line (S5 `scheduleCreateNotice`): "You'll hear about new versions and failures only.";
    /// with no word for what the task finds, the plain notice.
    public static func createNotice(findings: String?) -> String {
        let what = findings?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return what.isEmpty ? C.CreateCard.notice : fill(C.CreateCard.noticeAbout, ["findings": what])
    }

    /// The create card's When: "Daily 10:00 · Asia/Shanghai · first run tomorrow", with its parts.
    public struct CreateWhen: Equatable, Sendable {
        public let text: String
        public let rule: String
        public let zone: String
        public let firstRun: String?
    }

    public static func createWhen(_ when: ScheduleCardWhen, now: Date, viewerTimezone: String) -> CreateWhen {
        if case .when = when.rule {
            // A WHEN rule has no time, so no zone and no first run: its lines are `when.condition`.
            let rule = when.condition?.text ?? ruleText(when.rule, form: .short)
            return CreateWhen(text: rule, rule: rule, zone: "", firstRun: nil)
        }
        let zone = when.timezone ?? C.CreateCard.zoneFromDevice
        let rule = ruleText(when.rule, form: .short)
        let at = when.firstRunAt.flatMap(parse)
        let tz = when.timezone ?? viewerTimezone
        let firstRun = at.map { firstRunText($0, now: now, timezone: tz) }
        let inline = at.map { firstRunText($0, now: now, timezone: tz, inline: true) }
        return CreateWhen(text: [rule, zone, inline].compactMap { $0 }.joined(separator: C.separator),
                          rule: rule, zone: zone, firstRun: firstRun)
    }

    // MARK: - Circles

    /// A row's circle (board 1/2 ①): `open` is to come, `running` turns, `done` a grey tick, `new` a green tick,
    /// `failed` red, `held` amber, `draft` dashed, `paused` faint, `muted` a run that never did the work.
    public enum Circle: String, CaseIterable, Sendable { case open, running, done, new, failed, held, draft, paused, muted }
    public enum Mark: String, Sendable { case check, alert, clock }
    public enum TagTone: String, Sendable { case new, fail, held, mute }

    public struct Tag: Equatable, Sendable {
        public let tone: TagTone
        public let text: String
    }

    public struct CircleView: Equatable, Sendable {
        public let circle: Circle
        public let mark: Mark?
        public let tag: Tag?
        /// A condition's row (condition-triggers board ④ ③): a gauge in place of the circle, in the circle's tone.
        public let gauge: Bool
        public init(_ circle: Circle, _ mark: Mark? = nil, _ tag: Tag? = nil, gauge: Bool = false) {
            self.circle = circle
            self.mark = mark
            self.tag = tag
            self.gauge = gauge
        }
    }

    /// A run's circle. A CHANGED run is `new` when its finding was new, else a grey tick tagged Known.
    public static func runCircle(state: String, newFinding: Bool = false) -> CircleView {
        let label = C.runStates[state] ?? state
        switch state {
        case "QUEUED": return CircleView(.open, .clock)
        case "RUNNING": return CircleView(.running)
        case "AWAITING_APPROVAL": return CircleView(.held, .alert, Tag(tone: .held, text: label))
        case "NO_CHANGE": return CircleView(.done, .check, Tag(tone: .mute, text: label))
        case "CHANGED":
            return newFinding
                ? CircleView(.new, .check, Tag(tone: .new, text: C.Tags.new))
                : CircleView(.done, .check, Tag(tone: .mute, text: C.Tags.known))
        case "FAILED": return CircleView(.failed, .alert, Tag(tone: .fail, text: C.Tags.failed))
        case "HELD": return CircleView(.held, .alert, Tag(tone: .held, text: C.Tags.held))
        default: return CircleView(.muted, .check, Tag(tone: .mute, text: label))
        }
    }

    /// A schedule's circle on its next occurrence, or in Paused.
    public static func scheduleCircle(state: String, consecutiveFailures: Int, draft: Bool = false) -> CircleView {
        if draft { return CircleView(.draft) }
        switch state {
        case "PAUSED": return CircleView(.paused)
        case "HELD": return CircleView(.held, .alert, Tag(tone: .held, text: C.Tags.held))
        case "ENDED": return CircleView(.muted)
        default:
            if consecutiveFailures > 0 {
                let text = consecutiveFailures > 1
                    ? fill(C.Tags.failedInARow, ["count": String(consecutiveFailures)]) : C.Tags.failed
                return CircleView(.failed, .alert, Tag(tone: .fail, text: text))
            }
            return CircleView(.open)
        }
    }

    /// A schedule's row circle. `runs` are the list's timeline runs: while a run of a failing schedule is under way
    /// its Failed tag stays off (owner 2026-11-19, the shared `scheduleRowCircle`), and the run's end decides —
    /// a failure keeps consecutiveFailures above zero and the tag returns, a success has the server reset it.
    public static func scheduleCircle(_ schedule: ScheduleView, draft: Bool = false,
                                      runs: [ScheduleRunView] = []) -> CircleView {
        let failures = runUnderWay(schedule, runs: runs) ? 0 : schedule.consecutiveFailures
        if schedule.state == "ACTIVE", failures == 0, schedule.condition?.cantRead == true {
            return ConditionDisplay.circle(cantRead: true)
        }
        let view = scheduleCircle(state: schedule.state, consecutiveFailures: failures, draft: draft)
        // A WHEN schedule keeps its gauge in every group (condition-triggers board ④ ③).
        guard case .when = schedule.rule else { return view }
        return CircleView(view.circle, view.mark, view.tag, gauge: true)
    }

    /// Whether one of `runs` (the list's timeline runs) is a run of this schedule under way: queued, running or
    /// waiting for an approval.
    public static func runUnderWay(_ schedule: ScheduleView, runs: [ScheduleRunView]) -> Bool {
        runs.contains { $0.scheduleId == schedule.id && inProgress.contains($0.state) }
    }

    /// Needs you: failing or held (§9.2), or a WHEN rule whose condition cannot be read (condition-triggers §9) —
    /// the count beside Scheduled in the drawer. There is no Needs you group on the page any more (owner
    /// 2026-11-19): each is tagged on its own row.
    public static func needsYou(state: String, consecutiveFailures: Int) -> Bool {
        state == "HELD" || (state == "ACTIVE" && consecutiveFailures > 0)
    }

    /// A failing schedule whose next run is already under way in `runs` (Run now, owner 2026-11-19) waits for that
    /// run instead: a failure puts it back, an ended run that did not fail clears it.
    public static func needsYou(_ schedule: ScheduleView, runs: [ScheduleRunView] = []) -> Bool {
        let failures = runUnderWay(schedule, runs: runs) ? 0 : schedule.consecutiveFailures
        return needsYou(state: schedule.state, consecutiveFailures: failures)
            || (schedule.state == "ACTIVE" && schedule.condition?.cantRead == true)
    }

    /// The drawer's number: how many schedules, and tasks waiting on a condition, need you; nothing at zero.
    public static func needsYouCount(_ schedules: [ScheduleView], waitingTasks: [ScheduleWaitingTask] = [],
                                     runs: [ScheduleRunView] = []) -> Int {
        schedules.filter { needsYou($0, runs: runs) }.count + waitingTasks.filter(\.condition.cantRead).count
    }

    // MARK: - A row's second line

    /// Why a run failed, as a clause: the server's reasonText (S2d) when it has one.
    public static func failureClause(failureReason: String?, reasonText: String?) -> String? {
        if let reasonText, !reasonText.isEmpty { return reasonText }
        guard let failureReason else { return nil }
        return C.failureReasons[failureReason]
    }

    /// Why a schedule is held, as a clause: 'the agent "auditor" is disabled'.
    public static func heldClause(_ reason: String?, agent: String? = nil,
                                  workspace: String? = nil) -> ScheduleHeldCopy? {
        guard let reason, let entry = C.heldReasons[reason] else { return nil }
        var values: [String: String] = [:]
        if let agent, !agent.isEmpty { values["agent"] = agent }
        if let workspace, !workspace.isEmpty { values["workspace"] = workspace }
        let clause = fill(entry.clause, values)
            .scheduleReplacingFirst("the agent \"{agent}\"", with: "its agent")
            .scheduleReplacingFirst("the workspace {workspace}", with: "its workspace")
        return ScheduleHeldCopy(clause: clause, until: entry.until)
    }

    /// A schedule row's second line: "Every day at 02:00 · apiserver · Check only". A held schedule says why in
    /// place of the access, a paused one when it paused; a running one adds how long, a draft that it waits.
    public static func rowLine(rule: ScheduleRule, workspaceName: String?, accessLevel: String, state: String,
                               heldReason: String?, agentName: String? = nil, pausedAt: Date? = nil,
                               timezone: String? = nil, runningMinutes: Int? = nil, draft: Bool = false) -> String {
        var parts = [ruleText(rule, form: .long)]
        if let workspaceName, !workspaceName.isEmpty { parts.append(workspaceName) }
        if state == "HELD" {
            parts.append(heldClause(heldReason, agent: agentName)?.clause ?? accessCopy(accessLevel).label)
        } else if state == "PAUSED", let pausedAt, let timezone {
            parts.append(fill(C.Row.pausedOn, ["date": dateText(pausedAt, timezone: timezone)]))
        } else {
            parts.append(accessCopy(accessLevel).label)
        }
        if let runningMinutes { parts.append(fill(C.Row.runningFor, ["minutes": String(runningMinutes)])) }
        if draft { parts.append(C.Row.draft) }
        return parts.joined(separator: C.separator)
    }

    /// A schedule row's second line on a phone (iOS board 01 ②), one line — the shared `schedulePhoneRowLine`:
    /// the short rule, then the workspace or (held) why in a few words, then "Open a PR" only when it may, when it
    /// paused, how long it has been running, or that it is a draft.
    public static func phoneRowLine(rule: ScheduleRule, workspaceName: String?, accessLevel: String, state: String,
                                    heldReason: String?, pausedAt: Date? = nil, timezone: String? = nil,
                                    runningMinutes: Int? = nil, draft: Bool = false) -> String {
        var parts = [ruleText(rule, form: .short)]
        if state == "HELD" {
            parts.append(heldReason.flatMap { C.heldShort[$0] } ?? C.Tags.held)
        } else {
            if let workspaceName, !workspaceName.isEmpty { parts.append(workspaceName) }
            if accessLevel != "CHECK_ONLY" { parts.append(accessCopy(accessLevel).label) }
            if state == "PAUSED", let pausedAt, let timezone {
                parts.append(fill(C.Row.pausedOn, ["date": dateText(pausedAt, timezone: timezone)]))
            }
        }
        if let runningMinutes { parts.append(fill(C.Row.runningShort, ["minutes": String(runningMinutes)])) }
        if draft { parts.append(C.Row.draftShort) }
        return parts.joined(separator: C.separator)
    }

    /// A past run's second line: "Ended without a report", "2.1.310 is out · you were notified".
    public static func runLine(state: String, summary: String?, failureReason: String?, reasonText: String?,
                               notified: Bool = false) -> String {
        if state == "FAILED" || state == "MISSED" || state == "HELD" {
            // A reported failure says what the run reported, as its Waiting card and push do (W3).
            if let clause = reportedFailureClause(failureReason: failureReason, reasonText: reasonText, summary: summary)
                ?? failureClause(failureReason: failureReason, reasonText: reasonText) {
                return capitalize(clause)
            }
            return C.runStates[state] ?? state
        }
        var parts = [summary ?? C.runStates[state] ?? state]
        if state == "CHANGED" || state == "NO_CHANGE" { parts.append(notified ? C.Row.notified : C.Row.notNotified) }
        return parts.joined(separator: C.separator)
    }

    // MARK: - The timeline

    public enum GroupKey: String, Sendable { case condition = "CONDITION", today = "TODAY",
                                                  tomorrow = "TOMORROW", day = "DAY", later = "LATER", paused = "PAUSED" }

    public enum TimelineItem: Equatable, Sendable, Identifiable {
        case schedule(ScheduleView, at: String?)
        case run(ScheduleView, ScheduleRunView, at: String)
        case draft(ScheduleCard, at: String)
        /// A task that starts when its condition holds (condition-triggers board ④ ①).
        case task(ScheduleWaitingTask)

        public var at: String? {
            switch self {
            case .schedule(_, let at): return at
            case .run(_, _, let at), .draft(_, let at): return at
            case .task: return nil
            }
        }

        public var id: String {
            switch self {
            case .schedule(let s, _): return "schedule-\(s.id)"
            case .run(_, let r, _): return "run-\(r.id)"
            case .draft(let c, _): return "draft-\(c.id)"
            case .task(let t): return "task-\(t.id)"
            }
        }
    }

    public struct TimelineGroup: Equatable, Sendable, Identifiable {
        public let key: GroupKey
        /// "Waiting for a condition", "Today", "Monday", "Later", "Paused".
        public let title: String
        /// "Fri, Nov 14" under Today and Tomorrow, "Nov 17" under a day, the count under a condition and Paused.
        public let subtitle: String?
        public let items: [TimelineItem]
        public var id: String { key == .day ? "day-\(title)" : key.rawValue }
    }

    static let inProgress: Set<String> = ["QUEUED", "RUNNING", "AWAITING_APPROVAL"]

    /// The Scheduled page's groups (§9.2), in the viewer's zone: Waiting for a condition (the ACTIVE WHEN schedules and
    /// the tasks waiting on their startWhen, the ones whose condition cannot be read first: a condition has no day, so
    /// it is a group of its own above Today, condition-triggers §9), Today, Tomorrow, each day of the coming week by
    /// its name, Later, Paused (held before paused: a held one has no next run to be placed on). A schedule appears on
    /// the day of its next run, a draft on the day of its first; a run under way on its planned day, an ended one on
    /// today's only with `showPastRuns`. There is no group of errors (owner 2026-11-19, replacing Needs you): a failing
    /// schedule is tagged on its own row (`scheduleCircle(_:runs:)`). Ended schedules appear nowhere; empty groups are
    /// left out; a day is in time order.
    public static func timeline(schedules: [ScheduleView], runs: [ScheduleRunView] = [], drafts: [ScheduleCard] = [],
                                waitingTasks: [ScheduleWaitingTask] = [],
                                showPastRuns: Bool = false, now: Date, timezone: String) -> [TimelineGroup] {
        let today = localParts(now, timezone: timezone).dayNumber
        var byID: [String: ScheduleView] = [:]
        for s in schedules { byID[s.id] = s }
        var days: [Int: [(Int, TimelineItem)]] = [:]
        var later: [(Int, TimelineItem)] = []
        var order = 0
        func place(_ item: TimelineItem, _ at: String) {
            guard let date = parse(at) else { return }
            let day = max(localParts(date, timezone: timezone).dayNumber, today)
            order += 1
            if day - today >= 7 { later.append((order, item)) } else { days[day, default: []].append((order, item)) }
        }
        let byTitle: (ScheduleView, ScheduleView) -> Bool = {
            $0.title.compare($1.title, options: [.caseInsensitive]) == .orderedAscending
        }
        let byTaskTitle: (ScheduleWaitingTask, ScheduleWaitingTask) -> Bool = {
            $0.title.compare($1.title, options: [.caseInsensitive]) == .orderedAscending
        }
        let when = schedules.filter { s in
            if case .when = s.rule { return s.state == "ACTIVE" }
            return false
        }.sorted(by: byTitle)
        let tasks = waitingTasks.sorted(by: byTaskTitle)
        // Can't read first: the rows that need the owner lead the group.
        let cantRead: (ScheduleView) -> Bool = { $0.condition?.cantRead == true }
        let conditionItems: [TimelineItem] = when.filter(cantRead).map { .schedule($0, at: nil) }
            + tasks.filter(\.condition.cantRead).map { .task($0) }
            + when.filter { !cantRead($0) }.map { .schedule($0, at: nil) }
            + tasks.filter { !$0.condition.cantRead }.map { .task($0) }
        let paused = schedules.filter { $0.state == "PAUSED" || $0.state == "HELD" }.sorted {
            let a = $0.state == "HELD" ? 0 : 1, b = $1.state == "HELD" ? 0 : 1
            return a != b ? a < b : byTitle($0, $1)
        }

        for s in schedules where s.state == "ACTIVE" {
            if let next = s.nextDueAt { place(.schedule(s, at: next), next) }
        }
        for card in drafts {
            if let first = card.when?.firstRunAt { place(.draft(card, at: first), first) }
        }
        for run in runs {
            guard let schedule = byID[run.scheduleId] else { continue }
            if inProgress.contains(run.state) {
                place(.run(schedule, run, at: run.plannedAt), run.plannedAt)
            } else if showPastRuns, let planned = parse(run.plannedAt),
                      localParts(planned, timezone: timezone).dayNumber == today {
                place(.run(schedule, run, at: run.plannedAt), run.plannedAt)
            }
        }

        func byTime(_ a: (Int, TimelineItem), _ b: (Int, TimelineItem)) -> Bool {
            let ta = a.1.at.flatMap(parse)?.timeIntervalSince1970 ?? 0
            let tb = b.1.at.flatMap(parse)?.timeIntervalSince1970 ?? 0
            return ta != tb ? ta < tb : a.0 < b.0
        }
        var groups: [TimelineGroup] = []
        if !conditionItems.isEmpty {
            groups.append(TimelineGroup(key: .condition, title: ConditionCopy.group,
                                        subtitle: String(conditionItems.count), items: conditionItems))
        }
        for day in days.keys.sorted() {
            let items = days[day]!.sorted(by: byTime).map(\.1)
            guard let at = items.first?.at.flatMap(parse) else { continue }
            let offset = day - today
            let p = localParts(at, timezone: timezone)
            if offset == 0 || offset == 1 {
                groups.append(TimelineGroup(key: offset == 0 ? .today : .tomorrow,
                                            title: offset == 0 ? C.groups["TODAY"]! : C.groups["TOMORROW"]!,
                                            subtitle: dayWithWeekdayText(at, timezone: timezone), items: items))
            } else {
                groups.append(TimelineGroup(key: .day, title: C.weekdays[p.weekday] ?? p.weekday,
                                            subtitle: dateText(at, timezone: timezone), items: items))
            }
        }
        if !later.isEmpty {
            groups.append(TimelineGroup(key: .later, title: C.groups["LATER"]!, subtitle: nil,
                                        items: later.sorted(by: byTime).map(\.1)))
        }
        if !paused.isEmpty {
            groups.append(TimelineGroup(key: .paused, title: C.groups["PAUSED"]!, subtitle: String(paused.count),
                                        items: paused.map { .schedule($0, at: nil) }))
        }
        return groups
    }

    // MARK: - The envelope card: Now / Asked

    static let accessOrder: [String: Int] = ["CHECK_ONLY": 0, "OPEN_PR": 1, "LAND": 2]

    /// The parts of `after` wider than `before`, in the card's order (schedule-envelope.ts widenedParts).
    public static func widenedParts(before: ScheduleEnvelope, after: ScheduleEnvelope) -> [String] {
        var parts: [String] = []
        if after.workspaceId != before.workspaceId { parts.append("WORKSPACE") }
        if (accessOrder[after.accessLevel] ?? 0) > (accessOrder[before.accessLevel] ?? 0) { parts.append("ACCESS_LEVEL") }
        if after.runsPerWeek > before.runsPerWeek { parts.append("RUNS_PER_WEEK") }
        if after.runLimitMinutes > before.runLimitMinutes { parts.append("RUN_LIMIT") }
        if let hash = after.commandHash, hash != before.commandHash { parts.append("PROBE_COMMAND") }
        return parts
    }

    public struct EnvelopeSide: Equatable, Sendable {
        /// The part set in bold on Asked ("Daily 10:00", "Open a PR").
        public let lead: String
        public let detail: String
        public let text: String
    }

    /// The part a card is about: access first, then where it runs, how often, how long.
    static func headPart(_ widens: [String]) -> String? {
        ["ACCESS_LEVEL", "WORKSPACE", "PROBE_COMMAND", "RUNS_PER_WEEK", "RUN_LIMIT"].first(where: widens.contains)
    }

    /// An envelope card's Now and Asked lines (board 2/2 ② ③). Now names the run limit only where it differs.
    public static func envelopeSides(widens: [String], now: ScheduleEnvelope?, asked: ScheduleEnvelope,
                                     ruleNow: ScheduleRule? = nil, ruleAsked: ScheduleRule? = nil,
                                     workspaceNames: [String: String] = [:]) -> (now: EnvelopeSide?, asked: EnvelopeSide) {
        let part = headPart(widens)
        func side(_ e: ScheduleEnvelope, _ rule: ScheduleRule?, _ isNow: Bool) -> EnvelopeSide {
            if part == "ACCESS_LEVEL" {
                let a = accessCopy(e.accessLevel)
                let detail = isNow ? a.brief : a.detail
                return EnvelopeSide(lead: a.label, detail: detail, text: "\(a.label)\(C.EnvelopeCard.accessJoin)\(detail)")
            }
            if part == "PROBE_COMMAND" {
                // The command verbatim on both sides: what was approved, and what Allow would approve (board ⑥).
                let command = rule?.condition?.command ?? ""
                return EnvelopeSide(lead: command, detail: "", text: command)
            }
            let sameLimit = now?.runLimitMinutes == asked.runLimitMinutes
            let costs = isNow && sameLimit
                ? fill(C.Costs.runsOnly, ["runs": runsPerWeekText(e.runsPerWeek)])
                : fill(C.Costs.upToLower, ["runs": runsPerWeekText(e.runsPerWeek), "minutes": String(e.runLimitMinutes)])
            let lead = part == "WORKSPACE"
                ? (workspaceNames[e.workspaceId] ?? e.workspaceId)
                : rule.map { ruleText($0, form: .short) } ?? ""
            return EnvelopeSide(lead: lead, detail: costs,
                                text: lead.isEmpty ? capitalize(costs) : "\(lead)\(C.separator)\(costs)")
        }
        return (now.map { side($0, ruleNow, true) }, side(asked, ruleAsked ?? ruleNow, false))
    }

    /// "Let Codex stable check open PRs?"
    public static func envelopeTitle(_ title: String, widens: [String], workspaceName: String? = nil, accessLevel: String? = nil) -> String {
        let part = headPart(widens) ?? "RUNS_PER_WEEK"
        var values = ["title": title]
        if let workspaceName { values["workspace"] = workspaceName }
        return fill(part == "ACCESS_LEVEL" && accessLevel == "LAND" ? C.EnvelopeCard.landTitle : C.EnvelopeCard.titles[part] ?? "", values)
    }

    /// The card's decline button: "Keep check only", "Keep weekly", else "Keep as it is".
    public static func keepLabel(widens: [String], now: ScheduleEnvelope?, workspaceName: String? = nil) -> String {
        let part = headPart(widens)
        if part == "ACCESS_LEVEL", now?.accessLevel == "CHECK_ONLY" { return C.keep["ACCESS_LEVEL"]! }
        if part == "RUNS_PER_WEEK", now?.runsPerWeek == 1 { return C.keep["RUNS_PER_WEEK"]! }
        if part == "RUN_LIMIT", let now { return fill(C.keep["RUN_LIMIT"]!, ["minutes": String(now.runLimitMinutes)]) }
        if part == "WORKSPACE", let workspaceName { return fill(C.keep["WORKSPACE"]!, ["workspace": workspaceName]) }
        if part == "PROBE_COMMAND" { return ScheduleConditionCopy.keep }
        return C.keep["other"]!
    }

    /// The note under an envelope card.
    public static func envelopeNote(widens: [String]) -> String {
        if widens.contains("PROBE_COMMAND") { return ScheduleConditionCopy.commandNote }
        return widens.contains("ACCESS_LEVEL")
            ? "\(C.EnvelopeCard.appliesFromNextRun) \(C.EnvelopeCard.checkedEachRun)"
            : C.EnvelopeCard.appliesFromNextRun
    }

    /// A widen card in Waiting on you: "<reason> Now: Check only. Asked: Open a PR · edits in its own worktree…".
    public static func widenWaitingText(reason: String, widens: [String], now: ScheduleEnvelope?,
                                        asked: ScheduleEnvelope, ruleNow: ScheduleRule? = nil,
                                        ruleAsked: ScheduleRule? = nil, workspaceNames: [String: String] = [:]) -> String {
        let sides = envelopeSides(widens: widens, now: now, asked: asked, ruleNow: ruleNow, ruleAsked: ruleAsked,
                                  workspaceNames: workspaceNames)
        let access = headPart(widens) == "ACCESS_LEVEL"
        let nowText = sides.now.map { access ? $0.lead : $0.text } ?? ""
        let askedText = access ? "\(sides.asked.lead)\(C.separator)\(sides.asked.detail)" : sides.asked.text
        return fill(C.Waiting.widenBody, ["reason": reason, "now": nowText, "asked": askedText])
            .trimmingCharacters(in: .whitespaces)
    }

    /// The pieces an envelope card draws, from the card and the schedule it changes.
    public struct EnvelopeCardText: Equatable, Sendable {
        public let title: String
        public let now: EnvelopeSide?
        public let asked: EnvelopeSide
        public let keep: String
        public let note: String
    }

    public static func envelopeCard(_ card: ScheduleCard, scheduleTitle: String?,
                                    ruleNow: ScheduleRule?) -> EnvelopeCardText? {
        guard let envelope = card.envelope else { return nil }
        var names: [String: String] = [:]
        for lines in [envelope.now, envelope.asked].compactMap({ $0 }) {
            if let name = lines.runsIn.workspaceName { names[lines.runsIn.workspaceId] = name }
        }
        let ruleAsked = ScheduleRule(json: card.proposed?["rule"])
        let sides = envelopeSides(widens: envelope.widens, now: envelope.now?.envelope, asked: envelope.asked.envelope,
                                  ruleNow: ruleNow, ruleAsked: ruleAsked, workspaceNames: names)
        let title = card.title ?? scheduleTitle ?? ""
        return EnvelopeCardText(
            title: envelopeTitle(title, widens: envelope.widens, workspaceName: envelope.asked.runsIn.workspaceName, accessLevel: envelope.asked.may.accessLevel),
            now: sides.now, asked: sides.asked,
            keep: keepLabel(widens: envelope.widens, now: envelope.now?.envelope,
                            workspaceName: envelope.now?.runsIn.workspaceName),
            note: envelopeNote(widens: envelope.widens))
    }

    // MARK: - A change conversation (§8.2, board 03-change)

    /// The opening's rows, in order, as label and text (the shared `scheduleChangeOpeningRows`).
    public static func changeOpeningRows(_ opening: ScheduleChangeOpening) -> [(label: String, text: String)] {
        [
            (C.ChangeConversation.does, opening.does),
            (C.ChangeConversation.when, opening.when),
            (C.ChangeConversation.runsIn, opening.runsIn),
            (C.ChangeConversation.may, opening.may),
            (C.ChangeConversation.costs, opening.costs),
        ]
    }

    /// "Change Codex stable check": the draft page's and the conversation's title.
    public static func changeConversationTitle(_ title: String) -> String {
        fill(C.ChangeConversation.title, ["title": title])
    }

    /// "What should change about Codex stable check? This is what it does now:".
    public static func changeConversationLead(_ title: String) -> String {
        fill(C.ChangeConversation.lead, ["title": title])
    }

    // MARK: - History and the change line

    /// Who a history entry names: You, Session or Run — and You allowed for a change a session or a run asked for
    /// that grew the envelope, which only the owner's Allow can apply (§4).
    public static func historyWho(changedBy: String, before: [String: JSONValue]?,
                                  after: [String: JSONValue]?) -> (who: String, text: String) {
        if changedBy != "USER", let b = ScheduleEnvelope(json: before?["envelope"]),
           let a = ScheduleEnvelope(json: after?["envelope"]), !widenedParts(before: b, after: a).isEmpty {
            return ("ALLOWED", C.History.who["ALLOWED"]!)
        }
        return (changedBy, C.History.who[changedBy] ?? changedBy)
    }

    static func fieldValueText(_ field: String, _ value: JSONValue?, names: [String: String]) -> String {
        guard let value, value != .null else { return field == "endAt" || field == "maxRuns" ? C.History.noEnd : "" }
        if field == "accessLevel" { return C.access[value.asString ?? ""]?.label ?? (value.asString ?? "") }
        if field == "runLimitMinutes" { return fill(C.History.minutes, ["minutes": value.asString ?? ""]) }
        if field == "workspaceId" { return names[value.asString ?? ""] ?? (value.asString ?? "") }
        return value.asString ?? ""
    }

    static func ruleChangeText(before: ScheduleRule?, after: ScheduleRule) -> (field: String?, text: String) {
        if let before, let bt = before.time, let at = after.time {
            let sameShape: Bool
            switch (before, after) {
            case (.daily, .daily): sameShape = true
            case (.weekly(_, let a), .weekly(_, let b)): sameShape = a == b
            default: sameShape = false
            }
            if sameShape && bt != at {
                return (C.History.fields["rule"]!,
                        fill(C.History.change, ["field": C.History.fields["rule"]!, "before": bt, "after": at]))
            }
            if bt == at {
                // "Daily → Mondays 10:00": the time is said once, after the arrow.
                var was = String(ruleText(before, form: .short).dropLast(bt.count))
                while was.hasSuffix(" ") { was.removeLast() }
                if was.hasSuffix(" at") { was.removeLast(3) }
                return (nil, fill(C.History.ruleChange, ["before": was, "after": ruleText(after, form: .short)]))
            }
        }
        return (nil, fill(C.History.ruleChange, ["before": before.map { ruleText($0, form: .short) } ?? "",
                                                 "after": ruleText(after, form: .short)]))
    }

    /// What a revision changed, as one line: "Time 10:00 → 09:00", "Access → Open a PR", "Prompt: …",
    /// "Daily → Mondays 10:00", "Name: Codex check → Codex stable check", "Created · Check only · up to 7 runs a
    /// week", "Paused". `field` is the label the change line lowercases.
    public static func recordParts(revision: Int, before: [String: JSONValue]?, after: [String: JSONValue],
                                   names: [String: String] = [:]) -> (field: String?, text: String) {
        if revision == 1 || before == nil {
            let envelope = ScheduleEnvelope(json: after["envelope"])
            let access = after["accessLevel"]?.asString ?? envelope?.accessLevel
            return (nil, fill(C.History.created, [
                "access": access.map { accessCopy($0).label } ?? "",
                "runs": envelope.map { fill(C.Costs.runsOnly, ["runs": runsPerWeekText($0.runsPerWeek)]) } ?? "",
            ]))
        }
        let before = before ?? [:]
        if let state = after["state"]?.asString {
            if state == "PAUSED" { return (nil, C.History.paused) }
            if state == "ENDED" {
                let reason = C.endedReasons[after["endedReason"]?.asString ?? ""] ?? ""
                return (nil, fill(C.History.ended, ["reason": reason]))
            }
            if state == "ACTIVE" { return (nil, C.History.resumed) }
        }
        let fields = after.keys.filter { $0 != "envelope" && $0 != "endedReason" }.sorted()
        guard let key = fields.first(where: { $0 == "rule" }) ?? fields.first(where: { $0 == "accessLevel" })
            ?? orderedFirst(after: after, among: fields) else { return (nil, "") }
        if key == "rule", let rule = ScheduleRule(json: after["rule"]) {
            return ruleChangeText(before: ScheduleRule(json: before["rule"]), after: rule)
        }
        let label = C.History.fields[key] ?? key
        let a = fieldValueText(key, after[key], names: names)
        if key == "prompt" || key == "intent" { return (label, fill(C.History.changeText, ["field": label, "after": a])) }
        if key == "title" {
            return (label, fill(C.History.changeText,
                                ["field": label, "after": "\(fieldValueText(key, before[key], names: names)) → \(a)"]))
        }
        if key == "accessLevel" { return (label, fill(C.History.changeTo, ["field": label, "after": a])) }
        return (label, fill(C.History.change, ["field": label, "before": fieldValueText(key, before[key], names: names),
                                               "after": a]))
    }

    /// The web takes the first key the change wrote; a Swift dictionary has no order, so the field list's
    /// order (`history.fields`) stands in for it.
    static func orderedFirst(after: [String: JSONValue], among fields: [String]) -> String? {
        let order = ["title", "prompt", "intent", "rule", "timezone", "endAt", "maxRuns", "accessLevel", "runLimitMinutes",
                     "workspaceId"]
        return order.first(where: fields.contains) ?? fields.first
    }

    /// A person's rename as the history says it (§8.4 *Rename*): "Renamed from “Codex check”". Nil for any other
    /// record, an agent's new title included (web `scheduleRenamedText`).
    public static func renamedText(_ record: ScheduleChangeRecord) -> String? {
        guard record.changedBy == "USER", record.after.count == 1, record.after["title"] != nil,
              let before = record.before else { return nil }
        return fill(C.History.renamed, ["title": before["title"]?.asString ?? ""])
    }

    /// The title a rename field would save: trimmed, and nil when that is empty or the name it opened with.
    public static func renameTitle(_ draft: String, from title: String) -> String? {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty || trimmed == title.trimmingCharacters(in: .whitespacesAndNewlines) ? nil : trimmed
    }

    public static func recordText(_ record: ScheduleChangeRecord, names: [String: String] = [:]) -> String {
        recordParts(revision: record.revision, before: record.before, after: record.after, names: names).text
    }

    /// The change line in a session: "Changed Codex stable check: time 10:00 → 09:00", or for an end "Ended
    /// Release 2.0 freeze watch: goal reached · by this run".
    public static func changeLineText(title: String, revision: Int, changedBy: String, before: [String: JSONValue]?,
                                      after: [String: JSONValue], names: [String: String] = [:]) -> String {
        if after["state"]?.asString == "ENDED" {
            let reason = C.endedReasons[after["endedReason"]?.asString ?? ""] ?? ""
            let by = changedBy == "RUN" ? C.Record.byThisRun : changedBy == "USER" ? C.Record.byYou : C.Record.byASession
            return fill(C.Record.ended, ["title": title, "reason": reason, "by": by])
        }
        let parts = recordParts(revision: revision, before: before, after: after, names: names)
        let change = parts.field.map { parts.text.hasPrefix($0) } == true ? lowerFirst(parts.text) : parts.text
        return fill(C.Record.changed, ["title": title, "change": change])
    }

    public static func changeLineText(_ record: ScheduleChangeRecord, names: [String: String] = [:]) -> String {
        changeLineText(title: record.title, revision: record.revision, changedBy: record.changedBy,
                       before: record.before, after: record.after, names: names)
    }

    /// The change line's parts for drawing: "Changed " + bold title + ": rest".
    public static func changeLineParts(_ record: ScheduleChangeRecord,
                                       names: [String: String] = [:]) -> (lead: String, title: String, rest: String) {
        let text = changeLineText(record, names: names)
        guard !record.title.isEmpty, let range = text.range(of: record.title) else { return (text, "", "") }
        return (String(text[..<range.lowerBound]), record.title, String(text[range.upperBound...]))
    }

    // MARK: - Waiting on you

    public struct WaitingText: Equatable, Sendable {
        public let title: String
        public let kind: String
        public let body: String
        public let actions: [String]
        public var alwaysAllow: String? = nil
    }

    static let summaryMax = 120

    /// The failure clause a failure card and its push say (S5 `failedWaitingClause`): a REPORTED_FAILED run's own
    /// summary, one line of at most 120 characters with no closing full stop, else the reason's clause.
    static func failedWaitingClause(failureReason: String?, reasonText: String?, summary: String?) -> String {
        reportedFailureClause(failureReason: failureReason, reasonText: reasonText, summary: summary)
            ?? failureClause(failureReason: failureReason, reasonText: reasonText)
            ?? C.failureReasons["REPORTED_FAILED"]!
    }

    /// A REPORTED_FAILED run's clause with its own summary (shared `reportedFailureClause`), or nil when the run has
    /// none, or the server wrote its own reasonText.
    static func reportedFailureClause(failureReason: String?, reasonText: String?, summary: String?) -> String? {
        guard reasonText == nil, let template = C.failureReasonsWithSummary[failureReason ?? ""] else { return nil }
        var flat = (summary ?? "").split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        while let last = flat.last, last == "." || last == "。" { flat.removeLast() }
        guard !flat.isEmpty else { return nil }
        let clipped = flat.count <= summaryMax
            ? flat
            : String(flat.prefix(summaryMax - 1)).trimmingCharacters(in: .whitespaces) + "…"
        return fill(template, ["summary": clipped])
    }

    /// A failure's push (S5 `scheduleFailedPush`): the card's title, and "The last run ended without a report. It
    /// keeps running until you pause it."
    public static func failedPush(title: String, consecutiveFailures: Int, failureReason: String?, reasonText: String?,
                                  summary: String? = nil, plannedAt: String, timezone: String) -> (title: String, body: String) {
        let card = failedWaiting(title: title, consecutiveFailures: consecutiveFailures, failureReason: failureReason,
                                 reasonText: reasonText, summary: summary, plannedAt: plannedAt, timezone: timezone)
        return (card.title, fill(C.Push.failedBody, ["reason": failedWaitingClause(failureReason: failureReason,
                                                                                    reasonText: reasonText,
                                                                                    summary: summary)]))
    }

    /// "Release 2.0 freeze watch ended itself".
    public static func goalReachedPushTitle(_ title: String) -> String {
        fill(C.Push.goalReachedTitle, ["title": title])
    }

    /// A failed schedule's card: "Nightly pg spec sweep failed 3 runs in a row".
    public static func failedWaiting(title: String, consecutiveFailures: Int, failureReason: String?,
                                     reasonText: String?, summary: String? = nil, plannedAt: String,
                                     timezone: String) -> WaitingText {
        let at = parse(plannedAt) ?? Date(timeIntervalSince1970: 0)
        return WaitingText(
            title: consecutiveFailures > 1
                ? fill(C.Waiting.failedTitleInARow, ["title": title, "count": String(consecutiveFailures)])
                : fill(C.Waiting.failedTitle, ["title": title]),
            kind: C.Waiting.kindsSchedule,
            body: fill(C.Waiting.failedBody, [
                "reason": failedWaitingClause(failureReason: failureReason, reasonText: reasonText, summary: summary),
                "when": "\(dateText(at, timezone: timezone)), \(localParts(at, timezone: timezone).time)",
            ]),
            actions: [C.Actions.openRun, C.Actions.pauseSchedule])
    }

    /// A held schedule's card: "Weekly dependency audit is held".
    public static func heldWaiting(title: String, heldReason: String?, plannedAt: String, agentName: String? = nil,
                                   workspaceName: String? = nil, now: Date, timezone: String) -> WaitingText {
        let held = heldClause(heldReason, agent: agentName, workspace: workspaceName)
        let agent = heldReason == "AGENT_DISABLED" || heldReason == "AGENT_MISSING"
        let whereText = agent && agentName != nil && workspaceName != nil
            ? fill(C.heldWhere, ["workspace": workspaceName!]) : ""
        var reason = held?.clause ?? ""
        if !whereText.isEmpty {
            for tail in [" is disabled", " no longer exists"] where reason.hasSuffix(tail) {
                reason = String(reason.dropLast(tail.count)) + whereText + tail
                break
            }
        }
        return WaitingText(
            title: fill(C.Waiting.heldTitle, ["title": title]),
            kind: C.Waiting.kindsSchedule,
            body: fill(C.Waiting.heldBody, [
                "when": pastWhenText(parse(plannedAt) ?? now, now: now, timezone: timezone),
                "reason": reason,
                "until": held?.until ?? C.heldReasons["SESSION_REFUSED"]!.until,
            ]),
            actions: [agent ? C.Actions.openAgentSettings : C.Actions.openSchedule, C.Actions.resume])
    }

    /// A run's approval card: "Nightly pg spec sweep wants to run a command".
    public static func approvalWaiting(title: String, deadline: String, nextAt: String?, pattern: String,
                                       workspaceName: String, now: Date, timezone: String) -> WaitingText {
        let deadlineTime = parse(deadline).map { localParts($0, timezone: timezone).time } ?? ""
        let nextDay = nextAt.flatMap(parse).map { dayText($0, now: now, timezone: timezone) } ?? ""
        let next = nextDay == C.Dates.today ? C.Dates.todayLower : nextDay == C.Dates.tomorrow ? C.Dates.tomorrowLower : nextDay
        return WaitingText(
            title: fill(C.Waiting.approvalTitle, ["title": title]),
            kind: C.Waiting.kindsRun,
            body: fill(C.Waiting.approvalBody, ["deadline": deadlineTime, "next": next]),
            actions: [C.Actions.alwaysAllow, C.Actions.allowOnce, C.Actions.deny],
            alwaysAllow: fill(C.Waiting.approvalAlwaysAllow, ["pattern": pattern, "workspace": workspaceName]))
    }

    /// How long a run waits on an approval before it fails (§6.4): the approval card's deadline.
    public static let approvalTimeout: TimeInterval = 2 * 60 * 60

    // MARK: - A run's session

    /// "Scheduled run · planned 10:00, started 10:01 · access Check only".
    public static func runStripText(plannedAt: String, startedAt: String?, accessLevel: String,
                                    timezone: String) -> String {
        fill(C.RunSession.strip, [
            "planned": parse(plannedAt).map { localParts($0, timezone: timezone).time } ?? "",
            "started": startedAt.flatMap(parse).map { localParts($0, timezone: timezone).time } ?? "—",
            "access": accessCopy(accessLevel).label,
        ])
    }

    /// "Run of Nov 13": the label for a run in a schedule's history.
    public static func capitalizedRunOf(plannedAt: String, timezone: String) -> String {
        capitalize(runOfText(plannedAt: plannedAt, timezone: timezone))
    }

    /// The delete question's title: "Delete “Codex stable check”?".
    public static func deleteTitle(_ title: String) -> String {
        fill(C.DeleteConfirm.title, ["title": title])
    }

    /// "run of Nov 13".
    public static func runOfText(plannedAt: String, timezone: String) -> String {
        fill(C.RunSession.runOf, ["date": parse(plannedAt).map { dateText($0, timezone: timezone) } ?? ""])
    }

    /// A run that has ended, which is when its report is drawn.
    public static func runEnded(_ state: String) -> Bool {
        ["NO_CHANGE", "CHANGED", "FAILED", "MISSED", "SKIPPED", "HELD", "CANCELLED"].contains(state)
    }

    /// Whether a run's report is a failure's line rather than "Reported: …".
    public static func runReportFailed(_ state: String) -> Bool {
        state != "NO_CHANGE" && state != "CHANGED"
    }

    /// Whether this run's finding was new, and whether the owner was told (the web's `runFindingFacts`): the list's
    /// own answer when it carries one, else worked out from the schedule's findings.
    public static func runFindingFacts(_ run: ScheduleRunView,
                                       findings: [ScheduleFindingView]) -> (newFinding: Bool, notified: Bool) {
        if let isNew = run.newFinding { return (isNew, run.notified ?? false) }
        guard let key = run.key, let finding = findings.first(where: { $0.key == key }),
              let first = finding.firstRunId else { return (false, false) }
        let isNew = PublicID.storageKey(first) == PublicID.storageKey(run.id)
        return (isNew, isNew && finding.notifiedAt != nil)
    }

    /// The record's Undo still applies: it has a door, nothing undid it, and it is not itself an undo.
    public static func recordUndoable(_ record: ScheduleChangeRecord) -> Bool {
        record.undo != nil && record.undoneByRevision == nil && record.undoOfRevision == nil
    }

    /// "Reported: Changed · codex@0.49.0 · you were notified".
    public static func reportedText(state: String, key: String?, notified: Bool = false) -> String {
        var parts = [fill(C.RunSession.reported, ["state": C.runStates[state] ?? state])]
        if let key, !key.isEmpty { parts.append(key) }
        if notified { parts.append(C.Row.notified) }
        return parts.joined(separator: C.separator)
    }
}

fileprivate extension String {
    func scheduleReplacingFirst(_ target: String, with replacement: String) -> String {
        guard let range = range(of: target) else { return self }
        return replacingCharacters(in: range, with: replacement)
    }
}
