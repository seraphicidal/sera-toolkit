# apps/android (sera-android)

Native Android client for SERA.toolkit (`dev.sera.toolkit`, Kotlin `2.0.21`, Jetpack Compose BOM `2024.12.01`, Material 3, AGP `8.7.3`, Gradle `8.11.1`, minSdk `26`, compileSdk/targetSdk `35`).

## Verified Commands

Run from `apps/android/` with JDK 17 and `ANDROID_HOME` set:

- **Unit tests, lint, and debug APK**: `./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug` (Windows: `.\gradlew.bat :app:testDebugUnitTest --rerun :app:lintDebug :app:assembleDebug --stacktrace`)
- **Debug APK output**: `apps/android/app/build/outputs/apk/debug/app-debug.apk`
- **Local dev server override**: pass `-PSERA_DEFAULT_SERVER_URL=http://10.0.2.2:4000` (defaults to `https://130-61-188-184.sslip.io` via `BuildConfig.DEFAULT_SERVER_URL`).

## Specifics

- **Entry points**:
  - `SeraApplication.kt`: manual DI container wiring `SeraPreferences`, `SeraApiClient`, `DeviceDownloadManager`, `DownloadCoordinator`, `GitHubUpdateChecker`, and Coil's `ImageLoaderFactory` (using the redirect-free `OkHttpClient`).
  - `MainActivity.kt`: edge-to-edge Compose shell with Navigation Compose (`Home`, `Downloads`, `Settings`, `About`), responsive `NavigationBar` / `NavigationRail`, live server health status dot/dialog, and first-download permission prompts (`POST_NOTIFICATIONS` on API 33+, `WRITE_EXTERNAL_STORAGE` on API 26–28).
  - `ShareActivity.kt`: translucent bottom sheet (`excludeFromRecents="true"`, empty `taskAffinity`) handling `ACTION_SEND`, `ACTION_SEND_MULTIPLE` (`text/plain`), and `ACTION_PROCESS_TEXT`, with tracking-parameter stripping, multi-URL queueing, and the **Quick download** bypass toggle.
- **Data, domain, and background pipeline**:
  - `model/Contracts.kt`: `@Serializable` wire models mirroring `@sera/contracts/types` (including `MediaKind.FILE`, `NodeAvailability`, and `FallbackEnumSerializer` so unknown enum values decode to `UNKNOWN`).
  - `data/SeraApiClient.kt`: OkHttp + `okhttp-sse` client with redirects disabled, SSE-to-polling fallback, and `429` + `Retry-After` handling.
  - `data/ResumableTransfer.kt` & `data/DeviceDownloadManager.kt`: suspend HTTP transfers with `Range` + `If-Range` resume, MediaStore `Download/SERA` saving (API 29+) with pending-entry cleanup on cancel, legacy `Download/SERA` saving (API 26–28), and progress/completion notifications with Open and Share actions.
  - `domain/DownloadPipeline.kt`, `worker/DownloadCoordinator.kt`, `worker/DownloadWorker.kt`, `worker/DownloadActionReceiver.kt`: sequential foreground WorkManager (`FOREGROUND_SERVICE_TYPE_DATA_SYNC`) pipeline with single automatic IP-change / `EXPIRED` / `404` recovery, per-task cancellation (`DELETE /api/jobs/:id`), and Wi-Fi-only (`NetworkType.UNMETERED`) support.
  - `data/GitHubUpdateChecker.kt`: manual check against GitHub Releases filtered to `android-v*` tags (opens the release page in browser; no silent install).
  - `domain/*`: `ShareUrlParser` (multi-URL extraction + denylist tracking-parameter stripping), `SelectionLogic`, `TrimValidator`, `HistoryModel`, `HealthModel`, `Formatters`.
  - `ui/*`: `HomeScreen`, `DownloadsScreen`, `SettingsScreen`, `AboutScreen`, `components/MediaPickerComponents`, `theme/Theme` (`SeraPalette` light/dark).
- **Signing & CI**:
  - `app/build.gradle.kts` reads `SERA_VERSION_CODE` / `SERA_VERSION_NAME` and signing credentials from `keystore.properties` or `SERA_KEYSTORE_*` env vars, failing release tasks when signing is absent.
  - CI verification runs in `.github/workflows/ci.yml` (`android` job); releases publish via `.github/workflows/android-release.yml` on `android-v<version>+<code>` tags or manual dispatch.

## Gotchas

- Shares API wire contracts manually via `model/Contracts.kt`; update `Contracts.kt` and `ContractsDecodingTest.kt` when `@sera/contracts` changes.
- `res/xml/network_security_config.xml` allows cleartext HTTP only for `10.0.2.2`, `localhost`, and `127.0.0.1`.
- Never log URLs in release builds; keep `allowBackup="false"`, redirects off, and zero Play Services / analytics SDKs.
