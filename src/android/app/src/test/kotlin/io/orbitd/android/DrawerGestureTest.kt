package io.orbitd.android

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.ui.OrbitTheme
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
class DrawerGestureTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun slowDragPastHalfwayOpensDrawerWithoutAFling() {
        lateinit var drawer: DrawerState
        compose.activityRule.scenario.onActivity { activity -> activity.setContent {
            OrbitTheme {
                drawer = rememberDrawerState(DrawerValue.Closed)
                ModalNavigationDrawer(drawerState = drawer,
                    drawerContent = { ModalDrawerSheet(Modifier.fillMaxWidth()) { Text("Navigation") } }) {
                    Text("Directory", Modifier.fillMaxSize())
                }
            }
        } }
        compose.onRoot().performTouchInput {
            down(Offset(width * 0.1f, height * 0.5f))
            moveTo(Offset(width * 0.9f, height * 0.5f), delayMillis = 1_500)
            advanceEventTime(500)
            up()
        }
        compose.runOnIdle { assertTrue("Crossing the midpoint must open even with no fling velocity", drawer.isOpen) }
    }
}
