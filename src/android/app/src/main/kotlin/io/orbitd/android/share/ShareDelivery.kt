package io.orbitd.android.share

import android.content.Context
import io.orbitd.android.attachments.importAttachment
import io.orbitd.android.composer.ComposerModel
import io.orbitd.android.composer.StagedAttachment
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import java.util.UUID

/**
 * Stages what was shared in [model]'s draft, as the composer's own `+` menu would (§3.2): short text and links under the draft's
 * words, longer text as `shared-text.txt`, and each URI through [importAttachment] (a durable draft copy, then the upload). Nothing
 * is sent. False when the draft could not be read in time, so nothing was staged.
 */
suspend fun deliverShare(context: Context, model: ComposerModel, handoff: ShareHandoff): Boolean {
    withTimeoutOrNull(10_000) { model.state.first { it.loaded } } ?: return false
    handoff.text?.let { text ->
        when (val routed = ShareIntents.route(text)) {
            is SharedText.Inline -> model.putBack(routed.text)
            is SharedText.File -> {
                val attachment = StagedAttachment(UUID.randomUUID().toString(), routed.name, "text/plain", routed.bytes.size)
                model.importAttachment(attachment, read = { attachment to routed.bytes }, release = {})
            }
        }
    }
    handoff.uris.forEach { importAttachment(context, model, it, "file") }
    return true
}
