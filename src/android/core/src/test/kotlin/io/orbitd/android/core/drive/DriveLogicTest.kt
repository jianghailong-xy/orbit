package io.orbitd.android.core.drive

import io.orbitd.android.core.protocol.Wire
import java.time.Instant
import java.time.ZoneId
import org.junit.Assert.*
import org.junit.Test

/** The Drive reading rules (board 04-android; OrbitKit DriveLogicTests for the shared ones). */
class DriveLogicTest {
    private val utc = ZoneId.of("UTC")
    private val now = Instant.parse("2026-11-24T15:00:00Z")

    private fun entry(name: String, kind: String = "FILE", size: Long = 0, writer: DriveWriter = DriveWriter(),
                      updated: String = "2026-11-24T14:02:00Z", parent: String? = "root") =
        DriveEntry(id = name, parentId = parent, kind = kind, name = name, sizeBytes = size, updatedAt = updated, lastWriter = writer)

    @Test fun theRowShowsOnlyOnceTheReadFinishedAndOnlyAnExplicitFalseHidesIt() {
        assertFalse("not read yet", DriveLogic.shown(read = false, enabled = null))
        assertTrue("a server from before the switch", DriveLogic.shown(read = true, enabled = null))
        assertTrue(DriveLogic.shown(read = true, enabled = true))
        assertFalse(DriveLogic.shown(read = true, enabled = false))
        assertTrue("a failed read counts as on", DriveLogic.shown(read = true, enabled = null, failed = true))
    }

    @Test fun sizesCountInThousandsWithOneDecimalUnderTen() {
        assertEquals("812 B", DriveLogic.formatSize(812))
        assertEquals("1.2 MB", DriveLogic.formatSize(1_200_000))
        assertEquals("18 KB", DriveLogic.formatSize(18_000))
        assertEquals("3 KB", DriveLogic.formatSize(3_000))
        assertEquals("9.6 GB", DriveLogic.formatSize(9_600_000_000))
        assertEquals("10 KB", DriveLogic.formatSize(9_960))
        assertEquals("10.9 GB", DriveLogic.storageSize(11_703_768_678))
        assertEquals("640.0 MB", DriveLogic.storageSize(671_088_640))
    }

    @Test fun rowsReadAsTheBoardWritesThem() {
        assertEquals("14:02", DriveLogic.formatWhen("2026-11-24T14:02:00Z", now, utc))
        assertEquals("yesterday", DriveLogic.formatWhen("2026-11-23T09:00:00.000Z", now, utc))
        assertEquals("Nov 16", DriveLogic.formatWhen("2026-11-16T09:00:00Z", now, utc))
        assertEquals("Nov 16, 2025", DriveLogic.formatWhen("2025-11-16T09:00:00Z", now, utc))
        val folder = entry("screens", kind = "FOLDER")
        assertEquals("9 items · today 14:02", DriveLogic.folderLine(folder, 9, now, utc))
        assertEquals("today 14:02", DriveLogic.folderLine(folder, null, now, utc))
        val agent = DriveWriter(kind = "AGENT", sessionId = "s1", at = "2026-11-24T14:02:00Z")
        assertEquals("Agent in Redesign the sign-in page · 14:02",
            DriveLogic.fileLine(DriveLogic.writerText(agent, "Redesign the sign-in page\nmore"), entry("a.png", writer = agent), now, utc))
        assertEquals("Drive › Orbit UI migration", DriveLogic.crumb(listOf("Orbit UI migration")))
    }

    @Test fun whoWroteItFollowsRuleSix() {
        assertEquals("You", DriveLogic.writerText(DriveWriter("OWNER")))
        assertEquals("An agent on Orbit Cloud", DriveLogic.writerText(DriveWriter("AGENT")))
        assertNull(DriveLogic.writerSession(DriveWriter("AGENT")))
        assertEquals("Agent in a session", DriveLogic.writerText(DriveWriter("AGENT", sessionId = "s")))
        assertEquals("s", DriveLogic.writerSession(DriveWriter("AGENT", sessionId = "s")))
    }

    @Test fun foldersComeFirstAndNumbersSortAsNumbers() {
        val sorted = DriveLogic.sorted(listOf(entry("file10.md"), entry("Zeta", kind = "FOLDER"), entry("file2.md"), entry("alpha", kind = "FOLDER")))
        assertEquals(listOf("alpha", "Zeta", "file2.md", "file10.md"), sorted.map { it.name })
    }

