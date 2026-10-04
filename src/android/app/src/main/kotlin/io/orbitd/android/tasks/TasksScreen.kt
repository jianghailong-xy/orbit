package io.orbitd.android.tasks

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.navigation.OrbitRoute

@Composable
fun TasksScreen(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute, revision: Long,
    open: (OrbitRoute) -> Unit) {
    Text("Tasks")
}
