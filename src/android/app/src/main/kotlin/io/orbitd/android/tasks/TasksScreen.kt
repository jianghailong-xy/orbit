package io.orbitd.android.tasks

import io.orbitd.android.navigation.Destination
import androidx.compose.runtime.*
import io.orbitd.android.text.LocalReaderResources
import io.orbitd.android.text.ReaderResources
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.navigation.OrbitRoute

@Composable
fun TasksScreen(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute, revision: Long,
    open: (OrbitRoute) -> Unit, back: () -> Unit = {}) {
    val resources = remember(handle, route.id) { ReaderResources(app.session, handle) }
    CompositionLocalProvider(LocalReaderResources provides resources) {
    if (route.destination == Destination.TASK && route.id != null) TaskDetail(app, handle, route.id, revision, open, back)
    else TaskBrowser(app, handle, route, revision, open)
    }
}
