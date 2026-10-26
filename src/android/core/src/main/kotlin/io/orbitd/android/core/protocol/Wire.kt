package io.orbitd.android.core.protocol

import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.DecodeSequenceMode
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeToSequence

object Wire {
    val json = Json { ignoreUnknownKeys = true }

    fun <T> decode(bytes: ByteArray, serializer: DeserializationStrategy<T>): T = protocol {
        json.decodeFromString(serializer, bytes.decodeToString())
    }

    /** A JSON array of objects, read one object at a time straight from [bytes]: never the body as one string. [each] may
     * answer an equal object it already holds instead of the one just read. */
    @OptIn(ExperimentalSerializationApi::class)
    fun objects(bytes: ByteArray, each: (JsonObject) -> JsonObject = { it }): List<JsonObject> = protocol {
        json.decodeToSequence(bytes.inputStream(), JsonObject.serializer(), DecodeSequenceMode.ARRAY_WRAPPED)
            .map(each).toList()
    }

    private inline fun <T> protocol(decode: () -> T): T = try {
        decode()
    } catch (_: SerializationException) {
        // Serialization errors can embed the complete input, including auth credentials.
        throw ProtocolException()
    } catch (_: IllegalArgumentException) {
        throw ProtocolException()
    }
}

class ProtocolException : Exception("The server returned an invalid response")
