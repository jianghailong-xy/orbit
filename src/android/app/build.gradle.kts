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
        commandLine("git", "status", "--porcelain", "--", "src/android", ".github/workflows/android.yml")
    }.standardOutput.asText.map { it.isNotBlank() },
).get()

android {
    namespace = "io.orbitd.android"
    compileSdk = 36
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "io.orbitd.android"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0-a06"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        buildConfigField("String", "SOURCE_SHA", "\"$sourceSha\"")
        buildConfigField("boolean", "SOURCE_DIRTY", sourceDirty.toString())
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
        }
    }

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
