package io.orbitd.android.storage

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import io.orbitd.android.core.auth.AccountKey
import io.orbitd.android.core.auth.CredentialStore
import io.orbitd.android.core.auth.DataKind
import io.orbitd.android.core.auth.EmailStore
import io.orbitd.android.core.auth.InstanceStore
import io.orbitd.android.core.auth.SecureStorageException
import io.orbitd.android.core.auth.SessionDataStore
import io.orbitd.android.core.auth.StoredSession
import io.orbitd.android.core.protocol.ProtocolException
import io.orbitd.android.core.protocol.Wire
import java.io.File
import java.io.FileNotFoundException
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.encodeToString

/** CE private storage; excluded from both backup and device transfer. No plaintext credential file. */
class AndroidCredentialStore(context: Context, name: String = "credentials") : CredentialStore {
    init { require(name.matches(Regex("[a-z0-9-]+"))) }
    private val record = EncryptedRecord(context, name)

    override suspend fun load(): StoredSession? = storageIO {
        synchronized(credentialLock) { read() }
    }

    override suspend fun save(session: StoredSession) = storageIO {
        synchronized(credentialLock) {
            record.write(Wire.json.encodeToString(session).encodeToByteArray())
            if (read() != session) throw SecureStorageException()
        }
    }

    override suspend fun clear() = storageIO {
        synchronized(credentialLock) { record.delete() }
    }

    private fun read(): StoredSession? = record.read { Wire.decode(it, StoredSession.serializer()) }

    companion object { private val credentialLock = Any() }
}

/**
 * Each server's last signed-in email, for its login page (A03c, following iOS fdeb033ad): a deliberate change to A03's "no
 * email on disk", decided by the coordinator. One encrypted record like the credentials', under a key of its own, in the same
 * backup- and transfer-excluded storage. Sign-out and expiry leave it, as iOS keeps its email; it goes with the app's data.
 */
class AndroidEmailStore(context: Context, name: String = "emails") : EmailStore {
    init { require(name.matches(Regex("[a-z0-9-]+"))) }
    private val record = EncryptedRecord(context, name)
    private val serializer = MapSerializer(String.serializer(), String.serializer())

    override suspend fun load(server: String): String? = storageIO {
        synchronized(emailLock) { read()[server] }
    }

    override suspend fun save(server: String, email: String) = storageIO {
        synchronized(emailLock) {
            // An unreadable record (a lost key, tampering) is started again rather than blocking every later sign-in's email.
            val emails = (try { read() } catch (_: Exception) { emptyMap() }) + (server to email)
            record.write(Wire.json.encodeToString(serializer, emails).encodeToByteArray())
        }
    }

    private fun read(): Map<String, String> = record.read { Wire.decode(it, serializer) } ?: emptyMap()

    companion object { private val emailLock = Any() }
}

/**
 * One AES-256-GCM record under an AndroidKeyStore key of its own, in CE `noBackupFilesDir/orbit`: a format byte, the random
 * 96-bit IV, then ciphertext and 128-bit tag, with the key alias (which carries the package) as associated data.
 */
private class EncryptedRecord(context: Context, name: String) {
    private val file = AtomicFile(File(context.noBackupFilesDir, "orbit/$name.bin"))
    private val alias = "${context.packageName}.orbit.$name.v1"
    private val aad = alias.encodeToByteArray()

