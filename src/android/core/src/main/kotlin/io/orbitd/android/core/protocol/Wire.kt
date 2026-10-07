package io.orbitd.android.core.protocol

import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

object Wire {
    val json = Json { ignoreUnknownKeys = true }

    fun <T> decode(bytes: ByteArray, serializer: DeserializationStrategy<T>): T = try {
        json.decodeFromString(serializer, bytes.decodeToString())
    } catch (_: SerializationException) {
        // Serialization errors can embed the complete input, including auth credentials.
        throw ProtocolException()
    } catch (_: IllegalArgumentException) {
        throw ProtocolException()
    }
}

class ProtocolException : Exception("The server returned an invalid response")
