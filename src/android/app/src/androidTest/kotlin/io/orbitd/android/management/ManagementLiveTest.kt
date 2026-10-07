package io.orbitd.android.management

import android.graphics.Bitmap
import android.util.Base64
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.MainActivity
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.net.ServerAddress
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.time.Instant

/**
 * A13 on a real Orbit stack (scripts/management-live-test.sh): an isolated server of a fixed commit with real
 * accounts — a MEMBER, the bootstrap ADMIN, a second ADMIN, and a key pool's owner, admin and member — and a real
 * remote runner. Every write made through the UI is read back from the server with the acting account's own
 * token, and each check is logged. Skipped unless the run passes the stack (instrumentation argument a13Server);
 * the host script runs one step at a time, in order.
 */
@RunWith(AndroidJUnit4::class)
class ManagementLiveTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val app get() = instrumentation.targetContext.applicationContext as OrbitApplication
    private val args get() = InstrumentationRegistry.getArguments()
    private fun arg(name: String) = args.getString(name) ?: error("missing instrumentation argument $name")
    private lateinit var server: String
    private lateinit var accounts: JsonObject
    private lateinit var log: File
    private val http = OkHttpClient()

    private class Account(val email: String, val password: String, val id: String) { var token = "" }
    private fun account(key: String) = accounts[key]!!.jsonObject.let { Account(it.s("email")!!, it.s("password")!!, it.s("id").orEmpty()) }

    @Before fun stack() {
        assumeTrue("Needs the isolated stack (instrumentation argument a13Server)", args.getString("a13Server") != null)
        server = arg("a13Server").trimEnd('/')
        accounts = Json.parseToJsonElement(String(Base64.decode(arg("a13Accounts"), Base64.NO_WRAP))).jsonObject
        log = File(app.filesDir, "a13-live").apply { mkdirs() }.resolve("checks.log")
        compose.waitUntil(15_000) { app.session.state.value !is AuthState.Restoring }
        if (app.session.state.value is AuthState.SignedIn) runBlocking { app.session.logout() }
    }

    // ---- The server, read with the acting account's own token. ----

    private fun call(method: String, path: String, token: String? = null, body: JsonElement? = null): Pair<Int, JsonElement?> {
        val payload = body?.toString()?.toRequestBody("application/json".toMediaType())
            ?: if (method in setOf("POST", "PUT", "PATCH")) "".toRequestBody(null) else null
        val request = Request.Builder().url("$server/api/$path").method(method, payload).apply { token?.let { header("Authorization", "Bearer $it") } }.build()
        http.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            return response.code to text.takeIf { it.isNotBlank() }?.let { runCatching { Json.parseToJsonElement(it) }.getOrNull() }
        }
    }
    private fun login(email: String, password: String) = call("POST", "auth/login", null, buildJsonObject { put("email", email); put("password", password) })
    private fun token(account: Account): String {
        val (code, body) = login(account.email, account.password)
        check(code in 200..299) { "server: ${account.email} could not sign in ($code)" }
        return body!!.jsonObject.s("accessToken")!!.also { account.token = it }
    }
    private fun read(account: Account, path: String): JsonElement {
        val (code, body) = call("GET", path, account.token.ifEmpty { token(account) })
        check(code in 200..299) { "server: GET $path as ${account.email} → $code" }
        return body ?: JsonNull
    }
    private fun prefs(account: Account) = read(account, "users/me").jsonObject["preferences"]!!.jsonObject
    private fun runners(account: Account) = read(account, "runners").jsonArray.map { it.jsonObject }
    private fun runner(account: Account) = runners(account).first { it.s("name") == "a13-box" }

    private fun note(line: String) = log.appendText("${Instant.now()} $line\n")
    private fun ok(what: String, holds: Boolean) { note((if (holds) "PASS " else "FAIL ") + what); assertTrue(what, holds) }
    /** A write that went out through the UI, read back from the server until it shows (or 20 s pass). */
    private fun eventually(what: String, timeoutMs: Long = 20_000, holds: () -> Boolean) {
        val until = System.currentTimeMillis() + timeoutMs
        var last: Throwable? = null
        while (System.currentTimeMillis() < until) {
            try { if (holds()) { note("PASS $what"); return } } catch (e: Throwable) { last = e }
            compose.waitForIdle(); Thread.sleep(500)
        }
        note("FAIL $what${last?.let { " ($it)" }.orEmpty()}")
        throw AssertionError(what, last)
    }

    // ---- The app. ----

    private fun signIn(account: Account) {
        if (app.session.state.value is AuthState.SignedIn) runBlocking { app.session.logout() }
        compose.waitUntil(15_000) { app.session.state.value is AuthState.SignedOut }
        runBlocking { app.session.login(ServerAddress.parse(server, true), account.email, account.password) }
        compose.waitUntil(20_000) { app.session.state.value is AuthState.SignedIn && app.realtime.state.value.directoryFresh }
        token(account)
        note("as ${account.email}")
    }
    private fun settings() {
        compose.onAllNodesWithContentDescription("Open navigation").onFirst().performClick()
        click(hasText("Settings") and hasClickAction())
        await("Default permission")
    }
    private fun providers() { settings(); click(hasText("Providers") and hasClickAction()); await("Account pools") }
    private fun pick(row: String, option: String) { click(hasText(row) and hasClickAction()); click(hasText(option) and hasClickAction(), scroll = false) }
    private fun field(label: String) = compose.onNode(hasSetTextAction() and hasText(label))
    private fun back() = compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
    private fun await(text: String, timeoutMs: Long = 20_000) =
        compose.waitUntil(timeoutMs) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    private fun shows(matcher: SemanticsMatcher) = compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty()
    private fun click(matcher: SemanticsMatcher, scroll: Boolean = true) {
        compose.waitUntil(20_000) { compose.onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
        val node = compose.onAllNodes(matcher).onFirst()
        if (scroll) try { node.performScrollTo() } catch (_: AssertionError) { }
        node.performClick()
        compose.waitForIdle()
    }
    private fun openWorkspace(id: String) {
        val name = read(account("owner").also { token(it) }, "workspaces/$id").jsonObject.s("name")!!
        compose.waitUntil(20_000) { shows(hasText(name) and hasClickAction()) || shows(hasText("unreadable directory", substring = true)) }
        ok("the directory lists the workspace (not \"unreadable\")", shows(hasText(name) and hasClickAction()))
        click(hasText(name) and hasClickAction())
    }
    private fun capture(label: String) {
        compose.waitForIdle(); instrumentation.waitForIdleSync(); android.os.SystemClock.sleep(700)
        val dir = File(app.filesDir, "a13-live").apply { mkdirs() }
        instrumentation.uiAutomation.takeScreenshot().let { bitmap ->
            File(dir, "$label.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }

    // ---- The steps, in the order the host script runs them. ----

    @Test fun step1MemberSettingsReachTheServer() {
        val member = account("member")
        signIn(member); settings()
        ok("MEMBER sees no Admin row", !shows(hasText("Admin") and hasClickAction()))
        ok("server refuses GET admin/users to the MEMBER (403)", call("GET", "admin/users", member.token).first == 403)
        capture("live-settings-member")
        pick("Default permission", "Plan")
        eventually("server: defaultPermissionMode = plan") { prefs(member).s("defaultPermissionMode") == "plan" }
        click(hasText("Session orchestration") and isToggleable())
        eventually("server: enableOrchestration = false") { prefs(member).b("enableOrchestration") == false }
        pick("Appearance", "Dark")
        eventually("server: theme = dark") { prefs(member).s("theme") == "dark" }
        capture("live-settings-member-dark")
        pick("Appearance", "System")
        eventually("server: theme = system") { prefs(member).s("theme") == "system" }
        click(hasText("Notifications") and hasClickAction()); await("When a session finishes")
        val finished = prefs(member).b("notifySessionFinished") ?: true   // absent = on, as the app and the push service read it
        click(hasText("When a session finishes") and isToggleable())
        eventually("server: notifySessionFinished = ${!finished}") { prefs(member).b("notifySessionFinished") == !finished }
        back(); await("Default permission")
        compose.onNodeWithContentDescription("Edit profile").performScrollTo().performClick(); await("Save profile")
        field("Name").performTextReplacement("Member Renamed")
        click(hasText("Save profile") and hasClickAction())
        eventually("server: name = Member Renamed") { read(member, "users/me").jsonObject.s("name") == "Member Renamed" }
        await("Default permission")
        click(hasText("Change password") and hasClickAction()); await("At least 6 characters")
        field("Current password").performTextInput(member.password)
        field("New password").performTextInput("member-pass-2")
        field("Confirm new password").performTextInput("member-pass-2")
        click(hasText("Change password") and hasClickAction(), scroll = false)
        eventually("server: the new password signs in") { login(member.email, "member-pass-2").first in 200..299 }
        ok("server: the old password no longer signs in", login(member.email, member.password).first == 401)
        // Put the seeded password back through the API, so the steps after this one sign in as seeded.
        val again = login(member.email, "member-pass-2").second!!.jsonObject.s("accessToken")
        call("POST", "auth/change-password", again, buildJsonObject { put("currentPassword", "member-pass-2"); put("newPassword", member.password) })
        ok("server: seeded password restored", login(member.email, member.password).first in 200..299)
    }

    @Test fun step2AnAdminManagesUsersAndRoles() {
        val owner = account("owner"); val second = account("admin2")
        signIn(owner); settings()
        click(hasText("Admin") and hasClickAction()); await("member@a13.test")
        capture("live-admin-users")
        click(hasText("New user") and hasClickAction())
        field("Email").performTextInput("spare@a13.test"); field("Name (optional)").performTextInput("Spare")
        click(hasText("Create") and hasClickAction(), scroll = false)
        await("Generated password — copy now, shown once")
        val generated = compose.onAllNodes(anyText()).fetchSemanticsNodes()
            .flatMap { it.config.getOrNull(SemanticsProperties.Text).orEmpty().map { t -> t.text } }
            .first { it.length >= 12 && ' ' !in it && '@' !in it && it != "Generated password — copy now, shown once" }
        fun spare() = read(owner, "admin/users").jsonArray.map { it.jsonObject }.firstOrNull { it.s("email") == "spare@a13.test" }
        eventually("server: spare@a13.test exists as MEMBER") { spare()?.s("role") == "MEMBER" }
        ok("the password shown once signs the new account in", login("spare@a13.test", generated).first in 200..299)
        click(hasText("Dismiss") and hasClickAction())
        ok("the generated password is gone once dismissed", !shows(hasText(generated)))
        click(hasText("Spare") and hasClickAction()); await("Delete user")
        capture("live-admin-user")
        click(hasText("Admin") and hasClickAction(), scroll = false)
        eventually("server: Spare is ADMIN") { spare()?.s("role") == "ADMIN" }
        click(hasText("Member") and hasClickAction(), scroll = false)
        eventually("server: Spare is MEMBER again") { spare()?.s("role") == "MEMBER" }
        click(hasText("Delete user") and hasClickAction())
        click(hasText("Delete user") and hasClickAction() and hasAnyAncestor(isDialog()), scroll = false)
        eventually("server: Spare is deleted") { spare() == null }
        ok("server: the deleted account no longer signs in", login("spare@a13.test", generated).first == 401)
        // Demoted elsewhere: the next read takes Admin away.
        call("PATCH", "admin/users/${second.id}/role", owner.token, buildJsonObject { put("role", "MEMBER") })
        signIn(second); settings()
        ok("a demoted admin sees no Admin row", !shows(hasText("Admin") and hasClickAction()))
        ok("server refuses GET admin/users to the demoted account (403)", call("GET", "admin/users", second.token).first == 403)
        call("PATCH", "admin/users/${second.id}/role", token(owner), buildJsonObject { put("role", "ADMIN") })
        ok("server: admin2 restored to ADMIN", call("GET", "admin/users", token(second)).first in 200..299)
    }

    /** Every node with any text, to read the generated password off the screen. */
    private fun anyText() = SemanticsMatcher("has text") { it.config.getOrNull(SemanticsProperties.Text)?.isNotEmpty() == true }

    @Test fun step3ARunnerIsApprovedFromThePhoneByItsCode() {
        val owner = account("owner")
        signIn(owner); settings()
        click(hasText("Runners") and hasClickAction()); await("Add Runner")
        click(hasText("Add Runner") and hasClickAction())
        await("No browser on that machine?")
        field("Code").performScrollTo().performTextInput(arg("a13DeviceCode"))
        await("a13-box")
        capture("live-add-runner-code")
        click(hasText("Approve") and hasClickAction())
        await("is now registered")
        eventually("server: a13-box is one of the owner's runners") { runners(owner).any { it.s("name") == "a13-box" } }
        eventually("server: a13-box checks in", timeoutMs = 120_000) { runner(owner).b("online") == true }
        await("Runner online", timeoutMs = 60_000)
        capture("live-add-runner-online")
    }

    @Test fun step4RunnerManagementReachesTheRunnerAndTheServer() {
        val owner = account("owner")
        signIn(owner); settings()
        click(hasText("Runners") and hasClickAction())
        click(hasText("a13-box") and hasClickAction()); await("About This Runner")
        val activity = System.identityHashCode(compose.activity)
        compose.waitForIdle(); Thread.sleep(2_000); await("About This Runner")
        note("runner page settled; activity ${if (System.identityHashCode(compose.activity) == activity) "kept" else "recreated"}")
        capture("live-runner")
        click(hasText("Name") and hasClickAction())
        compose.waitUntil(20_000) { shows(hasSetTextAction()) }
        compose.onNode(hasSetTextAction()).performTextReplacement("Stack box")
        back(); await("About This Runner")
        eventually("server: displayName = Stack box") { runner(owner).s("displayName") == "Stack box" }
        val capacity = runner(owner).i("maxConcurrent")!!
        compose.onNodeWithContentDescription("Increase Max Concurrent").performScrollTo().performClick()
        eventually("server: maxConcurrent = ${capacity + 1}") { runner(owner).i("maxConcurrent") == capacity + 1 }
        click(hasText("Keep Free") and hasClickAction()); click(hasText("10 GB") and hasClickAction(), scroll = false)
        eventually("server: minFreeDiskMb = 10240") { runner(owner).i("minFreeDiskMb") == 10_240 }
        click(hasText("Keep Free") and hasClickAction()); click(hasText("Off") and hasClickAction(), scroll = false)
        eventually("server: minFreeDiskMb = null (Off)") { runner(owner)["minFreeDiskMb"].let { it == null || it is JsonNull } }
        capture("live-runner-after")
        click(hasText("Claude Code") and hasClickAction()); await("Accounts")
        capture("live-runner-engine")
        val runnerId = runner(owner).s("id")!!
        click(hasText("Add Account") and hasClickAction())
        eventually("server: the runner was asked to sign a new Claude account in", timeoutMs = 60_000) {
            read(owner, "runners/$runnerId/login").jsonObject.s("status") != null
        }
        capture("live-runner-sign-in")
        if (shows(hasText("Cancel") and hasClickAction())) {
            click(hasText("Cancel") and hasClickAction(), scroll = false)
            eventually("server: the sign-in was given up", timeoutMs = 60_000) {
                read(owner, "runners/$runnerId/login").jsonObject.s("status").let { it == null || it in setOf("CANCELLED", "FAILED", "EXPIRED") }
            }
        }
    }

    @Test fun step5TheWorkspaceFormWritesOnlyWhatChanged() {
        val owner = account("owner")
        val workspace = accounts["workspace"]!!.jsonObject.s("id")!!
        signIn(owner)
        openWorkspace(workspace)
        compose.onNodeWithContentDescription("Workspace settings").performClick()
        await("Smart model selection for tasks")
        field("Name").performTextReplacement("Stack workspace 2")
        compose.onAllNodes(hasSetTextAction()).filter(hasText("Name").not() and hasText("Path").not()).onFirst().performTextInput("Be brief.")
        capture("live-workspace-settings")
        click(hasText("Done") and hasClickAction(), scroll = false)
        eventually("server: workspace name and instructions saved") {
            read(owner, "workspaces/$workspace").jsonObject.let { it.s("name") == "Stack workspace 2" && it.s("appendSystemPrompt") == "Be brief." }
        }
        compose.onNodeWithContentDescription("Workspace settings").performClick(); await("Smart model selection for tasks")
        field("Name").performTextReplacement("Cancelled edit")
        click(hasText("Cancel") and hasClickAction(), scroll = false)
        compose.waitForIdle(); Thread.sleep(1_500)
        ok("server: Cancel wrote nothing", read(owner, "workspaces/$workspace").jsonObject.s("name") == "Stack workspace 2")
        compose.onNodeWithContentDescription("Workspace settings").performClick(); await("Smart model selection for tasks")
        ok("the form opens again on the server's record, not the cancelled edit", shows(hasSetTextAction() and hasText("Stack workspace 2")))
        click(hasText("Cancel") and hasClickAction(), scroll = false)
    }

    @Test fun step6SessionSharingWritesThroughToTheServer() {
        val owner = account("owner")
        val workspace = accounts["workspace"]!!.jsonObject.s("id")!!
        val session = accounts["session"]!!.jsonObject.s("id")!!
        signIn(owner)
        val title = read(owner, "sessions/$session").jsonObject.s("title") ?: "Untitled"
        fun share() = read(owner, "sessions/$session/share").jsonObject["link"]?.takeIf { it !is JsonNull }?.jsonObject
        openWorkspace(workspace)
        compose.waitUntil(20_000) { shows(hasContentDescription("Options for", substring = true)) }
        compose.onAllNodes(hasContentDescription("Options for", substring = true)).onFirst().performClick()
        click(hasText("Share…") and hasClickAction(), scroll = false)
        await("Anyone with the link")
        click(hasText("Anyone with the link") and isSelectable(), scroll = false)
        eventually("server: link is ACTIVE and includes tool output by default") { share()?.let { it.s("state") == "ACTIVE" && it["include"]?.jsonObject?.b("toolOutput") == true } == true }
        capture("live-share-on")
        click(hasText("Tool calls and output") and isToggleable())
        eventually("server: toolOutput off") { share()?.get("include")?.jsonObject?.b("toolOutput") == false }
        click(hasText("Only you") and isSelectable(), scroll = false)
        click(hasText("Turn off") and hasClickAction() and hasAnyAncestor(isDialog()), scroll = false)
        eventually("server: the link is off") { share() == null }
        note("shared session: $title")
    }

    @Test fun step7PoolRolesFollowTheServer() {
        val owner = account("owner"); val member = account("member"); val second = account("admin2")
        val pool = accounts["pool"]!!.jsonObject.s("id")!!
        fun openPool() { providers(); click(hasText("Team keys") and hasClickAction()); await("Who can use it") }
        fun keys() = read(owner, "providers/shared-pools/$pool").jsonObject["keys"]!!.jsonArray.map { it.jsonObject }
        fun people() = read(owner, "providers/shared-pools/$pool").jsonObject["people"]!!.jsonArray.map { it.jsonObject }
        val fakeKey = "sk-proj-" + (1..40).map { "abcdefghijklmnopqrstuvwxyz0123456789"[(it * 7) % 36] }.joinToString("")

        fun rules() = read(owner, "providers/shared-pools/$pool").jsonObject.let { it.b("membersCanAdd") to it.b("membersCanAddAccounts") }
        // A new pool lets its members add both keys and ChatGPT accounts; the owner turns both off first.
        signIn(owner); openPool()
        val (keysOn, accountsOn) = rules()
        note("server: a new pool's rules — keys ${keysOn}, accounts ${accountsOn}")
        if (keysOn == true) click(hasText("They can add their own API keys") and isToggleable())
        if (accountsOn == true) click(hasText("They can add their own ChatGPT accounts") and isToggleable())
        eventually("server: both member rules off") { rules() == (false to false) }
        capture("live-pool-owner-rules-off")

        signIn(member); openPool()
        capture("live-pool-member-rules-off")
        ok("member, both rules off: nothing to add", !shows(hasText("Add a key") and hasClickAction()) && !shows(hasText("Add account") and hasClickAction()))
        ok("server refuses the member's key while the rule is off (403)",
            call("POST", "providers/shared-pools/$pool/keys", member.token, buildJsonObject { put("label", "x"); put("apiKey", fakeKey) }).first == 403)
        ok("server refuses the member's ChatGPT sign-in while the rule is off (403)",
            call("POST", "providers/pools/$pool/codex-login", member.token).first == 403)

        signIn(owner); openPool()
        click(hasText("They can add their own API keys") and isToggleable())
        eventually("server: membersCanAdd = true, accounts still off") { rules() == (true to false) }

        signIn(member); openPool()
        capture("live-pool-member-keys-only")
        ok("member, keys rule on, accounts off: offered a key only", shows(hasText("Add a key") and hasClickAction()) && !shows(hasText("Add account") and hasClickAction()))

        click(hasText("Add a key") and hasClickAction())
        click(hasText("Continue") and hasClickAction(), scroll = false)
        field("Name").performTextInput("Member key"); field("Key").performTextInput(fakeKey)
        click(hasText("Add key") and hasClickAction())
        eventually("server: the pool holds Member key") { keys().any { it.s("label") == "Member key" } }
        click(hasText("Done") and hasClickAction(), scroll = false)
        click(hasText("Leave pool") and hasClickAction())
        click(hasText("Leave") and hasClickAction() and hasAnyAncestor(isDialog()), scroll = false)
        eventually("server: the member left the pool") { people().none { it.s("userId") == member.id } }

        signIn(second); openPool()
        capture("live-pool-non-creator-admin")
        compose.onNode(hasText("Leave pool") and hasClickAction()).performScrollTo().assertIsNotEnabled()
        ok("non-creator admin: Leave pool off, with the reason", shows(hasText("An admin leaves by being made a member first", substring = true)))
        ok("server refuses the admin's leave (403)", call("POST", "providers/shared-pools/$pool/leave", second.token).first == 403)

        signIn(owner); openPool()
        click(hasText("Delete pool") and hasClickAction())
        click(hasText("Delete") and hasClickAction() and hasAnyAncestor(isDialog()), scroll = false)
        eventually("server: the pool is gone") { call("GET", "providers/shared-pools/$pool", owner.token).first == 404 }
    }

    @Test fun step8RotatingAndRemovingTheRunner() {
        val owner = account("owner")
        signIn(owner); settings()
        click(hasText("Runners") and hasClickAction())
        click(hasText("Stack box") and hasClickAction()); await("About This Runner")
        val id = runner(owner).s("id")!!
        click(hasText("Rotate Token…") and hasClickAction())
        click(hasText("Rotate Token") and hasClickAction() and hasAnyAncestor(isDialog()), scroll = false)
        await("Copy")
        capture("live-runner-rotated")
        note("rotated token shown once for runner $id")
        click(hasText("Remove Runner") and hasClickAction())
        click(hasText("Remove Runner") and hasClickAction() and hasAnyAncestor(isDialog()), scroll = false)
        eventually("server: the runner is removed") { runners(owner).none { it.s("id") == id } }
    }

    private fun JsonObject.s(key: String) = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun JsonObject.b(key: String) = (this[key] as? JsonPrimitive)?.booleanOrNull
    private fun JsonObject.i(key: String) = (this[key] as? JsonPrimitive)?.intOrNull
}
