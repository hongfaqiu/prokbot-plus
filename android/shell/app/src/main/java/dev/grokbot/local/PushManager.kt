package dev.grokbot.local

import android.Manifest
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Coordinates iOS-parity device registration, authorization status, foreground presence
 * heartbeats, UnifiedPush / ntfy / Webhook / FCM transport setup, and push self-tests.
 */
class PushManager(private val app: GrokBotApp) {
    private val prefs = app.getSharedPreferences("push_config", Context.MODE_PRIVATE)
    private val io = Executors.newSingleThreadExecutor { Thread(it, "grokbot-push").apply { isDaemon = true } }
    private val scheduler = Executors.newSingleThreadScheduledExecutor { Thread(it, "grokbot-fg-hb").apply { isDaemon = true } }
    private var heartbeat: ScheduledFuture<*>? = null
    private var unifiedPushTimeout: ScheduledFuture<*>? = null

    @Volatile private var foregroundStreamThread: Thread? = null
    @Volatile private var foregroundStreamConn: HttpURLConnection? = null
    @Volatile private var foregroundStreamToken = 0L

    var provider: String
        get() = prefs.getString("provider", "none") ?: "none"
        private set(value) { prefs.edit().putString("provider", value).apply() }

    var unifiedPushDistributor: String
        get() = prefs.getString("unifiedPushDistributor", "") ?: ""
        private set(value) { prefs.edit().putString("unifiedPushDistributor", value).apply() }

    var unifiedPushEndpoint: String
        get() = prefs.getString("unifiedPushEndpoint", "") ?: ""
        private set(value) { prefs.edit().putString("unifiedPushEndpoint", value).apply() }

    var unifiedPushInstance: String
        get() = prefs.getString("unifiedPushInstance", null) ?: UUID.randomUUID().toString().also {
            prefs.edit().putString("unifiedPushInstance", it).apply()
        }
        private set(value) { prefs.edit().putString("unifiedPushInstance", value).apply() }

    var ntfyUrl: String
        get() = prefs.getString("ntfyUrl", "") ?: ""
        private set(value) { prefs.edit().putString("ntfyUrl", value).apply() }

    var ntfyToken: String
        get() = prefs.getString("ntfyToken", "") ?: ""
        private set(value) { prefs.edit().putString("ntfyToken", value).apply() }

    var webhookUrl: String
        get() = prefs.getString("webhookUrl", "") ?: ""
        private set(value) { prefs.edit().putString("webhookUrl", value).apply() }

    var webhookSecret: String
        get() = prefs.getString("webhookSecret", "") ?: ""
        private set(value) { prefs.edit().putString("webhookSecret", value).apply() }

    var fcmToken: String
        get() = prefs.getString("fcmToken", "") ?: ""
        private set(value) { prefs.edit().putString("fcmToken", value).apply() }

    var registrationError: String?
        get() = prefs.getString("registrationError", null)
        private set(value) {
            if (value == null) prefs.edit().remove("registrationError").apply()
            else prefs.edit().putString("registrationError", value).apply()
        }

    fun notePermissionAsked() {
        prefs.edit().putBoolean("askedPermission", true).apply()
    }

    fun authorization(): String {
        val enabled = app.getSystemService(NotificationManager::class.java)?.areNotificationsEnabled() != false
        if (Build.VERSION.SDK_INT >= 33) {
            val granted = app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
            if (granted && enabled) return "granted"
            return if (prefs.getBoolean("askedPermission", false) || !enabled) "denied" else "not_determined"
        }
        return if (enabled) "granted" else "denied"
    }

    fun isIgnoringBatteryOptimizations(): Boolean {
        val power = app.getSystemService(PowerManager::class.java) ?: return false
        return power.isIgnoringBatteryOptimizations(app.packageName)
    }

