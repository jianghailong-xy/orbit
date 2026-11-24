package io.orbitd.android.core.documents

import io.orbitd.android.core.protocol.Wire
import java.time.Instant
import java.time.ZoneId
import org.junit.Assert.*
import org.junit.Test

/** The Documents reading rules (board 04-android; OrbitKit DocumentsLogicTests for the shared ones). */
class DocumentsLogicTest {
    private val utc = ZoneId.of("UTC")
    private val now = Instant.parse("2026-11-24T15:00:00Z")

    private fun entry(name: String, kind: String = "FILE", size: Long = 0, writer: DocumentsWriter = DocumentsWriter(),
                      updated: String = "2026-11-24T14:02:00Z", parent: String? = "root") =
        DocumentsEntry(id = name, parentId = parent, kind = kind, name = name, sizeBytes = size, updatedAt = updated, lastWriter = writer)

    @Test fun theRowShowsOnlyOnceTheReadFinishedAndOnlyAnExplicitFalseHidesIt() {
        assertFalse("not read yet", DocumentsLogic.shown(read = false, enabled = null))
        assertTrue("a server from before the switch", DocumentsLogic.shown(read = true, enabled = null))
        assertTrue(DocumentsLogic.shown(read = true, enabled = true))
        assertFalse(DocumentsLogic.shown(read = true, enabled = false))
        assertTrue("a failed read counts as on", DocumentsLogic.shown(read = true, enabled = null, failed = true))
    }

    @Test fun sizesCountInThousandsWithOneDecimalUnderTen() {
        assertEquals("812 B", DocumentsLogic.formatSize(812))
        assertEquals("1.2 MB", DocumentsLogic.formatSize(1_200_000))
        assertEquals("18 KB", DocumentsLogic.formatSize(18_000))
        assertEquals("3 KB", DocumentsLogic.formatSize(3_000))
        assertEquals("9.6 GB", DocumentsLogic.formatSize(9_600_000_000))
        assertEquals("10 KB", DocumentsLogic.formatSize(9_960))
        assertEquals("10.9 GB", DocumentsLogic.storageSize(11_703_768_678))
        assertEquals("640.0 MB", DocumentsLogic.storageSize(671_088_640))
    }

    @Test fun rowsReadAsTheBoardWritesThem() {
        assertEquals("14:02", DocumentsLogic.formatWhen("2026-11-24T14:02:00Z", now, utc))
        assertEquals("yesterday", DocumentsLogic.formatWhen("2026-11-23T09:00:00.000Z", now, utc))
        assertEquals("Nov 16", DocumentsLogic.formatWhen("2026-11-16T09:00:00Z", now, utc))
        assertEquals("Nov 16, 2025", DocumentsLogic.formatWhen("2025-11-16T09:00:00Z", now, utc))
        val folder = entry("screens", kind = "FOLDER")
        assertEquals("9 items · today 14:02", DocumentsLogic.folderLine(folder, 9, now, utc))
        assertEquals("today 14:02", DocumentsLogic.folderLine(folder, null, now, utc))
        val agent = DocumentsWriter(kind = "AGENT", sessionId = "s1", at = "2026-11-24T14:02:00Z")
        assertEquals("Agent in Redesign the sign-in page · 14:02",
            DocumentsLogic.fileLine(DocumentsLogic.writerText(agent, "Redesign the sign-in page\nmore"), entry("a.png", writer = agent), now, utc))
        assertEquals("Documents › Orbit UI migration", DocumentsLogic.crumb(listOf("Orbit UI migration")))
    }

    @Test fun whoWroteItFollowsRuleSix() {
        assertEquals("You", DocumentsLogic.writerText(DocumentsWriter("OWNER")))
        assertEquals("An agent on Orbit Cloud", DocumentsLogic.writerText(DocumentsWriter("AGENT")))
        assertNull(DocumentsLogic.writerSession(DocumentsWriter("AGENT")))
        assertEquals("Agent in a session", DocumentsLogic.writerText(DocumentsWriter("AGENT", sessionId = "s")))
        assertEquals("s", DocumentsLogic.writerSession(DocumentsWriter("AGENT", sessionId = "s")))
    }

    @Test fun foldersComeFirstAndNumbersSortAsNumbers() {
        val sorted = DocumentsLogic.sorted(listOf(entry("file10.md"), entry("Zeta", kind = "FOLDER"), entry("file2.md"), entry("alpha", kind = "FOLDER")))
        assertEquals(listOf("alpha", "Zeta", "file2.md", "file10.md"), sorted.map { it.name })
    }

