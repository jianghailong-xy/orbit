package io.orbitd.android.wiki

import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.Wire
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** OrbitKit `WikiContractTests`' checks that apply to the Kotlin port, against `contracts/wiki.contract.json`: the
 * closed sets this client labels, the anchor keys it writes, the maintenance settings it reads — and every Wiki
 * route the client calls is one the user door declares. The contract is found by walking up; never a skip. */
class WikiContractTest {
    private val contract: JsonObject by lazy {
        val file = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "contracts/wiki.contract.json") }
            .firstOrNull { it.isFile } ?: error("contracts/wiki.contract.json was not found above ${File("").absolutePath}")
        Wire.json.parseToJsonElement(file.readText()).jsonObject
    }
    private fun at(vararg path: String): JsonElement = path.fold(contract as JsonElement) { node, key -> node.jsonObject[key] ?: error("contract has no ${path.joinToString(".")}") }

    @Test fun everyKindAndOpTheContractNamesHasItsLabel() {
        at("kinds").jsonObject.keys.forEach { assertTrue("kind $it has no label", WikiCopy.kindLabel(it).isNotEmpty()) }
        at("ops").jsonObject.keys.forEach { assertTrue("op $it has no chip", WikiCopy.opLabel(it).isNotEmpty()) }
    }

    @Test fun theRejectReasonsAreTheContractsInItsOrderAndWords() {
        val reasons = at("rejectReasons").jsonObject
        assertEquals(reasons.keys.toList(), WikiCopy.rejectReasons)
        reasons.forEach { (key, label) -> assertEquals(label.jsonPrimitive.content, WikiCopy.rejectReasonLabel(key)) }
    }

    @Test fun anAnchorIsWrittenWithTheContractsKeys() {
        val keys = at("anchorTypes").jsonObject.values.flatMap { it.jsonObject.getValue("fields").jsonObject.keys }.toSet() + "type"
        assertEquals(keys, WikiLogic.anchorInputKeys)
    }

    @Test fun maintenanceHeldReasonsAreTheContracts() {
        val reasons = at("maintenance", "job", "held", "reasons").jsonArray.map { it.jsonPrimitive.content }
        assertEquals(listOf("daily_limit_reached", "review_queue_full"), reasons)
        reasons.forEach { reason ->
            val health = WikiMaintenanceHealth.read(buildJsonObject { put("look", "held"); put("enabled", true)
                putJsonObject("held") { put("reason", reason); put("at", "2026-09-28T06:00:00.000Z") } })
            assertEquals(reason, health.held?.reason)
        }
    }

    @Test fun maintenanceSettingsAreTheContracts() {
        val maintenance = at("space", "settings", "maintenance").jsonObject
        val defaults = maintenance.getValue("default").jsonObject
        assertEquals(setOf("enabled", "workspaceId", "provider", "dailyRunLimit", "lookbackDays", "listId"), defaults.keys)
        assertEquals(WikiMaintenanceSettings.default, WikiMaintenanceSettings.read(defaults))
        assertFalse("maintenance is off until the owner turns it on", WikiMaintenanceSettings.default.enabled)
        assertEquals(WikiMaintenanceSettings.default, WikiMaintenanceSettings.read(JsonObject(emptyMap())))
        assertNull("a server that predates maintenance sends none", Wire.json.decodeFromString(WikiSpaceSettings.serializer(), """{"push":true}""").maintenance)
        val bounds = maintenance.getValue("bounds").jsonObject
        assertEquals(bounds["dailyRunLimit"]!!.jsonObject["min"]!!.jsonPrimitive.int, WikiMaintenanceSettings.dailyRunLimitRange.first)
        assertEquals(bounds["dailyRunLimit"]!!.jsonObject["max"]!!.jsonPrimitive.int, WikiMaintenanceSettings.dailyRunLimitRange.last)
        assertEquals(bounds["lookbackDays"]!!.jsonObject["min"]!!.jsonPrimitive.int, WikiMaintenanceSettings.lookbackDaysRange.first)
        assertEquals(bounds["lookbackDays"]!!.jsonObject["max"]!!.jsonPrimitive.int, WikiMaintenanceSettings.lookbackDaysRange.last)
        listOf("1" to 1, "48" to 48, "0" to 8, "49" to 8, "2.5" to 8, "\"12\"" to 8).forEach { (stored, reads) ->
            assertEquals("dailyRunLimit $stored", reads, WikiMaintenanceSettings.read(Wire.json.parseToJsonElement("""{"dailyRunLimit":$stored}"""))!!.dailyRunLimit)
        }
        listOf("0" to 0, "1" to 1, "365" to 365, "null" to null, "-1" to 14, "366" to 14, "2.5" to 14, "\"7\"" to 14).forEach { (stored, reads) ->
            assertEquals("lookbackDays $stored", reads, WikiMaintenanceSettings.read(Wire.json.parseToJsonElement("""{"lookbackDays":$stored}"""))!!.lookbackDays)
        }
        assertEquals("a look-back left out is the default, not all of history", 14, WikiMaintenanceSettings.read(JsonObject(emptyMap()))!!.lookbackDays)
    }

    /** Every request the Wiki client makes, from every method it has, matched against `agentSurface.doors.user.routes`. */
    @Test fun everyWikiRouteTheClientCallsIsOnTheUserDoor() = runBlocking {
        val routes = at("agentSurface", "doors", "user", "routes").jsonArray.map { it.jsonPrimitive.content }
        val sent = mutableListOf<String>()
        val auth = AuthSession(HttpTransport { request ->
            val api = request.api
            if (api.path == listOf("auth", "login")) ApiResponse(200, """{"accessToken":"a","refreshToken":"r","user":{"id":"u","email":"u@example.test","name":"U"}}""".encodeToByteArray())
            else { sent += "${api.method} /api/${api.path.joinToString("/")}"; ApiResponse(503, "{}".encodeToByteArray()) }
        }, object : CredentialStore {
            private var saved: StoredSession? = null
            override suspend fun load() = saved
            override suspend fun save(session: StoredSession) { saved = session }
            override suspend fun clear() { saved = null }
        }, object : InstanceStore {
            override suspend fun load(): String? = null
            override suspend fun save(server: String) {}
        }, object : SessionDataStore {
            override suspend fun read(account: AccountKey, kind: DataKind, key: String): ByteArray? = null
            override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) {}
            override suspend fun clearAll() {}
        }, "test")
        auth.login(ServerAddress.parse("https://fixture.test"), "u@example.test", "password")
        val client = WikiClient(auth, (auth.state.value as AuthState.SignedIn).handle)
        suspend fun call(block: suspend WikiClient.() -> Unit) = try { client.block() } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) {}
        val id = "34UAq0rbitSpaceOrbit01"
        call { spaces() }; call { space(id) }; call { entries(id) }; call { timeline(id) }; call { health(id) }
        call { articleDirectory(id) }; call { article(id, "reader", 0) }; call { article(id, "reader", 2) }; call { articleIndex(id) }
        call { topic(id, "reader") }; call { review() }; call { review(id) }; call { changeset(id) }; call { entry(id) }; call { search("q", id) }
        call { decide(id, "o", "accept") }; call { submit(id, JsonObject(emptyMap()), "r", "k") }; call { updateSpace(id, JsonObject(emptyMap())) }
        call { confirmEntry(id) }; call { rejectEntry(id, "not_true") }; call { revert(id) }
        call { docs(id) }; call { doc(id, "deploy") }; call { docIndex(id) }; call { plan(id) }; call { planVersions(id) }; call { planVersion(id, 3) }
        call { redraftPlan(id, "x") }; call { confirmPlan(id, 3) }; call { editPlan(id, JsonObject(emptyMap())) }; call { decidePlanProposal(id, true) }
        fun matches(request: String, route: String): Boolean {
            val (method, path) = request.split(' ', limit = 2); val (routeMethod, routePath) = route.split(' ', limit = 2)
            val a = path.split('/'); val b = routePath.split('/')
            return method == routeMethod && a.size == b.size && a.zip(b).all { (x, y) -> y.startsWith(':') || x == y }
        }
        val wiki = sent.filter { it.substringAfter(' ').startsWith("/api/wiki/") }
        assertEquals("every client method made its request", 31, wiki.size)
        wiki.forEach { request -> assertTrue("$request is not a route the user door declares", routes.any { matches(request, it) }) }
    }
}
