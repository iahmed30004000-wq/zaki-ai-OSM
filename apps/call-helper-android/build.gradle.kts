// The versions are pinned here once. AGP 8.7.3 + Kotlin 2.1.0 on Gradle 8.11.1
// (the workflow pins the Gradle version, since no wrapper jar is committed).
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.1.0" apply false
}
