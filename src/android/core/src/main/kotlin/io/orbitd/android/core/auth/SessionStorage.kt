package io.orbitd.android.core.auth

import io.orbitd.android.core.protocol.LoginResponse
import kotlinx.serialization.Serializable

/** Access and refresh tokens are committed together with their server and account identity. */
@Serializable
data class StoredSession(val server: String, val credentials: LoginResponse) {
    override fun toString() = "StoredSession([redacted])"
}

interface CredentialStore {
    suspend fun load(): StoredSession?
    /** Must atomically persist and verify the complete record, or throw. */
    suspend fun save(session: StoredSession)
    suspend fun clear()
}

interface InstanceStore {
    suspend fun load(): String?
    suspend fun save(server: String)
}

data class AccountKey(val server: String, val userId: String)
enum class DataKind { DRAFT, CACHE }

/** Only AuthSession exposes reads/writes to pages, after checking the current session handle. */
interface SessionDataStore {
    suspend fun read(account: AccountKey, kind: DataKind, key: String): ByteArray?
    suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray)
    suspend fun clearAll()
}

class SecureStorageException : Exception("Secure session storage is unavailable")
