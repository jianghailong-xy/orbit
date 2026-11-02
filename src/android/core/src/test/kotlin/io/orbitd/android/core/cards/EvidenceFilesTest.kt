package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.Wire
import java.time.Instant
import java.time.ZoneId
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** What an evidence card reads off a version's files, the same cases as the web's `evidenceFiles.test.ts`. */
class EvidenceFilesTest {
    private val sha = "3f9a1c07aabbccddeeff00112233445566778899aabbccddeeff001122334455"
    private val zone = ZoneId.of("UTC")

    private fun file(id: String = "f1", name: String? = "chromium-dark-phone/menu-open.png", folder: String? = "shots", mimeType: String? = "image/png",
        sizeBytes: Long? = 214L * 1024, sha256: String? = sha, expiredAt: String? = null, gone: Boolean = false) =
        EvidenceFile(id, name, folder, mimeType, sizeBytes, sha256, null, null, expiredAt, gone)
    private fun list(files: List<EvidenceFile>, fileCount: Int = files.size, totalBytes: Long = 1_887_437, nextOffset: Int? = null) =
        EvidenceFileList("2026-11-02T06:41:00.000Z", fileCount, totalBytes, files, nextOffset)
    private val report = EvidenceTestReport("playwright", 48, 46, 0, 2, 38_000.0, emptyList(), listOf("a", "b"))
    private fun citation(json: String) = Wire.json.parseToJsonElement(json).jsonObject

    @Test fun aVersionCitesFilesOnlyByAFileCitationResolvedOrNot() {
        assertFalse(EvidenceFiles.cites(listOf("TOOL_CALL", "COMMIT", "ARTIFACT").map { citation("""{"kind":"$it"}""") }))
        assertFalse(EvidenceFiles.cites(emptyList()))
        assertTrue(EvidenceFiles.cites(listOf(citation("""{"kind":"FILE","resolved":false}"""))))
    }

    @Test fun aReportIsReadOffTheCitationThatCarriesOne() {
        val carrying = citation("""{"kind":"FILE","testReport":{"format":"playwright","total":48,"passed":46,"failed":0,"skipped":2,
            "durationMs":38000,"failedNames":[],"skippedNames":["a","b"]}}""")
        assertEquals(listOf(report), EvidenceFiles.reports(listOf(citation("""{"kind":"TOOL_CALL"}"""), citation("""{"kind":"FILE"}"""), carrying)))
        // What the uploader's report says is nothing to trust: a shape that can't be read is no report, and the card goes on.
        assertEquals(emptyList<EvidenceTestReport>(), EvidenceFiles.reports(listOf(citation("""{"kind":"FILE","testReport":{"total":3}}"""))))
        // A run's own measure is a real number.
        val fractional = citation("""{"kind":"FILE","testReport":{"format":"junit","total":1,"passed":1,"failed":0,"skipped":0,"durationMs":38123.5,
            "failedNames":[],"skippedNames":[]}}""")
        assertEquals("1 passed · 0 failed · 0 skipped · 38s", EvidenceFiles.reportFacts(EvidenceFiles.reports(listOf(fractional)).single()))
    }

    /** The route's own answer, with the fields a card does not read. */
    @Test fun thePageIsReadInTheRoutesShape() {
        val page = Wire.json.decodeFromString(EvidenceFilePage.serializer(), """{"revision":"2","submittedAt":"2026-11-02T06:41:00.000Z","fileCount":2,"totalBytes":12288,
            "files":[{"id":"a","kind":"file","name":"report.json","label":null,"mimeType":"application/json","sizeBytes":12288,"sha256":"$sha","folder":null,
              "width":null,"height":null,"expiredAt":null,"gone":false,"testReport":null,"createdAt":"2026-11-02T06:40:00.000Z","sessionId":"s","taskId":"t","fileBundleId":null},
              {"id":"b","kind":"file","name":null,"label":null,"mimeType":null,"sizeBytes":null,"sha256":"$sha","folder":null,"width":780,"height":1688,
              "expiredAt":null,"gone":true,"testReport":null,"createdAt":null,"sessionId":null,"taskId":null,"fileBundleId":null}],"nextOffset":null}""")
        assertEquals(listOf("a", "b"), page.files.map { it.id })
        assertTrue(page.files[1].gone)
        assertEquals(780, page.files[1].width)
        assertEquals(null, page.nextOffset)
    }

