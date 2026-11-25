import Foundation

// GENERATED from contracts/schedule.contract.json `copy` (the shared SCHEDULE_COPY, src/shared/src/schedule.ts) and
// held to it word for word by ScheduleCopyParityTests: change the contract, then this file, never this file alone.
// Placeholders are `{name}`, filled by `ScheduleDisplay.fill`.

/// One access level's words: its label, the create card's May detail, and the envelope card's brief Now.
public struct ScheduleAccessCopy: Equatable, Sendable {
    public let label: String
    public let detail: String
    public let brief: String
}

/// Why a schedule is held, as a clause, and what has to change before Resume.
public struct ScheduleHeldCopy: Equatable, Sendable {
    public let clause: String
    public let until: String
}

/// Every word the Scheduled page, its inspector, the cards and Waiting on you put on screen.
public enum ScheduleCopy {
    public enum Nav {
        public static let scheduled = "Scheduled"
    }
    public enum Page {
        public static let title = "Scheduled"
        public static let allWorkspaces = "All workspaces"
        public static let showPastRuns = "Show past runs"
    }
    public static let groups: [String: String] = [
        "TODAY": "Today",
        "TOMORROW": "Tomorrow",
        "LATER": "Later",
        "PAUSED": "Paused",
    ]
    public static let weekdays: [String: String] = [
        "MON": "Monday",
        "TUE": "Tuesday",
        "WED": "Wednesday",
        "THU": "Thursday",
        "FRI": "Friday",
        "SAT": "Saturday",
        "SUN": "Sunday",
    ]
    public static let weekdaysPlural: [String: String] = [
        "MON": "Mondays",
        "TUE": "Tuesdays",
        "WED": "Wednesdays",
        "THU": "Thursdays",
        "FRI": "Fridays",
        "SAT": "Saturdays",
        "SUN": "Sundays",
    ]
    public static let weekdaysShort: [String: String] = [
        "MON": "Mon",
        "TUE": "Tue",
        "WED": "Wed",
        "THU": "Thu",
        "FRI": "Fri",
        "SAT": "Sat",
        "SUN": "Sun",
    ]
    public static let months: [String] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    public enum Dates {
        public static let dayWithWeekday = "{weekday}, {month} {day}"
        public static let day = "{month} {day}"
        public static let today = "Today"
        public static let tomorrow = "Tomorrow"
        public static let todayLower = "today"
        public static let tomorrowLower = "tomorrow"
        public static let at = "{day} {time}"
    }
    public enum Rules {
        public static let shortDaily = "Daily {time}"
        public static let shortWeekday = "{weekdays} {time}"
        public static let shortWeekdays = "Weekdays at {time}"
        public static let shortDays = "{days} {time}"
        public static let shortOnce = "Once"
        public static let longDaily = "Every day at {time}"
        public static let longWeekday = "Every {weekday} at {time}"
        public static let longWeekdays = "Weekdays at {time}"
        public static let longDays = "Every {days} at {time}"
        public static let longOnce = "Once"
        public static let daysSeparator = ", "
    }
    public static let separator = " · "
    public enum Every {
        public static let minutes = "Every {count} min"
        public static let hour = "Every hour"
        public static let hours = "Every {count} hours"
        public static let window = "{interval}, {time}–{until}"
        public static let from = "{interval} from {time}"
        public static let days = "{rule}, {days}"
        public static let workweek = "Mon–Fri"
        public static let weekend = "weekends"
    }
    /// The planned end (§8.5) and the line a run of missed slots collapses into.
    public enum End {
        public static let until = "until {when}"
        public static let today = "{time} today"
        public static let tomorrow = "{time} tomorrow"
        public static let runLeft = "1 run left"
        public static let runsLeft = "{count} runs left"
        public static let missed = "{count} slots missed, {from}–{to}"
        public static let missedDated = "{count} slots missed, {fromDate}, {from}–{toDate}, {to}"
        public static let endLabel = "Ends"
        public static let extend = "Extend the end"
        public static let remove = "Remove the end"
        public static let extendAsk = "{title}: extend the end"
        public static let removeAsk = "{title}: remove the end"
    }
    public enum Landing {
        public static let landed = "Landed on main: {sha}."
        public static let failed = "Could not land on main: {reason}"
    }
    public static let access: [String: ScheduleAccessCopy] = [
        "CHECK_ONLY": ScheduleAccessCopy(label: "Check only", detail: "reads and reports, edits nothing", brief: "reads and reports"),
        "LAND": ScheduleAccessCopy(label: "Edit and land on main", detail: "edits in its own worktree, then Orbit merges it into main after the run. It can't release or deploy.", brief: "edits in its own worktree, then Orbit merges it into main after the run. It can't release or deploy."),
        "OPEN_PR": ScheduleAccessCopy(label: "Open a PR", detail: "edits in its own worktree and opens a PR. It can't merge or deploy.", brief: "edits in its own worktree and opens a PR. It can't merge or deploy."),
    ]
    public enum Costs {
        public static let upTo = "Up to {runs}, {minutes} min each"
        public static let upToLower = "up to {runs}, {minutes} min each"
        public static let runsOnly = "up to {runs}"
        public static let runsOne = "{count} run a week"
        public static let runsOther = "{count} runs a week"
        public static let allowed = "Allowed: {costs}"
    }
    public enum Row {
        public static let runningFor = "running for {minutes} min"
        public static let pausedOn = "paused {date}"
        public static let draft = "draft, waiting for you"
        public static let notified = "you were notified"
        public static let notNotified = "not notified"
        public static let runningShort = "running {minutes} min"
        public static let draftShort = "draft"
    }
    public enum Tags {
        public static let failedInARow = "Failed {count} in a row"
        public static let held = "Held"
        public static let failed = "Failed"
        public static let known = "Known"
        public static let `new` = "New"
    }
    public static let runStates: [String: String] = [
        "QUEUED": "Queued",
        "RUNNING": "Running",
        "AWAITING_APPROVAL": "Waiting for you",
        "NO_CHANGE": "No change",
        "CHANGED": "Changed",
        "FAILED": "Failed",
        "SKIPPED": "Skipped",
        "MISSED": "Missed",
        "HELD": "Held",
        "CANCELLED": "Cancelled",
    ]
    public static let failureReasons: [String: String] = [
        "RUNNER_UNAVAILABLE": "found no runner online",
        "RUNNER_FULL": "waited for a full runner until its window closed",
        "QUOTA": "hit the engine's usage limit",
        "ENGINE_CRASHED_BEFORE_START": "stopped before its engine started",
        "LANDING_FAILED": "could not land on main",
        "REPORTED_FAILED": "reported a failure",
        "NO_REPORT": "ended without a report",
        "ENGINE_CRASHED": "ended when its engine stopped",
        "APPROVAL_TIMEOUT": "waited 2 hours for an approval with no answer",
        "RUN_LIMIT": "ran past its run limit",
        "CANCELLED_BY_OWNER": "was stopped by you",
        "OVER_BUDGET": "was over what you allowed this week",
    ]
    public static let runReasonTexts: [String: String] = [
        "OVER_BUDGET": "Not started: it had already started as many scheduled runs in the past 7 days as you allowed.",
    ]
    public static let failureReasonsWithSummary: [String: String] = [
        "LANDING_FAILED": "could not land on main: {summary}",
        "REPORTED_FAILED": "reported a failure: {summary}",
    ]
    public static let heldReasons: [String: ScheduleHeldCopy] = [
        "WORKSPACE_NOT_OWNED": ScheduleHeldCopy(clause: "the workspace {workspace} is no longer yours", until: "it is yours again"),
        "WORKSPACE_DELETED": ScheduleHeldCopy(clause: "the workspace {workspace} was deleted", until: "it runs in another workspace"),
        "WORKSPACE_DISABLED": ScheduleHeldCopy(clause: "the workspace {workspace} is disabled", until: "it is enabled"),
        "AGENT_MISSING": ScheduleHeldCopy(clause: "the agent \"{agent}\" no longer exists", until: "it has an agent"),
        "AGENT_DISABLED": ScheduleHeldCopy(clause: "the agent \"{agent}\" is disabled", until: "it is enabled"),
        "OUTSIDE_ENVELOPE": ScheduleHeldCopy(clause: "it no longer fits what you allowed", until: "you allow it"),
        "ACCESS_NOT_ENFORCEABLE": ScheduleHeldCopy(clause: "the engine it would run on cannot enforce its access level", until: "it runs on an engine that can"),
        "MODE_WIDER_THAN_ACCOUNT_DEFAULT": ScheduleHeldCopy(clause: "your account's default permission mode is narrower than its runs use (set it to Default in Settings > General)", until: "your default mode allows it"),
        "WORKTREE_DISABLED": ScheduleHeldCopy(clause: "the workspace {workspace} has worktrees disabled", until: "worktrees are enabled"),
        "NO_REPOSITORY": ScheduleHeldCopy(clause: "the workspace {workspace} has no repository", until: "it has one"),
        "SESSION_REFUSED": ScheduleHeldCopy(clause: "its run's session could not be opened", until: "that is fixed"),
    ]
    public static let heldWhere = " in workspace {workspace}"
    public static let heldShort: [String: String] = [
        "WORKSPACE_NOT_OWNED": "workspace not yours",
        "WORKSPACE_DELETED": "workspace deleted",
        "WORKSPACE_DISABLED": "workspace disabled",
        "AGENT_MISSING": "agent missing",
        "AGENT_DISABLED": "agent disabled",
        "OUTSIDE_ENVELOPE": "outside what you allowed",
        "ACCESS_NOT_ENFORCEABLE": "access not enforceable",
        "MODE_WIDER_THAN_ACCOUNT_DEFAULT": "wider than your default mode",
        "WORKTREE_DISABLED": "worktrees disabled",
        "NO_REPOSITORY": "no repository",
        "SESSION_REFUSED": "session refused",
    ]
    public static let endedReasons: [String: String] = [
        "DELETED": "deleted",
        "END_REACHED": "its end time passed",
        "GOAL_REACHED": "goal reached",
    ]
    public enum Inspector {
        public static let nextRun = "Next run"
        public static let last = "Last"
        public static let whatItDoes = "What it does"
        public static let whatWasAsked = "What was asked"
        public static let yourWordsIn = "Your words in {session}, {date}"
        public static let notesForNextRun = "Notes for the next run"
        public static let leftByRunOf = "Left by the run of {date}"
        public static let thisMonth = "This month"
        public static let usageOne = "{runs} run · {minutes} min"
        public static let usageOther = "{runs} runs · {minutes} min"
        public static let history = "History"
        public static let session = "session"
        public static let late = "late"
        public static let draftMeta = "Draft · set up by the agent in {workspace} from what you typed"
    }
    public enum Actions {
        public static let runNow = "Run now"
        public static let pause = "Pause"
        public static let resume = "Resume"
        public static let change = "Change…"
        public static let rename = "Rename…"
        public static let delete = "Delete"
        public static let undo = "Undo"
        public static let `open` = "Open"
        public static let create = "Create"
        public static let notNow = "Not now"
        public static let openConversation = "Open conversation"
        public static let allow = "Allow"
        public static let openRun = "Open run"
        public static let pauseSchedule = "Pause schedule"
        public static let openSchedule = "Open schedule"
        public static let openAgentSettings = "Open agent settings"
        public static let alwaysAllow = "Always allow"
        public static let allowOnce = "Allow once"
        public static let deny = "Deny"
        public static let stop = "Stop"
        public static let openLastRun = "Open last run"
    }
    public enum DeleteConfirm {
        public static let title = "Delete “{title}”?"
        public static let body = "It stops running: a run waiting to start is cancelled, and one under way finishes. Its runs and their sessions are kept, but the Scheduled page no longer shows it or its history, and you cannot undo this here."
        public static let confirm = "Delete"
        public static let cancel = "Cancel"
    }
    public enum RenameAlert {
        public static let title = "Rename Schedule"
        public static let body = "Only the name changes. When it runs and what it does stay the same."
        public static let cancel = "Cancel"
        public static let save = "Save"
    }
    public enum StopConfirm {
        public static let title = "Stop this run?"
        public static let body = "It ends where it is and counts as stopped by you. Its session is kept, and the schedule runs again at its next time."
        public static let confirm = "Stop"
        public static let cancel = "Cancel"
    }
    public static let keep: [String: String] = [
        "ACCESS_LEVEL": "Keep check only",
        "RUNS_PER_WEEK": "Keep weekly",
        "RUN_LIMIT": "Keep {minutes} min",
        "WORKSPACE": "Keep in {workspace}",
        "other": "Keep as it is",
    ]
    public enum History {
        public static let change = "{field} {before} → {after}"
        public static let changeTo = "{field} → {after}"
        public static let changeText = "{field}: {after}"
        public static let ruleChange = "{before} → {after}"
        public static let created = "Created · {access} · {runs}"
        public static let paused = "Paused"
        public static let resumed = "Resumed"
        public static let ended = "Ended: {reason}"
        public static let minutes = "{minutes} min"
        public static let noEnd = "no end"
        public static let renamed = "Renamed from “{title}”"
        public static let who: [String: String] = [
            "USER": "You",
            "SESSION": "Session",
            "RUN": "Run",
            "ALLOWED": "You allowed",
        ]
        public static let fields: [String: String] = [
            "title": "Name",
            "prompt": "Prompt",
            "readBack": "Read-back",
            "intent": "What was asked",
            "rule": "Time",
            "timezone": "Time zone",
            "endAt": "Ends",
            "maxRuns": "Runs",
            "accessLevel": "Access",
            "runLimitMinutes": "Run limit",
            "workspaceId": "Workspace",
        ]
    }
    /// A schedule's change conversation (§8.2, board 03-change): Orbit's opening, its strip, its input.
    public enum ChangeConversation {
        public static let title = "Change {title}"
        public static let lead = "What should change about {title}? This is what it does now:"
        public static let does = "Does"
        public static let when = "When"
        public static let runsIn = "Runs in"
        public static let may = "May"
        public static let costs = "Costs"
        public static let tail = "I can change the time, the days, what it checks and how it reports right away, and you can undo it. More runs, longer runs, more access or another workspace need your Allow."
        public static let placeholder = "Say what to change…"
        public static let openSchedule = "Open"
        public static let openInScheduled = "Open in Scheduled"
        public static let conversation = "conversation"
    }
    public enum Record {
        public static let changed = "Changed {title}: {change}"
        public static let ended = "Ended {title}: {reason} · {by}"
        public static let byThisRun = "by this run"
        public static let byYou = "by you"
        public static let byASession = "by a session"
    }
    public enum CreateCard {
        public static let title = "Create scheduled task?"
        public static let when = "When"
        public static let runsIn = "Runs in"
        public static let may = "May"
        public static let costs = "Costs"
        public static let today = "Today"
        public static let firstRun = "First run {day}"
        public static let firstRunInline = "first run {day}"
        public static let runsInEngine = "{workspace} · {engine} agent"
        public static let zoneFromDevice = "your time zone"
        public static let notice = "You'll hear about new findings and failures only."
        public static let noticeAbout = "You'll hear about new {findings} and failures only."
    }
    public enum EnvelopeCard {
        public static let landTitle = "Let {title} land on main?"
        public static let now = "Now"
        public static let asked = "Asked"
        public static let accessJoin = " — "
        public static let appliesFromNextRun = "Applies from the next run."
        public static let checkedEachRun = "Each run checks this again before it starts."
        public static let titles: [String: String] = [
            "ACCESS_LEVEL": "Let {title} open PRs?",
            "RUNS_PER_WEEK": "Let {title} run more often?",
            "RUN_LIMIT": "Let {title} run longer?",
            "WORKSPACE": "Let {title} run in {workspace}?",
            "PROBE_COMMAND": "Let {title} check with a new command?",
        ]
    }
    public enum SessionPreview {
        public static let create = "Waiting for you to confirm"
        public static let envelope = "Waiting for you to allow"
    }
    public enum Waiting {
        public static let title = "Waiting on you"
        public static let kindsSchedule = "Scheduled"
        public static let kindsRun = "Scheduled run"
        public static let failedTitle = "{title} failed"
        public static let failedTitleInARow = "{title} failed {count} runs in a row"
        public static let failedBody = "The last run {reason} ({when}). It keeps running on schedule until you pause it. Open the run to see where it stopped, or ask a session to fix the prompt."
        public static let heldTitle = "{title} is held"
        public static let heldBody = "It could not start on {when}: {reason}. Nothing runs until {until} and you resume."
        public static let approvalTitle = "{title} wants to run a command"
        public static let approvalBody = "If nobody answers by {deadline} this run fails; the next one starts {next}."
        public static let approvalAlwaysAllow = "Always allow covers {pattern} in {workspace}: later runs won't ask for this."
        public static let widenBody = "{reason} Now: {now}. Asked: {asked}"
    }
    public enum Push {
        public static let failedBody = "The last run {reason}. It keeps running until you pause it."
        public static let goalReachedTitle = "{title} ended itself"
        public static let stoppedAsPlanned = "Stopped as planned after {runs}"
    }
    public enum Empty {
        public static let lead = "Nothing scheduled. Say what should happen and when; an agent sets it up and asks you once."
        public static let examples: [String] = ["Every day at 10:00, check the Codex stable release against our pinned version", "Every Monday at 9, list dependencies with known vulnerabilities", "At 18:00 today, check that the deploy is healthy and tell me"]
    }
    public enum QuickAdd {
        public static let placeholder = "Describe a scheduled task…"
        public static let hint = "↵ to ask"
    }
    public enum RunSession {
        public static let crumb = "Scheduled"
        public static let runOf = "run of {date}"
        public static let strip = "Scheduled run · planned {planned}, started {started} · access {access}"
        public static let reported = "Reported: {state}"
        public static let agent = "{engine} agent"
        public static let duration = "{minutes} min"
    }

