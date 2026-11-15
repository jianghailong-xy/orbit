package io.orbitd.android.share

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.IntentCompat
import io.orbitd.android.MainActivity

/** What another app shared to Orbit (docs/share-to-orbit-design.md §3.2, §3.4): files and images as content URIs, and any text. */
data class SharedItems(val uris: List<Uri>, val text: String?, val dropped: Int) {
    val count get() = uris.size + (if (text != null) 1 else 0)
    val isEmpty get() = count == 0
}

/** Where shared text goes: into the composer's words, or a `shared-text.txt` attachment. */
sealed interface SharedText {
    data class Inline(val text: String) : SharedText
    data class File(val name: String, val bytes: ByteArray) : SharedText
}

object ShareCopy {
    const val TITLE = "Add to session"
    const val CLOSE = "Close"
    const val SEARCH = "Search sessions"
    const val NEW_SESSION = "New session"
    const val RECENT = "Recent"
    const val NO_SESSIONS = "No open sessions"
    const val NO_MATCHES = "No matching sessions"
    const val NOTHING_SHARED = "Nothing to add: the app shared no files or text."
    const val NO_WORKSPACE = "No workspace to start a session in"
    const val CHOOSE_WORKSPACE = "Choose workspace"
    const val TOO_LARGE = "Too large (max 25 MB)"
    const val TEXT_ITEM = "Text"
    const val LINK_ITEM = "Link"
    const val SESSION_GONE = "That session has ended"
    const val SESSION_GONE_DETAIL = "Your shared items are in a new session draft instead."
    fun keptFirst(total: Int) = "Only the first ${ShareIntents.MAX_ITEMS} of $total items were added."
}

object ShareIntents {
    const val MAX_ITEMS = 10
    const val MAX_INLINE_TEXT = 2_000
    const val TEXT_FILE_NAME = "shared-text.txt"
    /** MainActivity's hand-off from [ShareActivity]: a session to open, or a workspace to start a new session in. */
    const val ACTION_HANDOFF = "io.orbitd.android.action.SHARE_TO_SESSION"
    private const val EXTRA_SESSION = "io.orbitd.android.share.SESSION"
    private const val EXTRA_WORKSPACE = "io.orbitd.android.share.WORKSPACE"
    private const val EXTRA_TEXT = "io.orbitd.android.share.TEXT"
    private val url = Regex("""^[a-zA-Z][a-zA-Z0-9+.-]*://\S+$""")

    fun isShare(intent: Intent?) = intent?.action == Intent.ACTION_SEND || intent?.action == Intent.ACTION_SEND_MULTIPLE

    /** The items of an ACTION_SEND / ACTION_SEND_MULTIPLE intent: its streams (or, failing them, its clip's URIs) then its text, at
     * most [MAX_ITEMS] of them, with how many more were left out. */
    fun parse(intent: Intent): SharedItems {
        if (!isShare(intent)) return SharedItems(emptyList(), null, 0)
        val streams = if (intent.action == Intent.ACTION_SEND_MULTIPLE)
            IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty().filterNotNull()
        else listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
        val texts = intent.getCharSequenceArrayListExtra(Intent.EXTRA_TEXT)?.map { it.toString() }
            ?: listOfNotNull(intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString())
        val text = texts.map(String::trim).filter(String::isNotEmpty).joinToString("\n\n").ifEmpty { null }
        // A clip's URIs stand in for a stream only when no text was shared: beside text they are the share sheet's preview
        // (Chrome's page thumbnail), not an item.
        val clip = intent.clipData?.takeIf { text == null }
        val uris = streams.ifEmpty { (0 until (clip?.itemCount ?: 0)).mapNotNull { clip!!.getItemAt(it).uri } }.distinct()
        val total = uris.size + (if (text != null) 1 else 0)
        val kept = uris.take(MAX_ITEMS)
        val keepText = text != null && kept.size < MAX_ITEMS
        return SharedItems(kept, if (keepText) text else null, total - kept.size - (if (keepText) 1 else 0))
    }

    fun isLink(text: String) = url.matches(text.trim())

    /** §3.4: a link, or text up to [MAX_INLINE_TEXT] characters, goes into the composer text; longer text becomes a `.txt` file. */
    fun route(text: String): SharedText = if (isLink(text) || text.length <= MAX_INLINE_TEXT) SharedText.Inline(text)
        else SharedText.File(TEXT_FILE_NAME, text.encodeToByteArray())

    /** The intent that opens MainActivity on the picked target with the items, passing on the read grant for each URI. */
    fun handoff(context: Context, target: ShareTarget, items: SharedItems): Intent =
        Intent(context, MainActivity::class.java).setAction(ACTION_HANDOFF)
            .putExtra(EXTRA_SESSION, (target as? ShareTarget.Session)?.id)
            .putExtra(EXTRA_WORKSPACE, target.workspaceId)
            .putExtra(EXTRA_TEXT, items.text)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .also { intent ->
                if (items.uris.isEmpty()) return@also
                val clip = ClipData.newRawUri(null, items.uris.first())
                items.uris.drop(1).forEach { clip.addItem(ClipData.Item(it)) }
                intent.clipData = clip
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }

    /** MainActivity's reading of [handoff]; null for any other intent. */
    fun receive(intent: Intent): ShareHandoff? {
        if (intent.action != ACTION_HANDOFF) return null
        val workspace = intent.getStringExtra(EXTRA_WORKSPACE) ?: return null
        val session = intent.getStringExtra(EXTRA_SESSION)
        val clip = intent.clipData
        val uris = (0 until (clip?.itemCount ?: 0)).mapNotNull { clip!!.getItemAt(it).uri }
        return ShareHandoff(if (session != null) ShareTarget.Session(session, workspace) else ShareTarget.NewSession(workspace),
            uris, intent.getStringExtra(EXTRA_TEXT))
    }
}

sealed interface ShareTarget {
    val workspaceId: String
    data class Session(val id: String, override val workspaceId: String) : ShareTarget
    data class NewSession(override val workspaceId: String) : ShareTarget
}

data class ShareHandoff(val target: ShareTarget, val uris: List<Uri>, val text: String?) {
    /** §4: a picked session that is no longer open (deleted or ended meanwhile) gives way to a new-session draft in its workspace. */
    fun landing(openSessions: (String) -> Boolean): ShareTarget = when (target) {
        is ShareTarget.Session -> if (openSessions(target.id)) target else ShareTarget.NewSession(target.workspaceId)
        is ShareTarget.NewSession -> target
    }
}
