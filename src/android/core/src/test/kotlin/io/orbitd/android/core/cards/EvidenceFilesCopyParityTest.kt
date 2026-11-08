package io.orbitd.android.core.cards

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * Every word an evidence card shares with the other clients is the web's `src/web/src/lib/evidenceFiles.ts`, which T6 wrote for the
 * native clients' parity tests to read. Kotlin cannot import it, so this reads the file as text and holds each EvidenceFiles word to the
 * web declaration of the same meaning, each template rendered with the web's own `${…}` holes so the whole sentence is compared. The
 * words are new on every client at once, so they are held to the web rather than to OrbitKit, whose own parity test holds it to the same
 * lines. What may be drawn inline is held to the same place: the web's `userFile.ts` list, without its one type that is no picture.
 * A missing file or counterpart is a failure, never a skip.
 */
class EvidenceFilesCopyParityTest {
    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .firstOrNull { File(it, WORDS).isFile } ?: throw AssertionError("$WORDS was not found above ${System.getProperty("user.dir")}")
    private fun source(relative: String) = File(root, relative).also { assertTrue("$relative is missing", it.isFile) }.readText()
    /** Where a declaration wraps is a formatting decision; the words are the contract. */
    private val words by lazy { source(WORDS).replace(Regex("\\s+"), " ") }
    private fun assertSays(literal: String) = assertTrue("$WORDS no longer says $literal", words.contains(literal))

    @Test fun everyWordIsTheWebsDeclaration() {
        mapOf(
            "EVIDENCE_FILES_HEADING" to EvidenceFiles.heading,
            "EVIDENCE_FILES_TITLE" to EvidenceFiles.title,
            "EVIDENCE_FILES_EXPIRED" to EvidenceFiles.expiredHeading,
            "EVIDENCE_FILE_EXPIRED" to EvidenceFiles.expired,
            "EVIDENCE_FILES_NO_FOLDER" to EvidenceFiles.noFolder,
            "EVIDENCE_FILE_DOWNLOAD" to EvidenceFiles.download,
            "EVIDENCE_FILES_SHOW_MORE" to EvidenceFiles.showMore,
            "EVIDENCE_FILE_DOWNLOAD_FAILED" to EvidenceFiles.downloadFailed,
            "EVIDENCE_FILES_LOADING" to EvidenceFiles.loading,
            "EVIDENCE_FILES_UNREAD" to EvidenceFiles.unread,
            "EVIDENCE_FILE_PIN" to EvidenceFiles.pin,
            "EVIDENCE_FILE_UNPIN" to EvidenceFiles.unpin,
            "EVIDENCE_FILE_PINNED" to EvidenceFiles.pinned,
            "EVIDENCE_FILE_PIN_FAILED" to EvidenceFiles.pinFailed,
            "EVIDENCE_FILE_UNPIN_FAILED" to EvidenceFiles.unpinFailed,
            "EVIDENCE_REPORT_FAILED" to EvidenceFiles.reportFailed,
            "EVIDENCE_REPORT_SKIPPED" to EvidenceFiles.reportSkipped,
        ).forEach { (name, value) ->
            val quote = if ('\'' in value) "\"" else "'"
            assertSays("export const $name = $quote$value$quote;")
        }
        assertSays("export const EVIDENCE_FILES_SHOWN = ${EvidenceFiles.shown};")
        assertSays("export const EVIDENCE_REPORT_NAMES_SHOWN = ${EvidenceFiles.reportNamesShown};")
    }

    /** [rendered] with each number put back as the web's interpolation: numbers no sentence holds otherwise. */
    private fun holes(rendered: String, vararg values: Pair<Int, String>) = values.fold(rendered) { text, (number, name) -> text.replace("$number", "\${$name}") }

