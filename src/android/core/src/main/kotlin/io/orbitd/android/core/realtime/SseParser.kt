package io.orbitd.android.core.realtime

import io.orbitd.android.core.protocol.ProtocolException
import java.io.ByteArrayOutputStream

data class SseFrame(val data: String, val event: String?, val id: String?)

/** Byte framing keeps UTF-8 fragments and empty dispatch lines intact. EOF never commits a frame. */
class SseParser(private val maxFrameBytes: Int = 4 * 1024 * 1024) {
    private val line = ByteArrayOutputStream()
    private val data = mutableListOf<String>()
    private var event: String? = null
    private var id: String? = null
    private var firstLine = true
    private var afterCr = false
    private var frameBytes = 0

    fun consume(byte: Byte): SseFrame? {
        val value = byte.toInt() and 255
        if (afterCr && value == 10) { afterCr = false; return null }
        afterCr = value == 13
        if (++frameBytes > maxFrameBytes) throw ProtocolException()
        if (value != 10 && value != 13) { line.write(value); return null }
        var text = line.toByteArray().decodeToString()
        line.reset()
        if (firstLine) { text = text.removePrefix("\uFEFF"); firstLine = false }
        if (text.isEmpty()) {
            val result = if (data.isEmpty()) null else SseFrame(data.joinToString("\n"), event, id)
            data.clear()
            event = null
            frameBytes = 0
            return result
        }
        if (text.startsWith(':')) return null
        val field = text.substringBefore(':')
        val content = if (':' in text) text.substringAfter(':').removePrefix(" ") else ""
        when (field) {
            "data" -> data += content
            "event" -> event = content
            "id" -> if ('\u0000' !in content) id = content
        }
        return null
    }
}
