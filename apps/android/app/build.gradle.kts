import org.gradle.api.GradleException
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

val keystoreProps = Properties().apply {
    val propsFile = rootProject.file("keystore.properties")
    if (propsFile.isFile) {
        propsFile.inputStream().use { load(it) }
    }
}

fun signingValue(propKey: String, envKey: String): String? {
    return keystoreProps.getProperty(propKey)?.trim()?.takeIf { it.isNotEmpty() }
        ?: System.getenv(envKey)?.trim()?.takeIf { it.isNotEmpty() }
}

fun buildConfigOption(propKeys: List<String>, envKeys: List<String>): String? {
    for (key in propKeys) {
        val value = providers.gradleProperty(key).orNull?.trim()
        if (!value.isNullOrEmpty()) return value
    }
    for (key in envKeys) {
        val value = System.getenv(key)?.trim()
        if (!value.isNullOrEmpty()) return value
    }
    return null
}

fun escapeBuildConfigString(raw: String): String {
    val escaped = raw
        .replace("\\", "\\\\")
        .replace("\"", "\\\"")
    return "\"$escaped\""
}

val releaseStorePath = signingValue("storeFile", "SERA_KEYSTORE_PATH")
val releaseStorePassword = signingValue("storePassword", "SERA_KEYSTORE_PASSWORD")
val releaseKeyAlias = signingValue("keyAlias", "SERA_KEY_ALIAS")
val releaseKeyPassword = signingValue("keyPassword", "SERA_KEY_PASSWORD")
val hasReleaseSigning = releaseStorePath != null &&
    releaseStorePassword != null &&
    releaseKeyAlias != null &&
    releaseKeyPassword != null &&
    file(releaseStorePath).isFile

val defaultServerUrl = buildConfigOption(
    listOf("SERA_DEFAULT_SERVER_URL"),
    listOf("SERA_DEFAULT_SERVER_URL"),
) ?: "https://130-61-188-184.sslip.io"

android {
    namespace = "dev.sera.toolkit"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.sera.toolkit"
        minSdk = 26
        targetSdk = 35
        versionCode = buildConfigOption(
            listOf("SERA_VERSION_CODE", "SERA_ANDROID_VERSION_CODE"),
            listOf("SERA_ANDROID_VERSION_CODE", "SERA_VERSION_CODE"),
        )?.toIntOrNull() ?: 1
        versionName = buildConfigOption(
            listOf("SERA_VERSION_NAME", "SERA_ANDROID_VERSION_NAME"),
            listOf("SERA_ANDROID_VERSION_NAME", "SERA_VERSION_NAME"),
        ) ?: "2.0.0"

        buildConfigField("String", "DEFAULT_SERVER_URL", escapeBuildConfigString(defaultServerUrl))

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(releaseStorePath!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

tasks.matching {
    it.name.endsWith("Release") &&
        (it.name.startsWith("assemble") || it.name.startsWith("bundle") || it.name.startsWith("package"))
}.configureEach {
    val signingReady = hasReleaseSigning
    doFirst {
        if (!signingReady) {
            throw GradleException("Release signing credentials are required via keystore.properties or SERA_KEYSTORE_* environment variables.")
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    implementation(libs.androidx.material.icons.extended)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.media3.exoplayer)
    implementation(libs.androidx.media3.ui)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.okhttp.sse)
    implementation(libs.coil.compose)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)

    debugImplementation(libs.androidx.ui.tooling)
}
