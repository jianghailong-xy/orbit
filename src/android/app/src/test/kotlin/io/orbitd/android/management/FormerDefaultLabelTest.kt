package io.orbitd.android.management

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * After Set as default, the account that was the Default sits in an added folder. "Default" is that slot's label, not a name, so the
 * server serves it as the former Default (`formerDefault`, with the `email` Claude reported): it is called by its email, else
 * "Former default", unless the owner named it (CodexAccounts.label, web accountNameOf).
 */
class FormerDefaultLabelTest {
    private fun account(json: String): JsonObject = Json.parseToJsonElement(json).jsonObject
    private val accounts = listOf(
        account("""{"id":"default","name":"Work","home":"/root/.claude","auth":"yes"}"""),
        account("""{"id":"3fa91c2e","home":"/h/3fa91c2e","auth":"yes","formerDefault":true,"email":"me@home.example"}"""),
        account("""{"id":"c0ffee42","home":"/h/c0ffee42","auth":"yes","formerDefault":true}"""),
        account("""{"id":"5e1fa7b2","name":"Personal","home":"/h/5e1fa7b2","auth":"yes","formerDefault":true,"email":"me@home.example"}"""),
        account("""{"id":"0dc2eb6d","home":"/h/0dc2eb6d","auth":"yes"}"""),
    )

    @Test fun aFormerDefaultIsNamedByItsEmailElseFormerDefaultUnlessTheOwnerNamedIt() {
        assertEquals("Work", RunnerPage.accountLabel("default", accounts))
        assertEquals("me@home.example", RunnerPage.accountLabel("3fa91c2e", accounts))
        assertEquals("Former default", RunnerPage.accountLabel("c0ffee42", accounts))
        assertEquals("Personal", RunnerPage.accountLabel("5e1fa7b2", accounts))
        assertEquals("Account 0dc2eb6d", RunnerPage.accountLabel("0dc2eb6d", accounts))
        assertEquals("Default", RunnerPage.accountLabel("default", listOf(account("""{"id":"default","home":"/root/.claude","auth":"yes"}"""))))
    }
}
