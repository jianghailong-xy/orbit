package io.orbitd.android.watch

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Pins the Watch wire types to what `GET /watches/:id` actually sends (OrbitKit `WatchCodableTests`): every id is the
 * public id with a `…PublicId` twin beside it, a Match nests its deliveries and snapshot, and an unmatched end is
 * flattened into `expiryDeliveries` next to its `kind`. */
class WatchCodableTest {
    @Test fun decodesAMatchedWatchAsTheServerSendsIt() {
        val watch = WatchFixture.server("""
        {
          "id":"4ZcDj8QnWm0KxO4hQ2Hn9V","publicId":"4ZcDj8QnWm0KxO4hQ2Hn9V",
          "observerType":"SESSION","observerSessionId":"5beHmMJGwRpQhndTZImQL3",
          "observerSessionPublicId":"5beHmMJGwRpQhndTZImQL3",
          "predicateVersion":1,
          "predicate":{"kind":"ANY_OF","operands":[
            {"kind":"ALL","over":"ALL_TARGETS","leaf":"TASK_TERMINAL"},
            {"kind":"ANY","over":"ALL_TARGETS","leaf":"TASK_FAILED"}]},
          "mode":"ONE_SHOT","action":"RESUME_SESSION","state":"MATCHED","generation":1,
          "expiresAt":"2026-09-15T02:27:18.859Z","nextEvaluateAt":null,
          "lastEvaluatedAt":"2026-09-14T03:01:02.003Z","idempotencyKey":null,
          "createdAt":"2026-09-14T02:27:18.859Z","updatedAt":"2026-09-14T03:01:02.003Z",
          "targets":[
            {"targetKind":"TASK","targetResourceId":"34DGtxXdn1PcOJxwF1k2n",
             "targetResourcePublicId":"34DGtxXdn1PcOJxwF1k2n","state":"SATISFIED","targetEpoch":0,
             "lastEvaluatedAt":"2026-09-14T03:01:02.003Z"},
            {"targetKind":"TASK","targetResourceId":"34DGtxcc4kgCWg19LFgVZ","state":"GONE","targetEpoch":0,
             "lastEvaluatedAt":null}
          ],
          "matches":[{
            "id":"4ZcDj8QnWm0KxO4hQ2Hn9W","generation":1,"matchedAt":"2026-09-14T03:01:02.003Z",
            "reason":"ANY_OF(ALL TASK_TERMINAL 1/1, ANY TASK_FAILED 0/1)","predicateVersion":1,
            "perTargetSnapshot":{"evaluatedAt":"2026-09-14T03:01:02.003Z","targets":[
              {"kind":"TASK","id":"34DGtxXdn1PcOJxwF1k2n","publicId":"34DGtxXdn1PcOJxwF1k2n","epoch":0,
               "state":"SATISFIED","changed":true,"leaves":{"TASK_TERMINAL":true,"TASK_FAILED":false},
               "observed":{"status":"DONE"}},
              {"kind":"TASK","id":"34DGtxcc4kgCWg19LFgVZ","epoch":0,"state":"GONE","changed":true}
            ]},
            "deliveries":[{"id":"4ZcDj8QnWm0KxO4hQ2Hn9X","action":"RESUME_SESSION","state":"DEAD_LETTER",
              "attempts":0,"nextAttemptAt":"2026-09-14T03:01:02.003Z",
              "lastError":"OBSERVER_SESSION_ENDED: the observer's run ended",
              "deliveredAt":"2026-09-14T03:01:03.000Z","deadLetteredAt":"2026-09-14T03:05:00.000Z",
              "createdAt":"2026-09-14T03:01:02.003Z","updatedAt":"2026-09-14T03:05:00.000Z"}]
          }],
          "expiryDeliveries":[]
        }
        """)
        assertEquals("4ZcDj8QnWm0KxO4hQ2Hn9V", watch.id)
        assertEquals(WatchObserverType.SESSION, watch.observerType)
        assertEquals("5beHmMJGwRpQhndTZImQL3", watch.observerSessionId)
        assertEquals(WatchPredicate.AnyOf(listOf(WatchPredicate.All(WatchLeaf.TASK_TERMINAL), WatchPredicate.Any(WatchLeaf.TASK_FAILED))), watch.predicate)
        assertEquals(WatchMode.ONE_SHOT, watch.mode)
        assertEquals(WatchAction.RESUME_SESSION, watch.action)
        assertEquals(WatchState.MATCHED, watch.state)
        assertEquals(1, watch.generation)
        assertEquals(listOf(WatchTargetState.SATISFIED, WatchTargetState.GONE), watch.targets.map { it.state })
        assertEquals(listOf("34DGtxXdn1PcOJxwF1k2n", "34DGtxcc4kgCWg19LFgVZ"), watch.targets.map { it.targetResourceId })
        assertNull(watch.targets[1].lastEvaluatedAt)

        val match = watch.matches.single()
        assertEquals(1, match.generation)
        val seen = match.perTargetSnapshot!!.targets
        assertEquals(true, seen.first().leaves?.get("TASK_TERMINAL"))
        assertEquals("DONE", seen.first().observed?.status)
        // A GONE target carries neither leaves nor observed columns.
        assertNull(seen.last().leaves)
        assertNull(seen.last().observed)
        assertEquals(WatchDeliveryState.DEAD_LETTER, match.deliveries.first().state)
        assertEquals("OBSERVER_SESSION_ENDED: the observer's run ended", match.deliveries.first().lastError)
        assertTrue(watch.expiryDeliveries.isEmpty())
    }

