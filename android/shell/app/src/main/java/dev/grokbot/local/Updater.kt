package dev.grokbot.local

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Base64
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.concurrent.Executors

/**
 * Verifies signed release manifests (ECDSA P-256 / SHA256withECDSA) from build.json's updateUrl,
 * downloads verified APK updates, checks APK SHA-256 & matching v2 signing certificate, and launches
 * the system package installer.
 */
class Updater(private val app: GrokBotApp) {
    private val prefs = app.getSharedPreferences("updater", Context.MODE_PRIVATE)
    private val executor = Executors.newSingleThreadExecutor { Thread(it, "grokbot-updater").apply { isDaemon = true } }
    private val stateLock = Any()

    private var updateUrl: String = ""
    private var updatePublicKey: String = ""
    private var builtAt: String = ""
    @Volatile private var pendingInstallApk: File? = null
    @Volatile private var currentState: JSONObject
    @Volatile private var checking = false
    @Volatile private var checkGeneration = 0L

    init {
        loadBuildMetadata()
        currentState = if (isEnabled()) {
            val cached = findReadyCachedApk(track)
            if (cached != null) {
                pendingInstallApk = cached.first
                JSONObject().put("type", "ready").put("version", cached.second)
            } else {
                JSONObject().put("type", "idle")
            }
        } else {
            JSONObject().put("type", "disabled").put("reason", "disabled-by-env")
        }
        cleanupOldUpdates()
    }

    private fun loadBuildMetadata() {
        val raw = runCatching {
            app.assets.open("web/client/build.json").use { it.readBytes().decodeToString() }
        }.getOrNull() ?: return
        val json = runCatching { JSONObject(raw) }.getOrNull() ?: return
        builtAt = json.optString("builtAt", "")
        val rawUrl = json.optString("updateUrl", "").trim().trimEnd('/')
        val rawKey = json.optString("updatePublicKey", "").trim()
        if (isValidUpdateOrigin(rawUrl) && parseEcPublicKey(rawKey) != null) {
            updateUrl = rawUrl
            updatePublicKey = rawKey
        }
    }

    fun isEnabled(): Boolean = updateUrl.isNotEmpty() && updatePublicKey.isNotEmpty()

    var track: String
        get() = prefs.getString("track", "stable")?.takeIf { it in VALID_TRACKS } ?: "stable"
        private set(value) { prefs.edit().putString("track", value).apply() }

    var autoUpdateWhenIdle: Boolean
        get() = prefs.getBoolean("autoUpdateWhenIdle", false)
        private set(value) { prefs.edit().putBoolean("autoUpdateWhenIdle", value).apply() }

    fun statusJson(): JSONObject {
        val enabled = isEnabled()
        val obj = JSONObject()
            .put("state", JSONObject(currentState.toString()))
            .put("delivery", if (enabled) "in-app" else "package-manager")
            .put("currentVersion", BuildConfig.VERSION_NAME)
            .put("currentTrack", track)
            .put("trackOverride", JSONObject.NULL)
            .put("buildDefaultTrack", if (enabled) "stable" else JSONObject.NULL)
            .put("availableTracks", JSONArray(if (enabled) listOf("stable", "nightly") else listOf("stable")))
            .put("isTrackManagedByPolicy", !enabled)
            .put("isBelowMinimumVersion", false)
            .put("autoUpdateWhenIdle", autoUpdateWhenIdle)
        if (builtAt.isNotEmpty() && runCatching { java.time.Instant.parse(builtAt) }.isSuccess) {
            obj.put("currentBuiltAt", builtAt)
        }
        return obj
    }

    fun setTrack(nextTrack: String): JSONObject {
        require(nextTrack in VALID_TRACKS) { "Invalid track" }
        val status: JSONObject
        synchronized(stateLock) {
            checkGeneration++
            checking = false
            track = nextTrack
            val cached = if (isEnabled()) findReadyCachedApk(nextTrack) else null
            pendingInstallApk = cached?.first
            currentState = if (!isEnabled()) {
                currentState
            } else if (cached != null) {
                JSONObject().put("type", "ready").put("version", cached.second)
            } else {
                JSONObject().put("type", "idle")
            }
            status = statusJson()
        }
        emitStatus(status)
        return status
    }

