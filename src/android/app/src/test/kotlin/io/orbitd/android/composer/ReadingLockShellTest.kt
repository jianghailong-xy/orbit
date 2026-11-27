package io.orbitd.android.composer

import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.DataKind
import io.orbitd.android.core.realtime.ReadingCache
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.FixMethodOrder
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runners.MethodSorters

/**
 * A reading-access step cut off as its test ends holds up no later test's session page. Robolectric clears the main looper between
 * tests, so a resume posted to the main thread after the Activity has closed is never run: the step stays inside its lock for the
 * rest of the JVM. While that lock served the whole process, every later shell test's store waited on it before the open
 * conversation's snapshot, its stream and its transcript ("Loading messages…", "Reconnect to send"), and each spent its full minute
 * in the composer's wait (Android CI 44842668197, 44895359369, 44900650148, 44910859092). The two tests run in name order, in one
 * sandbox: the first leaves the step cut off, the second opens a session after it.
 */
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class ReadingLockShellTest : ComposerShellTest() {
    private companion object {
        const val HELD = "reading-lock-shell-held-read"
        /** The step the first test cut off, for the second to see that it is still there. */
        var step: Job? = null
    }
    private var release: (() -> Unit)? = null

    /** Runs after the Compose rule has closed the Activity and idled the main looper, and before Robolectric clears it. */
    @get:Rule(order = -2)
    val afterTeardown = object : TestWatcher() {
        override fun finished(description: Description) { release?.invoke(); release = null }
    }

    @Test fun aReadingAccessStepIsCutOffAsItsTestEnds() {
        signIn()
        val auth = app().session
        val handle = (auth.state.value as AuthState.SignedIn).handle
        // Another read holds the session's own lock on a worker thread, its disk read still out.
        val gate = CompletableDeferred<Unit>()
        ComposerShell.diskGates[HELD] = gate
        val holder: Deferred<ByteArray?> = CoroutineScope(Dispatchers.Default).async { auth.readData(handle, DataKind.CACHE, HELD) }
        await { HELD in ComposerShell.diskReadsHeld }
        // On the app's main scope the step takes its reading lock, then waits for the session's.
        step = app().processScope.launch { ReadingCache(auth, handle, ComposerShell.SESSION).permission() }
        assertTrue(step!!.isActive)
        release = {
            // The worker's unlock posts the step's resume to the main looper, which nothing runs before Robolectric clears it.
            gate.complete(Unit)
            runBlocking { holder.await() }
        }
    }

    @Test fun theNextTestsSessionStillReadsItsSnapshotAndTranscript() {
        assertTrue("the first test's step is still cut off inside its lock", step?.isActive == true)
        signIn(); openSession()
        await { app().realtime.state.value.session?.snapshot?.detail != null }
        assertTrue(ComposerShell.calls.any { it.startsWith("GET sessions/${ComposerShell.SESSION}/approvals") })
        assertTrue(ComposerShell.calls.any { it.startsWith("GET sessions/${ComposerShell.SESSION}/events/page") })
    }
}
