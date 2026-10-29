package io.orbitd.android.management

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.time.Instant

/**
 * Add Runner's machine with no browser says what the web says, word for word: each of these RunnerCopy sentences is the one
 * src/web/src/lib/runnerCopy.ts declares under the same name, read as text — an `export function`'s single template with its
 * `${parameter}`s, or an `export const`. The words for what became of a request, and for a runner already of its name, are the web
 * /enroll page's, which EnrollPage.test.tsx holds runnerCopy.ts to. A missing file fails, never skips.
 */
class AddRunnerCopyParityTest {
    private val source: String by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.firstOrNull { File(it, "src/web/src/lib").isDirectory }
        assertNotNull("the repository root was not found above the test's working directory", root)
        File(root, "src/web/src/lib/runnerCopy.ts").also { assertTrue("runnerCopy.ts is missing", it.isFile) }.readText()
            .replace(Regex("""'\s*\+\s*'"""), "")
    }
    /** Each sentence with values, by its name: its template with every `${parameter}` written `{parameter}`. */
    private val templates by lazy {
        Regex("""^export function (\w+)\([^)]*\): string \{\n {2}return `([^`]*)`;\n\}$""", RegexOption.MULTILINE).findAll(source)
            .associate { it.groupValues[1] to it.groupValues[2].replace(Regex("""\$\{(\w+)\}"""), "{$1}") }
    }
    private val constants by lazy {
        Regex("""^export const ([A-Z0-9_]+) =\s*'([^'\n]*)';$""", RegexOption.MULTILINE).findAll(source).associate { it.groupValues[1] to it.groupValues[2] }
    }

    @Test fun theDeviceSectionSaysTheWebsWords() {
        val android = mapOf(
            "RUNNER_NO_BROWSER" to RunnerCopy.NO_BROWSER,
            "RUNNER_DEVICE_CODE" to RunnerCopy.DEVICE_CODE,
            "RUNNER_DEVICE_CODE_PLACEHOLDER" to RunnerCopy.DEVICE_CODE_PLACEHOLDER,
            "RUNNER_DEVICE_CODE_FOOTER" to RunnerCopy.DEVICE_CODE_FOOTER,
            "RUNNER_APPROVE" to RunnerCopy.APPROVE,
            "RUNNER_REREGISTER" to RunnerCopy.REREGISTER,
            "RUNNER_DENY" to RunnerCopy.DENY,
            "RUNNER_DEVICE_APPROVED" to RunnerCopy.DEVICE_APPROVED,
            "runnerDeviceApprovedDetail" to RunnerCopy.deviceApprovedDetail("{name}"),
            "RUNNER_DEVICE_DENIED" to RunnerCopy.DEVICE_DENIED,
            "RUNNER_DEVICE_DENIED_DETAIL" to RunnerCopy.DEVICE_DENIED_DETAIL,
            "runnerDeviceNameTaken" to RunnerCopy.deviceNameTaken("{name}"),
            "runnerDeviceLastOnline" to RunnerCopy.deviceLastOnline("{when}"),
            "RUNNER_DEVICE_NAME_TAKEN_DETAIL" to RunnerCopy.DEVICE_NAME_TAKEN_DETAIL)
        val web = templates + constants
        for ((name, said) in android) assertEquals(name, web[name], said)
    }

    /** The page's notice: "Last online 3d ago. " only when the server says when that runner last checked in, then the rest. */
    @Test fun theSameNamesNoticeSaysWhenThatRunnerWasLastOnlineOnlyWhenTheServerSays() {
        val nowMs = Instant.parse("2026-10-28T12:00:00Z").toEpochMilli()
        assertEquals("Last online 3d ago. ${RunnerCopy.DEVICE_NAME_TAKEN_DETAIL}",
            RunnerPage.deviceNameTakenDetail(buildJsonObject { put("existingLastSeenAt", "2026-10-25T11:00:00.000Z") }, nowMs))
        assertEquals("Last online 5m ago. ${RunnerCopy.DEVICE_NAME_TAKEN_DETAIL}",
            RunnerPage.deviceNameTakenDetail(buildJsonObject { put("existingLastSeenAt", "2026-10-28T11:55:00.000Z") }, nowMs))
        assertEquals(RunnerCopy.DEVICE_NAME_TAKEN_DETAIL, RunnerPage.deviceNameTakenDetail(buildJsonObject { put("existingLastSeenAt", JsonNull) }, nowMs))
        assertEquals(RunnerCopy.DEVICE_NAME_TAKEN_DETAIL, RunnerPage.deviceNameTakenDetail(buildJsonObject { }, nowMs))
    }
}
