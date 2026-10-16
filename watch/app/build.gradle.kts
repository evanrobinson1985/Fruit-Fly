plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "fly.watch"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.evanrobinson1985.feedthefly"
        minSdk = 30           // Wear OS 3+
        targetSdk = 35
        versionCode = 3
        versionName = "0.3.0"
    }

    // A fixed, public key for sideloading (watch/sideload.keystore), so new builds install
    // over old ones and keep the pet. Not for Play Store distribution.
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
    // Engine, sound and scene drawing are shared with the phone app (../phone).
    sourceSets.getByName("main").java.srcDir("../common/kotlin")
}

dependencies {
    implementation(project(":brain"))
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation(platform("androidx.compose:compose-bom:2024.10.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.wear.compose:compose-material:1.4.0")
    implementation("androidx.wear.compose:compose-foundation:1.4.0")
    implementation("androidx.wear:wear-input:1.1.0")                 // keyboard / voice entry for the fly's name
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}
