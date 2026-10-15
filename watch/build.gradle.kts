// Plugin versions live in settings.gradle.kts (pluginManagement), so building only
// :brain never needs the Android Gradle plugin. (Declaring the Kotlin plugins here
// instead would hide the Android plugin's classes from them and break :app.)
