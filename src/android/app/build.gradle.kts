import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

val sourceSha = providers.gradleProperty("orbitSourceSha").orElse(
    providers.exec {
        workingDir(rootDir.resolve("../.."))
        commandLine("git", "rev-parse", "HEAD")
    }.standardOutput.asText.map { it.trim() },
).get()
require(sourceSha.matches(Regex("[0-9a-f]{40}"))) { "orbitSourceSha must be a full Git SHA" }

val sourceDirty = providers.gradleProperty("orbitSourceDirty").map { it.toBooleanStrict() }.orElse(
    providers.exec {
        workingDir(rootDir.resolve("../.."))
        commandLine("git", "status", "--porcelain", "--", "src/android", ".github/workflows/android.yml", ".github/workflows/android-release.yml")
    }.standardOutput.asText.map { it.isNotBlank() },
).get()

val releaseVersionName = providers.environmentVariable("ORBIT_ANDROID_VERSION_NAME")
    .orElse(providers.gradleProperty("orbitVersionName")).get()
require(releaseVersionName.length <= 32 && releaseVersionName.matches(Regex("[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?"))) {
    "Version must be X.Y.Z or X.Y.Z-suffix, at most 32 characters (client telemetry limit)"
}
val releaseVersionCode = providers.environmentVariable("ORBIT_ANDROID_VERSION_CODE")
    .orElse(providers.gradleProperty("orbitVersionCode")).get().toInt()
require(releaseVersionCode in 1..2100000000) { "Version code must be between 1 and 2100000000" }
val packageId = providers.environmentVariable("ORBIT_ANDROID_APPLICATION_ID").orElse("io.orbitd.android").get()
require(packageId.matches(Regex("[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*)+"))) { "Invalid Android application ID" }

// Environment only: no credential files or passwords in Gradle properties or source control.
val signingValues = listOf("KEYSTORE_PATH", "STORE_PASSWORD", "KEY_ALIAS", "KEY_PASSWORD").associateWith {
    providers.environmentVariable("ORBIT_ANDROID_$it").orNull
}
val hasSigning = signingValues.values.any { it != null }
require(!hasSigning || signingValues.values.all { !it.isNullOrBlank() }) { "All four Android signing environment values are required" }

android {
    namespace = "io.orbitd.android"
    compileSdk = 36
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = packageId
        minSdk = 29
        targetSdk = 36
        versionCode = releaseVersionCode
        versionName = releaseVersionName
        testInstrumentationRunner = providers.gradleProperty("orbitTestRunner")
            .orElse("androidx.test.runner.AndroidJUnitRunner").get()

        buildConfigField("String", "SOURCE_SHA", "\"$sourceSha\"")
        buildConfigField("boolean", "SOURCE_DIRTY", sourceDirty.toString())
        // Firebase client values are supplied per build, independently of signing/release settings.
        // An empty or mismatched configuration keeps push disabled; no credential is required by CI.
        mapOf("APP_ID" to "AppId", "API_KEY" to "ApiKey", "PROJECT_ID" to "ProjectId",
            "SENDER_ID" to "SenderId", "ANDROID_PACKAGE" to "AndroidPackage").forEach { (name, property) ->
            val value = providers.environmentVariable("ORBIT_ANDROID_FIREBASE_$name")
                .orElse(providers.gradleProperty("orbitFirebase$property")).orElse("").get()
            require(value.matches(Regex("[A-Za-z0-9_.:-]*"))) { "Invalid Firebase client configuration: $name" }
            buildConfigField("String", "FIREBASE_$name", "\"$value\"")
        }
    }

    signingConfigs {
        if (hasSigning) {
            create("internalRelease") {
                storeFile = file(signingValues.getValue("KEYSTORE_PATH")!!)
                storePassword = signingValues.getValue("STORE_PASSWORD")
                keyAlias = signingValues.getValue("KEY_ALIAS")
                keyPassword = signingValues.getValue("KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
        }
        release {
            if (hasSigning) signingConfig = signingConfigs.getByName("internalRelease")
        }
    }

    // Opt-in for upgrade verification against a non-debuggable, test-signed release APK.
    testBuildType = providers.gradleProperty("orbitTestBuildType").orElse("debug").get()

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions.unitTests.isIncludeAndroidResources = true
}

kotlin {
    jvmToolchain(21)
    compilerOptions.jvmTarget.set(JvmTarget.JVM_17)
}

dependencies {
    implementation(project(":core"))
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    // Parse CommonMark/GFM into native selectable Compose content; no HTML/WebView runtime.
    listOf("commonmark", "commonmark-ext-gfm-tables", "commonmark-ext-gfm-strikethrough",
        "commonmark-ext-task-list-items", "commonmark-ext-autolink").forEach {
        implementation("org.commonmark:$it:${libs.versions.commonmark.get()}")
    }
    implementation(libs.okhttp)
    implementation("com.google.firebase:firebase-messaging:25.0.1")
    implementation("androidx.work:work-runtime-ktx:2.10.1")

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.compose.ui.test.junit4)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    androidTestImplementation(libs.okhttp.mockwebserver)
}
