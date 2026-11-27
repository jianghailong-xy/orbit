package io.orbitd.android.drive

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import androidx.core.app.NotificationCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.R
import io.orbitd.android.core.auth.AccountKey
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.drive.DriveApi
import io.orbitd.android.core.drive.DriveFileSource
import io.orbitd.android.core.drive.DriveLogic
import io.orbitd.android.core.drive.DriveUploadQueue
import io.orbitd.android.core.drive.DriveUploadRequest
import io.orbitd.android.core.drive.DriveUploadState
import io.orbitd.android.core.drive.DriveUploadStore
import java.io.FileInputStream
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * The owner's uploads on the phone (board 04-android frames 5 and 6; D12): the picked files are read through the content resolver
 * from the addresses the system pickers granted — no storage permission — and sent by [DriveUploadQueue] from background work,
 * so they go on with the app closed. One ongoing notification follows all of them, with Pause and Show; it goes once they are done.
 * An agent's sync never posts one: it is the agent's work, seen in the app's uploads sheet.
 */
object DriveUploads {
    private var queues = mutableMapOf<AccountKey, DriveUploadQueue>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var watching = false

    /** The signed-in account's queue, made once per process and account: it outlives the page. */
    fun queue(app: OrbitApplication, handle: SessionHandle): DriveUploadQueue = synchronized(this) {
        queues.getOrPut(handle.account) {
            DriveUploadQueue(DriveApi(app.session, handle), PrefsStore(app, handle.account), ContentFiles(app.contentResolver), scope).also {
                watchConnection(app)
            }
        }
    }

    /** Queue what was picked and start the background work. */
    fun add(app: OrbitApplication, handle: SessionHandle, requests: List<DriveUploadRequest>) {
        if (requests.isEmpty()) return
        queue(app, handle).add(requests)
        start(app)
    }

    /** Start (or keep) the background work that drives the queue while anything waits. */
    fun start(context: Context) {
        val work = OneTimeWorkRequestBuilder<DriveUploadWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        runCatching { WorkManager.getInstance(context).enqueueUniqueWork(WORK, ExistingWorkPolicy.KEEP, work) }
    }