    @Test fun previewsGoByKindAndSize() {
        assertEquals(DocumentsLogic.Preview.PICTURE, DocumentsLogic.preview("sign-in-v3.PNG", 1_200_000))
        assertEquals(DocumentsLogic.Preview.NONE, DocumentsLogic.preview("huge.png", 40L * 1024 * 1024))
        assertEquals(DocumentsLogic.Preview.MARKDOWN, DocumentsLogic.preview("notes.md", 10))
        assertEquals(DocumentsLogic.Preview.TEXT, DocumentsLogic.preview("route-inventory.csv", 10))
        assertEquals(DocumentsLogic.Preview.NONE, DocumentsLogic.preview("eval.zip", 10))
        assertEquals(DocumentsLogic.TEXT_PREVIEW_BYTES, DocumentsLogic.previewBytes(DocumentsLogic.Preview.MARKDOWN, 5L * 1024 * 1024))
        assertNull(DocumentsLogic.previewBytes(DocumentsLogic.Preview.PICTURE, 5L * 1024 * 1024))
        assertEquals("PNG · 1.2 MB · 1179 × 2556 · Orbit UI migration",
            DocumentsLogic.infoLine(entry("sign-in-v3.png", size = 1_200_000), "Orbit UI migration", 1179, 2556))
        assertEquals(DocumentsLogic.Icon.TABLE, DocumentsLogic.icon("labels.csv"))
        assertEquals(DocumentsLogic.Icon.ARCHIVE, DocumentsLogic.icon("eval-runs.zip"))
    }

    @Test fun namesAndMovesAreCheckedBeforeTheServer() {
        assertNotNull(DocumentsLogic.nameProblem("  "))
        assertNotNull(DocumentsLogic.nameProblem("a/b"))
        assertNotNull(DocumentsLogic.nameProblem(".."))
        assertNull(DocumentsLogic.nameProblem("brief.md"))
        val folder = DocumentsEntry(id = "f", parentId = "root", kind = "FOLDER", name = "f")
        assertFalse("not where it already is", DocumentsLogic.canMove(folder, "root", listOf()))
        assertFalse("not into itself", DocumentsLogic.canMove(folder, "f", listOf("root")))
        assertFalse("not under itself", DocumentsLogic.canMove(folder, "g", listOf("root", "f")))
        assertTrue(DocumentsLogic.canMove(folder, "g", listOf("root")))
    }

    @Test fun trashReadsByGroup() {
        val group = DocumentsTrashGroup(id = "g", folderPath = "/Orbit UI migration", createdAt = "2026-11-24T14:20:00Z", itemCount = 18,
            sizeBytes = 46_000_000, actor = DocumentsWriter("AGENT"))
        assertEquals("Orbit UI migration · today 14:20", DocumentsLogic.groupHeading(group, now, utc))
        val folder = DocumentsEntry(id = "x", kind = "FOLDER", name = "old-screens", sizeBytes = 46_000_000)
        assertEquals("Folder · 18 items · 46 MB · by an agent on Orbit Cloud",
            DocumentsLogic.trashLine(folder, group, DocumentsLogic.UNCHECKED_AGENT, 18))
        assertEquals("Deleted by you", DocumentsLogic.trashLine(entry("eval.zip"), group, DocumentsLogic.YOU))
        assertEquals("18 items · 46 MB · kept until you empty it", DocumentsLogic.trashSummary(listOf(group)))
        assertEquals("18 items from Orbit UI migration are deleted for good. This can't be undone.", DocumentsLogic.deleteForGoodMessage(group))
        assertEquals("Documents", DocumentsLogic.folderLabel("/"))
    }

    @Test fun storageSplitsTheTotal() {
        val usage = DocumentsUsage(totalBytes = 1000, driveBytes = 660, trashBytes = 70, otherBytes = 340)
        val bar = DocumentsLogic.storageBar(usage)
        assertEquals(0.59, bar.documents, 1e-9)
        assertEquals(0.07, bar.trash, 1e-9)
        assertEquals(0.34, bar.other, 1e-9)
        assertEquals(listOf("Documents 590 B", "Trash 70 B", "Other 340 B"), DocumentsLogic.storageLegend(usage))
        assertEquals("Week of Nov 16", DocumentsLogic.weekLabel("2026-11-16"))
        assertEquals("1.8 GB · 1,204 files", DocumentsLogic.storedValue(StorageUsage(totalBytes = 1_932_735_283, fileCount = 1204)))
    }

    private fun upload(name: String, state: DocumentsUploadState, size: Long, sent: Long = 0, parent: String = "Datasets", rate: Double? = null,
                       error: String? = null) =
        DocumentsUploadItem(id = name, name = name, size = size, source = name, parentName = parent, state = state, sentBytes = sent, rate = rate, error = error)

