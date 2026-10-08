package io.orbitd.android.push

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

@Serializable
data class PushBinding(val server: String, val accountId: String, val token: String, val registrationKey: String) {
    override fun toString() = "PushBinding([redacted])"
}

/** The caller supplies a directory inside Context.noBackupFilesDir, never backed-up preferences. */
class PushStorage(private val directory: File) {
    @Serializable
    private data class State(
        val token: String? = null,
        val binding: PushBinding? = null,
        val installations: Map<String, String> = emptyMap(),
    )

    private val file = File(directory, "registration.json")
    private var state = try { Json.decodeFromString<State>(file.readText()) } catch (_: Exception) { State() }

    @Synchronized fun token(): String? = state.token
    @Synchronized fun binding(): PushBinding? = state.binding

    @Synchronized fun installationId(server: String): String {
        state.installations[server]?.let { return it }
        val id = UUID.randomUUID().toString()
        save(state.copy(installations = state.installations + (server to id)))
        return id
    }

    @Synchronized fun setToken(token: String) { save(state.copy(token = token, binding = null)) }
    @Synchronized fun setBinding(binding: PushBinding?) { save(state.copy(binding = binding)) }

    private fun save(next: State) {
        check(directory.isDirectory || directory.mkdirs())
        val temporary = File(directory, "registration.tmp")
        temporary.outputStream().use { stream ->
            stream.write(Json.encodeToString(next).encodeToByteArray())
            stream.fd.sync()
        }
        Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        state = next
    }
}
