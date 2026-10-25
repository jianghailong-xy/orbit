package io.orbitd.android.core.auth

import io.orbitd.android.core.net.ApiResponse
import io.orbitd.android.core.net.HttpRequest
import io.orbitd.android.core.net.HttpTransport
import io.orbitd.android.core.net.ServerAddress
import io.orbitd.android.core.protocol.LoginResponse
import io.orbitd.android.core.protocol.User
import io.orbitd.android.core.protocol.Wire
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.serialization.encodeToString

internal val serverA = ServerAddress.parse("https://orbit.example/team-a")
internal val serverB = ServerAddress.parse("https://orbit.example:8443/team-b")
internal fun tokens(user: String = "alice", version: Int = 0) = LoginResponse(
    "fixture-access-$user-$version", "fixture-refresh-$user-$version", User(user, "$user@example.test", user),
)
internal fun response(tokens: LoginResponse) = ApiResponse(200, Wire.json.encodeToString(tokens).encodeToByteArray())
internal fun ok() = ApiResponse(200, "{}".encodeToByteArray())
internal fun unauthorized() = ApiResponse(401, "{\"message\":\"Unauthorized\"}".encodeToByteArray())

internal class MemoryCredentials : CredentialStore {
    var value: StoredSession? = null
    var failSave = false
    /** Thrown by the next loads, one each, before a load reads [value]. */
    val loadFailures = ArrayDeque<SecureStorageException>()
    var loads = 0
    override suspend fun load(): StoredSession? {
        loads++
        loadFailures.removeFirstOrNull()?.let { throw it }
        return value
    }
    override suspend fun save(session: StoredSession) {
        if (failSave) throw SecureStorageException()
        value = session
    }
    override suspend fun clear() { value = null }
}
internal class MemoryInstances : InstanceStore {
    var value: String? = null
    override suspend fun load() = value
    override suspend fun save(server: String) { value = server }
}
internal class MemoryEmails : EmailStore {
    val values = mutableMapOf<String, String>()
    var fail = false
    override suspend fun load(server: String): String? {
        if (fail) throw SecureStorageException()
        return values[server]
    }
    override suspend fun save(server: String, email: String) {
        if (fail) throw SecureStorageException()
        values[server] = email
    }
}
internal class MemoryData : SessionDataStore {
    val values = mutableMapOf<Triple<AccountKey, DataKind, String>, ByteArray>()
    override suspend fun read(account: AccountKey, kind: DataKind, key: String) = values[Triple(account, kind, key)]
    override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) { values[Triple(account, kind, key)] = bytes }
    override suspend fun clearAll() { values.clear() }
}

internal class Harness(scope: TestScope) {
    val credentials = MemoryCredentials()
    val instances = MemoryInstances()
    val data = MemoryData()
    val emails = MemoryEmails()
    val requests = mutableListOf<HttpRequest>()
    val logs = mutableListOf<String>()
    var handler: suspend (HttpRequest) -> ApiResponse = { ok() }
    private val dispatcher = StandardTestDispatcher(scope.testScheduler)
    /** A session over these stores, as the next launch's process creates it. */
    fun launch() = AuthSession(HttpTransport {
        requests += it
        if (it.api.path == listOf("auth", "logout")) ok() else handler(it)
    }, credentials, instances, data, "test", dispatcher = dispatcher, emails = emails, log = { logs += it })
    val client = launch()

    suspend fun seed(): SessionHandle {
        instances.value = serverA.value
        credentials.value = StoredSession(serverA.value, tokens())
        client.restore()
        return (client.state.value as AuthState.SignedIn).handle
    }

    val refreshes get() = requests.filter { it.api.path == listOf("auth", "refresh") }
}
