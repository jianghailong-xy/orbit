package io.orbitd.android.management

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*

/** The words of the Share panel's People who can reply — web `SessionGuests.tsx` and the line `ShareModal.tsx` puts under Access, and
 * OrbitKit `SessionGuestsCopy`, word for word (docs/session-guests-design.md §3). SessionGuestsCopyParityTest holds them to both. */
internal object SessionGuestsCopy {
    const val peopleWhoCanReply = "People who can reply"
    const val emailPlaceholder = "Email of an Orbit account"
    const val invite = "Invite"
    const val remove = "Remove"
    const val acknowledge = "I understand the agent won’t ask before acting on their messages"
    /** Under Access while no public link is open, in a session's panel: the people below can still reply. */
    const val privateDetail = "No public link. People you invite below can still open and reply."
    const val couldNotRemove = "Couldn't remove them"
    const val notOpenedYet = "Not opened yet"

    /** The session's permission mode as the consequence line says it. */
    fun modeWords(mode: String) = when (mode) {
        "default" -> "Default"
        "plan" -> "Plan"
        "acceptEdits" -> "Accept edits"
        "auto" -> "Auto"
        "dontAsk" -> "Don’t ask"
        "bypassPermissions" -> "Bypass permissions"
        else -> mode
    }

    /** The modes in which the agent acts on a guest's message without asking anyone first. */
    val unaskingModes = setOf("auto", "dontAsk", "bypassPermissions")

    /** What inviting someone means, said in the panel rather than in a separate warning (§3): their messages run on the owner's machine,
     * in the session's mode, on the owner's accounts. In a mode that does not ask, the line is amber ([Consequence.warns]) and says so
     * instead of promising approvals that will not come. */
    fun consequence(runnerName: String, permissionMode: String): Consequence {
        val warns = permissionMode in unaskingModes
        val runs = "They can send messages to this session. The agent runs them on $runnerName as ${modeWords(permissionMode)}, using your accounts"
        return if (warns) Consequence("$runs — it won’t ask before acting.", true)
            else Consequence("$runs. Approvals and the agent’s questions still come only to you.", false)
    }

    /** "12 messages today" once the guest has opened the session or written, else "Not opened yet". */
    fun activity(guest: SessionGuestPerson) =
        if (guest.opened || guest.messagesToday > 0) "${ShareCopy.countOf(guest.messagesToday, "message")} today" else notOpenedYet

    data class Consequence(val text: String, val warns: Boolean)
}

/** One person who can reply in a session, as the owner's `GET sessions/:id/guests` lists them (`@orbit/shared` and OrbitKit
 * `SessionGuestPerson`). [messagesToday] counts since midnight UTC; [opened] is whether they have opened the session at least once. */
internal data class SessionGuestPerson(val userId: String, val name: String, val email: String, val messagesToday: Int, val opened: Boolean) {
    companion object {
        /** What all three owner routes answer, `{guests: [...]}`: the people as they now stand. */
        fun list(value: JsonElement): List<SessionGuestPerson> {
            val guests = (value as? JsonObject)?.get("guests") as? JsonArray ?: throw IllegalStateException("Missing guest list")
            return guests.map { item ->
                val o = item as? JsonObject ?: throw IllegalStateException("Invalid guest")
                SessionGuestPerson(o.text("userId").ifEmpty { throw IllegalStateException("Invalid guest") }, o.text("name"), o.text("email"),
                    (o["messagesToday"] as? JsonPrimitive)?.intOrNull ?: 0, o.flag("opened"))
            }
        }
    }
}

/** Where and how the agent runs a guest's message: the session's machine and permission mode (OrbitKit `SessionGuestContext`, web
 * `guestContextOf`). A session that names no mode runs in Default. */
data class SessionGuestContext(val runnerName: String, val permissionMode: String)

/** People who can reply, as state (OrbitKit `SessionGuestsPanel`): an email and Invite, the guests the server listed, and whether the
 * first invite to a session in Auto, Don't ask or Bypass has the owner's tick that the agent won't ask before acting. */
internal data class SessionGuestsPanel(
    val context: SessionGuestContext,
    /** Null until the server has answered. */
    val guests: List<SessionGuestPerson>? = null,
    val email: String = "",
    /** The reason the last invite was refused, shown under the field until the email changes. */
    val error: String? = null,
    val acknowledged: Boolean = false,
    val inviting: Boolean = false,
) {
    val consequence get() = SessionGuestsCopy.consequence(context.runnerName, context.permissionMode)
    /** The tick is asked for only before the first guest of a session that will not ask. */
    val needsAcknowledge get() = consequence.warns && guests?.isEmpty() == true
    val trimmedEmail get() = email.trim()
    val canInvite get() = trimmedEmail.isNotEmpty() && !inviting && (!needsAcknowledge || acknowledged)

    fun editEmail(value: String) = copy(email = value, error = null)
    fun loaded(people: List<SessionGuestPerson>) = copy(guests = people)
    fun invited(people: List<SessionGuestPerson>) = copy(guests = people, email = "", error = null, inviting = false)
    fun inviteFailed(reason: String) = copy(error = reason, inviting = false)
}