    @Test fun previewsGoByKindAndSize() {
        assertEquals(DriveLogic.Preview.PICTURE, DriveLogic.preview("sign-in-v3.PNG", 1_200_000))
        assertEquals(DriveLogic.Preview.NONE, DriveLogic.preview("huge.png", 40L * 1024 * 1024))
        assertEquals(DriveLogic.Preview.MARKDOWN, DriveLogic.preview("notes.md", 10))
        assertEquals(DriveLogic.Preview.TEXT, DriveLogic.preview("route-inventory.csv", 10))
        assertEquals(DriveLogic.Preview.NONE, DriveLogic.preview("eval.zip", 10))
        assertEquals(DriveLogic.TEXT_PREVIEW_BYTES, DriveLogic.previewBytes(DriveLogic.Preview.MARKDOWN, 5L * 1024 * 1024))
        assertNull(DriveLogic.previewBytes(DriveLogic.Preview.PICTURE, 5L * 1024 * 1024))
        assertEquals("PNG · 1.2 MB · 1179 × 2556 · Orbit UI migration",
            DriveLogic.infoLine(entry("sign-in-v3.png", size = 1_200_000), "Orbit UI migration", 1179, 2556))
        assertEquals(DriveLogic.Icon.TABLE, DriveLogic.icon("labels.csv"))
        assertEquals(DriveLogic.Icon.ARCHIVE, DriveLogic.icon("eval-runs.zip"))
    }

    @Test fun namesAndMovesAreCheckedBeforeTheServer() {
        assertNotNull(DriveLogic.nameProblem("  "))
        assertNotNull(DriveLogic.nameProblem("a/b"))
        assertNotNull(DriveLogic.nameProblem(".."))
        assertNull(DriveLogic.nameProblem("brief.md"))
        val folder = DriveEntry(id = "f", parentId = "root", kind = "FOLDER", name = "f")
        assertFalse("not where it already is", DriveLogic.canMove(folder, "root", listOf()))
        assertFalse("not into itself", DriveLogic.canMove(folder, "f", listOf("root")))
        assertFalse("not under itself", DriveLogic.canMove(folder, "g", listOf("root", "f")))
        assertTrue(DriveLogic.canMove(folder, "g", listOf("root")))
    }

    @Test fun trashReadsByGroup() {
        val group = DriveTrashGroup(id = "g", folderPath = "/Orbit UI migration", createdAt = "2026-11-24T14:20:00Z", itemCount = 18,
            sizeBytes = 46_000_000, actor = DriveWriter("AGENT"))
        assertEquals("Orbit UI migration · today 14:20", DriveLogic.groupHeading(group, now, utc))
        val folder = DriveEntry(id = "x", kind = "FOLDER", name = "old-screens")
        assertEquals("the folder and the 18 under it", "Folder · 18 items · 46 MB · by an agent on Orbit Cloud",
            DriveLogic.trashLine(folder, group.copy(itemCount = 19, items = listOf(folder)), DriveLogic.UNCHECKED_AGENT))
        assertEquals("Deleted by you", DriveLogic.trashLine(entry("eval.zip"), group, DriveLogic.YOU))
        assertEquals("18 items · 46 MB · kept until you empty it", DriveLogic.trashSummary(listOf(group)))
        assertEquals("18 items from Orbit UI migration are deleted for good. This can't be undone.", DriveLogic.deleteForGoodMessage(group))
        assertEquals("Drive", DriveLogic.folderLabel("/"))
    }

    @Test fun storageSplitsTheTotal() {
        val usage = DriveUsage(totalBytes = 1000, driveBytes = 660, trashBytes = 70, otherBytes = 340)
        val bar = DriveLogic.storageBar(usage)
        assertEquals(0.59, bar.drive, 1e-9)
        assertEquals(0.07, bar.trash, 1e-9)
        assertEquals(0.34, bar.other, 1e-9)
        assertEquals(listOf("Drive 590 B", "Trash 70 B", "Other 340 B"), DriveLogic.storageLegend(usage))
        assertEquals("Week of Nov 16", DriveLogic.weekLabel("2026-11-16"))
        assertEquals("1.8 GB · 1,204 files", DriveLogic.storedValue(StorageUsage(totalBytes = 1_932_735_283, fileCount = 1204)))
    }

    private fun upload(name: String, state: DriveUploadState, size: Long, sent: Long = 0, parent: String = "Datasets", rate: Double? = null,
                       error: String? = null) =
        DriveUploadItem(id = name, name = name, size = size, source = name, parentName = parent, state = state, sentBytes = sent, rate = rate, error = error)

