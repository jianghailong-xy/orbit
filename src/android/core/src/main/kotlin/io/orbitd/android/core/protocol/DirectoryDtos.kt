package io.orbitd.android.core.protocol

import kotlinx.serialization.Serializable

/** Only the directory fields consumed by this milestone. Wire enum strings remain forward-readable. */
@Serializable
data class WorkspaceSummary(
    val id: String,
    val name: String,
    val runnerId: String? = null,
    val workDir: String? = null,
    val lastProvider: String? = null,
)

@Serializable
data class SessionSummary(
    val id: String,
    val title: String? = null,
    val status: String,
    val runState: String? = null,
    val lifecycleState: String? = null,
    val agentId: String? = null,
    val workspaceId: String? = null,
    val folderId: String? = null,
    val capabilities: SessionCapabilities? = null,
) {
    // Unknown/missing capabilities grant no actions; status strings never grant permission.
    fun allows(action: SessionAction): Boolean = capabilities?.allows(action) == true
}

enum class SessionAction { SEND, RESUME, COMPLETE, RESTORE }

@Serializable
data class SessionCapabilities(
    val canSend: Boolean = false,
    val canResume: Boolean = false,
    val resumeBlockedReason: String? = null,
    val canComplete: Boolean? = null,
    val canArchive: Boolean? = null,
    val canRestore: Boolean = false,
) {
    fun allows(action: SessionAction): Boolean = when (action) {
        SessionAction.SEND -> canSend
        SessionAction.RESUME -> canResume
        SessionAction.COMPLETE -> canComplete ?: canArchive ?: false
        SessionAction.RESTORE -> canRestore
    }
}
