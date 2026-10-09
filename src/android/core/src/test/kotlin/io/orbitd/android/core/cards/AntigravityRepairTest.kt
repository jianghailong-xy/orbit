package io.orbitd.android.core.cards

import org.junit.Assert.*
import org.junit.Test

/** OrbitKit EngineAuthTests' Antigravity cases (iOS d2737d665, cd8e8a41a): which failures earn the repair card, and its words. */
class AntigravityRepairTest {
    @Test fun theRunnersAndTheServersWordsAreRecognised() {
        assertEquals(AntigravityRepair.NEEDS_KEY, AntigravityRepair.of("Failed to authenticate: Antigravity runs on an API key (GEMINI_API_KEY), " +
            "and neither this session nor the runner has one — run `agy login` on that machine."))
        assertEquals(AntigravityRepair.UPDATE_RUNNER, AntigravityRepair.of("Antigravity requires a newer Orbit runner; update this runner first"))
        assertEquals(AntigravityRepair.NOT_INSTALLED, AntigravityRepair.of("Antigravity CLI (\"agy\") not found on this runner's PATH — run `orbit doctor` " +
            "on the runner to install it and sign in."))
        assertEquals(AntigravityRepair.NOT_INSTALLED, AntigravityRepair.of("Antigravity CLI isn't installed on this runner"))
        assertNull("another engine's sign-in is the sign-in card's", AntigravityRepair.of("Failed to authenticate: Codex is installed on this runner but not signed in."))
        assertNull(AntigravityRepair.of(null))
        assertTrue("the run-start card leaves these to it", SessionRunStart.antigravityRepair("Antigravity requires a newer Orbit runner; update this runner first"))
    }

    @Test fun eachRepairSaysWhatStopsTheSessionAndWhereItIsFixed() {
        assertEquals("Antigravity needs authentication", AntigravityRepair.NEEDS_KEY.title("wikova"))
        assertEquals("Sign in with Google on this runner, or connect a Gemini API key in Providers.", AntigravityRepair.NEEDS_KEY.body("wikova", "0.1.230"))
        assertEquals("Waiting for a newer runner", AntigravityRepair.UPDATE_RUNNER.title(null))
        assertEquals("wikova runs Orbit runner 0.1.200; Antigravity needs 0.1.209 or newer. The runner updates itself when no session is running " +
            "on it, and this session starts then.", AntigravityRepair.UPDATE_RUNNER.body("wikova", "0.1.200"))
        assertEquals("this runner runs Orbit runner an unknown version; Antigravity needs 0.1.209 or newer. The runner updates itself when no " +
            "session is running on it, and this session starts then.", AntigravityRepair.UPDATE_RUNNER.body(null, ""))
        assertEquals("Antigravity CLI isn't installed on wikova", AntigravityRepair.NOT_INSTALLED.title("wikova"))
        assertEquals("Antigravity CLI isn't installed on this runner", AntigravityRepair.NOT_INSTALLED.title(""))
        assertEquals("Install it from Providers, then send your message again.", AntigravityRepair.NOT_INSTALLED.body(null, null))
    }
}