    /// Every sentence above under its contract path (`group.key`, arrays by index): what the parity test reads.
    public static let contract: [String: String] = [
        "nav.scheduled": ScheduleCopy.Nav.scheduled,
        "page.title": ScheduleCopy.Page.title,
        "page.allWorkspaces": ScheduleCopy.Page.allWorkspaces,
        "page.showPastRuns": ScheduleCopy.Page.showPastRuns,
        "groups.TODAY": ScheduleCopy.groups["TODAY"]!,
        "groups.TOMORROW": ScheduleCopy.groups["TOMORROW"]!,
        "groups.LATER": ScheduleCopy.groups["LATER"]!,
        "groups.PAUSED": ScheduleCopy.groups["PAUSED"]!,
        "weekdays.MON": ScheduleCopy.weekdays["MON"]!,
        "weekdays.TUE": ScheduleCopy.weekdays["TUE"]!,
        "weekdays.WED": ScheduleCopy.weekdays["WED"]!,
        "weekdays.THU": ScheduleCopy.weekdays["THU"]!,
        "weekdays.FRI": ScheduleCopy.weekdays["FRI"]!,
        "weekdays.SAT": ScheduleCopy.weekdays["SAT"]!,
        "weekdays.SUN": ScheduleCopy.weekdays["SUN"]!,
        "weekdaysPlural.MON": ScheduleCopy.weekdaysPlural["MON"]!,
        "weekdaysPlural.TUE": ScheduleCopy.weekdaysPlural["TUE"]!,
        "weekdaysPlural.WED": ScheduleCopy.weekdaysPlural["WED"]!,
        "weekdaysPlural.THU": ScheduleCopy.weekdaysPlural["THU"]!,
        "weekdaysPlural.FRI": ScheduleCopy.weekdaysPlural["FRI"]!,
        "weekdaysPlural.SAT": ScheduleCopy.weekdaysPlural["SAT"]!,
        "weekdaysPlural.SUN": ScheduleCopy.weekdaysPlural["SUN"]!,
        "weekdaysShort.MON": ScheduleCopy.weekdaysShort["MON"]!,
        "weekdaysShort.TUE": ScheduleCopy.weekdaysShort["TUE"]!,
        "weekdaysShort.WED": ScheduleCopy.weekdaysShort["WED"]!,
        "weekdaysShort.THU": ScheduleCopy.weekdaysShort["THU"]!,
        "weekdaysShort.FRI": ScheduleCopy.weekdaysShort["FRI"]!,
        "weekdaysShort.SAT": ScheduleCopy.weekdaysShort["SAT"]!,
        "weekdaysShort.SUN": ScheduleCopy.weekdaysShort["SUN"]!,
        "months.0": ScheduleCopy.months[0],
        "months.1": ScheduleCopy.months[1],
        "months.2": ScheduleCopy.months[2],
        "months.3": ScheduleCopy.months[3],
        "months.4": ScheduleCopy.months[4],
        "months.5": ScheduleCopy.months[5],
        "months.6": ScheduleCopy.months[6],
        "months.7": ScheduleCopy.months[7],
        "months.8": ScheduleCopy.months[8],
        "months.9": ScheduleCopy.months[9],
        "months.10": ScheduleCopy.months[10],
        "months.11": ScheduleCopy.months[11],
        "dates.dayWithWeekday": ScheduleCopy.Dates.dayWithWeekday,
        "dates.day": ScheduleCopy.Dates.day,
        "dates.today": ScheduleCopy.Dates.today,
        "dates.tomorrow": ScheduleCopy.Dates.tomorrow,
        "dates.todayLower": ScheduleCopy.Dates.todayLower,
        "dates.tomorrowLower": ScheduleCopy.Dates.tomorrowLower,
        "dates.at": ScheduleCopy.Dates.at,
        "rules.short.daily": ScheduleCopy.Rules.shortDaily,
        "rules.short.weekday": ScheduleCopy.Rules.shortWeekday,
        "rules.short.weekdays": ScheduleCopy.Rules.shortWeekdays,
        "rules.short.days": ScheduleCopy.Rules.shortDays,
        "rules.short.once": ScheduleCopy.Rules.shortOnce,
        "rules.long.daily": ScheduleCopy.Rules.longDaily,
        "rules.long.weekday": ScheduleCopy.Rules.longWeekday,
        "rules.long.weekdays": ScheduleCopy.Rules.longWeekdays,
        "rules.long.days": ScheduleCopy.Rules.longDays,
        "rules.long.once": ScheduleCopy.Rules.longOnce,
        "rules.daysSeparator": ScheduleCopy.Rules.daysSeparator,
        "separator": ScheduleCopy.separator,
        "access.CHECK_ONLY.label": ScheduleCopy.access["CHECK_ONLY"]!.label,
        "access.CHECK_ONLY.detail": ScheduleCopy.access["CHECK_ONLY"]!.detail,
        "access.CHECK_ONLY.brief": ScheduleCopy.access["CHECK_ONLY"]!.brief,
        "landing.landed": ScheduleCopy.Landing.landed,
        "landing.failed": ScheduleCopy.Landing.failed,
        "access.LAND.label": ScheduleCopy.access["LAND"]!.label,
        "access.LAND.detail": ScheduleCopy.access["LAND"]!.detail,
        "access.LAND.brief": ScheduleCopy.access["LAND"]!.brief,
        "failureReasons.LANDING_FAILED": ScheduleCopy.failureReasons["LANDING_FAILED"]!,
        "failureReasonsWithSummary.LANDING_FAILED": ScheduleCopy.failureReasonsWithSummary["LANDING_FAILED"]!,
        "heldReasons.WORKTREE_DISABLED.clause": ScheduleCopy.heldReasons["WORKTREE_DISABLED"]!.clause,
        "heldReasons.WORKTREE_DISABLED.until": ScheduleCopy.heldReasons["WORKTREE_DISABLED"]!.until,
        "heldShort.WORKTREE_DISABLED": ScheduleCopy.heldShort["WORKTREE_DISABLED"]!,
        "history.fields.readBack": ScheduleCopy.History.fields["readBack"]!,
        "access.OPEN_PR.label": ScheduleCopy.access["OPEN_PR"]!.label,
        "access.OPEN_PR.detail": ScheduleCopy.access["OPEN_PR"]!.detail,
        "access.OPEN_PR.brief": ScheduleCopy.access["OPEN_PR"]!.brief,
        "costs.upTo": ScheduleCopy.Costs.upTo,
        "costs.upToLower": ScheduleCopy.Costs.upToLower,
        "costs.runsOnly": ScheduleCopy.Costs.runsOnly,
        "costs.runs.one": ScheduleCopy.Costs.runsOne,
        "costs.runs.other": ScheduleCopy.Costs.runsOther,
        "costs.allowed": ScheduleCopy.Costs.allowed,
        "row.runningFor": ScheduleCopy.Row.runningFor,
        "row.pausedOn": ScheduleCopy.Row.pausedOn,
        "row.draft": ScheduleCopy.Row.draft,
        "row.notified": ScheduleCopy.Row.notified,
        "row.notNotified": ScheduleCopy.Row.notNotified,
        "row.runningShort": ScheduleCopy.Row.runningShort,
        "row.draftShort": ScheduleCopy.Row.draftShort,
        "tags.failedInARow": ScheduleCopy.Tags.failedInARow,
        "tags.held": ScheduleCopy.Tags.held,
        "tags.failed": ScheduleCopy.Tags.failed,
        "tags.known": ScheduleCopy.Tags.known,
        "tags.new": ScheduleCopy.Tags.new,
        "runStates.QUEUED": ScheduleCopy.runStates["QUEUED"]!,
        "runStates.RUNNING": ScheduleCopy.runStates["RUNNING"]!,
        "runStates.AWAITING_APPROVAL": ScheduleCopy.runStates["AWAITING_APPROVAL"]!,
        "runStates.NO_CHANGE": ScheduleCopy.runStates["NO_CHANGE"]!,
        "runStates.CHANGED": ScheduleCopy.runStates["CHANGED"]!,
        "runStates.FAILED": ScheduleCopy.runStates["FAILED"]!,
        "runStates.SKIPPED": ScheduleCopy.runStates["SKIPPED"]!,
        "runStates.MISSED": ScheduleCopy.runStates["MISSED"]!,
        "runStates.HELD": ScheduleCopy.runStates["HELD"]!,
        "runStates.CANCELLED": ScheduleCopy.runStates["CANCELLED"]!,
        "failureReasons.RUNNER_UNAVAILABLE": ScheduleCopy.failureReasons["RUNNER_UNAVAILABLE"]!,
        "failureReasons.RUNNER_FULL": ScheduleCopy.failureReasons["RUNNER_FULL"]!,
        "failureReasons.QUOTA": ScheduleCopy.failureReasons["QUOTA"]!,
        "failureReasons.ENGINE_CRASHED_BEFORE_START": ScheduleCopy.failureReasons["ENGINE_CRASHED_BEFORE_START"]!,
        "failureReasons.REPORTED_FAILED": ScheduleCopy.failureReasons["REPORTED_FAILED"]!,
        "failureReasons.NO_REPORT": ScheduleCopy.failureReasons["NO_REPORT"]!,
        "failureReasons.ENGINE_CRASHED": ScheduleCopy.failureReasons["ENGINE_CRASHED"]!,
        "failureReasons.APPROVAL_TIMEOUT": ScheduleCopy.failureReasons["APPROVAL_TIMEOUT"]!,
        "failureReasons.RUN_LIMIT": ScheduleCopy.failureReasons["RUN_LIMIT"]!,
        "failureReasons.CANCELLED_BY_OWNER": ScheduleCopy.failureReasons["CANCELLED_BY_OWNER"]!,
        "failureReasons.OVER_BUDGET": ScheduleCopy.failureReasons["OVER_BUDGET"]!,
        "runReasonTexts.OVER_BUDGET": ScheduleCopy.runReasonTexts["OVER_BUDGET"]!,
        "failureReasonsWithSummary.REPORTED_FAILED": ScheduleCopy.failureReasonsWithSummary["REPORTED_FAILED"]!,
        "heldReasons.WORKSPACE_NOT_OWNED.clause": ScheduleCopy.heldReasons["WORKSPACE_NOT_OWNED"]!.clause,
        "heldReasons.WORKSPACE_NOT_OWNED.until": ScheduleCopy.heldReasons["WORKSPACE_NOT_OWNED"]!.until,
        "heldReasons.WORKSPACE_DELETED.clause": ScheduleCopy.heldReasons["WORKSPACE_DELETED"]!.clause,
        "heldReasons.WORKSPACE_DELETED.until": ScheduleCopy.heldReasons["WORKSPACE_DELETED"]!.until,
        "heldReasons.WORKSPACE_DISABLED.clause": ScheduleCopy.heldReasons["WORKSPACE_DISABLED"]!.clause,
        "heldReasons.WORKSPACE_DISABLED.until": ScheduleCopy.heldReasons["WORKSPACE_DISABLED"]!.until,
        "heldReasons.AGENT_MISSING.clause": ScheduleCopy.heldReasons["AGENT_MISSING"]!.clause,
        "heldReasons.AGENT_MISSING.until": ScheduleCopy.heldReasons["AGENT_MISSING"]!.until,
        "heldReasons.AGENT_DISABLED.clause": ScheduleCopy.heldReasons["AGENT_DISABLED"]!.clause,
        "heldReasons.AGENT_DISABLED.until": ScheduleCopy.heldReasons["AGENT_DISABLED"]!.until,
        "heldReasons.OUTSIDE_ENVELOPE.clause": ScheduleCopy.heldReasons["OUTSIDE_ENVELOPE"]!.clause,
        "heldReasons.OUTSIDE_ENVELOPE.until": ScheduleCopy.heldReasons["OUTSIDE_ENVELOPE"]!.until,
        "heldReasons.ACCESS_NOT_ENFORCEABLE.clause": ScheduleCopy.heldReasons["ACCESS_NOT_ENFORCEABLE"]!.clause,
        "heldReasons.ACCESS_NOT_ENFORCEABLE.until": ScheduleCopy.heldReasons["ACCESS_NOT_ENFORCEABLE"]!.until,
        "heldReasons.MODE_WIDER_THAN_ACCOUNT_DEFAULT.clause": ScheduleCopy.heldReasons["MODE_WIDER_THAN_ACCOUNT_DEFAULT"]!.clause,
        "heldReasons.MODE_WIDER_THAN_ACCOUNT_DEFAULT.until": ScheduleCopy.heldReasons["MODE_WIDER_THAN_ACCOUNT_DEFAULT"]!.until,
        "heldReasons.NO_REPOSITORY.clause": ScheduleCopy.heldReasons["NO_REPOSITORY"]!.clause,
        "heldReasons.NO_REPOSITORY.until": ScheduleCopy.heldReasons["NO_REPOSITORY"]!.until,
        "heldReasons.SESSION_REFUSED.clause": ScheduleCopy.heldReasons["SESSION_REFUSED"]!.clause,
        "heldReasons.SESSION_REFUSED.until": ScheduleCopy.heldReasons["SESSION_REFUSED"]!.until,
        "heldWhere": ScheduleCopy.heldWhere,
        "heldShort.WORKSPACE_NOT_OWNED": ScheduleCopy.heldShort["WORKSPACE_NOT_OWNED"]!,
        "heldShort.WORKSPACE_DELETED": ScheduleCopy.heldShort["WORKSPACE_DELETED"]!,
        "heldShort.WORKSPACE_DISABLED": ScheduleCopy.heldShort["WORKSPACE_DISABLED"]!,
        "heldShort.AGENT_MISSING": ScheduleCopy.heldShort["AGENT_MISSING"]!,
        "heldShort.AGENT_DISABLED": ScheduleCopy.heldShort["AGENT_DISABLED"]!,
        "heldShort.OUTSIDE_ENVELOPE": ScheduleCopy.heldShort["OUTSIDE_ENVELOPE"]!,
        "heldShort.ACCESS_NOT_ENFORCEABLE": ScheduleCopy.heldShort["ACCESS_NOT_ENFORCEABLE"]!,
        "heldShort.MODE_WIDER_THAN_ACCOUNT_DEFAULT": ScheduleCopy.heldShort["MODE_WIDER_THAN_ACCOUNT_DEFAULT"]!,
        "heldShort.NO_REPOSITORY": ScheduleCopy.heldShort["NO_REPOSITORY"]!,
        "heldShort.SESSION_REFUSED": ScheduleCopy.heldShort["SESSION_REFUSED"]!,
        "endedReasons.DELETED": ScheduleCopy.endedReasons["DELETED"]!,
        "endedReasons.END_REACHED": ScheduleCopy.endedReasons["END_REACHED"]!,
        "endedReasons.GOAL_REACHED": ScheduleCopy.endedReasons["GOAL_REACHED"]!,
        "inspector.nextRun": ScheduleCopy.Inspector.nextRun,
        "inspector.last": ScheduleCopy.Inspector.last,
        "inspector.whatItDoes": ScheduleCopy.Inspector.whatItDoes,
        "inspector.whatWasAsked": ScheduleCopy.Inspector.whatWasAsked,
        "inspector.yourWordsIn": ScheduleCopy.Inspector.yourWordsIn,
        "inspector.notesForNextRun": ScheduleCopy.Inspector.notesForNextRun,
        "inspector.leftByRunOf": ScheduleCopy.Inspector.leftByRunOf,
        "inspector.thisMonth": ScheduleCopy.Inspector.thisMonth,
        "inspector.usage.one": ScheduleCopy.Inspector.usageOne,
        "inspector.usage.other": ScheduleCopy.Inspector.usageOther,
        "inspector.history": ScheduleCopy.Inspector.history,
        "inspector.session": ScheduleCopy.Inspector.session,
        "inspector.late": ScheduleCopy.Inspector.late,
        "inspector.draftMeta": ScheduleCopy.Inspector.draftMeta,
        "actions.runNow": ScheduleCopy.Actions.runNow,
        "actions.pause": ScheduleCopy.Actions.pause,
        "actions.resume": ScheduleCopy.Actions.resume,
        "actions.change": ScheduleCopy.Actions.change,
        "actions.rename": ScheduleCopy.Actions.rename,
        "actions.delete": ScheduleCopy.Actions.delete,
        "actions.undo": ScheduleCopy.Actions.undo,
        "actions.open": ScheduleCopy.Actions.open,
        "actions.create": ScheduleCopy.Actions.create,
        "actions.notNow": ScheduleCopy.Actions.notNow,
        "actions.openConversation": ScheduleCopy.Actions.openConversation,
        "actions.allow": ScheduleCopy.Actions.allow,
        "actions.openRun": ScheduleCopy.Actions.openRun,
        "actions.pauseSchedule": ScheduleCopy.Actions.pauseSchedule,
        "actions.openSchedule": ScheduleCopy.Actions.openSchedule,
        "actions.openAgentSettings": ScheduleCopy.Actions.openAgentSettings,
        "actions.alwaysAllow": ScheduleCopy.Actions.alwaysAllow,
        "actions.allowOnce": ScheduleCopy.Actions.allowOnce,
        "actions.deny": ScheduleCopy.Actions.deny,
        "actions.stop": ScheduleCopy.Actions.stop,
        "actions.openLastRun": ScheduleCopy.Actions.openLastRun,
        "deleteConfirm.title": ScheduleCopy.DeleteConfirm.title,
        "deleteConfirm.body": ScheduleCopy.DeleteConfirm.body,
        "deleteConfirm.confirm": ScheduleCopy.DeleteConfirm.confirm,
        "deleteConfirm.cancel": ScheduleCopy.DeleteConfirm.cancel,
        "renameAlert.title": ScheduleCopy.RenameAlert.title,
        "renameAlert.body": ScheduleCopy.RenameAlert.body,
        "renameAlert.cancel": ScheduleCopy.RenameAlert.cancel,
        "renameAlert.save": ScheduleCopy.RenameAlert.save,
        "stopConfirm.title": ScheduleCopy.StopConfirm.title,
        "stopConfirm.body": ScheduleCopy.StopConfirm.body,
        "stopConfirm.confirm": ScheduleCopy.StopConfirm.confirm,
        "stopConfirm.cancel": ScheduleCopy.StopConfirm.cancel,
        "keep.ACCESS_LEVEL": ScheduleCopy.keep["ACCESS_LEVEL"]!,
        "keep.RUNS_PER_WEEK": ScheduleCopy.keep["RUNS_PER_WEEK"]!,
        "keep.RUN_LIMIT": ScheduleCopy.keep["RUN_LIMIT"]!,
        "keep.WORKSPACE": ScheduleCopy.keep["WORKSPACE"]!,
        "keep.other": ScheduleCopy.keep["other"]!,
        "history.change": ScheduleCopy.History.change,
        "every.minutes": ScheduleCopy.Every.minutes,
        "every.hour": ScheduleCopy.Every.hour,
        "every.hours": ScheduleCopy.Every.hours,
        "every.window": ScheduleCopy.Every.window,
        "every.from": ScheduleCopy.Every.from,
        "every.days": ScheduleCopy.Every.days,
        "every.workweek": ScheduleCopy.Every.workweek,
        "every.weekend": ScheduleCopy.Every.weekend,
        "end.until": ScheduleCopy.End.until,
        "end.today": ScheduleCopy.End.today,
        "end.tomorrow": ScheduleCopy.End.tomorrow,
        "end.runLeft": ScheduleCopy.End.runLeft,
        "end.runsLeft": ScheduleCopy.End.runsLeft,
        "end.missed": ScheduleCopy.End.missed,
        "end.missedDated": ScheduleCopy.End.missedDated,
        "end.endLabel": ScheduleCopy.End.endLabel,
        "end.extend": ScheduleCopy.End.extend,
        "end.remove": ScheduleCopy.End.remove,
        "end.extendAsk": ScheduleCopy.End.extendAsk,
        "end.removeAsk": ScheduleCopy.End.removeAsk,
        "history.changeTo": ScheduleCopy.History.changeTo,
        "history.changeText": ScheduleCopy.History.changeText,
        "history.ruleChange": ScheduleCopy.History.ruleChange,
        "history.created": ScheduleCopy.History.created,
        "history.paused": ScheduleCopy.History.paused,
        "history.resumed": ScheduleCopy.History.resumed,
        "history.ended": ScheduleCopy.History.ended,
        "history.minutes": ScheduleCopy.History.minutes,
        "history.noEnd": ScheduleCopy.History.noEnd,
        "history.renamed": ScheduleCopy.History.renamed,
        "history.who.USER": ScheduleCopy.History.who["USER"]!,
        "history.who.SESSION": ScheduleCopy.History.who["SESSION"]!,
        "history.who.RUN": ScheduleCopy.History.who["RUN"]!,
        "history.who.ALLOWED": ScheduleCopy.History.who["ALLOWED"]!,
        "history.fields.title": ScheduleCopy.History.fields["title"]!,
        "history.fields.prompt": ScheduleCopy.History.fields["prompt"]!,
        "history.fields.intent": ScheduleCopy.History.fields["intent"]!,
        "history.fields.rule": ScheduleCopy.History.fields["rule"]!,
        "history.fields.timezone": ScheduleCopy.History.fields["timezone"]!,
        "history.fields.endAt": ScheduleCopy.History.fields["endAt"]!,
        "history.fields.maxRuns": ScheduleCopy.History.fields["maxRuns"]!,
        "history.fields.accessLevel": ScheduleCopy.History.fields["accessLevel"]!,
        "history.fields.runLimitMinutes": ScheduleCopy.History.fields["runLimitMinutes"]!,
        "history.fields.workspaceId": ScheduleCopy.History.fields["workspaceId"]!,
        "changeConversation.title": ScheduleCopy.ChangeConversation.title,
        "changeConversation.lead": ScheduleCopy.ChangeConversation.lead,
        "changeConversation.does": ScheduleCopy.ChangeConversation.does,
        "changeConversation.when": ScheduleCopy.ChangeConversation.when,
        "changeConversation.runsIn": ScheduleCopy.ChangeConversation.runsIn,
        "changeConversation.may": ScheduleCopy.ChangeConversation.may,
        "changeConversation.costs": ScheduleCopy.ChangeConversation.costs,
        "changeConversation.tail": ScheduleCopy.ChangeConversation.tail,
        "changeConversation.placeholder": ScheduleCopy.ChangeConversation.placeholder,
        "changeConversation.openSchedule": ScheduleCopy.ChangeConversation.openSchedule,
        "changeConversation.openInScheduled": ScheduleCopy.ChangeConversation.openInScheduled,
        "changeConversation.conversation": ScheduleCopy.ChangeConversation.conversation,
        "record.changed": ScheduleCopy.Record.changed,
        "record.ended": ScheduleCopy.Record.ended,
        "record.byThisRun": ScheduleCopy.Record.byThisRun,
        "record.byYou": ScheduleCopy.Record.byYou,
        "record.byASession": ScheduleCopy.Record.byASession,
        "createCard.title": ScheduleCopy.CreateCard.title,
        "createCard.when": ScheduleCopy.CreateCard.when,
        "createCard.runsIn": ScheduleCopy.CreateCard.runsIn,
        "createCard.may": ScheduleCopy.CreateCard.may,
        "createCard.costs": ScheduleCopy.CreateCard.costs,
        "createCard.today": ScheduleCopy.CreateCard.today,
        "createCard.firstRun": ScheduleCopy.CreateCard.firstRun,
        "createCard.firstRunInline": ScheduleCopy.CreateCard.firstRunInline,
        "createCard.runsInEngine": ScheduleCopy.CreateCard.runsInEngine,
        "createCard.zoneFromDevice": ScheduleCopy.CreateCard.zoneFromDevice,
        "createCard.notice": ScheduleCopy.CreateCard.notice,
        "createCard.noticeAbout": ScheduleCopy.CreateCard.noticeAbout,
        "envelopeCard.landTitle": ScheduleCopy.EnvelopeCard.landTitle,
        "envelopeCard.now": ScheduleCopy.EnvelopeCard.now,
        "envelopeCard.asked": ScheduleCopy.EnvelopeCard.asked,
        "envelopeCard.accessJoin": ScheduleCopy.EnvelopeCard.accessJoin,
        "envelopeCard.appliesFromNextRun": ScheduleCopy.EnvelopeCard.appliesFromNextRun,
        "envelopeCard.checkedEachRun": ScheduleCopy.EnvelopeCard.checkedEachRun,
        "envelopeCard.titles.ACCESS_LEVEL": ScheduleCopy.EnvelopeCard.titles["ACCESS_LEVEL"]!,
        "envelopeCard.titles.RUNS_PER_WEEK": ScheduleCopy.EnvelopeCard.titles["RUNS_PER_WEEK"]!,
        "envelopeCard.titles.RUN_LIMIT": ScheduleCopy.EnvelopeCard.titles["RUN_LIMIT"]!,
        "envelopeCard.titles.WORKSPACE": ScheduleCopy.EnvelopeCard.titles["WORKSPACE"]!,
        "envelopeCard.titles.PROBE_COMMAND": ScheduleCopy.EnvelopeCard.titles["PROBE_COMMAND"]!,
        "sessionPreview.create": ScheduleCopy.SessionPreview.create,
        "sessionPreview.envelope": ScheduleCopy.SessionPreview.envelope,
        "waiting.title": ScheduleCopy.Waiting.title,
        "waiting.kinds.schedule": ScheduleCopy.Waiting.kindsSchedule,
        "waiting.kinds.run": ScheduleCopy.Waiting.kindsRun,
        "waiting.failed.title": ScheduleCopy.Waiting.failedTitle,
        "waiting.failed.titleInARow": ScheduleCopy.Waiting.failedTitleInARow,
        "waiting.failed.body": ScheduleCopy.Waiting.failedBody,
        "waiting.held.title": ScheduleCopy.Waiting.heldTitle,
        "waiting.held.body": ScheduleCopy.Waiting.heldBody,
        "waiting.approval.title": ScheduleCopy.Waiting.approvalTitle,
        "waiting.approval.body": ScheduleCopy.Waiting.approvalBody,
        "waiting.approval.alwaysAllow": ScheduleCopy.Waiting.approvalAlwaysAllow,
        "waiting.widen.body": ScheduleCopy.Waiting.widenBody,
        "push.failedBody": ScheduleCopy.Push.failedBody,
        "push.goalReachedTitle": ScheduleCopy.Push.goalReachedTitle,
        "push.stoppedAsPlanned": ScheduleCopy.Push.stoppedAsPlanned,
        "empty.lead": ScheduleCopy.Empty.lead,
        "empty.examples.0": ScheduleCopy.Empty.examples[0],
        "empty.examples.1": ScheduleCopy.Empty.examples[1],
        "empty.examples.2": ScheduleCopy.Empty.examples[2],
        "quickAdd.placeholder": ScheduleCopy.QuickAdd.placeholder,
        "quickAdd.hint": ScheduleCopy.QuickAdd.hint,
        "runSession.crumb": ScheduleCopy.RunSession.crumb,
        "runSession.runOf": ScheduleCopy.RunSession.runOf,
        "runSession.strip": ScheduleCopy.RunSession.strip,
        "runSession.reported": ScheduleCopy.RunSession.reported,
        "runSession.agent": ScheduleCopy.RunSession.agent,
        "runSession.duration": ScheduleCopy.RunSession.duration,
    ]
}
