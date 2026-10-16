// Feed the Fly for Android phones: the website's 3D game mode (web/index.html?game) in a
// WebView, served from the APK by a small local web server, so it is the same fly, grass
// arena, sky and 165,122-neuron brain as the website, and works offline.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "fly.phone"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.evanrobinson1985.feedthefly.phone"
        minSdk = 26
        targetSdk = 35
        versionCode = 3
        versionName = "0.3.1"
    }

    // Same public sideload key as the watch app (see ../app/build.gradle.kts).
    signingConfigs {
        create("sideload") {
            storeFile = rootProject.file("sideload.keystore")
            storePassword = "feedthefly"
            keyAlias = "sideload"
            keyPassword = "feedthefly"
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("sideload")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    sourceSets.getByName("main") {
        assets.srcDir(layout.buildDirectory.dir("site"))    // the website, as web/
        res.srcDir("../app/src/main/res")                  // name and icon
    }
}

// The website (page, scripts, connectome, fly model) and three.js, copied into the APK.
val copySite by tasks.registering(Copy::class) {
    into(layout.buildDirectory.dir("site/web"))
    from("../../web") {
        include("index.html", "src/**", "assets/**")
        exclude("assets/NOTICE.md")
    }
    from("vendor") { into("vendor") }
}
tasks.named("preBuild") { dependsOn(copySite) }

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
}
