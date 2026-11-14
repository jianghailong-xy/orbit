package io.orbitd.android.core.cards

import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.Serializable

/*
 * The owner's terminals (docs/terminal-session-design.md, "The terminal credential"): a machine where `orbit` asked to be approved,
 * and the terminals approved since. OrbitKit `TerminalModels.swift` and the `terminals` doors of its APIClient; web
 * lib/terminals.ts. Never a credential: only what the approve card and Settings → Terminals show.
 */

/** A terminal sign-in waiting for the owner: what the approve card shows. `GET /terminals/requests`; each lives ten minutes. */
@Serializable
data class TerminalRequest(
    val id: String,
    /** The code the terminal shows ("7KQ-4MZ"), compared by eye before Approve. */
    val userCode: String,
    val machineName: String,
    val runnerId: String,
    val createdAt: String,
    val expiresAt: String,
)

@Serializable
data class TerminalRequestList(val requests: List<TerminalRequest> = emptyList())

/** A live terminal — approved, not revoked, not expired. `GET /terminals`. */
@Serializable
data class Terminal(
    val id: String,
    val machineName: String,
    val runnerId: String,
    val createdAt: String,
    val approvedAt: String,
    val lastUsedAt: String? = null,
    val expiresAt: String,
)

@Serializable
data class TerminalList(val terminals: List<Terminal> = emptyList())

/** The owner's doors on terminals: the approve card's Approve and Deny, and Settings → Terminals' list and Revoke. */
class TerminalsApi(private val api: OrbitApi, private val handle: SessionHandle) {
    /** The terminal sign-ins waiting for this owner. A server that predates terminals answers 404: none, not an error. */
    suspend fun requests(): List<TerminalRequest> = try {
        Wire.decode(api.request(handle, ApiRequest(listOf("terminals", "requests"))).requireSuccess().body, TerminalRequestList.serializer()).requests
    } catch (error: ApiError) {
        if (error.status == 404) emptyList() else throw error
    }

    /** Approve: the terminal's next poll collects a credential bound to this account and that machine, for 30 days. */
    suspend fun approve(id: String) { api.request(handle, ApiRequest(listOf("terminals", "requests", id, "approve"), HttpMethod.POST)).requireSuccess() }

    /** Deny: the terminal is told so, and nothing is minted. */
    suspend fun deny(id: String) { api.request(handle, ApiRequest(listOf("terminals", "requests", id, "deny"), HttpMethod.POST)).requireSuccess() }

    /** The live terminals, newest first. */
    suspend fun list(): List<Terminal> =
        Wire.decode(api.request(handle, ApiRequest(listOf("terminals"))).requireSuccess().body, TerminalList.serializer()).terminals

    /** Revoke one terminal at once: its next request is 401. */
    suspend fun revoke(id: String) { api.request(handle, ApiRequest(listOf("terminals", id), HttpMethod.DELETE)).requireSuccess() }
}