    fun openBatteryOptimizationSettings(): Boolean {
        val host = app.host
        val intent = if (!isIgnoringBatteryOptimizations()) {
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${app.packageName}"))
        } else {
            Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            (host ?: app).startActivity(intent)
            true
        } catch (_: Exception) {
            try {
                (host ?: app).startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                true
            } catch (_: Exception) {
                false
            }
        }
    }

    fun discoverDistributors(): JSONArray {
        val intent = Intent("org.unifiedpush.android.distributor.REGISTER")
        val pm = app.packageManager
        val list = if (Build.VERSION.SDK_INT >= 33) {
            pm.queryBroadcastReceivers(intent, PackageManager.ResolveInfoFlags.of(PackageManager.GET_RESOLVED_FILTER.toLong()))
        } else {
            @Suppress("DEPRECATION")
            pm.queryBroadcastReceivers(intent, PackageManager.GET_RESOLVED_FILTER)
        }
        val arr = JSONArray()
        val seen = HashSet<String>()
        for (info in list) {
            val pkg = info.activityInfo?.packageName ?: continue
            if (pkg == app.packageName || !seen.add(pkg)) continue
            val label = info.loadLabel(pm)?.toString()?.trim().orEmpty().ifEmpty { pkg }
            arr.put(JSONObject().put("packageName", pkg).put("label", label))
        }
        return arr
    }

    fun stateJson(): JSONObject = JSONObject()
        .put("provider", provider)
        .put("authorization", authorization())
        .put("batteryOptimizationIgnored", isIgnoringBatteryOptimizations())
        .put("backgroundNotifications", app.settings.backgroundNotifications)
        .put("unifiedPushDistributor", unifiedPushDistributor)
        .put("unifiedPushEndpoint", unifiedPushEndpoint)
        .put("ntfyUrl", ntfyUrl)
        .put("hasNtfyToken", ntfyToken.isNotEmpty())
        .put("webhookUrl", webhookUrl)
        .put("hasWebhookSecret", webhookSecret.isNotEmpty())
        .put("fcmToken", fcmToken)
        .put("registrationError", registrationError ?: JSONObject.NULL)
        .put("distributors", discoverDistributors())

    fun onForegroundChanged(active: Boolean) {
        synchronized(this) {
            heartbeat?.cancel(false)
            heartbeat = null
            if (active && app.gateway.connection != null) {
                heartbeat = scheduler.scheduleWithFixedDelay({
                    if (app.inForeground && app.gateway.connection != null) {
                        runCatching { sendForegroundOnly(true) }
                    }
                }, 25, 25, TimeUnit.SECONDS)
            }
        }
        io.execute {
            runCatching {
                if (active) syncDevice(foreground = true, includePush = false)
                else sendForegroundOnly(false)
            }
        }
        syncForegroundNotificationStream(active)
    }

    fun syncForegroundNotificationStream(active: Boolean = app.inForeground) {
        // When NotificationService (background SSE) is active, it holds /notifications/events and sends
        // X-GrokBot-Foreground: 1 on resume. When it is disabled, keep a foreground-only stream here.
        val shouldHoldHere = active && app.gateway.connection != null && !app.settings.backgroundNotifications
        if (!shouldHoldHere) {
            foregroundStreamToken++
            foregroundStreamConn?.disconnect()
            foregroundStreamConn = null
            foregroundStreamThread?.interrupt()
            foregroundStreamThread = null
            return
        }
        if (foregroundStreamThread?.isAlive == true) return
        val token = ++foregroundStreamToken
        foregroundStreamThread = Thread({
            while (token == foregroundStreamToken && app.inForeground && !app.settings.backgroundNotifications) {
                val connection = app.gateway.connection ?: break
                var http: HttpURLConnection? = null
                try {
                    Notifications.seedCursorIfNeeded(app, connection) { foregroundStreamConn = it }
                    http = Notifications.openStreamHttp(
                        app, connection, "/notifications/events", app.connections.notificationCursor,
                        "text/event-stream", sendForegroundHeader = true,
                    ) { foregroundStreamConn = it }
                    val reader = BufferedReader(InputStreamReader(http.inputStream, Charsets.UTF_8))
                    Notifications.readSseEvents(
                        reader,
                        isActive = { token == foregroundStreamToken && app.inForeground && !app.settings.backgroundNotifications },
                    ) { id, event, data ->
                        if (event != "notification") return@readSseEvents
                        val item = try { JSONObject(data) } catch (_: Exception) { return@readSseEvents }
                        Notifications.deliverIncoming(app, connection, item, explicitId = id)
                    }
                } catch (_: NotificationUnauthorizedException) {
                    if (app.gateway.connection === connection) app.connections.lastError = "unauthorized"
                    break
                } catch (_: Exception) {
                    if (token != foregroundStreamToken) break
                    try { Thread.sleep(3_000) } catch (_: InterruptedException) { break }
                } finally {
                    http?.disconnect()
                    if (foregroundStreamConn === http) foregroundStreamConn = null
                }
            }
        }, "grokbot-fg-notifications").apply { isDaemon = true; start() }
    }

