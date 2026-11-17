import Foundation

/// A WHEN rule's words as the shared `SCHEDULE_CONDITION_COPY` (src/shared/src/schedule.ts) says them, word for word
/// (ConditionDisplayTests reads that file): the When lines of a create card, and an envelope card for a new probe
/// command.
public enum ScheduleConditionCopy {
    public static let rulesShort = "{condition}"
    public static let rulesLong = "When {condition}"
    public static let held = "{condition} for {duration}"
    public static let rearm = "Fires again only after it {rearm}."
    public static let rearmWhenFalse = "Fires again once it no longer holds."
    public static let rearmOps: [String: String] = [
        "GT": "goes above {value}",
        "GTE": "reaches {value}",
        "LT": "drops below {value}",
        "LTE": "drops to {value}",
        "EQ": "reads {value}",
        "EXIT_ZERO": "succeeds again",
    ]
    public static let `repeat` = "And again every {interval} while it stays that way."
    public static let repeatUnits: [String: String] = [
        "hour": "hour", "hours": "{count} hours", "minute": "minute", "minutes": "{count} minutes",
    ]
    public static let checked = "Checked every {interval} on {runner}, no model."
    public static let checkedNoRunner = "Checked every {interval}, no model."
    public static let keepsAwake = "Keeps this cloud workspace awake while it waits."
    public static let seconds = "{count} s"
    public static let minutes = "{count} min"
    public static let hours = "{count} h"
    public static let keep = "Keep the approved command"
    public static let commandNote =
        "It runs on its own, without a model, every time the condition is checked. Read it before you allow it."

    /// Every sentence above under its path in `SCHEDULE_CONDITION_COPY`: what the parity test reads.
    public static let contract: [String: String] = {
        var out: [String: String] = [
            "rules.short": rulesShort, "rules.long": rulesLong, "held": held, "rearm": rearm,
            "rearmWhenFalse": rearmWhenFalse, "repeat": `repeat`, "checked": checked,
            "checkedNoRunner": checkedNoRunner, "seconds": seconds, "minutes": minutes, "hours": hours, "keep": keep,
            "commandNote": commandNote,
        ]
        for (k, v) in rearmOps { out["rearmOps.\(k)"] = v }
        for (k, v) in repeatUnits { out["repeatUnits.\(k)"] = v }
        return out
    }()
}

/// The words the condition surfaces add on the clients (condition-triggers board ④ ⑤ ⑥ and frame 2): the Scheduled
/// page's group and readings, the inspector's Condition and How it checks blocks and history lines, a run's header,
/// and the Waiting on you cards. iOS is the reference; macOS and Android read this file.
public enum ConditionCopy {
    public static let group = "Waiting for a condition"
    public static let cantRead = "Can't read"
    /// A task row's second line: "Task · once, when 3 or more OSDs are in · HPC".
    public static let taskRow = "Task"
    public static let taskOnce = "once, when {condition}"
    public static let justNow = "just now"
    public static let minutesAgo = "{count} min ago"
    public static let hoursAgo = "{count} h ago"
    public static let daysAgo = "{count} d ago"
    /// The inspector's reading: "checked 1 min ago".
    public static let checkedAgo = "checked {age}"
    public static let notReadYet = "Not read yet"
    public static let conditionSection = "Condition"
    public static let howItChecks = "How it checks"
    public static let every = "Every {interval} on {runner}, without a model."
    public static let everyNoRunner = "Every {interval}, without a model."
    public static let approved = "Read-only. Approved by you on {date}."
    /// "Fires above 90% for 10 min."
    public static let fires = "Fires {op} {value}{hold}."
    public static let firesWhenSucceeds = "Fires when the check succeeds{hold}."
    public static let holdFor = " for {duration}"
    /// "Ready again below 85%."
    public static let readyAgain = "Ready again {op} {value}."
    public static let readyAgainWhenSucceeds = "Ready again when the check succeeds."
    public static let readyAgainWhenFalse = "Ready again once it no longer holds."
    public static let ops: [String: String] = [
        "GT": "above", "GTE": "at or above", "LT": "below", "LTE": "at or below", "EQ": "at",
    ]
    /// The history's lines and their chips.
    public static let historyFired = "Fired · {reading}{hold}"
    public static let historyFiredAgain = "Fired again · {reading}"
    public static let historyReadyAgain = "Ready again · {reading}"
    public static let historyCantRead = "Can't read"
    public static let historyReadAgain = "Reads again · {reading}"
    public static let historyAsked = "Asked whether to keep waiting"
    public static let chipRun = "Run"
    public static let chipCondition = "Condition"
    /// A run's session's header (board ⑤ ②): "Fired 03:12 · 90.4% for 10 min · Check only".
    public static let runFired = "Fired {time}"
    public static let runFiredAgain = "Fired again {time}"
    /// Waiting on you (board ⑥ ①).
    public static let waitingKind = "Condition"
    public static let pause = "Pause"
    public static let lookIntoIt = "Look into it"
    public static let keepWaiting = "Keep waiting"
    public static let stop = "Stop"
    /// The task create card (board frame 2): its title and the three lines a startWhen adds.
    public static let createTaskTitle = "Create task that starts on a condition?"
    public static let startsWhen = "Starts when"
    public static let today = "Today"
    public static let ifNever = "If never"

