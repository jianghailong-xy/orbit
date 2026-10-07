package io.orbitd.android.tasks

import androidx.compose.runtime.Composable
import kotlinx.serialization.json.JsonObject

/** TEMPORARY until projects/ProjectGraph.kt provides the iOS task dependency graph view. */
@Composable
internal fun TaskDependencyGraphView(graph: JsonObject, focusTaskId: String?, openTask: (String) -> Unit) =
    io.orbitd.android.projects.ProjectGraph(graph) { if (it != focusTaskId) openTask(it) }
