package io.orbitd.android.composer

/**
 * Every sentence of a new account's welcome card (docs/mocks/new-user-onboarding, board 02): on the managed runner's draft, on a bare
 * machine's setup card and on the home of an account with no machine. Names and words are the web's `src/web/src/lib/welcomeCopy.ts`;
 * `WelcomeCopyParityTest` holds each one to that file.
 */
object WelcomeCopy {
    /** The first word of the account's name: "Welcome to Orbit, Mia". Without a name, no comma. */
    fun welcomeTitle(name: String?): String {
        val first = name.orEmpty().trim().split(Regex("\\s+")).first()
        return if (first.isNotEmpty()) "Welcome to Orbit, $first" else "Welcome to Orbit"
    }
    const val WELCOME_LEAD =
        "Orbit gives a coding agent a computer and a task, and keeps the conversation and its results here — on the web and on your phone."

    const val WELCOME_COMPUTER = "A computer to work on"
    const val WELCOME_COMPUTER_MANAGED = "Orbit is starting one for you. You don’t need to install anything."
    const val WELCOME_COMPUTER_OWN = "Connect the computer you want the agent to work on. Run this there:"
    const val WELCOME_OWN_INSTEAD = "Use my own computer instead"
    const val WELCOME_COMPUTER_DONE = "Computer"
    fun welcomeComputerReady(machine: String): String = "$machine is ready"
    const val WELCOME_WAITING_CONNECT = "Waiting for it to connect… this page moves on by itself."
    const val WELCOME_HAVING_TROUBLE = "Having trouble?"

    const val WELCOME_MODEL = "A model to think with"
    const val WELCOME_MODEL_HELP =
        "Sign in with your Claude or ChatGPT subscription, or use an API key. The sign-in stays on that computer."
    const val WELCOME_MODEL_DONE = "Model"
    const val WELCOME_AFTER_COMPUTER = "Opens once the computer is up"
    const val WELCOME_AFTER_STEP_ONE = "Opens after step 1"

    const val WELCOME_FIRST = "Your first message"
    const val WELCOME_FIRST_HELP = "Pick one to try, or write your own below."
    /** Each one finishes in an empty folder within minutes. Picking one only fills the composer. */
    val WELCOME_EXAMPLES = listOf(
        "Build a one-page site that shows today’s weather for a city",
        "Read github.com/owner/repo and explain how it is put together",
        "Write a script that renames my photos by the date they were taken",
    )

    /** The managed draft's foot: a first session can't start yet, can start and wait, or starts now. */
    const val WELCOME_FOOT_WAIT = "Your first message can go once steps 1 and 2 are done."
    const val WELCOME_FOOT_SEND_NOW = "You can send now — it starts as soon as steps 1 and 2 are done."
    const val WELCOME_FOOT_READY = "All set. Send it and the agent starts right away."

    const val WELCOME_PLACEHOLDER = "Describe a task for the agent…"
}
