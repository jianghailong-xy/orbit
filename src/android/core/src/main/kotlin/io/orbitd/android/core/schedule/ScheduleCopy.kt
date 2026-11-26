package io.orbitd.android.core.schedule

// GENERATED from contracts/schedule.contract.json `copy` by src/android/scripts/gen-schedule-copy.py, and held to it
// word for word by ScheduleCopyParityTest: change the contract, then regenerate this file, never this file alone.
// The same words and member names as OrbitKit's ScheduleCopy.swift. Placeholders are `{name}`, filled by
// `ScheduleDisplay.fill`.

/** One access level's words: its label, the create card's May detail, and the envelope card's brief Now. */
data class ScheduleAccessCopy(val label: String, val detail: String, val brief: String)

/** Why a schedule is held, as a clause, and what has to change before Resume. */
data class ScheduleHeldCopy(val clause: String, val until: String)

/** Every word the Scheduled page, its inspector, the cards and Waiting on you put on screen. */
object ScheduleCopy {
    object Nav {
        const val scheduled = "Scheduled"
    }
    object Page {
        const val title = "Scheduled"
        const val allWorkspaces = "All workspaces"
        const val showPastRuns = "Show past runs"
    }
    val groups: Map<String, String> = mapOf(
        "TODAY" to "Today",
        "TOMORROW" to "Tomorrow",
        "LATER" to "Later",
        "PAUSED" to "Paused",
    )
    val weekdays: Map<String, String> = mapOf(
        "MON" to "Monday",
        "TUE" to "Tuesday",
        "WED" to "Wednesday",
        "THU" to "Thursday",
        "FRI" to "Friday",
        "SAT" to "Saturday",
        "SUN" to "Sunday",
    )
    val weekdaysPlural: Map<String, String> = mapOf(
        "MON" to "Mondays",
        "TUE" to "Tuesdays",
        "WED" to "Wednesdays",
        "THU" to "Thursdays",
        "FRI" to "Fridays",
        "SAT" to "Saturdays",
        "SUN" to "Sundays",
    )
    val weekdaysShort: Map<String, String> = mapOf(
        "MON" to "Mon",
        "TUE" to "Tue",
        "WED" to "Wed",
        "THU" to "Thu",
        "FRI" to "Fri",
        "SAT" to "Sat",
        "SUN" to "Sun",
    )
    val months: List<String> = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
    object Dates {
        const val dayWithWeekday = "{weekday}, {month} {day}"
        const val day = "{month} {day}"
        const val today = "Today"
        const val tomorrow = "Tomorrow"
        const val todayLower = "today"
        const val tomorrowLower = "tomorrow"
        const val at = "{day} {time}"
    }
    object Rules {
        const val shortDaily = "Daily {time}"
        const val shortWeekday = "{weekdays} {time}"
        const val shortWeekdays = "Weekdays at {time}"
        const val shortDays = "{days} {time}"
        const val shortOnce = "Once"
        const val longDaily = "Every day at {time}"
        const val longWeekday = "Every {weekday} at {time}"
        const val longWeekdays = "Weekdays at {time}"
        const val longDays = "Every {days} at {time}"
        const val longOnce = "Once"
        const val daysSeparator = ", "
    }
    const val separator = " · "
    val access: Map<String, ScheduleAccessCopy> = mapOf(
        "CHECK_ONLY" to ScheduleAccessCopy("Check only", "reads and reports, edits nothing", "reads and reports"),
        "OPEN_PR" to ScheduleAccessCopy("Open a PR", "edits in its own worktree and opens a PR. It can't merge or deploy.", "edits in its own worktree and opens a PR. It can't merge or deploy."),
        "LAND" to ScheduleAccessCopy("Edit and land on main", "edits in its own worktree, then Orbit merges it into main after the run. It can't release or deploy.", "edits in its own worktree, then Orbit merges it into main after the run. It can't release or deploy."),
    )
    object Costs {
        const val upTo = "Up to {runs}, {minutes} min each"
        const val upToLower = "up to {runs}, {minutes} min each"
        const val runsOnly = "up to {runs}"
        const val runsOne = "{count} run a week"
        const val runsOther = "{count} runs a week"
        const val allowed = "Allowed: {costs}"
    }
    object Row {
        const val runningFor = "running for {minutes} min"
        const val pausedOn = "paused {date}"
        const val draft = "draft, waiting for you"
        const val notified = "you were notified"
        const val notNotified = "not notified"
        const val runningShort = "running {minutes} min"
        const val draftShort = "draft"
    }
    object Tags {
        const val failedInARow = "Failed {count} in a row"
        const val held = "Held"
        const val failed = "Failed"
        const val known = "Known"
        const val new = "New"
    }
    val runStates: Map<String, String> = mapOf(
        "QUEUED" to "Queued",
        "RUNNING" to "Running",
        "AWAITING_APPROVAL" to "Waiting for you",
        "NO_CHANGE" to "No change",
        "CHANGED" to "Changed",
        "FAILED" to "Failed",
        "SKIPPED" to "Skipped",
        "MISSED" to "Missed",
        "HELD" to "Held",
        "CANCELLED" to "Cancelled",
    )
    val failureReasons: Map<String, String> = mapOf(
        "RUNNER_UNAVAILABLE" to "found no runner online",
        "RUNNER_FULL" to "waited for a full runner until its window closed",
        "QUOTA" to "hit the engine's usage limit",
        "ENGINE_CRASHED_BEFORE_START" to "stopped before its engine started",
        "REPORTED_FAILED" to "reported a failure",
        "NO_REPORT" to "ended without a report",
        "ENGINE_CRASHED" to "ended when its engine stopped",
        "APPROVAL_TIMEOUT" to "waited 2 hours for an approval with no answer",
        "RUN_LIMIT" to "ran past its run limit",
        "CANCELLED_BY_OWNER" to "was stopped by you",
        "OVER_BUDGET" to "was over what you allowed this week",
        "LANDING_FAILED" to "could not land on main",
    )
    val runReasonTexts: Map<String, String> = mapOf(
        "OVER_BUDGET" to "Not started: it had already started as many scheduled runs in the past 7 days as you allowed.",
    )
    val failureReasonsWithSummary: Map<String, String> = mapOf(
        "REPORTED_FAILED" to "reported a failure: {summary}",
        "LANDING_FAILED" to "could not land on main: {summary}",
    )
    val heldReasons: Map<String, ScheduleHeldCopy> = mapOf(
        "WORKSPACE_NOT_OWNED" to ScheduleHeldCopy("the workspace {workspace} is no longer yours", "it is yours again"),
        "WORKSPACE_DELETED" to ScheduleHeldCopy("the workspace {workspace} was deleted", "it runs in another workspace"),
        "WORKSPACE_DISABLED" to ScheduleHeldCopy("the workspace {workspace} is disabled", "it is enabled"),
        "AGENT_MISSING" to ScheduleHeldCopy("the agent \"{agent}\" no longer exists", "it has an agent"),
        "AGENT_DISABLED" to ScheduleHeldCopy("the agent \"{agent}\" is disabled", "it is enabled"),
        "OUTSIDE_ENVELOPE" to ScheduleHeldCopy("it no longer fits what you allowed", "you allow it"),
        "ACCESS_NOT_ENFORCEABLE" to ScheduleHeldCopy("the engine it would run on cannot enforce its access level", "it runs on an engine that can"),
        "MODE_WIDER_THAN_ACCOUNT_DEFAULT" to ScheduleHeldCopy("your account's default permission mode is narrower than its runs use (set it to Default in Settings > General)", "your default mode allows it"),
        "NO_REPOSITORY" to ScheduleHeldCopy("the workspace {workspace} has no repository", "it has one"),
        "SESSION_REFUSED" to ScheduleHeldCopy("its run's session could not be opened", "that is fixed"),
        "WORKTREE_DISABLED" to ScheduleHeldCopy("the workspace {workspace} has worktrees disabled", "worktrees are enabled"),
    )
    const val heldWhere = " in workspace {workspace}"
    val heldShort: Map<String, String> = mapOf(
        "WORKSPACE_NOT_OWNED" to "workspace not yours",
        "WORKSPACE_DELETED" to "workspace deleted",
        "WORKSPACE_DISABLED" to "workspace disabled",
        "AGENT_MISSING" to "agent missing",
        "AGENT_DISABLED" to "agent disabled",
        "OUTSIDE_ENVELOPE" to "outside what you allowed",
        "ACCESS_NOT_ENFORCEABLE" to "access not enforceable",
        "MODE_WIDER_THAN_ACCOUNT_DEFAULT" to "wider than your default mode",
        "NO_REPOSITORY" to "no repository",
        "SESSION_REFUSED" to "session refused",
        "WORKTREE_DISABLED" to "worktrees disabled",
    )
    val endedReasons: Map<String, String> = mapOf(
        "DELETED" to "deleted",
        "END_REACHED" to "its end time passed",
        "GOAL_REACHED" to "goal reached",
    )
    object Inspector {
        const val nextRun = "Next run"
        const val last = "Last"
        const val whatItDoes = "What it does"
        const val whatWasAsked = "What was asked"
        const val yourWordsIn = "Your words in {session}, {date}"
        const val notesForNextRun = "Notes for the next run"
        const val leftByRunOf = "Left by the run of {date}"
        const val thisMonth = "This month"
        const val usageOne = "{runs} run · {minutes} min"
        const val usageOther = "{runs} runs · {minutes} min"
        const val history = "History"
        const val session = "session"
        const val late = "late"
        const val draftMeta = "Draft · set up by the agent in {workspace} from what you typed"
    }
    object Actions {
        const val runNow = "Run now"
        const val pause = "Pause"
        const val resume = "Resume"
        const val change = "Change…"
        const val rename = "Rename…"
        const val delete = "Delete"
        const val undo = "Undo"
        const val open = "Open"
        const val create = "Create"
        const val notNow = "Not now"
        const val openConversation = "Open conversation"
        const val allow = "Allow"
        const val openRun = "Open run"
        const val pauseSchedule = "Pause schedule"
        const val openSchedule = "Open schedule"
        const val openAgentSettings = "Open agent settings"
        const val alwaysAllow = "Always allow"
        const val allowOnce = "Allow once"
        const val deny = "Deny"
        const val stop = "Stop"
        const val openLastRun = "Open last run"
    }
    object DeleteConfirm {
        const val title = "Delete “{title}”?"
        const val body = "It stops running: a run waiting to start is cancelled, and one under way finishes. Its runs and their sessions are kept, but the Scheduled page no longer shows it or its history, and you cannot undo this here."
        const val confirm = "Delete"
        const val cancel = "Cancel"
    }
    object RenameAlert {
        const val title = "Rename Schedule"
        const val body = "Only the name changes. When it runs and what it does stay the same."
        const val cancel = "Cancel"
        const val save = "Save"
    }
    object StopConfirm {
        const val title = "Stop this run?"
        const val body = "It ends where it is and counts as stopped by you. Its session is kept, and the schedule runs again at its next time."
        const val confirm = "Stop"
        const val cancel = "Cancel"
    }
    val keep: Map<String, String> = mapOf(
        "ACCESS_LEVEL" to "Keep check only",
        "RUNS_PER_WEEK" to "Keep weekly",
        "RUN_LIMIT" to "Keep {minutes} min",
        "WORKSPACE" to "Keep in {workspace}",
        "other" to "Keep as it is",
    )
    object Every {
        const val minutes = "Every {count} min"
        const val hour = "Every hour"
        const val hours = "Every {count} hours"
        const val window = "{interval}, {time}–{until}"
        const val from = "{interval} from {time}"
        const val days = "{rule}, {days}"
        const val workweek = "Mon–Fri"
        const val weekend = "weekends"
    }
    object End {
        const val until = "until {when}"
        const val today = "{time} today"
        const val tomorrow = "{time} tomorrow"
        const val runLeft = "1 run left"
        const val runsLeft = "{count} runs left"
        const val missed = "{count} slots missed, {from}–{to}"
        const val missedDated = "{count} slots missed, {fromDate}, {from}–{toDate}, {to}"
        const val endLabel = "Ends"
        const val extend = "Extend the end"
        const val remove = "Remove the end"
        const val extendAsk = "{title}: extend the end"
        const val removeAsk = "{title}: remove the end"
    }
    object History {
        val who: Map<String, String> = mapOf(
            "USER" to "You",
            "SESSION" to "Session",
            "RUN" to "Run",
            "ALLOWED" to "You allowed",
        )
        val fields: Map<String, String> = mapOf(
            "title" to "Name",
            "prompt" to "Prompt",
            "intent" to "What was asked",
            "rule" to "Time",
            "timezone" to "Time zone",
            "endAt" to "Ends",
            "maxRuns" to "Runs",
            "accessLevel" to "Access",
            "runLimitMinutes" to "Run limit",
            "workspaceId" to "Workspace",
            "readBack" to "Read-back",
        )
        const val change = "{field} {before} → {after}"
        const val changeTo = "{field} → {after}"
        const val changeText = "{field}: {after}"
        const val ruleChange = "{before} → {after}"
        const val created = "Created · {access} · {runs}"
        const val paused = "Paused"
        const val resumed = "Resumed"
        const val ended = "Ended: {reason}"
        const val minutes = "{minutes} min"
        const val noEnd = "no end"
        const val renamed = "Renamed from “{title}”"
    }
    object ChangeConversation {
        const val title = "Change {title}"
        const val lead = "What should change about {title}? This is what it does now:"
        const val does = "Does"
        const val `when` = "When"
        const val runsIn = "Runs in"
        const val may = "May"
        const val costs = "Costs"
        const val tail = "I can change the time, the days, what it checks and how it reports right away, and you can undo it. More runs, longer runs, more access or another workspace need your Allow."
        const val placeholder = "Say what to change…"
        const val openSchedule = "Open"
        const val openInScheduled = "Open in Scheduled"
        const val conversation = "conversation"
    }
    object Record {
        const val changed = "Changed {title}: {change}"
        const val ended = "Ended {title}: {reason} · {by}"
        const val byThisRun = "by this run"
        const val byYou = "by you"
        const val byASession = "by a session"
    }
    object CreateCard {
        const val title = "Create scheduled task?"
        const val `when` = "When"
        const val runsIn = "Runs in"
        const val may = "May"
        const val costs = "Costs"
        const val today = "Today"
        const val firstRun = "First run {day}"
        const val firstRunInline = "first run {day}"
        const val runsInEngine = "{workspace} · {engine} agent"
        const val zoneFromDevice = "your time zone"
        const val notice = "You'll hear about new findings and failures only."
        const val noticeAbout = "You'll hear about new {findings} and failures only."
    }
    object EnvelopeCard {
        val titles: Map<String, String> = mapOf(
            "ACCESS_LEVEL" to "Let {title} open PRs?",
            "RUNS_PER_WEEK" to "Let {title} run more often?",
            "RUN_LIMIT" to "Let {title} run longer?",
            "PROBE_COMMAND" to "Let {title} check with a new command?",
            "WORKSPACE" to "Let {title} run in {workspace}?",
        )
        const val now = "Now"
        const val asked = "Asked"
        const val accessJoin = " — "
        const val appliesFromNextRun = "Applies from the next run."
        const val checkedEachRun = "Each run checks this again before it starts."
        const val landTitle = "Let {title} land on main?"
    }
    object SessionPreview {
        const val create = "Waiting for you to confirm"
        const val envelope = "Waiting for you to allow"
    }
    object Waiting {
        const val title = "Waiting on you"
        const val kindsSchedule = "Scheduled"
        const val kindsRun = "Scheduled run"
        const val failedTitle = "{title} failed"
        const val failedTitleInARow = "{title} failed {count} runs in a row"
        const val failedBody = "The last run {reason} ({when}). It keeps running on schedule until you pause it. Open the run to see where it stopped, or ask a session to fix the prompt."
        const val heldTitle = "{title} is held"
        const val heldBody = "It could not start on {when}: {reason}. Nothing runs until {until} and you resume."
        const val approvalTitle = "{title} wants to run a command"
        const val approvalBody = "If nobody answers by {deadline} this run fails; the next one starts {next}."
        const val approvalAlwaysAllow = "Always allow covers {pattern} in {workspace}: later runs won't ask for this."
        const val widenBody = "{reason} Now: {now}. Asked: {asked}"
    }
    object Push {
        const val failedBody = "The last run {reason}. It keeps running until you pause it."
        const val goalReachedTitle = "{title} ended itself"
        const val reportedLateTitle = "{title} reported after all"
        const val stoppedAsPlanned = "Stopped as planned after {runs}"
    }
    object Empty {
        const val lead = "Nothing scheduled. Say what should happen and when; an agent sets it up and asks you once."
        val examples: List<String> = listOf("Every day at 10:00, check the Codex stable release against our pinned version", "Every Monday at 9, list dependencies with known vulnerabilities", "At 18:00 today, check that the deploy is healthy and tell me")
    }
    object QuickAdd {
        const val placeholder = "Describe a scheduled task…"
        const val hint = "↵ to ask"
    }
    object RunSession {
        const val crumb = "Scheduled"
        const val runOf = "run of {date}"
        const val strip = "Scheduled run · planned {planned}, started {started} · access {access}"
        const val reported = "Reported: {state}"
        const val agent = "{engine} agent"
        const val duration = "{minutes} min"
    }
    object Landing {
        const val landed = "Landed on main: {sha}."
        const val failed = "Could not land on main: {reason}"
    }