    private fun cancelUnifiedPushTimeout() {
        synchronized(this) {
            unifiedPushTimeout?.cancel(false)
            unifiedPushTimeout = null
        }
    }

    private fun scheduleUnifiedPushTimeout() {
        synchronized(this) {
            unifiedPushTimeout?.cancel(false)
            unifiedPushTimeout = scheduler.schedule({
                if (provider == "unifiedpush" && unifiedPushEndpoint.isEmpty() && registrationError == null) {
                    registrationError = Text.t(
                        app,
                        "UnifiedPush 分发器未在 12 秒内返回端点，请确认分发器已启动并允许联网。",
                        "UnifiedPush distributor did not return an endpoint within 12s.",
                    )
                    app.host?.emitPushState(stateJson())
                }
            }, 12, TimeUnit.SECONDS)
        }
    }

    fun configure(body: JSONObject): JSONObject {
        if (body.has("backgroundNotifications")) {
            val enabled = body.optBoolean("backgroundNotifications", app.settings.backgroundNotifications)
            app.settings.update("backgroundNotifications", enabled)
            NotificationService.sync(app)
            syncForegroundNotificationStream(app.inForeground)
        }
        val prevProvider = provider
        val nextProvider = body.optString("provider", provider).trim().lowercase()
        require(nextProvider in listOf("none", "unifiedpush", "ntfy", "webhook", "fcm")) {
            Text.t(app, "不支持的推送方式", "Unsupported push provider")
        }
        registrationError = null
        cancelUnifiedPushTimeout()
        when (nextProvider) {
            "none" -> {
                if (prevProvider == "unifiedpush" && unifiedPushDistributor.isNotEmpty()) {
                    unregisterUnifiedPush()
                    prefs.edit().remove("unifiedPushInstance").commit()
                }
                provider = "none"
                syncDevice(foreground = app.inForeground, includePush = true)
            }
            "unifiedpush" -> {
                val distributor = body.optString("distributor", unifiedPushDistributor).trim()
                require(distributor.isNotEmpty()) { Text.t(app, "请选择 UnifiedPush 分发器", "Select a UnifiedPush distributor") }
                val changedDistributor = distributor != unifiedPushDistributor || prevProvider != "unifiedpush"
                if (prevProvider == "unifiedpush" && unifiedPushDistributor.isNotEmpty() && distributor != unifiedPushDistributor) {
                    unregisterUnifiedPush()
                    prefs.edit().remove("unifiedPushInstance").commit()
                }
                provider = "unifiedpush"
                unifiedPushDistributor = distributor
                if (changedDistributor || unifiedPushEndpoint.isEmpty()) {
                    unifiedPushEndpoint = ""
                    if (prevProvider in listOf("ntfy", "webhook", "fcm")) {
                        // Disable previous Host push target until NEW_ENDPOINT arrives.
                        runCatching {
                            app.gateway.connection?.let { conn ->
                                putDevice(conn, JSONObject()
                                    .put("authorization", authorization())
                                    .put("push", JSONObject().put("provider", "none")))
                            }
                        }
                    }
                    registerUnifiedPush(distributor)
                    scheduleUnifiedPushTimeout()
                    syncDevice(foreground = app.inForeground, includePush = false)
                } else {
                    syncDevice(foreground = app.inForeground, includePush = true)
                }
            }
            "ntfy" -> {
                val rawUrl = body.optString("ntfyUrl", ntfyUrl).trim()
                require(rawUrl.isNotEmpty()) { Text.t(app, "请填写 ntfy 主题地址", "Enter an ntfy topic URL") }
                val rawToken = if (body.has("ntfyToken")) body.optString("ntfyToken", "").trim() else null
                if (prevProvider == "unifiedpush" && unifiedPushDistributor.isNotEmpty()) {
                    unregisterUnifiedPush()
                    prefs.edit().remove("unifiedPushInstance").commit()
                }
                provider = "ntfy"
                ntfyUrl = rawUrl
                if (rawToken != null) ntfyToken = rawToken
                syncDevice(foreground = app.inForeground, includePush = true, explicitNtfyToken = rawToken)
            }
            "webhook" -> {
                val rawUrl = body.optString("webhookUrl", webhookUrl).trim()
                require(rawUrl.isNotEmpty()) { Text.t(app, "请填写 Webhook 地址", "Enter a Webhook URL") }
                val rawSecret = if (body.has("webhookSecret")) body.optString("webhookSecret", "").trim() else null
                if (prevProvider == "unifiedpush" && unifiedPushDistributor.isNotEmpty()) {
                    unregisterUnifiedPush()
                    prefs.edit().remove("unifiedPushInstance").commit()
                }
                provider = "webhook"
                webhookUrl = rawUrl
                if (rawSecret != null) webhookSecret = rawSecret
                syncDevice(foreground = app.inForeground, includePush = true, explicitWebhookSecret = rawSecret)
            }
            "fcm" -> {
                val rawToken = body.optString("fcmToken", fcmToken).trim()
                require(rawToken.length >= 16) { Text.t(app, "请填写有效的 FCM Token", "Enter a valid FCM token") }
                if (prevProvider == "unifiedpush" && unifiedPushDistributor.isNotEmpty()) {
                    unregisterUnifiedPush()
                    prefs.edit().remove("unifiedPushInstance").commit()
                }
                provider = "fcm"
                fcmToken = rawToken
                syncDevice(foreground = app.inForeground, includePush = true)
            }
        }
        val state = stateJson()
        app.host?.emitPushState(state)
        return state
    }

