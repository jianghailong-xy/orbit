package io.orbitd.android.push

import android.app.Application
import android.content.Context
import androidx.test.runner.AndroidJUnitRunner
import io.orbitd.android.OrbitApplication
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/** This runner exists only in the test APK. It substitutes token acquisition, never HTTP or UI. */
class PushTestRunner : AndroidJUnitRunner() {
    override fun newApplication(cl: ClassLoader, className: String, context: Context): Application =
        super.newApplication(cl, PushTestApplication::class.java.name, context)
}

class PushTestApplication : OrbitApplication() {
    private val pushScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    override fun createPush() = PushController(this, session, realtime, pushScope, object : PushTokenSource {
        override val available = true
        override fun requestToken(receive: (String) -> Unit) = receive(listOf("a10", "controlled", "device", "token").joinToString("-"))
    })
}