    /** Only an expiry carries a snapshot; a revoked watch reports nothing about its targets (§7). */
    @Test fun decodesUnmatchedEndsWithTheDeliveryFlattenedBesideTheKind() {
        val ends = Wire.json.parseToJsonElement("""
        [{"kind":"EXPIRY","id":"E1","action":"RESUME_SESSION","state":"DELIVERED","attempts":1,
          "nextAttemptAt":null,"lastError":null,"deliveredAt":"2026-09-14T03:00:00.000Z","deadLetteredAt":null,
          "createdAt":"2026-09-14T02:59:00.000Z","updatedAt":"2026-09-14T03:00:00.000Z",
          "expirySnapshot":{"evaluatedAt":"2026-09-14T02:59:00.000Z","targets":[
            {"kind":"SESSION","id":"S2","epoch":0,"state":"OBSERVED","changed":false,
             "leaves":{"SESSION_TURN_SETTLED":false},
             "observed":{"status":"RUNNING","endReason":null,"runState":"RUNNING","lifecycleState":"OPEN",
                         "pendingApproval":false}}]}},
         {"kind":"REVOKED","id":"E2","action":"RESUME_SESSION","state":"PENDING","attempts":0,
          "nextAttemptAt":"2026-09-14T03:00:00.000Z","lastError":null,"deliveredAt":null,"deadLetteredAt":null,
          "createdAt":"2026-09-14T03:00:00.000Z","updatedAt":"2026-09-14T03:00:00.000Z","expirySnapshot":null}]
        """).jsonArray.map { WatchEndDelivery.decode(it.jsonObject) }
        assertEquals(listOf(WatchEndDelivery.Kind.EXPIRY, WatchEndDelivery.Kind.REVOKED), ends.map { it.kind })
        assertEquals("E1", ends[0].delivery.id)
        assertEquals(WatchDeliveryState.DELIVERED, ends[0].delivery.state)
        assertEquals(1, ends[0].delivery.attempts)
        val facts = ends[0].expirySnapshot!!.targets.first().observed!!
        assertEquals("RUNNING", facts.runState)
        assertEquals(false, facts.pendingApproval)
        assertEquals(WatchDeliveryState.PENDING, ends[1].delivery.state)
        assertNull(ends[1].expirySnapshot)
    }