    /** Encrypts and commits [plaintext], then wipes it. */
    fun write(plaintext: ByteArray) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, keyStore().getKey(alias, null) as? SecretKey ?: generateKey())
        cipher.updateAAD(aad)
        val encrypted = try { cipher.doFinal(plaintext) } finally { plaintext.fill(0) }
        check(cipher.iv.size == 12)
        atomicWrite(file, byteArrayOf(1) + cipher.iv + encrypted)
    }

    /**
     * The decrypted record handed to [decode] and wiped after; null when there is none. Fails closed on anything else, and
     * says which are unrecoverable: a record of another format, a key that is gone, or authenticated bytes that do not decode.
     */
    fun <T> read(decode: (ByteArray) -> T): T? {
        val bytes = readOrNull(file) ?: return null
        if (bytes.size < 29 || bytes[0] != 1.toByte()) throw SecureStorageException(unrecoverable = true)
        // Keystore2 (Android 12+) answers null only for a key that does not exist. Android 10–11's keystore answers null
        // as well when its daemon cannot be reached, so there a missing key may come back.
        val key = keyStore().getKey(alias, null) as? SecretKey
            ?: throw SecureStorageException(unrecoverable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(1, 13)))
        cipher.updateAAD(aad)
        val plaintext = cipher.doFinal(bytes.copyOfRange(13, bytes.size))
        return try {
            decode(plaintext)
        } catch (error: ProtocolException) {
            throw SecureStorageException(error, unrecoverable = true)
        } finally { plaintext.fill(0) }
    }

    fun delete() {
        // Delete the key even if a filesystem failure leaves an encrypted file behind.
        try { keyStore().deleteEntry(alias) } finally { file.delete() }
        if (file.baseFile.exists()) throw SecureStorageException()
    }

    private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun generateKey(): SecretKey = KeyGenerator.getInstance("AES", "AndroidKeyStore").run {
        init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build())
        generateKey()
    }
}

class AndroidInstanceStore(context: Context, name: String = "instance") : InstanceStore {
    init { require(name.matches(Regex("[a-z0-9-]+"))) }
    private val file = AtomicFile(File(context.noBackupFilesDir, "orbit/$name"))
    override suspend fun load(): String? = storageIO {
        readOrNull(file)?.decodeToString()
    }
    override suspend fun save(server: String) = storageIO { atomicWrite(file, server.encodeToByteArray()) }
}

/** Content is app-private; namespace includes the complete canonical server and stable user id. */
class AndroidSessionDataStore(context: Context, name: String = "accounts") : SessionDataStore {
    init { require(name.matches(Regex("[a-z0-9-]+"))) }
    private val root = File(context.noBackupFilesDir, "orbit/$name")

    override suspend fun read(account: AccountKey, kind: DataKind, key: String): ByteArray? = storageIO {
        val file = dataFile(account, kind, key)
        readOrNull(file)
    }
    override suspend fun write(account: AccountKey, kind: DataKind, key: String, bytes: ByteArray) = storageIO {
        atomicWrite(dataFile(account, kind, key), bytes)
    }
    override suspend fun clearAll() = storageIO {
        if (root.exists() && !root.deleteRecursively()) throw SecureStorageException()
    }

    private fun dataFile(account: AccountKey, kind: DataKind, key: String): AtomicFile {
        val namespace = digest("${account.server.length}:${account.server}${account.userId}")
        return AtomicFile(File(root, "$namespace/${kind.name}/${digest(key)}"))
    }
    private fun digest(value: String) = MessageDigest.getInstance("SHA-256")
        .digest(value.encodeToByteArray()).joinToString("") { "%02x".format(it) }
}

private fun atomicWrite(file: AtomicFile, bytes: ByteArray) {
    val stream = file.startWrite()
    try {
        stream.write(bytes)
        file.finishWrite(stream)
    } catch (error: Exception) {
        file.failWrite(stream)
        throw error
    }
}

private fun readOrNull(file: AtomicFile): ByteArray? = try {
    file.readFully()
} catch (error: FileNotFoundException) {
    if (file.baseFile.exists() || File(file.baseFile.path + ".bak").exists()) throw error
    null
}

private suspend fun <T> storageIO(block: () -> T): T = withContext(Dispatchers.IO) {
    try { block() } catch (error: Exception) { throw storageFailure(error) }
}

/**
 * [error] as the stores report it, with the original failure as its cause. A key the Keystore has permanently invalidated,
 * and a record that fails GCM authentication, can never be read again; any other failure (I/O, a busy or restarting
 * Keystore) may pass, and restoring keeps what is stored.
 */
internal fun storageFailure(error: Exception): SecureStorageException = error as? SecureStorageException
    ?: SecureStorageException(error, unrecoverable = generateSequence<Throwable>(error) { it.cause }.take(8)
        .any { it is KeyPermanentlyInvalidatedException || it is AEADBadTagException })
