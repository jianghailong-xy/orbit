package io.orbitd.android

import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import io.orbitd.android.core.BuildIdentity

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
                OrbitShell()
            }
        }
    }
}

@Composable
private fun OrbitShell() {
    val navController = rememberNavController()
    Scaffold { contentPadding ->
        NavHost(
            navController = navController,
            startDestination = "home",
            modifier = Modifier.fillMaxSize().padding(contentPadding),
        ) {
            composable("home") {
                Column(
                    modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineLarge)
                    Text(stringResource(R.string.foundation_title), style = MaterialTheme.typography.titleLarge)
                    Text(stringResource(R.string.foundation_description))
                    Button(onClick = { navController.navigate("build") }) {
                        Text(stringResource(R.string.build_information))
                    }
                }
            }
            composable("build") {
                BuildInformation(onBack = { navController.popBackStack() })
            }
        }
    }
}

@Composable
private fun BuildInformation(onBack: () -> Unit) {
    val identity = BuildIdentity(
        versionName = BuildConfig.VERSION_NAME,
        sourceRevision = BuildConfig.SOURCE_SHA,
        buildType = BuildConfig.BUILD_TYPE,
        isSourceDirty = BuildConfig.SOURCE_DIRTY,
    )
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(stringResource(R.string.build_information), style = MaterialTheme.typography.headlineMedium)
        Button(onClick = onBack) { Text(stringResource(R.string.back)) }
        IdentityField(stringResource(R.string.package_label), BuildConfig.APPLICATION_ID)
        IdentityField(stringResource(R.string.build_label), identity.displayId)
        IdentityField(stringResource(R.string.source_sha_label), identity.sourceRevision)
        IdentityField(
            stringResource(R.string.source_tree_label),
            stringResource(if (identity.isSourceDirty) R.string.source_modified else R.string.source_clean),
        )
        IdentityField(stringResource(R.string.device_label), "${Build.MANUFACTURER} ${Build.MODEL}")
        IdentityField(
            stringResource(R.string.android_label),
            stringResource(R.string.android_version, Build.VERSION.RELEASE, Build.VERSION.SDK_INT),
        )
        IdentityField(stringResource(R.string.os_build_label), Build.DISPLAY)
    }
}

@Composable
private fun IdentityField(label: String, value: String) {
    Column {
        Text(label, style = MaterialTheme.typography.labelLarge)
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}
