# apps/android (sera-android)

Untracked, in-progress native Android client (Kotlin 2.0.21, Jetpack Compose, AGP 8.7.3, minSdk 26, compileSdk/targetSdk 35, Gradle 8.11.1).

## Commands (unverified)

- Gradle wrapper script (`gradlew` / `gradlew.bat`) is not present in `apps/android/`; build with a local Gradle 8.11.1 installation or Android Studio once UI entry points exist.

## Specifics

- Package `dev.sera.toolkit` (`app/build.gradle.kts`, `versionName = "1.8.0"`).
- Implemented layers:
  - `SeraApplication.kt`: initializes `SeraPreferences`, `SeraApiClient`, and `DeviceDownloadManager`.
  - `model/Contracts.kt`: `@Serializable` models mirroring `@sera/contracts/types` (`SERA_APP_VERSION = "1.8.0"`).
  - `data/SeraApiClient.kt`: OkHttp + `okhttp-sse` client targeting `/health`, `/api/info`, `/api/media/info`, `/api/media/import`, `/api/jobs`, `/api/jobs/:id`, `/api/jobs/:id/events`, and `/api/legal/report`.
  - `data/DeviceDownloadManager.kt`: authenticated-free HTTP streaming downloads to device `SERA/` or `Download/SERA/` (`res/xml/file_paths.xml`).
  - `data/SeraPreferences.kt`: Jetpack DataStore preferences (`DEFAULT_SERVER_URL = "http://10.0.2.2:4000"`).
  - `domain/*`: pure Kotlin ports of web logic (`Formatters`, `HealthModel`, `HistoryModel`, `SelectionLogic`, `ShareUrlParser`, `TrimValidator`).
  - `ui/theme/Theme.kt`: Material 3 light/dark `SeraPalette` matching `apps/web/src/styles/globals.css`.
- `AndroidManifest.xml` registers `MAIN`/`LAUNCHER`, `ACTION_SEND`, `ACTION_SEND_MULTIPLE`, `ACTION_PROCESS_TEXT`, and `FileProvider`. `res/xml/network_security_config.xml` restricts cleartext HTTP to `10.0.2.2`, `localhost`, and `127.0.0.1`.

## Gotchas

- Incomplete app: `AndroidManifest.xml` references `.MainActivity`, but `MainActivity.kt` and Compose UI screens under `ui/` do not exist yet, so the module will not assemble as-is.
- Shares API wire contracts manually via `model/Contracts.kt`; any breaking change in `packages/contracts` must be mirrored here.