    /** Every sentence above under its contract path (`group.key`, arrays by index): what the parity test reads. */
    val contract: Map<String, String> by lazy {
        mapOf(
        "nav.scheduled" to Nav.scheduled,
        "page.title" to Page.title,
        "page.allWorkspaces" to Page.allWorkspaces,
        "page.showPastRuns" to Page.showPastRuns,
        "groups.TODAY" to groups.getValue("TODAY"),
        "groups.TOMORROW" to groups.getValue("TOMORROW"),
        "groups.LATER" to groups.getValue("LATER"),
        "groups.PAUSED" to groups.getValue("PAUSED"),
        "weekdays.MON" to weekdays.getValue("MON"),
        "weekdays.TUE" to weekdays.getValue("TUE"),
        "weekdays.WED" to weekdays.getValue("WED"),
        "weekdays.THU" to weekdays.getValue("THU"),
        "weekdays.FRI" to weekdays.getValue("FRI"),
        "weekdays.SAT" to weekdays.getValue("SAT"),
        "weekdays.SUN" to weekdays.getValue("SUN"),
        "weekdaysPlural.MON" to weekdaysPlural.getValue("MON"),
        "weekdaysPlural.TUE" to weekdaysPlural.getValue("TUE"),
        "weekdaysPlural.WED" to weekdaysPlural.getValue("WED"),
        "weekdaysPlural.THU" to weekdaysPlural.getValue("THU"),
        "weekdaysPlural.FRI" to weekdaysPlural.getValue("FRI"),
        "weekdaysPlural.SAT" to weekdaysPlural.getValue("SAT"),
        "weekdaysPlural.SUN" to weekdaysPlural.getValue("SUN"),
        "weekdaysShort.MON" to weekdaysShort.getValue("MON"),
        "weekdaysShort.TUE" to weekdaysShort.getValue("TUE"),
        "weekdaysShort.WED" to weekdaysShort.getValue("WED"),
        "weekdaysShort.THU" to weekdaysShort.getValue("THU"),
        "weekdaysShort.FRI" to weekdaysShort.getValue("FRI"),
        "weekdaysShort.SAT" to weekdaysShort.getValue("SAT"),
        "weekdaysShort.SUN" to weekdaysShort.getValue("SUN"),
        "months.0" to months[0],
        "months.1" to months[1],
        "months.2" to months[2],
        "months.3" to months[3],
        "months.4" to months[4],
        "months.5" to months[5],
        "months.6" to months[6],
        "months.7" to months[7],
        "months.8" to months[8],
        "months.9" to months[9],
        "months.10" to months[10],
        "months.11" to months[11],
        "dates.dayWithWeekday" to Dates.dayWithWeekday,
        "dates.day" to Dates.day,
        "dates.today" to Dates.today,
        "dates.tomorrow" to Dates.tomorrow,
        "dates.todayLower" to Dates.todayLower,
        "dates.tomorrowLower" to Dates.tomorrowLower,
        "dates.at" to Dates.at,
        "rules.short.daily" to Rules.shortDaily,
        "rules.short.weekday" to Rules.shortWeekday,
        "rules.short.weekdays" to Rules.shortWeekdays,
        "rules.short.days" to Rules.shortDays,
        "rules.short.once" to Rules.shortOnce,
        "rules.long.daily" to Rules.longDaily,
        "rules.long.weekday" to Rules.longWeekday,
        "rules.long.weekdays" to Rules.longWeekdays,
        "rules.long.days" to Rules.longDays,
        "rules.long.once" to Rules.longOnce,
        "rules.daysSeparator" to Rules.daysSeparator,
        "separator" to separator,
        "access.CHECK_ONLY.label" to access.getValue("CHECK_ONLY").label,
        "access.CHECK_ONLY.detail" to access.getValue("CHECK_ONLY").detail,
        "access.CHECK_ONLY.brief" to access.getValue("CHECK_ONLY").brief,
        "access.OPEN_PR.label" to access.getValue("OPEN_PR").label,
        "access.OPEN_PR.detail" to access.getValue("OPEN_PR").detail,
        "access.OPEN_PR.brief" to access.getValue("OPEN_PR").brief,
        "access.LAND.label" to access.getValue("LAND").label,
        "access.LAND.detail" to access.getValue("LAND").detail,
        "access.LAND.brief" to access.getValue("LAND").brief,
        "costs.upTo" to Costs.upTo,
        "costs.upToLower" to Costs.upToLower,
        "costs.runsOnly" to Costs.runsOnly,
        "costs.runs.one" to Costs.runsOne,
        "costs.runs.other" to Costs.runsOther,
        "costs.allowed" to Costs.allowed,
        "row.runningFor" to Row.runningFor,
        "row.pausedOn" to Row.pausedOn,
        "row.draft" to Row.draft,
        "row.notified" to Row.notified,
        "row.notNotified" to Row.notNotified,
        "row.runningShort" to Row.runningShort,
        "row.draftShort" to Row.draftShort,
        "tags.failedInARow" to Tags.failedInARow,
        "tags.held" to Tags.held,
        "tags.failed" to Tags.failed,
        "tags.known" to Tags.known,
        "tags.new" to Tags.new,
        "runStates.QUEUED" to runStates.getValue("QUEUED"),
        "runStates.RUNNING" to runStates.getValue("RUNNING"),
        "runStates.AWAITING_APPROVAL" to runStates.getValue("AWAITING_APPROVAL"),
        "runStates.NO_CHANGE" to runStates.getValue("NO_CHANGE"),
        "runStates.CHANGED" to runStates.getValue("CHANGED"),
        "runStates.FAILED" to runStates.getValue("FAILED"),
        "runStates.SKIPPED" to runStates.getValue("SKIPPED"),
        "runStates.MISSED" to runStates.getValue("MISSED"),
        "runStates.HELD" to runStates.getValue("HELD"),
        "runStates.CANCELLED" to runStates.getValue("CANCELLED"),
        "failureReasons.RUNNER_UNAVAILABLE" to failureReasons.getValue("RUNNER_UNAVAILABLE"),
        "failureReasons.RUNNER_FULL" to failureReasons.getValue("RUNNER_FULL"),
        "failureReasons.QUOTA" to failureReasons.getValue("QUOTA"),
        "failureReasons.ENGINE_CRASHED_BEFORE_START" to failureReasons.getValue("ENGINE_CRASHED_BEFORE_START"),
        "failureReasons.REPORTED_FAILED" to failureReasons.getValue("REPORTED_FAILED"),
        "failureReasons.NO_REPORT" to failureReasons.getValue("NO_REPORT"),
        "failureReasons.ENGINE_CRASHED" to failureReasons.getValue("ENGINE_CRASHED"),
        "failureReasons.APPROVAL_TIMEOUT" to failureReasons.getValue("APPROVAL_TIMEOUT"),
        "failureReasons.RUN_LIMIT" to failureReasons.getValue("RUN_LIMIT"),
        "failureReasons.CANCELLED_BY_OWNER" to failureReasons.getValue("CANCELLED_BY_OWNER"),
        "failureReasons.OVER_BUDGET" to failureReasons.getValue("OVER_BUDGET"),
        "failureReasons.LANDING_FAILED" to failureReasons.getValue("LANDING_FAILED"),
        "runReasonTexts.OVER_BUDGET" to runReasonTexts.getValue("OVER_BUDGET"),
        "failureReasonsWithSummary.REPORTED_FAILED" to failureReasonsWithSummary.getValue("REPORTED_FAILED"),
        "failureReasonsWithSummary.LANDING_FAILED" to failureReasonsWithSummary.getValue("LANDING_FAILED"),
        "heldReasons.WORKSPACE_NOT_OWNED.clause" to heldReasons.getValue("WORKSPACE_NOT_OWNED").clause,
        "heldReasons.WORKSPACE_NOT_OWNED.until" to heldReasons.getValue("WORKSPACE_NOT_OWNED").until,
        "heldReasons.WORKSPACE_DELETED.clause" to heldReasons.getValue("WORKSPACE_DELETED").clause,
        "heldReasons.WORKSPACE_DELETED.until" to heldReasons.getValue("WORKSPACE_DELETED").until,
        "heldReasons.WORKSPACE_DISABLED.clause" to heldReasons.getValue("WORKSPACE_DISABLED").clause,
        "heldReasons.WORKSPACE_DISABLED.until" to heldReasons.getValue("WORKSPACE_DISABLED").until,
        "heldReasons.AGENT_MISSING.clause" to heldReasons.getValue("AGENT_MISSING").clause,
        "heldReasons.AGENT_MISSING.until" to heldReasons.getValue("AGENT_MISSING").until,
        "heldReasons.AGENT_DISABLED.clause" to heldReasons.getValue("AGENT_DISABLED").clause,
        "heldReasons.AGENT_DISABLED.until" to heldReasons.getValue("AGENT_DISABLED").until,
        "heldReasons.OUTSIDE_ENVELOPE.clause" to heldReasons.getValue("OUTSIDE_ENVELOPE").clause,
        "heldReasons.OUTSIDE_ENVELOPE.until" to heldReasons.getValue("OUTSIDE_ENVELOPE").until,
        "heldReasons.ACCESS_NOT_ENFORCEABLE.clause" to heldReasons.getValue("ACCESS_NOT_ENFORCEABLE").clause,
        "heldReasons.ACCESS_NOT_ENFORCEABLE.until" to heldReasons.getValue("ACCESS_NOT_ENFORCEABLE").until,
        "heldReasons.MODE_WIDER_THAN_ACCOUNT_DEFAULT.clause" to heldReasons.getValue("MODE_WIDER_THAN_ACCOUNT_DEFAULT").clause,
        "heldReasons.MODE_WIDER_THAN_ACCOUNT_DEFAULT.until" to heldReasons.getValue("MODE_WIDER_THAN_ACCOUNT_DEFAULT").until,
        "heldReasons.NO_REPOSITORY.clause" to heldReasons.getValue("NO_REPOSITORY").clause,
        "heldReasons.NO_REPOSITORY.until" to heldReasons.getValue("NO_REPOSITORY").until,
        "heldReasons.SESSION_REFUSED.clause" to heldReasons.getValue("SESSION_REFUSED").clause,
        "heldReasons.SESSION_REFUSED.until" to heldReasons.getValue("SESSION_REFUSED").until,
        "heldReasons.WORKTREE_DISABLED.clause" to heldReasons.getValue("WORKTREE_DISABLED").clause,
        "heldReasons.WORKTREE_DISABLED.until" to heldReasons.getValue("WORKTREE_DISABLED").until,
        "heldWhere" to heldWhere,
        "heldShort.WORKSPACE_NOT_OWNED" to heldShort.getValue("WORKSPACE_NOT_OWNED"),
        "heldShort.WORKSPACE_DELETED" to heldShort.getValue("WORKSPACE_DELETED"),
        "heldShort.WORKSPACE_DISABLED" to heldShort.getValue("WORKSPACE_DISABLED"),
        "heldShort.AGENT_MISSING" to heldShort.getValue("AGENT_MISSING"),
        "heldShort.AGENT_DISABLED" to heldShort.getValue("AGENT_DISABLED"),
        "heldShort.OUTSIDE_ENVELOPE" to heldShort.getValue("OUTSIDE_ENVELOPE"),
        "heldShort.ACCESS_NOT_ENFORCEABLE" to heldShort.getValue("ACCESS_NOT_ENFORCEABLE"),
        "heldShort.MODE_WIDER_THAN_ACCOUNT_DEFAULT" to heldShort.getValue("MODE_WIDER_THAN_ACCOUNT_DEFAULT"),
        "heldShort.NO_REPOSITORY" to heldShort.getValue("NO_REPOSITORY"),
        "heldShort.SESSION_REFUSED" to heldShort.getValue("SESSION_REFUSED"),
        "heldShort.WORKTREE_DISABLED" to heldShort.getValue("WORKTREE_DISABLED"),
        "endedReasons.DELETED" to endedReasons.getValue("DELETED"),
        "endedReasons.END_REACHED" to endedReasons.getValue("END_REACHED"),
        "endedReasons.GOAL_REACHED" to endedReasons.getValue("GOAL_REACHED"),
        "inspector.nextRun" to Inspector.nextRun,
        "inspector.last" to Inspector.last,
        "inspector.whatItDoes" to Inspector.whatItDoes,
        "inspector.whatWasAsked" to Inspector.whatWasAsked,
        "inspector.yourWordsIn" to Inspector.yourWordsIn,
        "inspector.notesForNextRun" to Inspector.notesForNextRun,
        "inspector.leftByRunOf" to Inspector.leftByRunOf,
        "inspector.thisMonth" to Inspector.thisMonth,
        "inspector.usage.one" to Inspector.usageOne,
        "inspector.usage.other" to Inspector.usageOther,
        "inspector.history" to Inspector.history,
        "inspector.session" to Inspector.session,
        "inspector.late" to Inspector.late,
        "inspector.draftMeta" to Inspector.draftMeta,
        "actions.runNow" to Actions.runNow,
        "actions.pause" to Actions.pause,
        "actions.resume" to Actions.resume,
        "actions.change" to Actions.change,
        "actions.rename" to Actions.rename,
        "actions.delete" to Actions.delete,
        "actions.undo" to Actions.undo,
        "actions.open" to Actions.open,
        "actions.create" to Actions.create,
        "actions.notNow" to Actions.notNow,
        "actions.openConversation" to Actions.openConversation,
        "actions.allow" to Actions.allow,
        "actions.openRun" to Actions.openRun,
        "actions.pauseSchedule" to Actions.pauseSchedule,
        "actions.openSchedule" to Actions.openSchedule,
        "actions.openAgentSettings" to Actions.openAgentSettings,
        "actions.alwaysAllow" to Actions.alwaysAllow,
        "actions.allowOnce" to Actions.allowOnce,
        "actions.deny" to Actions.deny,
        "actions.stop" to Actions.stop,
        "actions.openLastRun" to Actions.openLastRun,
        "deleteConfirm.title" to DeleteConfirm.title,
        "deleteConfirm.body" to DeleteConfirm.body,
        "deleteConfirm.confirm" to DeleteConfirm.confirm,
        "deleteConfirm.cancel" to DeleteConfirm.cancel,
        "renameAlert.title" to RenameAlert.title,
        "renameAlert.body" to RenameAlert.body,
        "renameAlert.cancel" to RenameAlert.cancel,
        "renameAlert.save" to RenameAlert.save,
        "stopConfirm.title" to StopConfirm.title,
        "stopConfirm.body" to StopConfirm.body,
        "stopConfirm.confirm" to StopConfirm.confirm,
        "stopConfirm.cancel" to StopConfirm.cancel,
        "keep.ACCESS_LEVEL" to keep.getValue("ACCESS_LEVEL"),
        "keep.RUNS_PER_WEEK" to keep.getValue("RUNS_PER_WEEK"),
        "keep.RUN_LIMIT" to keep.getValue("RUN_LIMIT"),
        "keep.WORKSPACE" to keep.getValue("WORKSPACE"),
        "keep.other" to keep.getValue("other"),
        "every.minutes" to Every.minutes,
        "every.hour" to Every.hour,
        "every.hours" to Every.hours,
        "every.window" to Every.window,
        "every.from" to Every.from,
        "every.days" to Every.days,
        "every.workweek" to Every.workweek,
        "every.weekend" to Every.weekend,
        "end.until" to End.until,
        "end.today" to End.today,
        "end.tomorrow" to End.tomorrow,
        "end.runLeft" to End.runLeft,
        "end.runsLeft" to End.runsLeft,
        "end.missed" to End.missed,
        "end.missedDated" to End.missedDated,
        "end.endLabel" to End.endLabel,
        "end.extend" to End.extend,
        "end.remove" to End.remove,
        "end.extendAsk" to End.extendAsk,
        "end.removeAsk" to End.removeAsk,
        "history.who.USER" to History.who.getValue("USER"),
        "history.who.SESSION" to History.who.getValue("SESSION"),
        "history.who.RUN" to History.who.getValue("RUN"),
        "history.who.ALLOWED" to History.who.getValue("ALLOWED"),
        "history.fields.title" to History.fields.getValue("title"),
        "history.fields.prompt" to History.fields.getValue("prompt"),
        "history.fields.intent" to History.fields.getValue("intent"),
        "history.fields.rule" to History.fields.getValue("rule"),
        "history.fields.timezone" to History.fields.getValue("timezone"),
        "history.fields.endAt" to History.fields.getValue("endAt"),
        "history.fields.maxRuns" to History.fields.getValue("maxRuns"),
        "history.fields.accessLevel" to History.fields.getValue("accessLevel"),
        "history.fields.runLimitMinutes" to History.fields.getValue("runLimitMinutes"),
        "history.fields.workspaceId" to History.fields.getValue("workspaceId"),
        "history.fields.readBack" to History.fields.getValue("readBack"),
        "history.change" to History.change,
        "history.changeTo" to History.changeTo,
        "history.changeText" to History.changeText,
        "history.ruleChange" to History.ruleChange,
        "history.created" to History.created,
        "history.paused" to History.paused,
        "history.resumed" to History.resumed,
        "history.ended" to History.ended,
        "history.minutes" to History.minutes,
        "history.noEnd" to History.noEnd,
        "history.renamed" to History.renamed,
        "changeConversation.title" to ChangeConversation.title,
        "changeConversation.lead" to ChangeConversation.lead,
        "changeConversation.does" to ChangeConversation.does,
        "changeConversation.when" to ChangeConversation.`when`,
        "changeConversation.runsIn" to ChangeConversation.runsIn,
        "changeConversation.may" to ChangeConversation.may,
        "changeConversation.costs" to ChangeConversation.costs,
        "changeConversation.tail" to ChangeConversation.tail,
        "changeConversation.placeholder" to ChangeConversation.placeholder,
        "changeConversation.openSchedule" to ChangeConversation.openSchedule,
        "changeConversation.openInScheduled" to ChangeConversation.openInScheduled,
        "changeConversation.conversation" to ChangeConversation.conversation,
        "record.changed" to Record.changed,
        "record.ended" to Record.ended,
        "record.byThisRun" to Record.byThisRun,
        "record.byYou" to Record.byYou,
        "record.byASession" to Record.byASession,
        "createCard.title" to CreateCard.title,
        "createCard.when" to CreateCard.`when`,
        "createCard.runsIn" to CreateCard.runsIn,
        "createCard.may" to CreateCard.may,
        "createCard.costs" to CreateCard.costs,
        "createCard.today" to CreateCard.today,
        "createCard.firstRun" to CreateCard.firstRun,
        "createCard.firstRunInline" to CreateCard.firstRunInline,
        "createCard.runsInEngine" to CreateCard.runsInEngine,
        "createCard.zoneFromDevice" to CreateCard.zoneFromDevice,
        "createCard.notice" to CreateCard.notice,
        "createCard.noticeAbout" to CreateCard.noticeAbout,
        "envelopeCard.titles.ACCESS_LEVEL" to EnvelopeCard.titles.getValue("ACCESS_LEVEL"),
        "envelopeCard.titles.RUNS_PER_WEEK" to EnvelopeCard.titles.getValue("RUNS_PER_WEEK"),
        "envelopeCard.titles.RUN_LIMIT" to EnvelopeCard.titles.getValue("RUN_LIMIT"),
        "envelopeCard.titles.PROBE_COMMAND" to EnvelopeCard.titles.getValue("PROBE_COMMAND"),
        "envelopeCard.titles.WORKSPACE" to EnvelopeCard.titles.getValue("WORKSPACE"),
        "envelopeCard.now" to EnvelopeCard.now,
        "envelopeCard.asked" to EnvelopeCard.asked,
        "envelopeCard.accessJoin" to EnvelopeCard.accessJoin,
        "envelopeCard.appliesFromNextRun" to EnvelopeCard.appliesFromNextRun,
        "envelopeCard.checkedEachRun" to EnvelopeCard.checkedEachRun,
        "envelopeCard.landTitle" to EnvelopeCard.landTitle,
        "sessionPreview.create" to SessionPreview.create,
        "sessionPreview.envelope" to SessionPreview.envelope,
        "waiting.title" to Waiting.title,
        "waiting.kinds.schedule" to Waiting.kindsSchedule,
        "waiting.kinds.run" to Waiting.kindsRun,
        "waiting.failed.title" to Waiting.failedTitle,
        "waiting.failed.titleInARow" to Waiting.failedTitleInARow,
        "waiting.failed.body" to Waiting.failedBody,
        "waiting.held.title" to Waiting.heldTitle,
        "waiting.held.body" to Waiting.heldBody,
        "waiting.approval.title" to Waiting.approvalTitle,
        "waiting.approval.body" to Waiting.approvalBody,
        "waiting.approval.alwaysAllow" to Waiting.approvalAlwaysAllow,
        "waiting.widen.body" to Waiting.widenBody,
        "push.failedBody" to Push.failedBody,
        "push.goalReachedTitle" to Push.goalReachedTitle,
        "push.reportedLateTitle" to Push.reportedLateTitle,
        "push.stoppedAsPlanned" to Push.stoppedAsPlanned,
        "empty.lead" to Empty.lead,
        "empty.examples.0" to Empty.examples[0],
        "empty.examples.1" to Empty.examples[1],
        "empty.examples.2" to Empty.examples[2],
        "quickAdd.placeholder" to QuickAdd.placeholder,
        "quickAdd.hint" to QuickAdd.hint,
        "runSession.crumb" to RunSession.crumb,
        "runSession.runOf" to RunSession.runOf,
        "runSession.strip" to RunSession.strip,
        "runSession.reported" to RunSession.reported,
        "runSession.agent" to RunSession.agent,
        "runSession.duration" to RunSession.duration,
        "landing.landed" to Landing.landed,
        "landing.failed" to Landing.failed,
        )
    }
}
