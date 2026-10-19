package io.orbitd.android.storage

import android.app.Application
import android.security.keystore.KeyPermanentlyInvalidatedException
import io.orbitd.android.core.auth.SecureStorageException
import java.io.FileNotFoundException
import java.io.IOException
import java.security.ProviderException
import java.security.UnrecoverableKeyException
import javax.crypto.AEADBadTagException
import javax.crypto.IllegalBlockSizeException
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A03d: which storage failures make a stored session unrecoverable, and that each keeps its original cause. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = Application::class)
class AndroidSessionStorageTest {
    @Test fun aPermanentlyInvalidatedKeyOrARecordFailingAuthenticationIsUnrecoverable() {
        for (error in listOf(KeyPermanentlyInvalidatedException(), AEADBadTagException(),
            ProviderException("Keystore operation failed", KeyPermanentlyInvalidatedException()))) {
            val failure = storageFailure(error)
            assertTrue(error.toString(), failure.unrecoverable)
            assertSame(error, failure.cause)
        }
    }

    /** I/O and a Keystore that cannot answer for now: restore keeps the stored session. */
    @Test fun aFailureThatMayPassKeepsItsCauseAndIsNotUnrecoverable() {
        for (error in listOf(IOException("fixture"), FileNotFoundException("fixture: open failed: EACCES"),
            UnrecoverableKeyException("Failed to obtain information about key").apply { initCause(IllegalStateException("fixture")) },
            ProviderException("Keystore operation failed"), IllegalBlockSizeException())) {
            val failure = storageFailure(error)
            assertFalse(error.toString(), failure.unrecoverable)
            assertSame(error, failure.cause)
            assertEquals("Secure session storage is unavailable", failure.message)
        }
    }

    @Test fun aStoreFailureIsPassedOnAsItIs() {
        for (failure in listOf(SecureStorageException(), SecureStorageException(unrecoverable = true))) {
            assertSame(failure, storageFailure(failure))
        }
    }
}
