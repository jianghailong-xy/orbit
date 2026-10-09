package io.orbitd.android.auth

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import androidx.browser.customtabs.CustomTabsService
import androidx.core.net.toUri
import io.orbitd.android.MainActivity

/**
 * The browser half of Google sign-in (docs/google-sign-in-design.md §3.1, §8.3), out: a Google sign-in's
 * /start in a Custom Tab — of the default browser when it has them, else of another browser that does —
 * or, with no such browser on the device, in the default browser. False when there is no browser at all.
 */
fun openInSignInBrowser(activity: Activity, url: String): Boolean {
    val uri = url.toUri()
    val customTabs = Intent(CustomTabsService.ACTION_CUSTOM_TABS_CONNECTION)
    val providers = if (Build.VERSION.SDK_INT >= 33) {
        activity.packageManager.queryIntentServices(customTabs, PackageManager.ResolveInfoFlags.of(0))
    } else {
        @Suppress("DEPRECATION") activity.packageManager.queryIntentServices(customTabs, 0)
    }.map { it.serviceInfo.packageName }
    val browser = CustomTabsClient.getPackageName(activity, providers)
    return try {
        if (browser != null) {
            CustomTabsIntent.Builder().build().apply { intent.setPackage(browser) }.launchUrl(activity, uri)
        } else {
            activity.startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        }
        true
    } catch (_: ActivityNotFoundException) {
        false
    }
}

/**
 * ...and back: the browser opens `orbit://auth/google` here (§4.2). The address goes to the existing
 * MainActivity, closing the browser tab above it, and this activity ends without showing anything. Its
 * empty task affinity keeps it from rooting a task, so the launcher still returns to the one it joins.
 */
class GoogleSignInRedirectActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        startActivity(Intent(this, MainActivity::class.java).setData(intent.data).addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        finish()
    }
}