    @Test fun everyTemplateIsTheWebsWholeSentence() {
        assertSays("export const evidenceFilesMore = (rest: number): string => `${holes(EvidenceFiles.more(7), 7 to "rest")}`;")
        assertSays("export const evidenceReportNamesMore = (rest: number): string => `${holes(EvidenceFiles.reportNamesMore(7), 7 to "rest")}`;")
        assertSays("export const evidenceFilePosition = (position: number, total: number): string => `${holes(EvidenceFiles.position(7, 8), 7 to "position", 8 to "total")}`;")
        assertSays("export const evidenceFilesShowing = (shown: number, total: number): string => `${holes(EvidenceFiles.showing(7, 8), 7 to "shown", 8 to "total")}`;")
        assertSays("export const evidenceRevisionLine = (revision: string): string => `${EvidenceFiles.revisionLine("\${revision}")}`;")
        assertEquals("${EvidenceFiles.download} report.html", EvidenceFiles.downloadName("report.html"))
        assertSays("export const evidenceFileDownloadName = (name: string): string => `\${EVIDENCE_FILE_DOWNLOAD} \${name}`;")
        val report = EvidenceTestReport("playwright", 0, 7, 8, 9)
        assertSays("export const evidenceReportCounts = (report: EvidenceTestReport): string => `" +
            holes(EvidenceFiles.reportCounts(report), 7 to "report.passed", 8 to "report.failed", 9 to "report.skipped") + "`;")
        assertEquals("Playwright report", EvidenceFiles.reportTitle(report))
        assertSays("export const evidenceReportTitle = (report: EvidenceTestReport): string => `\${evidenceReportFormat(report)} report`;")
        assertEquals("Failed · 2", EvidenceFiles.reportList(EvidenceFiles.reportFailed, 2))
        assertSays("export const evidenceReportList = (word: string, count: number): string => `\${word} · \${count}`;")
        val now = java.time.Instant.parse("2026-11-03T00:00:00Z")
        assertEquals("Expires Nov 17", EvidenceFiles.expires("2026-11-17T06:00:00Z", now, java.time.ZoneOffset.UTC))
        assertSays("export const evidenceFileExpires = (at: string, now?: Date): string => `Expires \${evidenceExpiryDate(at, now)}`;")
        assertEquals("Expired Sep 14", EvidenceFiles.expiredLine("2026-09-14T06:00:00Z", now, java.time.ZoneOffset.UTC))
        assertSays("`\${EVIDENCE_FILE_EXPIRED} \${evidenceExpiryDate(at, now)}`")
    }

    /** The lines the web composes, each beside what Kotlin composes for the same values. */
    @Test fun theLinesAreJoinedAsTheWebJoinsThem() {
        val list = EvidenceFileList("2026-11-02T06:41:00.000Z", 9, 1_887_437, listOf(EvidenceFile("f")))
        assertSays("[EVIDENCE_FILES_HEADING, list.fileCount, ...listSize(list)].join(' · ')")
        assertEquals("FILES · 9 · 1.8 MB", EvidenceFiles.headline(list))
        assertSays("`\${list.fileCount} \${list.fileCount === 1 ? 'file' : 'files'}`")
        assertEquals("9 files · 1.8 MB", EvidenceFiles.count(list))
        assertEquals("1 file · 1.8 MB", EvidenceFiles.count(list.copy(fileCount = 1)))
        assertSays("`\${size.width} × \${size.height}`")
        assertSays("`sha256 \${file.sha256.slice(0, 8)}`")
        assertEquals("780 × 1688 · sha256 3f9a1c07", EvidenceFiles.facts(EvidenceFile("f", sha256 = "3f9a1c07aabb"), 780, 1688))
        assertSays("`\${line} · \${EVIDENCE_FILES_EXPIRED}\${last === null ? '' : ` \${evidenceExpiryDate(last, now).toUpperCase()}`}`")
        assertEquals("FILES · 1 · EXPIRED", EvidenceFiles.headline(EvidenceFileList("", 1, 0, listOf(EvidenceFile("f", gone = true)))))
        assertSays("playwright: 'Playwright', junit: 'JUnit'")
        assertEquals("JUnit", EvidenceFiles.reportFormat(EvidenceTestReport("junit")))
        assertSays("dot > 0 ? name.slice(dot + 1).toUpperCase() : 'FILE'")
        assertEquals("FILE", EvidenceFiles.kind(EvidenceFile("f", "Makefile")))
    }

    @Test fun whatMayBeDrawnIsTheWebsListWithoutItsOneTypeThatIsNoPicture() {
        val list = Regex("OPENS_IN_BROWSER = new Set\\(\\[([^\\]]*)]").find(source(USER_FILE))?.groupValues?.get(1)
            ?: throw AssertionError("$USER_FILE no longer declares OPENS_IN_BROWSER")
        val web = Regex("'([^']+)'").findAll(list).map { it.groupValues[1] }.toSet()
        assertEquals(web.filter { it.startsWith("image/") }.toSet(), EvidenceFiles.rasterImages)
        assertEquals(setOf("application/pdf"), web - EvidenceFiles.rasterImages)
        assertFalse("image/svg+xml" in EvidenceFiles.rasterImages)
    }

    private companion object {
        const val WORDS = "src/web/src/lib/evidenceFiles.ts"
        const val USER_FILE = "src/web/src/lib/userFile.ts"
    }
}
