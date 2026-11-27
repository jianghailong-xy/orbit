package io.orbitd.android.composer

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.orbitd.android.R

/**
 * The drawer's Workspaces +, iOS `NewWorkspaceButton` (docs/mocks/new-workspace-form/02-apple-entry, owner A 2026-11-20): New workspace
 * on a machine. A menu of the account's machines, each with what it holds, or straight to the page with only one machine. Nothing while
 * the account has none. [open] is told the machine and whether it has a workspace already.
 */
@Composable
internal fun NewWorkspaceButton(machines: List<NewWorkspaceMachine>, open: (NewWorkspaceMachine) -> Unit) {
    if (machines.isEmpty()) return
    var menu by remember { mutableStateOf(false) }
    Box {
        Box(
            Modifier
                .size(32.dp)
                .clip(CircleShape)
                .clickable(role = Role.Button) { if (machines.size == 1) open(machines.first()) else menu = true }
                .semantics { contentDescription = NewWorkspaceCopy.NEW_WORKSPACE }
                .testTag("new-workspace"),
            contentAlignment = Alignment.Center,
        ) {
            Icon(painterResource(R.drawable.ic_plus), null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary)
        }
        DropdownMenu(menu, onDismissRequest = { menu = false }) {
            Text(
                NewWorkspaceCopy.NEW_WORKSPACE_ON,
                Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            machines.forEach { machine ->
                DropdownMenuItem(
                    text = {
                        // The machine's name, and under it what it holds.
                        Column {
                            Text(machine.name, maxLines = 1)
                            Text(
                                NewWorkspaceCopy.machineDetail(machine.workspaces, machine.online),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    },
                    onClick = { menu = false; open(machine) },
                    modifier = Modifier.testTag("new-workspace-machine:${machine.id}"),
                )
            }
        }
    }
}