    @Test fun theNotificationCountsTheBatchAndGoesWhenItIsDone() {
        val items = listOf(upload("a.csv", DocumentsUploadState.DONE, 4_000_000_000),
            upload("b.zip", DocumentsUploadState.UPLOADING, 6_000_000_000, sent = 2_100_000_000, rate = 4_000_000.0),
            upload("c.zip", DocumentsUploadState.QUEUED, 4_300_000_000))
        val notice = DocumentsLogic.notice(items)!!
        assertEquals("Uploading 2 of 3 to Datasets", notice.title)
        assertEquals("6.1 GB of 14 GB · about 34 min left", notice.text)
        assertFalse(notice.paused)
        assertNull("everything up: the notification goes", DocumentsLogic.notice(listOf(upload("a", DocumentsUploadState.DONE, 1))))
        val paused = DocumentsLogic.notice(listOf(upload("demo-recording.mov", DocumentsUploadState.PAUSED, 2_400_000_000, sent = 1_200_000_000,
            error = DocumentsUploadQueue.CONNECTION_LOST)))!!
        assertEquals("demo-recording.mov is paused", paused.title)
        assertEquals("No connection. 1.2 GB of 2.4 GB is kept; it goes on from there when you're back online.", paused.text)
    }

    @Test fun theUploadsSheetCountsUploadsAndSyncsTogether() {
        val sync = DocumentsSync(id = "s", status = "UPLOADING", sourceName = "out", destPath = "/Reports/out", filesTotal = 42, filesDone = 12,
            bytesTotal = 900_000_000, bytesSent = 90_000_000)
        val (title, bytes) = DocumentsLogic.trayTitle(listOf(upload("holiday.mov", DocumentsUploadState.UPLOADING, 800_000_000, 310_000_000,
            parent = "Videos")), listOf(sync))
        assertEquals("Uploading 1 of 2", title)
        assertEquals("400 MB of 1.7 GB", bytes)
        assertEquals("out/ → Reports/out", DocumentsLogic.syncTitle(sync))
        assertEquals("12 of 42 files · 90 MB of 900 MB", DocumentsLogic.syncStatus(sync))
        val done = sync.copy(status = "DONE", sourceName = "data", destPath = "/Datasets", filesDone = 30, failedCount = 1,
            failed = listOf(DocumentsSync.Failure("survey-2026/raw/export.zip", "Changed while uploading. It was being written to.")),
            session = DocumentsSync.Session("x", "Clean survey data"), endedAt = "2026-11-24T14:12:00Z")
        assertTrue(DocumentsLogic.syncHasFailures(done))
        assertEquals("Synced 30 files · 1 failed", DocumentsLogic.syncStatus(done))
        assertEquals("data/ → Datasets", DocumentsLogic.syncDetailsTitle(done))
        assertEquals("Synced 30 files from Clean survey data at 14:12. 1 file didn't upload. The other files are in Datasets. " +
            "Ask the agent to run the sync again; it only sends what's still missing.", DocumentsLogic.syncDetailsSummary(done, utc))
        assertEquals("Open Datasets", DocumentsLogic.openFolder(done))
        assertNull(DocumentsLogic.syncMoreFailures(done))
        assertEquals("and 4 more", DocumentsLogic.syncMoreFailures(done.copy(failedCount = 5)))
        assertEquals("holiday.mov → Videos", DocumentsLogic.uploadTitle(upload("holiday.mov", DocumentsUploadState.QUEUED, 1, parent = "Videos")))
        assertEquals("310 MB of 800 MB · 12 MB/s · under a minute left",
            DocumentsLogic.uploadStatus(upload("h", DocumentsUploadState.UPLOADING, 800_000_000, 310_000_000, rate = 12_000_000.0)))
    }

    @Test fun answersDecodeAsTheServerWritesThem() {
        val listing = Wire.decode("""{"folder":{"id":"r","parentId":null,"kind":"FOLDER","name":"","sizeBytes":0},"entries":[
            {"id":"a","parentId":"r","kind":"FILE","name":"eval.zip","sizeBytes":9600000000,"mtime":"2026-10-31T00:00:00Z",
             "lastWriter":{"kind":"AGENT","sessionId":null,"runnerId":"x","at":"2026-10-31T00:00:00Z"},"newField":1}],"nextCursor":null}"""
            .encodeToByteArray(), DocumentsListing.serializer())
        assertEquals(9_600_000_000, listing.entries.single().sizeBytes)
        assertEquals("Documents", DocumentsLogic.folderTitle(listing.folder))
        val sync = Wire.decode("""{"syncs":[{"id":"s","status":"CHECKING","sourceName":"out","destPath":"/out","filesSeen":3,"failed":[]}]}"""
            .encodeToByteArray(), DocumentsSyncList.serializer())
        assertNull(DocumentsLogic.syncFraction(sync.syncs.single()))
        assertEquals("Checking files… 3 so far", DocumentsLogic.syncStatus(sync.syncs.single()))
    }
}