    /// Every sentence above, so the copy guard reads them as English.
    public static let all: [String] = [
        group, cantRead, taskRow, taskOnce, justNow, minutesAgo, hoursAgo, daysAgo, checkedAgo, notReadYet,
        conditionSection, howItChecks, every, everyNoRunner, approved, fires, firesWhenSucceeds, holdFor, readyAgain,
        readyAgainWhenSucceeds, readyAgainWhenFalse, historyFired, historyFiredAgain, historyReadyAgain,
        historyCantRead, historyReadAgain, historyAsked, chipRun, chipCondition, runFired, runFiredAgain, waitingKind,
        pause, lookIntoIt, keepWaiting, stop, createTaskTitle, startsWhen, today, ifNever,
    ] + ops.values.sorted()
}

/// The rules that turn a condition's reads into what the Apple clients draw. Pure and Foundation-only, so it runs in
/// the Linux `swift test`.
public enum ConditionDisplay {
    private typealias C = ConditionCopy
    private typealias CC = ScheduleConditionCopy
    private static func fill(_ t: String, _ v: [String: String]) -> String { ScheduleDisplay.fill(t, v) }

    // MARK: readings

    /// A number as a reading says it: "2", "6.9", "90.4", at most two decimals (the server's `readingText`).
    public static func numberText(_ value: Double) -> String {
        if value == value.rounded(), abs(value) < 1e15 { return String(Int(value)) }
        let rounded = (value * 100).rounded() / 100
        if rounded == rounded.rounded() { return String(Int(rounded)) }
        var text = String(format: "%.2f", rounded)
        while text.hasSuffix("0") { text.removeLast() }
        return text
    }

    /// A reading with its unit: "6.9%", "2 in", "412 GiB".
    public static func readingText(_ value: Double, unit: String?) -> String {
        let n = numberText(value)
        guard let unit, !unit.isEmpty else { return n }
        return unit == "%" ? "\(n)%" : "\(n) \(unit)"
    }

    /// How old a reading is: "just now", "1 min ago", "3 h ago", "2 d ago".
    public static func ageText(_ at: Date, now: Date) -> String {
        let minutes = Int(max(0, now.timeIntervalSince(at)) / 60)
        if minutes < 1 { return C.justNow }
        if minutes < 60 { return fill(C.minutesAgo, ["count": String(minutes)]) }
        let hours = minutes / 60
        if hours < 48 { return fill(C.hoursAgo, ["count": String(hours)]) }
        return fill(C.daysAgo, ["count": String(hours / 24)])
    }

    /// A row's reading where a timed row shows its time (board ④ ②): "6.9%" and "1 min ago"; nil before a first
    /// reading.
    public struct RowReading: Equatable, Sendable {
        public let value: String
        public let age: String?
        public var text: String { [value, age].compactMap { $0 }.joined(separator: ScheduleCopy.separator) }
    }

    public static func rowReading(value: Double?, unit: String?, at: String?, now: Date) -> RowReading? {
        guard let value else { return nil }
        return RowReading(value: readingText(value, unit: unit),
                          age: at.flatMap(ScheduleDisplay.parse).map { ageText($0, now: now) })
    }

