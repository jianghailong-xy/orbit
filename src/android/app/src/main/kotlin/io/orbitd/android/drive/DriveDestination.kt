package io.orbitd.android.drive

import androidx.compose.runtime.Composable
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
fun DriveDestination(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute, open: (OrbitRoute) -> Unit, back: () -> Unit) {
    val store = DriveStore.of(app, handle)
    LaunchedEffect(store) { store.uploads.start(); if (store.uploads.busy) DriveUploads.start(app) }
    LaunchedEffect(route) { if (route.recordId == DRIVE_UPLOADS_RECORD) store.showUploads = true }
    val openSession = { id: String -> open(OrbitRoute(Destination.SESSION, id, origin = Origin.LINK)) }
    when (route.destination) {
        Destination.DRIVE_FILE -> DriveFilePage(store, route, open, openSession, back)
        Destination.DRIVE_TRASH -> DriveTrashPage(store, route)
        Destination.DRIVE_STORAGE -> DriveStoragePage(store, route, open)
        else -> DriveFolderPage(store, route, open, openSession)
    }
}

/** Whether the drawer has the Drive row: once the capabilities read finished and did not say `documents.enabled: false`. */
@Composable
fun driveShown(app: OrbitApplication, handle: SessionHandle): Boolean {
    val store = DriveStore.of(app, handle)
    LaunchedEffect(store) { store.loadCapability() }
    return store.shown == true
}
