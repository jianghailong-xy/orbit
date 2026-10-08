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

/**
 * The email of the last successful password sign-in on each server, which that server's login page prefills (iOS fdeb033ad).
 * A deliberate change to A03's "no email on disk": the coordinator's A03c decision follows iOS, which keeps the email through
 * sign-out and session expiry. A store must encrypt it, keep it out of backups and device transfer, and never hold a password.
 */
interface EmailStore {
    suspend fun load(server: String): String?
    suspend fun save(server: String, email: String)
}

data class AccountKey(val server: String, val userId: String)
enum class DataKind { DRAFT, CACHE }

/** Only AuthSession exposes reads/writes to pages, after checking the current session handle. */
interface SessionDataStore {
    suspend fun read(account: AccountKey, kind: DataKind, key: String): ByteArray?
    suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray)
    suspend fun clearAll()
}

/**
 * [cause] is the store's original failure, kept for diagnosis; the message never carries a stored value. [unrecoverable]
 * means what is stored can never be read again (corrupt, or its key is gone or invalidated). Anything else may pass, such
 * as an I/O error or a Keystore that is busy, so restoring keeps what is stored rather than deleting it.
 */
class SecureStorageException(cause: Throwable? = null, val unrecoverable: Boolean = false) :
    Exception("Secure session storage is unavailable", cause)