    fun isValidUnifiedPushBroadcast(token: String?, hasTokenExtra: Boolean, requireToken: Boolean = false): Boolean {
        val expected = prefs.getString("unifiedPushInstance", null)?.takeIf { it.isNotEmpty() } ?: return false
        if (provider != "unifiedpush") return false
        val trimmed = token?.trim().orEmpty()
        if (hasTokenExtra || requireToken) {
            return trimmed.isNotEmpty() && trimmed == expected
        }
        return true
    }

    fun onUnifiedPushEndpoint(endpoint: String, token: String): Future<*>? {
        if (!isValidUnifiedPushBroadcast(token, hasTokenExtra = true, requireToken = true)) return null
        cancelUnifiedPushTimeout()
        prefs.edit()
            .putString("unifiedPushEndpoint", endpoint)
            .remove("registrationError")
            .putString("provider", "unifiedpush")
            .commit()
        app.host?.emitPushState(stateJson())
        return io.submit(Runnable {
            try {
                syncDevice(foreground = app.inForeground, includePush = true)
                registrationError = null
            } catch (error: Exception) {
                registrationError = error.message ?: Text.t(app, "同步 UnifiedPush 端点失败", "Failed to sync UnifiedPush endpoint")
                Log.w(TAG, "Failed to upload UnifiedPush endpoint: ${error.message}")
            }
            app.host?.emitPushState(stateJson())
        })
    }