    /** A connection that came back: what a lost connection paused goes on by itself. */
    private fun watchConnection(app: OrbitApplication) {
        if (watching) return
        watching = true
        val manager = app.getSystemService(ConnectivityManager::class.java) ?: return
        runCatching {
            manager.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    scope.launch { if (synchronized(this@DriveUploads) { queues.values.toList() }.map { it.resumeInterrupted() }.any { it }) start(app) }
                }
            })
        }
    }

    /** Requests for picked files, each with its size and time as the provider says now. */
    fun requests(context: Context, uris: List<Uri>, parentId: String?, parentName: String): List<DriveUploadRequest> =
        uris.mapNotNull { uri ->
            keep(context, uri)
            val (name, size, modified) = describe(context.contentResolver, uri) ?: return@mapNotNull null
            DriveUploadRequest(uri.toString(), name, size, modified, parentId, parentName)
        }

    /** Requests for a picked folder: every file under it, each with its path inside the folder (`Dir/sub/name`) and one drop key, so
     * the folder keeps its tree and lands under one top folder. Hidden files stay behind. */
    fun folder(context: Context, tree: Uri, parentId: String?, parentName: String): List<DriveUploadRequest> {
        keep(context, tree)
        val resolver = context.contentResolver
        val rootId = DocumentsContract.getTreeDocumentId(tree)
        val rootName = describe(resolver, DocumentsContract.buildDocumentUriUsingTree(tree, rootId))?.first ?: "Folder"
        val drop = DriveUploadRequest.dropKey()
        val out = mutableListOf<DriveUploadRequest>()
        fun walk(documentId: String, path: String) {
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, documentId)
            resolver.query(children, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED),
                null, null, null)?.use { c ->
                while (c.moveToNext()) {
                    val id = c.getString(0) ?: continue
                    val name = c.getString(1) ?: continue
                    if (name.startsWith(".")) continue
                    if (c.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR) walk(id, "$path/$name")
                    else out += DriveUploadRequest(DocumentsContract.buildDocumentUriUsingTree(tree, id).toString(), name,
                        if (c.isNull(3)) 0 else c.getLong(3), if (c.isNull(4)) 0 else c.getLong(4), parentId, parentName, "$path/$name", drop)
                }
            }
        }
        walk(rootId, rootName)
        return out.sortedBy { it.relativePath }
    }

    /** Keep the grant across a restart, where the provider allows it; the photo picker's grant lasts for the process anyway. */
    private fun keep(context: Context, uri: Uri) {
        runCatching { context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    }

    internal fun describe(resolver: ContentResolver, uri: Uri): Triple<String, Long, Long>? = runCatching {
        if (uri.scheme == ContentResolver.SCHEME_FILE) {
            val file = java.io.File(uri.path!!)
            return@runCatching if (file.isFile) Triple(file.name, file.length(), file.lastModified()) else null
        }
        resolver.query(uri, null, null, null, null)?.use { c ->
            if (!c.moveToFirst()) return@use null
            val name = c.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let(c::getString) ?: uri.lastPathSegment ?: "file"
            val size = c.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 && !c.isNull(it) }?.let(c::getLong) ?: return@use null
            val modified = c.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED).takeIf { it >= 0 && !c.isNull(it) }?.let(c::getLong) ?: 0
            Triple(name, size, modified)
        }
    }.getOrNull()

    const val WORK = "drive-uploads"
    const val CHANNEL = "drive-uploads"
    const val NOTIFICATION_ID = 0x0D0C
    const val PAUSE_ACTION = "io.orbitd.android.drive.PAUSE"
    /** The notification's Show: Drive with its uploads sheet open. */
    const val SHOW_LINK = "orbit://drive/uploads"

    fun channel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL) == null) manager.createNotificationChannel(
            NotificationChannel(CHANNEL, DriveLogic.CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW).apply {
                description = DriveLogic.CHANNEL_DESCRIPTION; setShowBadge(false)
            })
    }

    fun notification(context: Context, notice: DriveLogic.Notice): android.app.Notification {
        channel(context)
        val show = PendingIntent.getActivity(context, 1, Intent(Intent.ACTION_VIEW, Uri.parse(SHOW_LINK), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val pause = PendingIntent.getBroadcast(context, 2, Intent(PAUSE_ACTION).setClass(context, DrivePauseReceiver::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return NotificationCompat.Builder(context, CHANNEL).setSmallIcon(R.drawable.ic_notification)
            .setSubText(DriveLogic.TITLE).setContentTitle(notice.title).setContentText(notice.text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(notice.text))
            .setOngoing(!notice.paused).setOnlyAlertOnce(true).setSilent(true).setContentIntent(show)
            .apply {
                notice.progress?.let { setProgress(1000, (it * 1000).toInt(), false) }
                if (!notice.paused) addAction(0, DriveLogic.PAUSE, pause)
                addAction(0, DriveLogic.SHOW, show)
            }.build()
    }
}

/** The notification's Pause: every upload going up or waiting stops where it is, kept. */
class DrivePauseReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext as? OrbitApplication ?: return
        val handle = (app.session.state.value as? AuthState.SignedIn)?.handle ?: return
        DriveUploads.queue(app, handle).pauseAll()
    }
}

/** Drives the queue in the background, in the foreground-service slot with the one notification, until nothing waits. */
class DriveUploadWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val app = applicationContext as OrbitApplication
        app.session.restore()
        val handle = app.session.state.first { it !is AuthState.Restoring }.let { (it as? AuthState.SignedIn)?.handle } ?: return Result.success()
        val queue = DriveUploads.queue(app, handle)
        val manager = applicationContext.getSystemService(NotificationManager::class.java)
        val watcher = CoroutineScope(Dispatchers.Main.immediate).launch {
            queue.items.collect { items ->
                val notice = DriveLogic.notice(items) ?: return@collect
                runCatching { setForeground(info(notice)) }.onFailure { manager?.notify(DriveUploads.NOTIFICATION_ID, DriveUploads.notification(applicationContext, notice)) }
            }
        }
        try {
            queue.start()
            queue.idle()
        } finally {
            watcher.cancel()
        }
        val items = queue.items.value
        // Still waiting on the connection: the notification says so, and the work comes back with it.
        val waiting = items.any { it.state == DriveUploadState.PAUSED }
        val notice = DriveLogic.notice(items)
        if (waiting && notice != null) manager?.notify(DriveUploads.NOTIFICATION_ID, DriveUploads.notification(applicationContext, notice))
        else manager?.cancel(DriveUploads.NOTIFICATION_ID)
        return if (items.any { it.state == DriveUploadState.PAUSED && it.error == DriveUploadQueue.CONNECTION_LOST } && queue.resumeInterrupted())
            Result.retry() else Result.success()
    }

    private fun info(notice: DriveLogic.Notice) = if (Build.VERSION.SDK_INT >= 29)
        ForegroundInfo(DriveUploads.NOTIFICATION_ID, DriveUploads.notification(applicationContext, notice), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    else ForegroundInfo(DriveUploads.NOTIFICATION_ID, DriveUploads.notification(applicationContext, notice))
}

/** The bytes of a picked file, through the content resolver. */
private class ContentFiles(private val resolver: ContentResolver) : DriveFileSource {
    override fun stat(source: String): Pair<Long, Long>? = DriveUploads.describe(resolver, Uri.parse(source))?.let { it.second to it.third }

    override fun read(source: String, offset: Long, length: Int): ByteArray {
        val uri = Uri.parse(source)
        resolver.openFileDescriptor(uri, "r")?.use { fd ->
            FileInputStream(fd.fileDescriptor).channel.use { channel ->
                channel.position(offset)
                val buffer = java.nio.ByteBuffer.allocate(length)
                while (buffer.hasRemaining()) if (channel.read(buffer) < 0) break
                return buffer.array().copyOf(buffer.position())
            }
        }
        error("unreadable")
    }
}

/** The account's uploads across a restart: one preference per account. */
private class PrefsStore(context: Context, private val account: AccountKey) : DriveUploadStore {
    private val prefs = context.getSharedPreferences("drive-uploads", Context.MODE_PRIVATE)
    private val key = "${account.server}|${account.userId}"
    override fun load(): String? = prefs.getString(key, null)
    override fun save(json: String) { prefs.edit().putString(key, json).apply() }
}
