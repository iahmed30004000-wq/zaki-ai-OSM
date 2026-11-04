import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/*
 * SIGNING COMES FROM CI ONLY.
 *
 * The workflow decodes the keystore secret to a temporary file and passes its
 * path in ANDROID_KEYSTORE_FILE. Without it the release APK is built unsigned
 * (and the debug APK, signed with the runner's throwaway debug key, is what can
 * be installed). No key, password or alias is ever written in this repository.
 */
val keystoreFile: String? = System.getenv("ANDROID_KEYSTORE_FILE")?.takeIf { it.isNotBlank() }

android {
    namespace = "io.zakiai.callhelper"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.zakiai.callhelper"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    signingConfigs {
        if (keystoreFile != null) {
            create("release") {
                storeFile = file(keystoreFile)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystoreFile != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

// No runtime dependencies on purpose: the platform's own Views, HttpURLConnection
// and org.json do everything this app needs, and nothing here can phone home.
// JUnit is for the JVM tests only and never reaches the APK.
dependencies {
    testImplementation("junit:junit:4.13.2")
}
