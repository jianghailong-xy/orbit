package io.orbitd.android.drive

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.orbitd.android.chat.ChatMetrics
import io.orbitd.android.directory.DirectoryApi
import io.orbitd.android.directory.DirectoryData
import androidx.compose.runtime.LaunchedEffect
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.Origin
import io.orbitd.android.navigation.OrbitRoute

/** The drawer's key for the Drive destination, and the link the upload notification's Show opens. */
const val DRIVE_SECTION = "Drive"
const val DRIVE_UPLOADS_RECORD = "uploads"

val OrbitRoute.isDrive get() = destination.name.startsWith("DRIVE")

/** Drive' pages (board 04-android): a folder, a file, Trash and Storage. */
@Composable
fun DriveDestination(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute, api: DirectoryApi, data: DirectoryData,
    open: (OrbitRoute) -> Unit, back: () -> Unit) {
    val store = DriveStore.of(app, handle)
    LaunchedEffect(store) { store.uploads.start(); if (store.uploads.busy) DriveUploads.start(app) }
    LaunchedEffect(route) { if (route.recordId == DRIVE_UPLOADS_RECORD) store.showUploads = true }
    val openSession = { id: String -> open(OrbitRoute(Destination.SESSION, id, origin = Origin.LINK)) }
    // The Drive chat (board drive-chat 02 frames 9–12): its round button on a folder — over Upload (owner Q1 A) — and on a file; Trash
    // and Storage host none.
    Box(Modifier.fillMaxSize()) {
        when (route.destination) {
            Destination.DRIVE_FILE -> DriveFilePage(store, route, open, openSession, back)
            Destination.DRIVE_TRASH -> DriveTrashPage(store, route)
            Destination.DRIVE_STORAGE -> DriveStoragePage(store, route, open)
            else -> DriveFolderPage(store, route, open, openSession)
        }
        when (route.destination) {
            Destination.DRIVE_TRASH, Destination.DRIVE_STORAGE -> {}
            Destination.DRIVE_FILE -> DriveChatLayer(store, api, data, open, fabBottom = ChatMetrics.fabEdge)
            else -> DriveChatLayer(store, api, data, open, fabBottom = DriveMetrics.uploadBottom + 56.dp + ChatMetrics.fabEdge)
        }
    }
}

/** Whether the drawer has the Drive row: once the capabilities read finished and did not say `documents.enabled: false`. */
@Composable
fun driveShown(app: OrbitApplication, handle: SessionHandle): Boolean {
    val store = DriveStore.of(app, handle)
    LaunchedEffect(store) { store.loadCapability() }
    return store.shown == true
}