    public static func rowReading(_ reading: ScheduleConditionReading, now: Date) -> RowReading? {
        rowReading(value: reading.lastValue, unit: reading.unit, at: reading.lastSampleAt, now: now)
    }

    // MARK: the rows

    /// A WHEN schedule's or a waiting task's mark: the gauge in place of the circle, amber and "Can't read" when its
    /// probe cannot be read.
    public static func circle(cantRead: Bool) -> ScheduleDisplay.CircleView {
        cantRead
            ? ScheduleDisplay.CircleView(.held, nil, ScheduleDisplay.Tag(tone: .held, text: C.cantRead), gauge: true)
            : ScheduleDisplay.CircleView(.open, gauge: true)
    }

    /// A waiting task's second line: "Task · once, when 3 or more OSDs are in · HPC".
    public static func taskRowLine(_ task: ScheduleWaitingTask) -> String {
        var parts = [C.taskRow, fill(C.taskOnce, ["condition": ScheduleDisplay.lowerFirst(task.condition.text)])]
        if let name = task.workspaceName, !name.isEmpty { parts.append(name) }
        return parts.joined(separator: ScheduleCopy.separator)
    }

    /// A task's waiting line (§6.2, Tasks): the server's "Waiting for: 3 or more OSDs are in", and the newest reading
    /// with its age ("2 in · 3 min ago"); nil once it fired or ended.
    public static func taskWaiting(_ startWhen: TaskStartWhenView?, now: Date) -> (line: String, reading: String?)? {
        guard let startWhen, let line = startWhen.waitingLine else { return nil }
        let reading = startWhen.state == "UNKNOWN"
            ? C.cantRead
            : rowReading(value: startWhen.lastValue, unit: startWhen.unit, at: startWhen.lastSampleAt, now: now)?.text
        return (line, reading)
    }

    // MARK: the When lines (shared `scheduleWhenLines`)

    /// "10 min", "45 s", "2 h".
    public static func durationText(_ seconds: Int) -> String {
        if seconds < 60 { return fill(CC.seconds, ["count": String(seconds)]) }
        if seconds < 7200 || seconds % 3600 != 0 {
            return fill(CC.minutes, ["count": String(Int((Double(seconds) / 60).rounded()))])
        }
        return fill(CC.hours, ["count": String(seconds / 3600)])
    }

    /// "And again every 2 hours while it stays that way."; nil with no repeat.
    public static func repeatText(_ seconds: Int?) -> String? {
        guard let seconds else { return nil }
        let interval: String
        if seconds % 3600 == 0 {
            interval = seconds == 3600 ? CC.repeatUnits["hour"]! : fill(CC.repeatUnits["hours"]!, ["count": String(seconds / 3600)])
        } else {
            let minutes = Int((Double(seconds) / 60).rounded())
            interval = minutes == 1 ? CC.repeatUnits["minute"]! : fill(CC.repeatUnits["minutes"]!, ["count": String(minutes)])
        }
        return fill(CC.repeat, ["interval": interval])
    }

    /// A WHEN rule's lines worked out on the client, for a card from a server that sends none.
    public static func whenLines(_ condition: ScheduleWhenCondition, runner: String?,
                                 keepsWorkspaceAwake: Bool = false) -> ScheduleWhenLines {
        let text = condition.holdSeconds > 0
            ? fill(CC.held, ["condition": condition.text, "duration": durationText(condition.holdSeconds)])
            : condition.text
        let rearm: String
        if let r = condition.rearm, let op = CC.rearmOps[r.op] {
            rearm = fill(CC.rearm, ["rearm": fill(op, ["value": r.value.map { readingText($0, unit: condition.unit) } ?? ""])])
        } else {
            rearm = CC.rearmWhenFalse
        }
        let interval = durationText(condition.intervalSeconds)
        let checked = runner.map { fill(CC.checked, ["interval": interval, "runner": $0]) }
            ?? fill(CC.checkedNoRunner, ["interval": interval])
        return ScheduleWhenLines(text: text, detail: "\(rearm) \(checked)", command: condition.command,
                                 repeat: repeatText(condition.repeatSeconds),
                                 awake: keepsWorkspaceAwake ? CC.keepsAwake : nil)
    }