    fun onUnifiedPushUnregistered(token: String): Future<*>? {
        if (!isValidUnifiedPushBroadcast(token, hasTokenExtra = true, requireToken = true)) return null
        cancelUnifiedPushTimeout()
        prefs.edit()
            .putString("unifiedPushEndpoint", "")
            .putString("provider", "none")
            .commit()
        app.host?.emitPushState(stateJson())
        return io.submit(Runnable {
            runCatching { syncDevice(foreground = app.inForeground, includePush = true) }
        })
    }

    fun onUnifiedPushFailed(message: String, token: String = "", hasTokenExtra: Boolean = token.isNotEmpty()): Future<*>? {
        if (!isValidUnifiedPushBroadcast(token, hasTokenExtra = hasTokenExtra, requireToken = false)) return null
        cancelUnifiedPushTimeout()
        val reason = message.ifBlank { Text.t(app, "UnifiedPush 注册失败", "UnifiedPush registration failed") }
        prefs.edit().putString("registrationError", reason).commit()
        app.host?.emitPushState(stateJson())
        return io.submit(Runnable {
            runCatching {
                val connection = app.gateway.connection ?: return@Runnable
                putDevice(connection, JSONObject()
                    .put("authorization", authorization())
                    .put("push", JSONObject().put("registrationError", reason)))
            }
        })
    }

