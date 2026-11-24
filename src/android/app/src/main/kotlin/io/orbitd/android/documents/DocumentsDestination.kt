package io.orbitd.android.documents

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.Origin
import io.orbitd.android.navigation.OrbitRoute

/** The drawer's key for the Documents destination, and the link the upload notification's Show opens. */
const val DOCUMENTS_SECTION = "Documents"
const val DOCUMENTS_UPLOADS_RECORD = "uploads"

val OrbitRoute.isDocuments get() = destination.name.startsWith("DOCUMENTS")

/** Documents' pages (board 04-android): a folder, a file, Trash and Storage. */
@Composable
fun DocumentsDestination(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute, open: (OrbitRoute) -> Unit, back: () -> Unit) {
    val store = DocumentsStore.of(app, handle)
    LaunchedEffect(store) { store.uploads.start(); if (store.uploads.busy) DocumentsUploads.start(app) }
    LaunchedEffect(route) { if (route.recordId == DOCUMENTS_UPLOADS_RECORD) store.showUploads = true }
    val openSession = { id: String -> open(OrbitRoute(Destination.SESSION, id, origin = Origin.LINK)) }
    when (route.destination) {
        Destination.DOCUMENTS_FILE -> DocumentsFilePage(store, route, open, openSession, back)
        Destination.DOCUMENTS_TRASH -> DocumentsTrashPage(store, route)
        Destination.DOCUMENTS_STORAGE -> DocumentsStoragePage(store, route, open)
        else -> DocumentsFolderPage(store, route, open, openSession)
    }
}

/** Whether the drawer has the Documents row: once the capabilities read finished and did not say `documents.enabled: false`. */
@Composable
fun documentsShown(app: OrbitApplication, handle: SessionHandle): Boolean {
    val store = DocumentsStore.of(app, handle)
    LaunchedEffect(store) { store.loadCapability() }
    return store.shown == true
}