    /// The When line split for drawing: the condition in bold, the hold after it ("**Raw used above 90%** for 10 min").
    public static func whenTextParts(_ lines: ScheduleWhenLines, condition: ScheduleWhenCondition?) -> (bold: String, rest: String) {
        guard let text = condition?.text, lines.text.hasPrefix(text) else { return (lines.text, "") }
        return (text, String(lines.text.dropFirst(text.count)))
    }

    // MARK: the inspector (board ⑥ ② ③)

    /// "Fires above 90% for 10 min."
    public static func firingLine(compare: ConditionCompare, holdSeconds: Int, unit: String?) -> String {
        let hold = holdSeconds > 0 ? fill(C.holdFor, ["duration": durationText(holdSeconds)]) : ""
        guard compare.op != "EXIT_ZERO", let op = C.ops[compare.op], let value = compare.value else {
            return fill(C.firesWhenSucceeds, ["hold": hold])
        }
        return fill(C.fires, ["op": op, "value": readingText(value, unit: unit), "hold": hold])
    }

    /// "Ready again below 85%."
    public static func rearmLine(rearm: ConditionCompare?, unit: String?) -> String {
        guard let rearm else { return C.readyAgainWhenFalse }
        guard rearm.op != "EXIT_ZERO", let op = C.ops[rearm.op], let value = rearm.value else {
            return C.readyAgainWhenSucceeds
        }
        return fill(C.readyAgain, ["op": op, "value": readingText(value, unit: unit)])
    }

    /// The Condition block's lines.
    public struct ConditionBlock: Equatable, Sendable {
        /// "6.9%", or nil before a first reading.
        public let reading: String?
        /// "checked 1 min ago", or "Not read yet".
        public let checked: String
        /// "Fires above 90% for 10 min. Ready again below 85%."
        public let rule: String
        /// "And again every 2 hours while it stays that way."
        public let `repeat`: String?
        /// "Can't read" while the probe cannot be read.
        public let cantRead: String?
        public let bar: Bar?
    }

    /// The bar under the reading: where the reading, the firing line and the re-arm line sit on one scale (0…1).
    public struct Bar: Equatable, Sendable {
        public let value: Double
        public let fire: Double
        public let fireLabel: String
        public let rearm: Double?
        public let rearmLabel: String?
    }

    public static func bar(value: Double?, compare: ConditionCompare, rearm: ConditionCompare?, unit: String?) -> Bar? {
        guard compare.op != "EXIT_ZERO", let fire = compare.value else { return nil }
        let rearmValue = rearm?.op == "EXIT_ZERO" ? nil : rearm?.value
        let top: Double
        if unit == "%" && max(fire, rearmValue ?? 0, value ?? 0) <= 100 {
            top = 100
        } else {
            top = max(fire, rearmValue ?? 0, value ?? 0) * 1.25
        }
        guard top > 0 else { return nil }
        func at(_ v: Double) -> Double { min(1, max(0, v / top)) }
        return Bar(value: at(value ?? 0), fire: at(fire), fireLabel: readingText(fire, unit: unit),
                   rearm: rearmValue.map(at), rearmLabel: rearmValue.map { readingText($0, unit: unit) })
    }

    public static func conditionBlock(_ c: ConditionView, now: Date) -> ConditionBlock {
        let reading = c.lastValue.map { readingText($0, unit: c.unit) }
        let at = (c.lastReadAt ?? c.lastSampleAt).flatMap(ScheduleDisplay.parse)
        return ConditionBlock(
            reading: reading,
            checked: at.map { fill(C.checkedAgo, ["age": ageText($0, now: now)]) } ?? C.notReadYet,
            rule: "\(firingLine(compare: c.compare, holdSeconds: c.holdSeconds, unit: c.unit)) \(rearmLine(rearm: c.rearm, unit: c.unit))",
            repeat: repeatText(c.repeatSeconds),
            cantRead: c.state == "UNKNOWN" ? C.cantRead : nil,
            bar: bar(value: c.lastValue, compare: c.compare, rearm: c.rearm, unit: c.unit))
    }

    /// The How it checks block: "Every 5 min on workstation-gpu, without a model.", the command, "Read-only.
    /// Approved by you on Nov 17.", and on Orbit Cloud that it keeps the workspace awake.
    public struct ChecksBlock: Equatable, Sendable {
        public let every: String
        public let command: String
        public let approved: String
        public let awake: String?
    }

