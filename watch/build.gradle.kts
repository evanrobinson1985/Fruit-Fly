// Plugin versions live in settings.gradle.kts (pluginManagement). The Kotlin plugins are
// declared here once so :brain and :app share one Kotlin Gradle plugin; the Android plugin
// is only resolved by :app, so `-PbrainOnly` builds never need the Android SDK.
plugins {
    id("org.jetbrains.kotlin.jvm") apply false
    id("org.jetbrains.kotlin.android") apply false
    id("org.jetbrains.kotlin.plugin.compose") apply false
}