    @Test fun theRouteIsAskedForTheFirstPageWithNoOffset() {
        val first = EvidenceFiles.request("t1", "2")
        assertEquals(listOf("tasks", "t1", "evidence", "2", "files"), first.path)
        assertEquals(emptyList<Pair<String, String>>(), first.query)
        assertEquals(listOf("offset" to "1000"), EvidenceFiles.request("t1", "2", 1000).query)
    }

    @Test fun laterPagesAddToTheListAndAFileCitedTwiceIsOneEntry() {
        val first = list(listOf(file("a"), file("b")), fileCount = 3, nextOffset = 2)
        val next = first + EvidenceFilePage("2", first.submittedAt, 3, 1_887_437, listOf(file("b"), file("c")), null)
        assertEquals(listOf("a", "b", "c"), next.files.map { it.id })
        assertEquals(null, next.nextOffset)
    }

    @Test fun theAreaIsHeadedWithTheWholeListWhicheverPageWasRead() {
        assertEquals("FILES · 9 · 1.8 MB", EvidenceFiles.headline(list(listOf(file()), fileCount = 9)))
        assertEquals("9 files · 1.8 MB", EvidenceFiles.count(list(listOf(file()), fileCount = 9)))
        assertEquals("1 file · 12 KB", EvidenceFiles.count(list(listOf(file()), fileCount = 1, totalBytes = 12L * 1024)))
    }

    @Test fun fourAreDrawnPicturesFirstAndTheRestOfTheWholeListCounted() {
        val report = file("report", "report.json", mimeType = "application/json")
        val pictures = listOf("a", "b", "c", "d", "e").map { file(it) }
        val onCard = EvidenceFiles.onCard(list(listOf(report) + pictures, fileCount = 9))
        assertEquals(listOf("a", "b", "c", "d"), onCard.shown.map { it.id })
        assertEquals(5, onCard.rest)
        assertEquals(0, EvidenceFiles.onCard(list(listOf(report, file()))).rest)
    }

    @Test fun groupsAreByTheFolderAPathNamesThenByTheUploadInTheOrderTheyFirstAppear() {
        val groups = EvidenceFiles.groups(listOf(
            file("a", "light/a.png"), file("b", "dark/b.png"), file("c", "light/c.png"), file("d", "deep/er/d.png"),
            file("e", "top.png", folder = "shots"), file("f", "report.json", folder = null), file("g", null, folder = null, gone = true)))
        assertEquals(listOf("light" to listOf("a", "c"), "dark" to listOf("b"), "deep/er" to listOf("d"), "shots" to listOf("e"),
            EvidenceFiles.noFolder to listOf("f", "g")), groups.map { group -> group.name to group.files.map { it.id } })
    }

    @Test fun onlyARasterImageIsEverAPicture() {
        listOf("image/png", "image/jpeg", "image/gif", "image/webp", "IMAGE/PNG; name=a").forEach {
            assertTrue("$it is drawn", EvidenceFiles.isPicture(file(mimeType = it)))
        }
        listOf("image/svg+xml", "text/html", "application/xhtml+xml", "application/pdf", "application/json", "text/plain", "",
            "application/octet-stream", "image/png, text/html").forEach {
            assertFalse("$it is never drawn", EvidenceFiles.isPicture(file(mimeType = it)))
        }
    }

    @Test fun nothingThatHasLostItsBytesIsDrawn() {
        assertFalse(EvidenceFiles.isPicture(file(expiredAt = "2026-12-02T12:00:00.000Z")))
        assertFalse(EvidenceFiles.isPicture(file(gone = true, mimeType = null)))
    }

    @Test fun aTileWithNoPictureIsNamedByItsKindAndASaveByTheEndOfItsPath() {
        assertEquals("HTML", EvidenceFiles.kind(file(name = "notes/page.html")))
        assertEquals("FILE", EvidenceFiles.kind(file(name = "Makefile")))
        assertEquals("FILE", EvidenceFiles.kind(file(name = ".env")))
        assertEquals("FILE", EvidenceFiles.kind(file(id = "34qId8VVBEGx2.9", name = null)))
        assertEquals("report.json", EvidenceFiles.saveName(file(name = "a/b/report.json")))
        assertEquals("f9", EvidenceFiles.saveName(file(id = "f9", name = null)))
    }