    fun setAutoUpdateWhenIdle(enabled: Boolean): JSONObject {
        autoUpdateWhenIdle = enabled
        val status = statusJson()
        emitStatus(status)
        return status
    }

    fun checkForUpdatesAsyncIfAuto() {
        if (!isEnabled() || !autoUpdateWhenIdle) return
        checkForUpdates(background = true)
    }

    fun checkForUpdates(background: Boolean = false): JSONObject {
        if (!isEnabled()) return statusJson()
        val gen: Long
        val activeTrack: String
        synchronized(stateLock) {
            if (checking) return statusJson()
            checking = true
            gen = ++checkGeneration
            activeTrack = track
            setState(JSONObject().put("type", "checking"))
        }
        executor.execute {
            try {
                performCheckAndStage(gen, activeTrack)
            } catch (error: UpdateFailure) {
                Log.w(TAG, "Update check failed (${error.kind}): ${error.message}")
                synchronized(stateLock) {
                    if (gen == checkGeneration) setFailure(error.kind, error.message ?: "Update failed")
                }
            } catch (error: Exception) {
                Log.w(TAG, "Update check error: ${error.message}")
                val kind = if (error is IOException) "feed_fetch_failed" else "update_failed"
                synchronized(stateLock) {
                    if (gen == checkGeneration) setFailure(kind, error.message ?: "Update failed")
                }
            } finally {
                synchronized(stateLock) {
                    if (gen == checkGeneration) checking = false
                }
            }
        }
        return statusJson()
    }

