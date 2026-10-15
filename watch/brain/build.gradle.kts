import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("org.jetbrains.kotlin.jvm")
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    testImplementation(kotlin("test"))
}

tasks.test {
    useJUnitPlatform()
    // Optional screen previews (see PreviewRender.kt): -PpreviewDir=... -PspriteDir=...
    providers.gradleProperty("previewDir").orNull?.let { systemProperty("previewDir", it) }
    providers.gradleProperty("spriteDir").orNull?.let { systemProperty("spriteDir", it) }
    maxHeapSize = "2g"
    testLogging { events("passed", "failed"); showStandardStreams = true }
}
