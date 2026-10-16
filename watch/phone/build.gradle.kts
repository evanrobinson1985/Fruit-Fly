// Feed the Fly for Android phones: the watch game's brain, world, sprites and scenery
// (shared from ../app and ../common) with a phone-sized portrait layout.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "fly.phone"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.evanrobinson1985.feedthefly.phone"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.2.0"
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
    buildFeatures { compose = true }
    androidResources { noCompress += "bin" }
    sourceSets.getByName("main") {
        java.srcDir("../common/kotlin")
        assets.srcDir("../app/src/main/assets")   // brain, sprites, scenery
        res.srcDir("../app/src/main/res")         // name and icon
    }
}

dependencies {
    implementation(project(":brain"))
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation(platform("androidx.compose:compose-bom:2024.10.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}