    public static func checksBlock(_ c: ConditionView, timezone: String) -> ChecksBlock {
        let interval = durationText(c.intervalSeconds)
        let every = c.runnerName.map { fill(C.every, ["interval": interval, "runner": $0]) }
            ?? fill(C.everyNoRunner, ["interval": interval])
        let date = ScheduleDisplay.parse(c.approvedAt).map { ScheduleDisplay.dateText($0, timezone: timezone) } ?? ""
        return ChecksBlock(every: every, command: c.probe.command, approved: fill(C.approved, ["date": date]),
                           awake: c.keepsWorkspaceAwake ? CC.keepsAwake : nil)
    }

    /// One history line of a condition: "Fired · 90.4% for 10 min", "Ready again · 82.9%".
    public struct HistoryLine: Equatable, Sendable {
        public let text: String
        public let chip: String
        /// The run a FIRED started, which the line opens.
        public let runId: String?
    }

    public static func historyLine(_ e: ConditionEventView, condition: ConditionView) -> HistoryLine? {
        let reading = e.value.map { readingText($0, unit: condition.unit) } ?? ""
        switch e.kind {
        case "FIRED":
            let hold = condition.holdSeconds > 0 ? fill(C.holdFor, ["duration": durationText(condition.holdSeconds)]) : ""
            let text = e.repeat
                ? fill(C.historyFiredAgain, ["reading": reading])
                : fill(C.historyFired, ["reading": reading, "hold": hold])
            return HistoryLine(text: text, chip: e.runId != nil ? C.chipRun : C.chipCondition, runId: e.runId)
        case "READY_AGAIN":
            return HistoryLine(text: fill(C.historyReadyAgain, ["reading": reading]), chip: C.chipCondition, runId: nil)
        case "CANT_READ":
            return HistoryLine(text: C.historyCantRead, chip: C.chipCondition, runId: nil)
        case "READ_AGAIN":
            return HistoryLine(text: fill(C.historyReadAgain, ["reading": reading]), chip: C.chipCondition, runId: nil)
        case "ASKED_STILL_WAITING":
            return HistoryLine(text: C.historyAsked, chip: C.chipCondition, runId: nil)
        default:
            return nil
        }
    }

    // MARK: a run's session (board ⑤ ②)

    /// "Fired 03:12 · 90.4% for 10 min · Check only": what fired the run, in place of when it was planned. The value
    /// is the FIRED event's that started this run; without the condition's read, the time alone.
    public static func runFiredText(run: ScheduleRunView, condition: ConditionView?, accessLevel: String,
                                    timezone: String) -> String {
        let key = PublicID.storageKey(run.id)
        let event = condition?.events.first { $0.kind == "FIRED" && $0.runId.map(PublicID.storageKey) == key }
        let at = ScheduleDisplay.parse(event?.at ?? run.plannedAt).map { ScheduleDisplay.localParts($0, timezone: timezone).time } ?? ""
        var parts = [fill(event?.repeat == true ? C.runFiredAgain : C.runFired, ["time": at])]
        if let condition, let value = event?.value {
            let reading = readingText(value, unit: condition.unit)
            parts.append(condition.holdSeconds > 0 && event?.repeat != true
                         ? fill(ScheduleConditionCopy.held, ["condition": reading, "duration": durationText(condition.holdSeconds)])
                         : reading)
        }
        parts.append(ScheduleDisplay.accessCopy(accessLevel).label)
        return parts.joined(separator: ScheduleCopy.separator)
    }

    // MARK: Waiting on you (board ⑥ ①)

    /// The buttons a condition's card carries: Pause and Look into it on a can't-read card of a schedule, Look into it
    /// on a task's; the 30-day question's own two answers.
    public static func waitingActions(_ item: ConditionWaitingItem, scheduleId: String?) -> [String] {
        if item.isStillWaiting {
            let labels = item.options.map(\.label)
            return labels.isEmpty ? [C.keepWaiting, C.stop] : labels
        }
        return scheduleId != nil ? [C.pause, C.lookIntoIt] : [C.lookIntoIt]
    }
}