    fun quitAndInstall(expectedVersion: String? = null): String {
        val activeTrack = track
        val file = pendingInstallApk ?: findReadyCachedApk(activeTrack)?.first
            ?: throw IllegalStateException(Text.t(app, "没有已准备好的安装包，请先检查更新。", "No staged update ready to install."))
        if (!file.isFile) throw IllegalStateException(Text.t(app, "更新包不存在，请重新检查更新。", "Update package missing."))
        val actualVersion = verifyDownloadedApk(file)
        val want = expectedVersion?.takeIf { it.isNotEmpty() }
        if (want != null && actualVersion != want) {
            return "superseded"
        }
        pendingInstallApk = file

        if (!app.packageManager.canRequestPackageInstalls()) {
            val permIntent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${app.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            (app.host ?: app).startActivity(permIntent)
            throw IllegalStateException(Text.t(
                app,
                "请先允许 Grok Bot 安装更新包，完成后再点击安装更新。",
                "Allow Grok Bot to install unknown apps, then tap Restart to Update again.",
            ))
        }
        val uri = ApkFileProvider.uriFor(app, file)
        val installIntent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        (app.host ?: app).startActivity(installIntent)
        return "requested"
    }

    private fun performCheckAndStage(expectedGen: Long, targetTrack: String) {
        val pubKey = parseEcPublicKey(updatePublicKey) ?: throw UpdateFailure("installer_signature_invalid", "Invalid embedded public key")
        val feedFile = if (targetTrack == "stable") "android.json" else "android-$targetTrack.json"
        val feedUrl = "$updateUrl/$feedFile?t=${System.currentTimeMillis()}"
        val manifestText = fetchText(feedUrl)
        if (expectedGen != checkGeneration) return
        val manifest = try {
            JSONObject(manifestText)
        } catch (_: Exception) {
            throw UpdateFailure("feed_malformed", "Malformed update manifest")
        }

        val schema = manifest.optString("schema")
        val mTrack = manifest.optString("track", "stable")
        val pkgName = manifest.optString("packageName")
        val versionName = manifest.optString("versionName")
        val versionCode = manifest.optLong("versionCode", -1L)
        val sha256 = manifest.optString("sha256").lowercase()
        val size = manifest.optLong("size", -1L)
        val certSha256 = manifest.optString("certificateSha256").lowercase()
        val downloadUrl = manifest.optString("url")
        val publishedAt = manifest.optString("publishedAt")
        val sigB64 = manifest.optString("signature")

        if (schema != "grokbot-android-update/v1" || versionName.isEmpty() || versionCode <= 0L ||
            mTrack != targetTrack ||
            !SHA_HEX.matches(sha256) || !SHA_HEX.matches(certSha256) || size <= 0L || size > 256L * 1024 * 1024 ||
            !isValidUpdateOrigin(downloadUrl) || sigB64.isEmpty()
        ) {
            throw UpdateFailure("feed_malformed", "Invalid manifest fields")
        }

        val canonical = "$schema\n$mTrack\n$pkgName\n$versionName\n$versionCode\n$sha256\n$size\n$certSha256\n$downloadUrl\n$publishedAt"
        if (!verifyEcdsaSignature(pubKey, canonical.toByteArray(Charsets.UTF_8), sigB64)) {
            throw UpdateFailure("installer_signature_invalid", "Manifest signature verification failed")
        }
        if (pkgName != app.packageName) {
            throw UpdateFailure("feed_malformed", "Package name mismatch")
        }
        val installedCert = installedSigningCertSha256()
            ?: throw UpdateFailure("installer_signature_invalid", "Cannot read installed app certificate")
        if (!certSha256.equals(installedCert, ignoreCase = true)) {
            throw UpdateFailure("installer_signature_invalid", "Release signing certificate mismatch")
        }

        if (versionCode <= currentVersionCode()) {
            synchronized(stateLock) {
                if (expectedGen == checkGeneration) {
                    setState(JSONObject().put("type", "idle").put("lastCheck", JSONObject().put("at", System.currentTimeMillis()).put("result", "up-to-date")))
                }
            }
            return
        }

        val dir = File(app.filesDir, "updates").apply { mkdirs() }
        val readyFile = File(dir, "ready-$targetTrack-$versionCode-$versionName.apk")
        if (readyFile.isFile && readyFile.length() == size && fileSha256(readyFile).equals(sha256, ignoreCase = true)) {
            verifyDownloadedApk(readyFile, versionName, expectedCert = installedCert, minVersionCode = versionCode)
            synchronized(stateLock) {
                if (expectedGen == checkGeneration) {
                    pendingInstallApk = readyFile
                    setState(JSONObject().put("type", "ready").put("version", versionName))
                }
            }
            return
        }

        synchronized(stateLock) {
            if (expectedGen != checkGeneration) return
            setState(JSONObject().put("type", "available").put("version", versionName))
        }
        val tmpFile = File(dir, "pending-$targetTrack-$versionCode.apk.tmp")
        tmpFile.delete()
        downloadFile(downloadUrl, size, tmpFile) { progress ->
            synchronized(stateLock) {
                if (expectedGen == checkGeneration) {
                    setState(JSONObject().put("type", "downloading").put("version", versionName).put("progress", progress))
                }
            }
        }
        if (expectedGen != checkGeneration) {
            tmpFile.delete()
            return
        }

        synchronized(stateLock) {
            if (expectedGen != checkGeneration) { tmpFile.delete(); return }
            setState(JSONObject().put("type", "staging").put("version", versionName))
        }
        val actualSha = fileSha256(tmpFile)
        if (!actualSha.equals(sha256, ignoreCase = true) || tmpFile.length() != size) {
            tmpFile.delete()
            throw UpdateFailure("installer_signature_invalid", "Downloaded APK checksum mismatch")
        }
        verifyDownloadedApk(tmpFile, versionName, expectedCert = installedCert, minVersionCode = versionCode)

        if (readyFile.exists()) readyFile.delete()
        if (!tmpFile.renameTo(readyFile)) {
            tmpFile.delete()
            throw UpdateFailure("staging_failed", "Failed to save staged APK")
        }
        synchronized(stateLock) {
            if (expectedGen == checkGeneration) {
                pendingInstallApk = readyFile
                setState(JSONObject().put("type", "ready").put("version", versionName))
            }
        }
    }

    private fun verifyDownloadedApk(
        file: File,
        expectedVersion: String? = null,
        expectedCert: String? = installedSigningCertSha256(),
        minVersionCode: Long = currentVersionCode() + 1,
    ): String {
        val pm = app.packageManager
        val flags = PackageManager.GET_SIGNING_CERTIFICATES
        val info = if (Build.VERSION.SDK_INT >= 33) {
            pm.getPackageArchiveInfo(file.absolutePath, PackageManager.PackageInfoFlags.of(flags.toLong()))
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageArchiveInfo(file.absolutePath, flags)
        } ?: throw UpdateFailure("installer_signature_invalid", "Downloaded file is not a valid APK")

        if (info.packageName != app.packageName) {
            throw UpdateFailure("installer_signature_invalid", "APK packageName mismatch")
        }
        val apkVersionCode = info.longVersionCode
        if (apkVersionCode < minVersionCode) {
            throw UpdateFailure("installer_signature_invalid", "APK versionCode is not newer")
        }
        if (expectedVersion != null && info.versionName != expectedVersion) {
            throw UpdateFailure("installer_signature_invalid", "APK versionName mismatch")
        }
        val signers = info.signingInfo?.apkContentsSigners.orEmpty()
        val certMatches = expectedCert != null && signers.any { sha256Hex(it.toByteArray()).equals(expectedCert, ignoreCase = true) }
        if (!certMatches) {
            throw UpdateFailure("installer_signature_invalid", "APK signing certificate mismatch")
        }
        return info.versionName ?: expectedVersion.orEmpty()
    }

    private fun findReadyCachedApk(forTrack: String = track): Pair<File, String>? {
        val dir = File(app.filesDir, "updates")
        if (!dir.isDirectory) return null
        val cert = installedSigningCertSha256() ?: return null
        val curCode = currentVersionCode()
        val trackPrefix = "ready-$forTrack-"
        return dir.listFiles()?.filter {
            it.isFile && it.name.endsWith(".apk") &&
                (it.name.startsWith(trackPrefix) || (forTrack == "stable" && Regex("^ready-\\d+-.*").matches(it.name)))
        }
            ?.sortedByDescending { it.lastModified() }
            ?.firstNotNullOfOrNull { file ->
                runCatching {
                    val vName = verifyDownloadedApk(file, expectedCert = cert, minVersionCode = curCode + 1)
                    file to vName
                }.getOrNull()
            }
    }

    private fun cleanupOldUpdates() {
        val dir = File(app.filesDir, "updates")
        if (!dir.isDirectory) return
        val curCode = currentVersionCode()
        dir.listFiles()?.forEach { file ->
            if (file.name.endsWith(".tmp")) file.delete()
            else if (file.name.startsWith("ready-") && file.name.endsWith(".apk")) {
                val match = Regex("^ready-(?:[a-z]+-)?(\\d+)-").find(file.name)
                val versionCode = match?.groupValues?.getOrNull(1)?.toLongOrNull() ?: 0L
                if (versionCode <= curCode) file.delete()
            }
        }
    }

    private fun currentVersionCode(): Long {
        val info = if (Build.VERSION.SDK_INT >= 33) {
            app.packageManager.getPackageInfo(app.packageName, PackageManager.PackageInfoFlags.of(0L))
        } else {
            @Suppress("DEPRECATION")
            app.packageManager.getPackageInfo(app.packageName, 0)
        }
        return info.longVersionCode
    }

    private fun installedSigningCertSha256(): String? = runCatching {
        val flags = PackageManager.GET_SIGNING_CERTIFICATES
        val info = if (Build.VERSION.SDK_INT >= 33) {
            app.packageManager.getPackageInfo(app.packageName, PackageManager.PackageInfoFlags.of(flags.toLong()))
        } else {
            @Suppress("DEPRECATION")
            app.packageManager.getPackageInfo(app.packageName, flags)
        }
        val signer = info.signingInfo?.apkContentsSigners?.firstOrNull() ?: return null
        sha256Hex(signer.toByteArray())
    }.getOrNull()

    private fun fetchText(url: String): String {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            instanceFollowRedirects = true
            connectTimeout = 15_000
            readTimeout = 20_000
            useCaches = false
            setRequestProperty("Cache-Control", "no-store")
        }
        try {
            val code = conn.responseCode
            if (code !in 200..299) throw UpdateFailure("feed_fetch_failed", "HTTP $code")
            val bytes = conn.inputStream.use { it.readBytes() }
            if (bytes.size > 1024 * 1024) throw UpdateFailure("feed_malformed", "Manifest too large")
            return bytes.decodeToString()
        } finally {
            conn.disconnect()
        }
    }

