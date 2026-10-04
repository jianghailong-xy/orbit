package io.orbitd.android.core

data class BuildIdentity(
    val versionName: String,
    val sourceRevision: String,
    val buildType: String,
    val isSourceDirty: Boolean,
) {
    init {
        require(sourceRevision.matches(Regex("[0-9a-f]{40}"))) {
            "A full Git SHA is required to identify this build"
        }
    }

    val displayId: String
        get() = "$versionName-$buildType (${sourceRevision.take(12)}${if (isSourceDirty) "-dirty" else ""})"
}