    @Test fun theNotificationCountsTheBatchAndGoesWhenItIsDone() {
        val items = listOf(upload("a.csv", DriveUploadState.DONE, 4_000_000_000),
            upload("b.zip", DriveUploadState.UPLOADING, 6_000_000_000, sent = 2_100_000_000, rate = 4_000_000.0),
            upload("c.zip", DriveUploadState.QUEUED, 4_300_000_000))
        val notice = DriveLogic.notice(items)!!
        assertEquals("Uploading 2 of 3 to Datasets", notice.title)
        assertEquals("6.1 GB of 14 GB · about 34 min left", notice.text)
        assertFalse(notice.paused)
        assertNull("everything up: the notification goes", DriveLogic.notice(listOf(upload("a", DriveUploadState.DONE, 1))))
        val paused = DriveLogic.notice(listOf(upload("demo-recording.mov", DriveUploadState.PAUSED, 2_400_000_000, sent = 1_200_000_000,
            error = DriveUploadQueue.CONNECTION_LOST)))!!
        assertEquals("demo-recording.mov is paused", paused.title)
        assertEquals("No connection. 1.2 GB of 2.4 GB is kept; it goes on from there when you're back online.", paused.text)
    }

    @Test fun theUploadsSheetCountsUploadsAndSyncsTogether() {
        val sync = DriveSync(id = "s", status = "UPLOADING", sourceName = "out", destPath = "/Reports/out", filesTotal = 42, filesDone = 12,
            bytesTotal = 900_000_000, bytesSent = 90_000_000)
        val (title, bytes) = DriveLogic.trayTitle(listOf(upload("holiday.mov", DriveUploadState.UPLOADING, 800_000_000, 310_000_000,
            parent = "Videos")), listOf(sync))
        assertEquals("Uploading 1 of 2", title)
        assertEquals("400 MB of 1.7 GB", bytes)
        assertEquals("out/ → Reports/out", DriveLogic.syncTitle(sync))
        assertEquals("12 of 42 files · 90 MB of 900 MB", DriveLogic.syncStatus(sync))
        val done = sync.copy(status = "DONE", sourceName = "data", destPath = "/Datasets", filesDone = 30, failedCount = 1,
            failed = listOf(DriveSync.Failure("survey-2026/raw/export.zip", "Changed while uploading. It was being written to.")),
            session = DriveSync.Session("x", "Clean survey data"), endedAt = "2026-11-24T14:12:00Z")
        assertTrue(DriveLogic.syncHasFailures(done))
        assertEquals("Synced 30 files · 1 failed", DriveLogic.syncStatus(done))
        assertEquals("data/ → Datasets", DriveLogic.syncDetailsTitle(done))
        assertEquals("Synced 30 files from Clean survey data at 14:12. 1 file didn't upload. The other files are in Datasets. " +
            "Ask the agent to run the sync again; it only sends what's still missing.", DriveLogic.syncDetailsSummary(done, utc))
        assertEquals("Open Datasets", DriveLogic.openFolder(done))
        assertNull(DriveLogic.syncMoreFailures(done))
        assertEquals("and 4 more", DriveLogic.syncMoreFailures(done.copy(failedCount = 5)))
        assertEquals("holiday.mov → Videos", DriveLogic.uploadTitle(upload("holiday.mov", DriveUploadState.QUEUED, 1, parent = "Videos")))
        assertEquals("310 MB of 800 MB · 12 MB/s · under a minute left",
            DriveLogic.uploadStatus(upload("h", DriveUploadState.UPLOADING, 800_000_000, 310_000_000, rate = 12_000_000.0)))
    }

    @Test fun answersDecodeAsTheServerWritesThem() {
        val listing = Wire.decode("""{"folder":{"id":"r","parentId":null,"kind":"FOLDER","name":"","sizeBytes":0},"entries":[
            {"id":"a","parentId":"r","kind":"FILE","name":"eval.zip","sizeBytes":9600000000,"mtime":"2026-10-31T00:00:00Z",
             "lastWriter":{"kind":"AGENT","sessionId":null,"runnerId":"x","at":"2026-10-31T00:00:00Z"},"newField":1}],"nextCursor":null}"""
            .encodeToByteArray(), DriveListing.serializer())
        assertEquals(9_600_000_000, listing.entries.single().sizeBytes)
        assertEquals("Drive", DriveLogic.folderTitle(listing.folder))
        val sync = Wire.decode("""{"syncs":[{"id":"s","status":"CHECKING","sourceName":"out","destPath":"/out","filesSeen":3,"failed":[]}]}"""
            .encodeToByteArray(), DriveSyncList.serializer())
        assertNull(DriveLogic.syncFraction(sync.syncs.single()))
        assertEquals("Checking files… 3 so far", DriveLogic.syncStatus(sync.syncs.single()))
    }
}