    private fun downloadFile(url: String, expectedSize: Long, outFile: File, onProgress: (Double) -> Unit) {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            instanceFollowRedirects = true
            connectTimeout = 20_000
            readTimeout = 60_000
            useCaches = false
        }
        try {
            val code = conn.responseCode
            if (code !in 200..299) throw UpdateFailure("update_failed", "Download HTTP $code")
            val total = if (conn.contentLengthLong > 0L) conn.contentLengthLong else expectedSize
            var downloaded = 0L
            var lastEmitAt = 0L
            var lastPct = -1
            conn.inputStream.use { input ->
                FileOutputStream(outFile).use { output ->
                    val buf = ByteArray(32 * 1024)
                    while (true) {
                        val read = input.read(buf)
                        if (read < 0) break
                        output.write(buf, 0, read)
                        downloaded += read
                        if (downloaded > 256L * 1024 * 1024) throw UpdateFailure("update_failed", "APK too large")
                        val fraction = if (total > 0L) (downloaded.toDouble() / total.toDouble()).coerceIn(0.0, 1.0) else 0.0
                        val pct = (fraction * 100).toInt()
                        val now = System.currentTimeMillis()
                        if (pct >= lastPct + 2 || now - lastEmitAt >= 250L) {
                            lastPct = pct
                            lastEmitAt = now
                            onProgress(fraction)
                        }
                    }
                }
            }
            onProgress(1.0)
        } finally {
            conn.disconnect()
        }
    }

    private fun setState(state: JSONObject) {
        currentState = state
        emitStatus(statusJson())
    }

    private fun setFailure(kind: String, message: String) {
        setState(
            JSONObject().put("type", "idle").put(
                "lastCheck",
                JSONObject()
                    .put("at", System.currentTimeMillis())
                    .put("result", "error")
                    .put("failure", JSONObject().put("kind", kind))
                    .put("errorMessage", message.take(300)),
            ),
        )
    }

    private fun emitStatus(status: JSONObject) {
        app.host?.emitUpdateStatus(status)
    }

    private class UpdateFailure(val kind: String, message: String) : IOException(message)

    companion object {
        private const val TAG = "GrokBotUpdater"
        private val VALID_TRACKS = setOf("stable", "nightly", "dogfood")
        private val SHA_HEX = Regex("^[a-f0-9]{64}$")

        private fun isValidUpdateOrigin(raw: String): Boolean {
            if (raw.isEmpty() || raw.length > 2048) return false
            val uri = runCatching { Uri.parse(raw) }.getOrNull() ?: return false
            val scheme = uri.scheme?.lowercase() ?: return false
            val host = uri.host?.lowercase() ?: return false
            if (!uri.userInfo.isNullOrEmpty()) return false
            return scheme == "https" || (scheme == "http" && host == "127.0.0.1")
        }

        private fun parseEcPublicKey(base64Spki: String): java.security.PublicKey? = runCatching {
            if (base64Spki.isEmpty()) return null
            val bytes = Base64.decode(base64Spki, Base64.DEFAULT)
            KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(bytes))
        }.getOrNull()

        private fun verifyEcdsaSignature(publicKey: java.security.PublicKey, payload: ByteArray, signatureBase64: String): Boolean = runCatching {
            val sigBytes = Base64.decode(signatureBase64, Base64.DEFAULT)
            val sig = Signature.getInstance("SHA256withECDSA")
            sig.initVerify(publicKey)
            sig.update(payload)
            sig.verify(sigBytes)
        }.getOrDefault(false)

        private fun fileSha256(file: File): String {
            val md = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buf = ByteArray(32 * 1024)
                while (true) {
                    val read = input.read(buf)
                    if (read < 0) break
                    md.update(buf, 0, read)
                }
            }
            return md.digest().joinToString("") { "%02x".format(it) }
        }

        private fun sha256Hex(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }
}
