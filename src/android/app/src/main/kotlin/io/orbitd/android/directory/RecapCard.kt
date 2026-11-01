package io.orbitd.android.directory

import io.orbitd.android.projects.ProjectTime
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * The conversation's last row while it is at rest (the owner, 2026-10-22, docs/mocks/session-recap-display/04-decided): the
 * recap its list row reads, here whole, with when it was written and a way to write it again now. A port of OrbitKit's
 * `RecapCard` (and the web's `SessionRecapCard`), whose words RecapCardTest holds [RecapCardCopy] to.
 */
data class RecapCard(val text: String, val whenWritten: String?) {
    /** What a refresh that wrote nothing says to the reader; [failed] is drawn as a failure the reader may try again. */
    data class Notice(val text: String, val failed: Boolean)

    companion object {
        /** The card for [s], or null while the conversation is not at rest for one ([rests]), in Trash, with no recap, or with
         * the account's Session recaps switch off — the switch that governs the list row's recap governs this too — or when this
         * device hid that very recap with the card's × ([hidden], the [hideKey] it stored). */
        internal fun make(s: DirectorySession, recaps: Boolean, now: Instant = Instant.now(),
                          zone: ZoneId = ZoneId.systemDefault(), hidden: String? = null): RecapCard? {
            if (!recaps || s.lifecycleState == "TRASH" || s.deletedAt != null || !rests(s)) return null
            val text = s.recapText?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            if (hidden == hideKey(s.recapAt, text)) return null
            return RecapCard(text, whenWritten(s.recapAt, now, zone))
        }

        /** What a recap this device hid is remembered by (the owner, 2026-11-01, docs/mocks/session-recap-display/06-hide): when it
         * was written, so the next one the server writes shows again — or its words, for a recap that came with no time. OrbitKit
         * `RecapCard.hideKey`, web `recapHideKey`. */
        internal fun hideKey(recapAt: String?, text: String): String = recapAt?.takeIf { it.isNotEmpty() } ?: "text:$text"

        /** Where this device keeps the recap it hid in a session: one entry per session in the reader's preferences. */
        internal fun hiddenPreferenceKey(sessionId: String): String = "recap.hidden.$sessionId"

        /** Whether a conversation is at rest for its card: nothing it is doing or asking outranks the summary of what it did.
         * The lines that outrank the recap on its row ([SessionLine.make]) and are work in hand — waiting on you, generating,
         * queued, an agent it started — keep the card away. A watch it is parked on, or a process it left running, is no turn of
         * its own and does not. OrbitKit `RecapCard.rests`, web `restsForRecap`. */
        internal fun rests(s: DirectorySession): Boolean =
            s.pendingApprovals == 0 && !s.isGenerating && s.effectiveRunState != RunState.QUEUED &&
                (s.runningSubagentCount ?: 0) == 0

        /** When the recap was written: "5:38 PM" today, "Wed, Aug 6, 5:38 PM" on another day, because a bare clock time on
         * another day misleads. Null for a recap that arrived with no time, from an older control plane. */
        internal fun whenWritten(recapAt: String?, now: Instant, zone: ZoneId = ZoneId.systemDefault()): String? {
            val at = ProjectTime.parse(recapAt)?.atZone(zone) ?: return null
            val clock = recapClock.format(at)
            return if (at.toLocalDate() == now.atZone(zone).toLocalDate()) clock else "${recapDay.format(at)}, $clock"
        }

        /** The notice for a pass that wrote nothing, by its reason (apiserver sessions/recap.ts `RecapSkipReason`); null when
         * there is nothing to say — another pass wrote first, and reading the session again shows that one's line. */
        fun notice(reason: String): Notice? = when (reason) {
            "cas-lost" -> null
            "no-events" -> Notice(RecapCardCopy.upToDate, failed = false)
            "too-few-events" -> Notice(RecapCardCopy.tooLittle, failed = false)
            "no-key", "disabled" -> Notice(RecapCardCopy.unavailable, failed = false)
            else -> Notice(RecapCardCopy.failed, failed = true)
        }
    }
}

// Built once and reused: "5:38 PM" and "Wed, Aug 6", the shapes the web's `toLocaleTimeString`/`toLocaleDateString` produce
// in its default locale. US English because the words are English (RunnerPage's rule for its own dates).
private val recapClock = DateTimeFormatter.ofPattern("h:mm a", Locale.US)
private val recapDay = DateTimeFormatter.ofPattern("EEE, MMM d", Locale.US)

/** The card's words, held to RecapCard.swift word for word by RecapCardTest. */
internal object RecapCardCopy {
    /** The card's name, over the recap. */
    const val word = "Recap"
    /** The ⋮ at the end of the recap that holds Refresh and Hide (2026-11-02, 07-last-line B), as TalkBack reads it. */
    const val more = "Recap actions"
    /** The menu's item that writes the recap again now. */
    const val refresh = "Refresh recap"
    /** The menu's item that hides this recap in this conversation on this device. */
    const val hide = "Hide recap"
    const val upToDate = "The recap is already up to date."
    const val tooLittle = "There's too little to recap yet."
    const val unavailable = "Recaps aren't available on this server."
    const val failed = "Couldn't refresh the recap. Try again."
}
