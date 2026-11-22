package io.orbitd.android.core.schedule

/** The web run card's words, pinned to runStatusCopy in contracts/schedule.contract.json. */
object ScheduleRunStatusCopy {
    const val strip = "Scheduled run · planned {planned} · access {access}"

    object DidntRun {
        const val title = "Didn't run"
        const val notPickedUp = "{runner} didn't pick it up on any of {tries} tries, so the run never started."
        const val notPickedUpOnce = "{runner} didn't pick it up, so the run never started."
        const val full = "{runner} was full the whole time, so the run never started."
        const val engineFailed = "{runner} couldn't start the engine on any of {tries} tries, so the run never started."
        const val engineFailedOnce = "{runner} couldn't start the engine, so the run never started."
        const val quota = "The engine's usage limit was reached, so the run never started."
        const val cancelled = "You cancelled the run before it started."
        const val nothingChanged = "Nothing was changed."
        const val gaveUp = "gave up {time}"
        const val nextRun = "Next run: {when}"
    }

    object Queued {
        const val title = "Queued · {tag}"
        const val waited = "{waited} · gives up at {deadline}"
        const val givesUp = "Gives up at {deadline}"
    }

    object StartedOn {
        const val title = "Started on try {try}"
        const val body = "This try stopped before its engine started ({why}). Try {try} started at {time}."
        const val engineExited = "{engine} exited"
        const val notPickedUp = "{runner} didn't pick it up"
    }

    object Actions {
        const val runNow = "Run now"
        const val openSchedule = "Open schedule"
        const val cancelRun = "Cancel run"
        const val openRun = "Open the run →"
    }

    internal val contract = mapOf(
        "strip" to strip,
        "didntRun.title" to DidntRun.title,
        "didntRun.notPickedUp" to DidntRun.notPickedUp,
        "didntRun.notPickedUpOnce" to DidntRun.notPickedUpOnce,
        "didntRun.full" to DidntRun.full,
        "didntRun.engineFailed" to DidntRun.engineFailed,
        "didntRun.engineFailedOnce" to DidntRun.engineFailedOnce,
        "didntRun.quota" to DidntRun.quota,
        "didntRun.cancelled" to DidntRun.cancelled,
        "didntRun.nothingChanged" to DidntRun.nothingChanged,
        "didntRun.gaveUp" to DidntRun.gaveUp,
        "didntRun.nextRun" to DidntRun.nextRun,
        "queued.title" to Queued.title,
        "queued.waited" to Queued.waited,
        "queued.givesUp" to Queued.givesUp,
        "startedOn.title" to StartedOn.title,
        "startedOn.body" to StartedOn.body,
        "startedOn.engineExited" to StartedOn.engineExited,
        "startedOn.notPickedUp" to StartedOn.notPickedUp,
        "actions.runNow" to Actions.runNow,
        "actions.openSchedule" to Actions.openSchedule,
        "actions.cancelRun" to Actions.cancelRun,
        "actions.openRun" to Actions.openRun,
    )
}
