package io.orbitd.android.watch

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Holds this client's Watch vocabulary to `contracts/watch.contract.json`, the file every Watch surface transcribes
 * (OrbitKit `WatchContractTests`). Nothing compiles this Kotlin against it, so this is what notices a state, leaf,
 * transition or limit moving there and not here. */
class WatchContractTest {
    private val contract = WatchFixture.contract()
    private fun JsonObject.obj(key: String) = requireNotNull(this[key] as? JsonObject) { "contract has no object at $key" }
    private fun JsonObject.strings(key: String) = requireNotNull(this[key] as? JsonArray) { "contract has no string list at $key" }
        .map { it.jsonPrimitive.content }
    private fun <E : Enum<E>> known(values: Array<E>) = values.map { it.name }.filter { it != "UNKNOWN" }

    @Test fun watchStatesMatchTheContract() {
        val watch = contract.obj("states").obj("watch")
        assertEquals(watch.strings("values"), known(WatchState.values()))
        assertEquals(watch.strings("terminal").toSet(), WatchStateMachine.terminal.map { it.name }.toSet())
        assertEquals(WatchState.ACTIVE.name, watch["initial"]!!.jsonPrimitive.content)
    }

    @Test fun transitionsMatchTheContractEdgeForEdge() {
        val edges = contract.obj("states").obj("watch")["transitions"]!!.jsonArray.map { it.jsonObject }
        val contractEdges = edges.mapNotNull { e -> e["from"]?.jsonPrimitive?.content?.let { from -> e["to"]?.jsonPrimitive?.content?.let { "$from>$it" } } }.toSet()
        assertEquals("every contract transition names from and to", edges.size, contractEdges.size)
        assertEquals(contractEdges, WatchStateMachine.transitions.map { "${it.first.name}>${it.second.name}" }.toSet())
        // Nothing leaves a terminal state.
        WatchStateMachine.transitions.forEach { assertFalse("${it.first} is terminal", it.first in WatchStateMachine.terminal) }
    }

    /** A page can only offer a move the server's machine has, from the state the watch is in. */
    @Test fun everyOfferedControlIsALegalMove() {
        WatchState.values().forEach { state ->
            WatchStateMachine.controls(state).forEach { control ->
                control.resultingState?.let { next ->
                    assertTrue("$control offered on $state would move it to $next", WatchStateMachine.canTransition(state, next))
                }
            }
        }
        assertEquals(listOf(WatchControl.VIEW, WatchControl.EDIT, WatchControl.PAUSE, WatchControl.STOP), WatchStateMachine.controls(WatchState.ACTIVE))
        assertEquals(listOf(WatchControl.VIEW, WatchControl.EDIT, WatchControl.RESUME, WatchControl.STOP), WatchStateMachine.controls(WatchState.PAUSED))
        (WatchStateMachine.terminal + WatchState.UNKNOWN).forEach { assertEquals("$it", listOf(WatchControl.VIEW), WatchStateMachine.controls(it)) }
        assertEquals(listOf("View", "Edit", "Pause", "Resume", "Stop"), WatchControl.values().map { it.title })
    }

    @Test fun targetAndDeliveryStatesMatchTheContract() {
        val states = contract.obj("states")
        assertEquals(states.obj("target").strings("values"), known(WatchTargetState.values()))
        val delivery = states.obj("delivery")
        assertEquals(delivery.strings("values"), known(WatchDeliveryState.values()))
        assertEquals(listOf(WatchDeliveryState.DEAD_LETTER.name), delivery.strings("terminal"))
    }

    @Test fun leavesAndTheKindEachIsEvaluatedAgainstMatchTheContract() {
        val leaves = contract.obj("leaves")
        // A leaf a later grammar introduced declares its sinceVersion, and is one this build reads as unknown.
        val served = leaves.filter { (it.value as JsonObject)["sinceVersion"]?.jsonPrimitive?.int ?: 1 <= WatchPredicate.VERSION }
        assertEquals(served.keys, known(WatchLeaf.values()).toSet())
        leaves.keys.filter { it !in served }.forEach { assertEquals(it, WatchLeaf.UNKNOWN, WatchLeaf.of(it)) }
        WatchLeaf.values().filter { it != WatchLeaf.UNKNOWN }.forEach { leaf ->
            assertEquals(leaf.name, leaves.obj(leaf.name)["targetKind"]!!.jsonPrimitive.content, leaf.targetKind?.name)
        }
        assertEquals(setOf(WatchTargetKind.SESSION.name, WatchTargetKind.TASK.name), contract.strings("watchableTargetKinds").toSet())
    }

