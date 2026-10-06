package io.orbitd.android.core.net

import io.orbitd.android.core.auth.OrbitApi
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.protocol.SessionSummary
import io.orbitd.android.core.protocol.User
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.protocol.WorkspaceSummary
import kotlinx.serialization.builtins.ListSerializer

suspend fun OrbitApi.me(handle: SessionHandle): User =
    Wire.decode(request(handle, ApiRequest(listOf("users", "me"))).body, User.serializer())

suspend fun OrbitApi.workspaces(handle: SessionHandle): List<WorkspaceSummary> =
    Wire.decode(request(handle, ApiRequest(listOf("workspaces"))).body, ListSerializer(WorkspaceSummary.serializer()))

suspend fun OrbitApi.sessions(handle: SessionHandle, view: String = "open"): List<SessionSummary> =
    Wire.decode(request(handle, ApiRequest(listOf("sessions"), query = listOf("view" to view))).body,
        ListSerializer(SessionSummary.serializer()))