    /** A newer server's words for a state, a leaf, a term or a delivery mustn't fail the whole list. */
    @Test fun unknownValuesDecodeToUnknownRatherThanThrowing() {
        val watch = WatchFixture.server("""
        {"id":"W9","observerType":"TEAM","observerSessionId":null,"predicateVersion":1,
         "predicate":{"kind":"ANY_OF","operands":[{"kind":"ALL","over":"ALL_TARGETS","leaf":"TASK_BLOCKED"},
                                                  {"kind":"NONE_OF","operands":[]}]},
         "mode":"CONTINUOUS_V2","action":"EMAIL","state":"SNOOZED","generation":0,
         "expiresAt":"2026-09-15T00:00:00.000Z","nextEvaluateAt":null,"lastEvaluatedAt":null,
         "createdAt":"2026-09-14T00:00:00.000Z","updatedAt":"2026-09-14T00:00:00.000Z",
         "targets":[{"targetKind":"WORKFLOW","targetResourceId":"X1","state":"PARKED","targetEpoch":2,
                     "lastEvaluatedAt":null}],
         "matches":[{"id":"M1","generation":1,"matchedAt":"2026-09-14T00:00:00.000Z","reason":"?",
                     "predicateVersion":1,"perTargetSnapshot":null,
                     "deliveries":[{"id":"D1","action":"EMAIL","state":"BOUNCED","attempts":0,"nextAttemptAt":null,
                                    "lastError":null,"deliveredAt":null,"deadLetteredAt":null,
                                    "createdAt":"2026-09-14T00:00:00.000Z","updatedAt":"2026-09-14T00:00:00.000Z"}]}],
         "expiryDeliveries":[{"kind":"DRAINED","id":"E1","action":"EMAIL","state":"PENDING","attempts":0,
                              "nextAttemptAt":null,"lastError":null,"deliveredAt":null,"deadLetteredAt":null,
                              "createdAt":"2026-09-14T00:00:00.000Z","updatedAt":"2026-09-14T00:00:00.000Z"}]}
        """)
        assertEquals(WatchState.UNKNOWN, watch.state)
        assertEquals(WatchObserverType.UNKNOWN, watch.observerType)
        assertEquals(WatchMode.UNKNOWN, watch.mode)
        assertEquals(WatchAction.UNKNOWN, watch.action)
        assertEquals(WatchPredicate.AnyOf(listOf(WatchPredicate.All(WatchLeaf.UNKNOWN), WatchPredicate.Unknown("NONE_OF"))), watch.predicate)
        assertFalse(watch.predicate.isKnown)
        assertEquals(WatchTargetKind.UNKNOWN, watch.targets.first().targetKind)
        assertEquals(WatchTargetState.UNKNOWN, watch.targets.first().state)
        assertEquals(WatchDeliveryState.UNKNOWN, watch.matches.first().deliveries.first().state)
        assertEquals(WatchEndDelivery.Kind.UNKNOWN, watch.expiryDeliveries.first().kind)
        assertNull(watch.expiryDeliveries.first().expirySnapshot)
        // Every surface still reads it without failing.
        assertEquals("Unknown state", WatchProjection.headline(watch))
        assertEquals("An action this version of Orbit can't show", WatchProjection.action(watch, null))
        // Each operand it can't read says so, as OrbitKit's sentence does.
        assertEquals("A condition this version of Orbit can't show, or a condition this version of Orbit can't show",
            WatchProjection.condition(watch.predicate, 1))
        // A delivery state this build can't name says nothing; the end's pending one, after it, still reads.
        assertNull(WatchProjection.deliveryStatus(watch.matches.first().deliveries.first()))
        assertEquals("Delivering", WatchProjection.deliveryStatus(watch))
    }

    /** v1 has one selector; an aggregation over any other set is a term this build can't read. */
    @Test fun anAggregationOverAnotherSelectorIsUnknown() {
        assertEquals(WatchPredicate.Unknown("ALL"),
            WatchPredicate.decode(Wire.json.parseToJsonElement("""{"kind":"ALL","over":"FIRST_TARGET","leaf":"TASK_DONE"}""")))
    }

    /** The grammar goes back out exactly as the contract spells it (docs/watch-contract.md §2.1). */
    @Test fun predicateEncodesTheContractGrammar() {
        val predicate = WatchPredicate.AnyOf(listOf(WatchPredicate.All(WatchLeaf.TASK_TERMINAL), WatchPredicate.Any(WatchLeaf.TASK_FAILED)))
        val json = predicate.json()
        assertEquals("ANY_OF", json["kind"]!!.jsonPrimitive.content)
        assertNull(json["leaf"])
        val operands = json["operands"]!!.jsonArray.map { it.jsonObject }
        assertEquals(listOf("ALL", "ANY"), operands.map { it["kind"]!!.jsonPrimitive.content })
        assertEquals(listOf("ALL_TARGETS", "ALL_TARGETS"), operands.map { it["over"]!!.jsonPrimitive.content })
        assertEquals(listOf("TASK_TERMINAL", "TASK_FAILED"), operands.map { it["leaf"]!!.jsonPrimitive.content })
        assertNull(operands[0]["operands"])
        assertEquals(predicate, WatchPredicate.decode(json))
    }

    /** One row this build can't use leaves the rest of the list standing: a row with no id is left out, and a field
     * the decoder can't read takes its empty value. */
    @Test fun aRowWithoutAnIdIsLeftOutAndMissingFieldsReadEmpty() {
        assertNull(Watch.decode(Wire.json.parseToJsonElement("""{"state":"ACTIVE"}""")))
        assertNull(Watch.decode(Wire.json.parseToJsonElement("""["W1"]""")))
        val bare = WatchFixture.server("""{"id":"W1","state":"PAUSED","targets":[{"targetKind":"TASK","state":"OBSERVED","targetStatus":{"running":true}}]}""")
        assertEquals(WatchState.PAUSED, bare.state)
        assertEquals(WatchPredicate.Unknown(""), bare.predicate)
        assertEquals("", bare.targets.single().targetResourceId)
        assertNull("a standing with no status is no standing", bare.targets.single().targetStatus)
        assertNull("a target with no id opens nothing", watchTargetRoute(bare.targets.single()))
        assertEquals("Paused · 1 target", WatchProjection.headline(bare))
    }
}
