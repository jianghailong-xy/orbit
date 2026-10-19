package io.orbitd.android.directory

import android.provider.Settings
import android.view.KeyEvent
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.MainActivity
import java.io.File
import org.junit.Assert.assertEquals

/** Key and actual edge-swipe runs are separate evidence; neither asserts predictive animation. */
internal fun sendBackInput(activity: MainActivity, trace: File) {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val input = InstrumentationRegistry.getArguments().getString("a05_back_input") ?: "key"
    require(input in setOf("key", "gesture"))
    if (input == "gesture") {
        val mode = Settings.Secure.getInt(activity.contentResolver, "navigation_mode", -1)
        assertEquals("Edge Back requires an actual gestural navigation configuration", 2, mode)
        val view = activity.window.decorView
        val x = view.width - 1
        val imeBottom = androidx.core.view.ViewCompat.getRootWindowInsets(view)
            ?.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime())?.bottom ?: 0
        val y = (view.height - imeBottom) / 2
        val endX = view.width / 2
        trace.appendText("input=edge-swipe navigation_mode=$mode imeBottom=$imeBottom from=$x,$y to=$endX,$y duration_ms=350\n")
        instrumentation.uiAutomation.executeShellCommand("input touchscreen swipe $x $y $endX $y 350").use {
            android.os.ParcelFileDescriptor.AutoCloseInputStream(it).readBytes()
        }
    } else {
        trace.appendText("input=KEYCODE_BACK\n")
        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
    }
    instrumentation.waitForIdleSync()
    instrumentation.uiAutomation.waitForIdle(500, 5_000)
}