    @Test fun kindsSelectorsAndActionsMatchTheContract() {
        val encoded = listOf(WatchPredicate.All(WatchLeaf.TASK_DONE), WatchPredicate.Any(WatchLeaf.TASK_DONE),
            WatchPredicate.AllOf(listOf(WatchPredicate.All(WatchLeaf.TASK_DONE))), WatchPredicate.AnyOf(listOf(WatchPredicate.All(WatchLeaf.TASK_DONE))))
            .map { it.json() }
        val kinds = encoded.map { it["kind"]!!.jsonPrimitive.content }
        // This build's two aggregations are the contract's, in its order; one a later grammar added (a quorum) is a
        // term this build reads as one it does not know.
        val aggregations = contract.strings("aggregations")
        assertEquals(kinds.take(2), aggregations.filter { it in kinds.take(2) })
        aggregations.filter { it !in kinds.take(2) }.forEach { later ->
            val term = buildJsonObject { put("kind", later); put("count", 1); put("over", "ALL_TARGETS"); put("leaf", WatchLeaf.TASK_DONE.name) }
            assertEquals(later, WatchPredicate.Unknown(later), WatchPredicate.decode(term))
        }
        assertEquals(contract.strings("composites"), kinds.takeLast(2))
        assertEquals(contract.strings("targetSelectors").toSet(), encoded.take(2).map { it["over"]!!.jsonPrimitive.content }.toSet())
        assertEquals(known(WatchAction.values()), contract["actions"]!!.jsonArray.map { it.jsonObject["kind"]!!.jsonPrimitive.content })
        // The grammar this build reads is one the server still serves, and none newer than the contract's.
        assertTrue(WatchPredicate.VERSION in contract["servedPredicateVersions"]!!.jsonArray.map { it.jsonPrimitive.int })
        assertTrue(contract["predicateVersion"]!!.jsonPrimitive.int >= WatchPredicate.VERSION)
    }

    /** The canonical agent request (vector `all-terminal-or-any-failed`) reads into this grammar and goes back out
     * as the same JSON. */
    @Test fun theCanonicalRequestRoundTrips() {
        val vector = contract["vectors"]!!.jsonArray.map { it.jsonObject }.first { it["id"]?.jsonPrimitive?.content == "all-terminal-or-any-failed" }
        val raw = vector.obj("given")["predicate"]!!
        val predicate = WatchPredicate.decode(raw)
        assertEquals(WatchPredicate.AnyOf(listOf(WatchPredicate.All(WatchLeaf.TASK_TERMINAL), WatchPredicate.Any(WatchLeaf.TASK_FAILED))), predicate)
        assertEquals(raw, predicate.json())
    }

    /** The dead letters shown without being raised are the contract's `needsAttention: false` codes. */
    @Test fun quietDeadLetterCodesMatchTheContract() {
        val codes = contract.obj("deliveryGuards").obj("deadLetterCodes")
        val quiet = codes.filter { (code, value) ->
            val entry = value as JsonObject
            val needsAttention = requireNotNull(entry["needsAttention"]?.jsonPrimitive?.booleanOrNull) { "$code does not say whether it needs attention" }
            if (!needsAttention) assertEquals("$code can be redriven, so somebody has to see it", false, entry["retryable"]?.jsonPrimitive?.booleanOrNull)
            !needsAttention
        }.keys
        assertEquals(quiet, WatchDeadLetter.quietCodes)
    }

    /** The other two ways into Needs attention, beside a dead letter: the contract's `attention.states` and
     * `attention.expiredActions`, which `GET /watches?needsAttention=true` picks by. */
    @Test fun theEndsThatNeedAttentionMatchTheContract() {
        val attention = contract.obj("attention")
        assertEquals(attention.strings("states").toSet(), WatchAttentionRule.states.map { it.name }.toSet())
        assertEquals(attention.strings("expiredActions").toSet(), WatchAttentionRule.expiredActions.map { it.name }.toSet())
        val terminal = contract.obj("states").obj("watch").strings("terminal").toSet()
        WatchAttentionRule.states.forEach { assertTrue("${it.name} is terminal", it.name in terminal) }
    }

    @Test fun limitsMatchTheContract() {
        val limits = contract.obj("limits")
        fun limit(key: String) = limits[key]!!.jsonPrimitive.int
        assertEquals(limit("minTtlSeconds"), WatchLimits.MIN_TTL_SECONDS)
        assertEquals(limit("defaultTtlSeconds"), WatchLimits.DEFAULT_TTL_SECONDS)
        assertEquals(limit("maxTtlSeconds"), WatchLimits.MAX_TTL_SECONDS)
        assertEquals(limit("maxPredicateDepth"), WatchLimits.MAX_PREDICATE_DEPTH)
        assertEquals(limit("maxOperandsPerComposite"), WatchLimits.MAX_OPERANDS_PER_COMPOSITE)
        assertEquals(limit("maxDeliveryAttempts"), WatchLimits.MAX_DELIVERY_ATTEMPTS)
    }
}