    @Test fun theViewersLineSaysWhatIsKnownOfAFileAndNoMore() {
        assertEquals("3 of 8", EvidenceFiles.position(3, 8))
        assertEquals("214 KB · 780 × 1688 · sha256 3f9a1c07", EvidenceFiles.facts(file(), 780, 1688))
        assertEquals("214 KB · sha256 3f9a1c07", EvidenceFiles.facts(file()))
        assertEquals("sha256 3f9a1c07", EvidenceFiles.facts(file(sizeBytes = null, gone = true)))
    }

    @Test fun sizesReadAsTheWebsDo() {
        assertEquals("1023 B", EvidenceFiles.fileSize(1023))
        assertEquals("1 KB", EvidenceFiles.fileSize(1024))
        assertEquals("214 KB", EvidenceFiles.fileSize(214L * 1024))
        assertEquals("1.8 MB", EvidenceFiles.fileSize(1_887_437))
    }

    private val now = Instant.parse("2026-12-20T12:00:00.000Z")
    private fun expired(at: String, fileId: String = "f1") = file(fileId, expiredAt = at)

    @Test fun expiryIsDatedInEnglishWithTheYearOnlyWhenItIsNotThisOne() {
        assertEquals("Dec 2", EvidenceFiles.expiryDate("2026-12-02T12:00:00.000Z", now, zone))
        assertEquals("Dec 2, 2025", EvidenceFiles.expiryDate("2025-12-02T12:00:00.000Z", now, zone))
        assertNull(EvidenceFiles.expiryDate("not a date", now, zone))
    }

    @Test fun theAreaIsHeadedExpiredOnlyOnceAllOfThemHaveByTheLastDate() {
        val all = list(listOf(expired("2026-12-01T12:00:00.000Z"), expired("2026-12-02T12:00:00.000Z", "f2")), fileCount = 9)
        assertEquals("FILES · 9 · 1.8 MB · EXPIRED DEC 2", EvidenceFiles.headline(all, now, zone))
        assertEquals("FILES · 2 · 1.8 MB", EvidenceFiles.headline(list(listOf(expired("2026-12-01T12:00:00.000Z"), file("f2"))), now, zone))
    }

    @Test fun aRowThatWentIsCountedAndItTookItsDateWithIt() {
        val went = file(gone = true, name = null, mimeType = null, sizeBytes = null)
        assertEquals("FILES · 1 · EXPIRED", EvidenceFiles.headline(list(listOf(went), totalBytes = 0), now, zone))
        assertEquals("1 file", EvidenceFiles.count(list(listOf(went), totalBytes = 0)))
        assertEquals("FILES · 2 · 1.8 MB · EXPIRED DEC 2", EvidenceFiles.headline(list(listOf(went, expired("2026-12-02T12:00:00.000Z", "f2"))), now, zone))
    }

    @Test fun expiredIsNotSaidOfAListNotReadToTheEnd() {
        val page = list(listOf(expired("2026-12-02T12:00:00.000Z")), fileCount = 3000, nextOffset = 1000)
        assertFalse(EvidenceFiles.allGone(page))
        assertEquals("FILES · 3000 · 1.8 MB", EvidenceFiles.headline(page, now, zone))
    }

    @Test fun aReportReadsAsTheDesignSpellsIt() {
        assertEquals("46 passed · 0 failed · 2 skipped", EvidenceFiles.reportCounts(report))
        assertEquals("46 passed · 0 failed · 2 skipped · 38s", EvidenceFiles.reportFacts(report))
        assertEquals("46 passed · 0 failed · 2 skipped", EvidenceFiles.reportFacts(report.copy(durationMs = null)))
        assertEquals("Playwright report", EvidenceFiles.reportTitle(report))
        assertEquals("JUnit report", EvidenceFiles.reportTitle(report.copy(format = "junit")))
        assertEquals("Failed · 2", EvidenceFiles.reportList(EvidenceFiles.reportFailed, 2))
    }
}