internal fun sessionGuestsPath(sessionId: String) = "sessions/$sessionId/guests"

/**
 * People who can reply: the Share panel's section for a session — the Android half of web `SessionGuestsSection` and iOS
 * `ShareSheet.peopleSection`. Remove takes effect at once; a refused invite says why under the field.
 */
@Composable
internal fun SessionGuestsSection(api: ManagementApi, sessionId: String, context: SessionGuestContext) {
    val scope = rememberCoroutineScope()
    val path = remember(sessionId) { sessionGuestsPath(sessionId) }
    var panel by remember(sessionId, context) { mutableStateOf(SessionGuestsPanel(context)) }
    var removing by remember(sessionId) { mutableStateOf(false) }
    var failure by remember(sessionId) { mutableStateOf<String?>(null) }
    LaunchedEffect(path) {
        try { panel = panel.loaded(SessionGuestPerson.list(api.get(path))) }
        catch (e: CancellationException) { throw e } catch (e: Exception) { failure = personalFailure(e) }
    }
    fun invite() {
        if (!panel.canInvite) return
        val email = panel.trimmedEmail
        panel = panel.copy(inviting = true)
        scope.launch {
            panel = try { panel.invited(SessionGuestPerson.list(api.post(path, buildJsonObject { put("email", email) }))) }
            catch (e: CancellationException) { throw e } catch (e: Exception) { panel.inviteFailed(personalFailure(e)) }
        }
    }
    fun remove(guest: SessionGuestPerson) {
        removing = true; failure = null
        scope.launch {
            try { panel = panel.loaded(SessionGuestPerson.list(api.delete("$path/${guest.userId}"))) }
            catch (e: CancellationException) { throw e } catch (e: Exception) { failure = "${SessionGuestsCopy.couldNotRemove}: ${personalFailure(e)}" }
            finally { removing = false }
        }
    }
    // The Share dialog is narrower than a phone's sheet: compact buttons leave the email and the names their room.
    val compact = PaddingValues(horizontal = 12.dp, vertical = 6.dp)
    Column(Modifier.fillMaxWidth().testTag("share-people"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(SessionGuestsCopy.peopleWhoCanReply, style = MaterialTheme.typography.titleMedium)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(panel.email, { panel = panel.editEmail(it) }, Modifier.weight(1f).testTag("share-people-email"), singleLine = true,
                placeholder = { Text(SessionGuestsCopy.emailPlaceholder, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                isError = panel.error != null,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Send, autoCorrectEnabled = false),
                keyboardActions = KeyboardActions(onSend = { invite() }))
            Button(onClick = ::invite, enabled = panel.canInvite, contentPadding = compact) { Text(SessionGuestsCopy.invite) }
        }
        panel.error?.let { Text(it, color = Ink.red, style = MaterialTheme.typography.bodySmall) }
        failure?.let { Text(it, color = Ink.red, style = MaterialTheme.typography.bodySmall) }
        panel.guests.orEmpty().forEach { guest ->
            Row(Modifier.fillMaxWidth().testTag("share-person:${guest.email}"), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.size(28.dp).background(MaterialTheme.colorScheme.primary, CircleShape), contentAlignment = Alignment.Center) {
                    Text(guest.name.trim().take(1).uppercase().ifEmpty { "?" }, color = MaterialTheme.colorScheme.onPrimary,
                        style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                }
                // Name, email and today's messages stacked, one line each, as iOS: a phone's row has no room for the web's columns.
                Column(Modifier.weight(1f)) {
                    Text(guest.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(guest.email, style = MaterialTheme.typography.bodySmall, color = Ink.muted, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                    Text(SessionGuestsCopy.activity(guest), style = MaterialTheme.typography.bodySmall, color = Ink.muted, maxLines = 1)
                }
                OutlinedButton(onClick = { remove(guest) }, enabled = !removing, contentPadding = compact,
                    modifier = Modifier.semantics { contentDescription = "${SessionGuestsCopy.remove} ${guest.name}" }) { Text(SessionGuestsCopy.remove) }
            }
        }
        val consequence = panel.consequence
        Text(consequence.text, style = MaterialTheme.typography.bodySmall, color = if (consequence.warns) Ink.amber else Ink.muted)
        if (panel.needsAcknowledge) {
            Row(Modifier.fillMaxWidth().toggleable(panel.acknowledged, role = Role.Checkbox) { panel = panel.copy(acknowledged = it) },
                verticalAlignment = Alignment.CenterVertically) {
                Checkbox(panel.acknowledged, null); Spacer(Modifier.width(8.dp))
                Text(SessionGuestsCopy.acknowledge, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
