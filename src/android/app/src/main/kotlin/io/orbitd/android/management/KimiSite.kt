package io.orbitd.android.management

import kotlinx.serialization.json.JsonObject

/**
 * KimiSite (web KIMI_SITE, RunnerSignIn.tsx): Kimi Code's two sign-in sites. kimi.com and kimi.ai keep separate accounts, and
 * left to itself the CLI signs in on the site its installer came from — so a Kimi sign-in starts by naming the site the account
 * is on, and each step of it says which site it is on. KimiAccountsTest holds the words to the web's.
 */
internal enum class KimiSite(val region: String, val domain: String, val place: String) {
    MAINLAND_CN("mainland-cn", "kimi.com", "Mainland China"),
    GLOBAL("global", "kimi.ai", "International");

    val other get() = if (this == GLOBAL) MAINLAND_CN else GLOBAL
    val openPage get() = "Open the $domain sign-in page"
    /** The device code's one press — copy it, open the page it goes into — naming the site. */
    val copyCodeAndOpen get() = "Copy Code & Open $domain"
    val enterCode get() = "Sign in with your $domain account there, then enter this one-time code:"
    /** The same step on a card adding an account: the account wanted is the new one, on this site. */
    val enterCodeAdding get() = "Sign in with the $domain account you are adding, then enter this one-time code:"
    val useInstead get() = "Use $domain instead"

    companion object {
        /** What a runner declares when it signs Kimi in on the site a start names (shared KIMI_LOGIN_REGION_V1). One that
         * doesn't runs a bare `kimi login`. */
        const val LOGIN_REGION = "kimi-login-region/v1"
        const val QUESTION = "Which Kimi account are you signing in with?"
        const val SEPARATE_ACCOUNTS = "The two sites keep separate accounts — pick the one you signed up on."
        const val CURRENT = "Current"

        /** The site a `kimiRegion` names: `mainland-cn` is kimi.com, `global` kimi.ai; null for anything else. */
        fun of(region: String?) = entries.firstOrNull { it.region == region }

        /** The site a device-flow page belongs to, read off the address the CLI printed rather than the site asked for: it is
         * the page the user is about to sign in on. Null for any other host. */
        fun ofUrl(url: String?): KimiSite? {
            val host = url?.let { runCatching { java.net.URI(it).host }.getOrNull() }?.lowercase() ?: return null
            if (host == "kimi.ai" || host.endsWith(".kimi.ai")) return GLOBAL
            if (host == "kimi.com" || host.endsWith(".kimi.com")) return MAINLAND_CN
            return null
        }

        /** Whether [runner] can be told the site. */
        fun choosable(runner: JsonObject) = LOGIN_REGION in runner.strings("capabilities")

        /** What a press on [site] names to [runner]. Both sites can always be pressed: kimi.ai is named always, kimi.com only
         * where the runner can be told a site. One too old to be told signs in where its CLI decides — kimi.com, on an install
         * Orbit made — so kimi.com goes to it unnamed, and the server refuses it kimi.ai in words that say to update it. */
        fun named(site: KimiSite, runner: JsonObject) = site.takeIf { choosable(runner) || it == GLOBAL }

        /** The site a sign-in card marks Current: that of the login it signs in again — the account's own, Default's being the
         * engine's — and none on a card adding an account, which has no login yet (web RunnerSignIn `currentSite`). */
        fun current(runner: JsonObject, account: String?, adding: Boolean): KimiSite? {
            if (adding) return null
            val health = runner.list("engines").firstOrNull { it.str("engine") == "kimi" } ?: return null
            if (account == null || account == EngineAccounts.DEFAULT) return of(health.str("kimiRegion"))
            return of(health.list("accounts").firstOrNull { it.str("id") == account }?.str("kimiRegion"))
        }
    }
}
