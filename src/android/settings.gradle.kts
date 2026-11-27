pluginManagement {
    repositories {
        google()
        maven("https://maven-central.storage-download.googleapis.com/maven2/")
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        // Google's mirror of Maven Central first: on 2026-11-23 Maven Central answered GitHub's runners 429 Too Many
        // Requests for Robolectric's 152 MB nativeruntime jar, failing release v0.1.261-beta.76's Android job twice. An
        // artifact the mirror lacks falls through to Maven Central itself.
        maven("https://maven-central.storage-download.googleapis.com/maven2/")
        mavenCentral()
    }
}

rootProject.name = "OrbitAndroid"
include(":app", ":core")
