package io.orbitd.android.reader

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.reader.SessionSettings.Notify
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test
import java.time.ZoneId

/** What the session's Settings page reads off `GET /sessions/:id` and what its writes send (docs/mocks/session-settings). */
class SessionSettingsTest {
    private fun json(text: String) = Wire.json.parseToJsonElement(text).jsonObject
    private val detail = json("""{"id":"019a2b3c-4d5e-7f80-9a1b-ac2e648c946c","engine":"claude","engineVersion":"2.4.1",
        "createdAt":"2026-09-28T12:00:00Z","branch":"main","worktreeBranch":"orbit/session-settings-a1",
        "assignedRunner":{"id":"r1","name":"hpc-01","displayName":"HPC"},"claudeAccount":"max-2",
        "workspace":{"id":"w1","workDir":"/root/.orbit/worktrees/01a1c927"},
        "tags":[{"id":"t1","name":"web","color":"#3B82F6"},{"id":"t2","name":"needs review","color":"#F59E0B"}],
        "settings":{"env":{"DEBUG":"orbit:*","LOG_LEVEL":"trace","CLAUDE_CODE_AUTO_COMPACT_WINDOW":"500000"},
            "workspaceEnv":{"NODE_OPTIONS":"--max-old-space-size=6144","LOG_LEVEL":"info"},
            "notifyTurnFinished":"inherit","notifyNeedsYou":"off","muted":true,"envPendingRestart":true},
        "usage":{"inputTokens":190000,"outputTokens":108000,"cacheReadTokens":1520000,"cacheCreationTokens":0,"costUsd":4.37,"numTurns":23}}""")
    private val state = SessionSettings.state(detail["settings"])!!

    @Test fun readsTheSettingsTheServerAnswers() {
        assertEquals(mapOf("DEBUG" to "orbit:*", "LOG_LEVEL" to "trace", "CLAUDE_CODE_AUTO_COMPACT_WINDOW" to "500000"), state.env)
        assertEquals(Notify.INHERIT, state.notifyTurnFinished)
        assertEquals(Notify.OFF, state.notifyNeedsYou)
        assertTrue(state.muted); assertTrue(state.envPendingRestart)
        assertNull("a server without settings draws no Environment or Notifications", SessionSettings.state(null))
        assertEquals(Notify.INHERIT, Notify.of("unknown"))
    }

    @Test fun patchBodiesCarryOnlyWhatChanged() {
        assertEquals(json("""{"muted":false}"""), SessionSettings.mutePatch(false))
        assertEquals(json("""{"notifyNeedsYou":"on"}"""), SessionSettings.notifyPatch(true, Notify.ON))
        assertEquals(json("""{"notifyTurnFinished":"inherit"}"""), SessionSettings.notifyPatch(false, Notify.INHERIT))
        assertEquals(json("""{"env":{"A":"1","B":"2"}}"""), SessionSettings.envPatch(mapOf("B" to "2", "A" to "1")))
        assertEquals("an empty map clears the session's", json("""{"env":null}"""), SessionSettings.envPatch(emptyMap()))
        assertEquals(json("""{"tagIds":["t1","t3"]}"""), SessionSettings.tagsBody(listOf("t1", "t3")))
    }

    @Test fun compactAtIsTheSessionVariableAndKeepsOffTheVariablesPage() {
        assertEquals("500K tokens", SessionSettings.compactLabel(state))
        assertEquals(listOf(null, "700000", "500000", "300000"), SessionSettings.compactChoices(state).map { it.first })
        assertEquals("Default", SessionSettings.compactChoices(state).first().second)
        val defaulted = SessionSettings.withCompact(state.env, null)
        assertFalse(SessionSettings.COMPACT_VARIABLE in defaulted)
        assertEquals("300000", SessionSettings.withCompact(state.env, "300000")[SessionSettings.COMPACT_VARIABLE])
        assertEquals(listOf("DEBUG", "LOG_LEVEL"), SessionSettings.sessionVariables(state).keys.toList())
        assertEquals("DEBUG, LOG_LEVEL · 1 from the workspace", SessionSettings.variablesSummary(state))
        val inherited = state.copy(env = emptyMap(), workspaceEnv = mapOf(SessionSettings.COMPACT_VARIABLE to "700000"))
        assertEquals("700K tokens", SessionSettings.compactLabel(inherited))
        assertEquals("As the workspace (700K tokens)", SessionSettings.compactChoices(inherited).first().second)
        assertEquals("a typed size is offered as it stands", "123456 tokens",
            SessionSettings.compactChoices(state.copy(env = mapOf(SessionSettings.COMPACT_VARIABLE to "123456"))).last().second)
    }

    @Test fun variablesAreEditedInPlaceAndCheckedAsTheServerChecks() {
        assertEquals(mapOf("DEBUG" to "x", "TRACE" to "1"), SessionSettings.withVariable(mapOf("DEBUG" to "x", "OLD" to "1"), "TRACE", "1", "OLD"))
        assertNull(SessionSettings.keyProblem("LOG_LEVEL"))
        assertNotNull(SessionSettings.keyProblem("9LIVES"))
        assertNotNull(SessionSettings.keyProblem("orbit_token"))
        assertNotNull(SessionSettings.keyProblem(" "))
    }

    @Test fun restartSaysWhenItHappens() {
        assertEquals("Restart after this turn", SessionSettings.restartAction(running = true))
        assertEquals("Restart", SessionSettings.restartAction(running = false))
        assertEquals("The engine restarts after this turn", SessionSettings.restartToast(afterTurn = true))
    }

    @Test fun infoRowsReadTheDetail() {
        val usage = SessionSettings.usage(detail)!!
        assertEquals("1.82M", SessionSettings.tokens(SessionSettings.tokensTotal(usage)))
        assertEquals("in 1.71M · out 108K · cache 1.52M", SessionSettings.tokensLine(usage))
        assertEquals("$4.37", SessionSettings.cost(usage))
        assertEquals("23 turns", SessionSettings.turns(usage))
        assertEquals("1 turn", SessionSettings.turns(usage.copy(numTurns = 1)))
        assertEquals("950", SessionSettings.tokens(950)); assertEquals("2M", SessionSettings.tokens(2_000_000))
        assertEquals("Claude Code 2.4.1", SessionSettings.engineLine(detail))
        assertEquals("HPC · max-2", SessionSettings.runnerAccount(detail))
        assertEquals("orbit/session-settings-a1", SessionSettings.branch(detail))
        assertEquals("/root/.orbit/worktrees/01a1c927", SessionSettings.workingDirectory(detail))
        assertEquals("Sep 28, 20:00", SessionSettings.created(detail.string("createdAt"), ZoneId.of("Asia/Shanghai")))
        assertEquals("…ac2e648c946c", SessionSettings.shortId(detail.string("id")!!))
        assertEquals(listOf("web", "needs review"), SessionSettings.labels(detail).map { it.name })
        assertNull(SessionSettings.usage(JsonObject(emptyMap())))
    }
}
