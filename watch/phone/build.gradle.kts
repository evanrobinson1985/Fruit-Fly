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
        // Every CI build is a newer version (the in-app updater compares these): the run number.
        val run = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull()
        versionCode = if (run != null) 100 + run else 14
        versionName = if (run != null) "0.9.$run" else "0.9-dev"
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
        // Only frogs-original.glb (the detailed models, re-rigged at load) is used; the other frog files stay in the repo.
        exclude("assets/frogs.glb", "assets/frogs-animated.glb", "assets/frogs-rigged.glb", "assets/*.md")
        // The full-resolution scenery (env/hd: the pond's and the grass's original textures) is for computers.
        exclude("assets/env/hd/**")
    }
    from("vendor") { into("vendor") }
    doLast { // Fail the build if any Three.js module required by the phone page is missing.
        val requiredModules = listOf(
            "vendor/three/build/three.module.js",
            "vendor/three/examples/jsm/controls/OrbitControls.js",
            "vendor/three/examples/jsm/utils/BufferGeometryUtils.js",
            "vendor/three/examples/jsm/utils/SkeletonUtils.js",
            "vendor/three/examples/jsm/loaders/GLTFLoader.js",
            "vendor/three/examples/jsm/loaders/KTX2Loader.js",
            "vendor/three/examples/jsm/libs/meshopt_decoder.module.js",
            "vendor/three/examples/jsm/libs/basis/basis_transcoder.wasm",
        )
        requiredModules.forEach { path ->
            check(file(path).isFile) { "Required phone Three.js module is missing: phone/$path" }
        }
    }
}
tasks.named("preBuild") { dependsOn(copySite) }

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
}
