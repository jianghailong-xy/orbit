package io.orbitd.android.storage

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import io.orbitd.android.core.auth.AccountKey
import io.orbitd.android.core.auth.CredentialStore
import io.orbitd.android.core.auth.DataKind
import io.orbitd.android.core.auth.InstanceStore
import io.orbitd.android.core.auth.SecureStorageException
import io.orbitd.android.core.auth.SessionDataStore
import io.orbitd.android.core.auth.StoredSession
import io.orbitd.android.core.protocol.Wire
import java.io.File
import java.io.FileNotFoundException
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString

/** CE private storage; excluded from both backup and device transfer. No plaintext credential file. */
class AndroidCredentialStore(context: Context, name: String = "credentials") : CredentialStore {
    init { require(name.matches(Regex("[a-z0-9-]+"))) }
    private val file = AtomicFile(File(context.noBackupFilesDir, "orbit/$name.bin"))
    private val alias = "${context.packageName}.orbit.$name.v1"
    private val aad = alias.encodeToByteArray()

    override suspend fun load(): StoredSession? = storageIO {
        synchronized(credentialLock) { read() }
    }

    override suspend fun save(session: StoredSession) = storageIO {
        synchronized(credentialLock) {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, keyStore().getKey(alias, null) as? SecretKey ?: generateKey())
            cipher.updateAAD(aad)
            val plaintext = Wire.json.encodeToString(session).encodeToByteArray()
            val encrypted = try { cipher.doFinal(plaintext) } finally { plaintext.fill(0) }
            check(cipher.iv.size == 12)
            atomicWrite(file, byteArrayOf(1) + cipher.iv + encrypted)
            if (read() != session) throw SecureStorageException()
        }
    }

    override suspend fun clear() = storageIO {
        synchronized(credentialLock) {
            // Delete the key even if a filesystem failure leaves an encrypted file behind.
            try { keyStore().deleteEntry(alias) } finally { file.delete() }
            if (file.baseFile.exists()) throw SecureStorageException()
        }
    }

    private fun read(): StoredSession? {
        val bytes = readOrNull(file) ?: return null
        if (bytes.size < 29 || bytes[0] != 1.toByte()) throw SecureStorageException()
        val key = keyStore().getKey(alias, null) as? SecretKey ?: throw SecureStorageException()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(1, 13)))
        cipher.updateAAD(aad)
        val plaintext = cipher.doFinal(bytes.copyOfRange(13, bytes.size))
        return try { Wire.decode(plaintext, StoredSession.serializer()) } finally { plaintext.fill(0) }
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

    companion object { private val credentialLock = Any() }
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
    try { block() } catch (_: Exception) { throw SecureStorageException() }
}
