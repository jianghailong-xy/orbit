package io.orbitd.android

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.navigation.OrbitDrawerShell
import io.orbitd.android.navigation.OrbitDrawerState
import io.orbitd.android.navigation.rememberOrbitDrawerState
import io.orbitd.android.ui.OrbitTheme
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.junit.Assert.assertFalse
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

    @Test fun slowDragPastHalfwayOpensDrawerWithoutAFling() = slowDrag(0.9f, shouldOpen = true)
    @Test fun slowDragBeforeHalfwayKeepsDrawerClosed() = slowDrag(0.45f, shouldOpen = false)

    @Test fun closedDrawerIsOffScreenAndAPressOnThePagePeekClosesIt() {
        val drawer = shell()
        compose.onNodeWithText("Navigation").assertIsNotDisplayed()
        compose.onNodeWithTag("drawer-scrim").assertDoesNotExist()
        compose.runOnIdle { scope.launch { drawer.open() } }
        compose.waitForIdle()
        compose.runOnIdle { assertTrue(drawer.isOpen) }
        compose.onNodeWithText("Navigation").assertIsDisplayed()
        compose.onNodeWithTag("drawer-scrim").performClick()
        compose.waitForIdle()
        compose.runOnIdle { assertFalse(drawer.isOpen) }
        compose.onNodeWithText("Navigation").assertIsNotDisplayed()
    }

    private lateinit var scope: CoroutineScope

    private fun shell(): OrbitDrawerState {
        lateinit var drawer: OrbitDrawerState
        compose.activityRule.scenario.onActivity { activity -> activity.setContent {
            OrbitTheme {
                drawer = rememberOrbitDrawerState()
                scope = rememberCoroutineScope()
                OrbitDrawerShell(drawer, drawer = { Text("Navigation") }) {
                    Text("Directory", Modifier.fillMaxSize())
                }
            }
        } }
        compose.waitForIdle()
        return drawer
    }

    private fun slowDrag(endFraction: Float, shouldOpen: Boolean) {
        val drawer = shell()
        compose.onRoot().performTouchInput {
            down(Offset(width * 0.1f, height * 0.5f))
            moveTo(Offset(width * endFraction, height * 0.5f), delayMillis = 1_500)
            advanceEventTime(500)
            up()
        }
        compose.runOnIdle {
            if (shouldOpen) assertTrue("Crossing the midpoint must open even with no fling velocity", drawer.isOpen)
            else assertFalse("Releasing before the midpoint must keep the drawer closed", drawer.isOpen)
        }
    }
}
