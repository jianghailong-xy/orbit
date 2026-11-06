package io.orbitd.android.navigation

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.orbitd.android.core.auth.AuthSession
import io.orbitd.android.core.auth.DataKind
import io.orbitd.android.core.auth.SessionHandle
import kotlinx.coroutines.CancellationException

/** The workspace this phone last showed, which the next launch lands on (iOS `orbit.lastAgent`). It is this account's on this phone:
 * in the account's cache, so a logout clears it. A read or write that fails costs only that landing, which falls to the first. */
internal class LastWorkspace(private val auth: AuthSession, private val handle: SessionHandle) {
    var id by mutableStateOf<String?>(null)
        private set
    var loaded by mutableStateOf(false)
        private set

    suspend fun load() {
        id = try { auth.readData(handle, DataKind.CACHE, KEY)?.decodeToString() }
            catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }
        loaded = true
    }

    suspend fun save(workspace: String) {
        if (ObjectId.same(workspace, id)) return
        id = workspace
        try { auth.writeData(handle, DataKind.CACHE, KEY, workspace.encodeToByteArray()) }
        catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { }
    }

    private companion object { const val KEY = "last-workspace" }
}
