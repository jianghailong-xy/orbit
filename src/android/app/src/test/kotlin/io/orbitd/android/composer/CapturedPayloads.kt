package io.orbitd.android.composer

import io.orbitd.android.core.protocol.Wire
import java.io.File
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject

/**
 * The payloads a real apiserver on PostgreSQL answered (core/src/test/resources/wire/permission-mode, see its README): each session's
 * mode facts written through the server's own doors, read back over HTTP as a signed-in Android client reads them. The one copy is
 * core's; the app's tests find it from their own directory.
 */
internal object CapturedPayloads {
    private val dir: File = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
        .map { File(it, "core/src/test/resources/wire/permission-mode") }.first { it.isDirectory }

    fun json(name: String): JsonElement = Wire.json.parseToJsonElement(File(dir, "$name.json").readText())

    /** What routes a payload to the server's own ids: the shell's session, workspace and runner keep theirs, and every other field
     * is the server's. */
    private val ROUTING = Regex("^(id|publicId|.*Id|.*PublicId|.*Ids|.*PublicIds|agent|workspace|assignedRunner|runner|owner|creator)$")

    /** A captured session detail as [ComposerShell.session]'s fields. */
    fun session(name: String): Map<String, JsonElement> = fields("session-$name")

    /** The captured payload [file] (its path under the directory, without `.json`) as [ComposerShell.session]'s fields. */
    fun fields(file: String): Map<String, JsonElement> = json(file).jsonObject.filterKeys { !ROUTING.matches(it) }

    /** The captured payload [file] as the server sent it, byte for byte. */
    fun text(file: String): String = File(dir, "$file.json").readText()

    /** A captured session detail whole, as the server sent it. */
    fun detail(name: String): JsonObject = json("session-$name").jsonObject

    /** The captured runner of [name] from GET /runners, as [ComposerShell.runner]: the shell's id and name, everything else the server's. */
    fun runner(name: String): JsonObject {
        val list = json("runners")
        val rows = (list as? JsonArray ?: list.jsonObject["runners"]!!.jsonArray).map { it.jsonObject }
        val row = rows.first { (it["name"] as? kotlinx.serialization.json.JsonPrimitive)?.content == name }
        return JsonObject(row.filterKeys { !ROUTING.matches(it) } + ComposerShell.obj("""{"id":"${ComposerShell.RUNNER}"}"""))
    }
}