    private fun registerUnifiedPush(distributor: String) {
        val token = unifiedPushInstance
        val pi = PendingIntent.getBroadcast(
            app, 0, Intent(app, UnifiedPushReceiver::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val intent = Intent("org.unifiedpush.android.distributor.REGISTER")
            .setPackage(distributor)
            .putExtra("token", token)
            .putExtra("application", app.packageName)
            .putExtra("pi", pi)
        app.sendBroadcast(intent)
    }

    private fun unregisterUnifiedPush() {
        val distributor = unifiedPushDistributor
        val token = prefs.getString("unifiedPushInstance", null) ?: return
        if (distributor.isEmpty()) return
        runCatching {
            app.sendBroadcast(
                Intent("org.unifiedpush.android.distributor.UNREGISTER")
                    .setPackage(distributor)
                    .putExtra("token", token),
            )
        }
    }

    fun syncAfterDisconnect() {
        if (provider == "unifiedpush" && unifiedPushDistributor.isNotEmpty()) {
            unregisterUnifiedPush()
        }
        synchronized(this) {
            heartbeat?.cancel(false)
            heartbeat = null
        }
        cancelUnifiedPushTimeout()
        syncForegroundNotificationStream(false)
        prefs.edit()
            .remove("provider")
            .remove("unifiedPushDistributor")
            .remove("unifiedPushEndpoint")
            .remove("ntfyUrl")
            .remove("ntfyToken")
            .remove("webhookUrl")
            .remove("webhookSecret")
            .remove("fcmToken")
            .remove("registrationError")
            .apply()
    }

    fun syncDeviceAsync(foreground: Boolean? = app.inForeground, includePush: Boolean = false) {
        io.execute { runCatching { syncDevice(foreground = foreground, includePush = includePush) } }
    }

    fun syncDevice(
        foreground: Boolean? = null,
        includePush: Boolean = false,
        explicitNtfyToken: String? = null,
        explicitWebhookSecret: String? = null,
    ): JSONObject? {
        val connection = app.gateway.connection ?: return null
        val payload = JSONObject()
            .put("name", Pairing.deviceName(app))
            .put("kind", "desktop")
            .put("clientKind", "android")
            .put("bundleId", BuildConfig.APPLICATION_ID)
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("pushCapable", true)
            .put("authorization", authorization())
        if (foreground != null) payload.put("foreground", foreground)
        if (includePush) {
            val push = JSONObject().put("provider", provider)
            when (provider) {
                "unifiedpush" -> {
                    if (unifiedPushEndpoint.isEmpty()) return putDevice(connection, payload)
                    push.put("endpoint", unifiedPushEndpoint)
                }
                "ntfy" -> {
                    push.put("ntfyUrl", ntfyUrl)
                    if (explicitNtfyToken != null) push.put("ntfyToken", explicitNtfyToken)
                    else if (ntfyToken.isNotEmpty()) push.put("ntfyToken", ntfyToken)
                }
                "webhook" -> {
                    push.put("webhookUrl", webhookUrl)
                    if (explicitWebhookSecret != null) push.put("webhookSecret", explicitWebhookSecret)
                    else if (webhookSecret.isNotEmpty()) push.put("webhookSecret", webhookSecret)
                }
                "fcm" -> push.put("fcmToken", fcmToken)
            }
            payload.put("push", push)
        }
        return putDevice(connection, payload)
    }

    fun testPush(agentId: String?): JSONObject {
        val connection = app.gateway.connection ?: throw PairingException(Text.t(app, "尚未连接 Host。", "Not connected to a Host."))
        val baseServer = app.tailcat.resolveServer(app, connection)
        val body = JSONObject()
            .put("agentId", agentId?.takeIf { it.isNotBlank() } ?: firstAgentId(baseServer, connection.token) ?: "grokbot-test")
            .put("bypassForeground", true)
        return postJson("$baseServer/local/device/push/test", connection.token, body)
    }

    private fun firstAgentId(baseServer: String, token: String): String? = runCatching {
        val http = (URL("$baseServer/api/listAgents").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = 5_000
            readTimeout = 5_000
            setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("Content-Type", "application/json")
        }
        http.outputStream.use { it.write("{}".toByteArray()) }
        if (http.responseCode !in 200..299) return@runCatching null
        val text = http.inputStream.use { it.readBytes().decodeToString() }
        val arr = JSONArray(text)
        (0 until arr.length()).asSequence().mapNotNull { arr.optJSONObject(it)?.optString("id")?.takeIf { id -> id.isNotEmpty() } }.firstOrNull()
    }.getOrNull()

    private fun sendForegroundOnly(active: Boolean) {
        val connection = app.gateway.connection ?: return
        putDevice(connection, JSONObject().put("foreground", active), timeoutMs = 5_000)
    }

    private fun putDevice(connection: Connection, body: JSONObject, timeoutMs: Int = 12_000): JSONObject {
        val baseServer = app.tailcat.resolveServer(app, connection)
        val http = (URL("$baseServer/local/device").openConnection() as HttpURLConnection).apply {
            requestMethod = "PUT"
            instanceFollowRedirects = false
            doOutput = true
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            setRequestProperty("Authorization", "Bearer ${connection.token}")
            setRequestProperty("Content-Type", "application/json")
        }
        try {
            http.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = http.responseCode
            val raw = (if (code in 200..299) http.inputStream else http.errorStream)?.use { it.readBytes().decodeToString() }.orEmpty()
            val parsed = try { JSONObject(raw) } catch (_: Exception) { JSONObject() }
            if (code !in 200..299) {
                throw PairingException(parsed.optString("error").ifBlank { parsed.optString("message").ifBlank { "HTTP $code" } })
            }
            return parsed
        } finally {
            http.disconnect()
        }
    }

    private fun postJson(url: String, token: String, body: JSONObject): JSONObject {
        val http = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            instanceFollowRedirects = false
            doOutput = true
            connectTimeout = 15_000
            readTimeout = 15_000
            setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("Content-Type", "application/json")
        }
        try {
            http.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = http.responseCode
            val raw = (if (code in 200..299) http.inputStream else http.errorStream)?.use { it.readBytes().decodeToString() }.orEmpty()
            val parsed = try { JSONObject(raw) } catch (_: Exception) { JSONObject() }
            if (code !in 200..299) {
                throw PairingException(parsed.optString("error").ifBlank { parsed.optString("message").ifBlank { "HTTP $code" } })
            }
            return parsed
        } finally {
            http.disconnect()
        }
    }

    companion object {
        private const val TAG = "GrokBotPush"
    }
}
