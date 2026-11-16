package dev.grokbot.local

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import org.json.JSONObject
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

object Notifications {
    const val CHANNEL_MESSAGES = "messages"
    const val CHANNEL_ATTENTION = "attention"
    const val CHANNEL_CONNECTION = "connection"
    const val ID_CONNECTION = 1
    private const val GROUP_CONNECTION = "dev.grokbot.local.connection"
    private const val ID_EXPIRED = 2

    fun createChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannels(listOf(
            NotificationChannel(CHANNEL_MESSAGES, Text.string(context, R.string.channel_messages), NotificationManager.IMPORTANCE_HIGH),
            NotificationChannel(CHANNEL_ATTENTION, Text.string(context, R.string.channel_attention), NotificationManager.IMPORTANCE_HIGH),
            NotificationChannel(CHANNEL_CONNECTION, Text.string(context, R.string.channel_connection), NotificationManager.IMPORTANCE_MIN)
                .apply { setShowBadge(false) },
        ))
    }

    private fun openApp(context: Context, agentId: String?, request: Int): PendingIntent {
        val intent = if (agentId == null) Intent(context, MainActivity::class.java)
        else Intent(Intent.ACTION_VIEW, Uri.parse("grokbot-local://agent/$agentId"), context, MainActivity::class.java)
        return PendingIntent.getActivity(context, request, intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    fun connection(context: Context, reconnecting: Boolean): Notification =
        Notification.Builder(context, CHANNEL_CONNECTION)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(Text.string(context, if (reconnecting) R.string.connection_lost else R.string.connection_title))
            .setContentText(Text.string(context, R.string.connection_text))
            .setContentIntent(openApp(context, null, 0))
            .setOngoing(true)
            // Its own group: otherwise Android bundles it with Bot messages, and the bundle
            // inherits "ongoing" and can no longer be cleared.
            .setGroup(GROUP_CONNECTION)
            .setShowWhen(false)
            .build()

    private fun idFor(agentId: String) = 1000 + (agentId.hashCode() and 0x7fffffff) % 1_000_000

    private const val MAX_SEEN_TEST_IDS = 128
    private val seenTestIds = LinkedHashSet<String>()

    @Synchronized
    private fun acceptTestNotification(id: String): Boolean {
        if (id.isEmpty()) return true
        if (!seenTestIds.add(id)) return false
        while (seenTestIds.size > MAX_SEEN_TEST_IDS) {
            val oldest = seenTestIds.iterator().next()
            seenTestIds.remove(oldest)
        }
        return true
    }

    /** Shared delivery entrypoint for SSE notifications and background push (UnifiedPush/ntfy). */
    fun deliverIncoming(
        app: GrokBotApp,
        connection: Connection,
        item: JSONObject,
        explicitId: String? = null,
        updateCursor: Boolean = explicitId != null,
    ) {
        val itemId = explicitId?.takeIf { it.isNotEmpty() }
            ?: item.optString("notificationId").ifEmpty { item.optString("id") }
        val type = item.optString("type")
        val createdAt = item.optString("createdAt")
        if (type == "test") {
            val accepted = if (itemId.isNotEmpty()) {
                app.connections.acceptNotification(connection.deviceId, itemId, createdAt, updateCursor = updateCursor)
            } else {
                acceptTestNotification("")
            }
            if (!accepted) return
            val viewing = app.inForeground && app.viewingAgentId == item.optString("agentId")
            if (!viewing) show(app, item)
            return
        }
        if (itemId.isEmpty()) {
            if (explicitId == null) return
            val viewing = app.inForeground && app.viewingAgentId == item.optString("agentId")
            if (!viewing) show(app, item)
            return
        }
        if (app.connections.acceptNotification(connection.deviceId, itemId, createdAt, updateCursor = updateCursor)) {
            val viewing = app.inForeground && app.viewingAgentId == item.optString("agentId")
            if (!viewing) show(app, item)
        }
    }

    fun readSseEvents(
        reader: BufferedReader,
        isActive: () -> Boolean,
        onEvent: (id: String?, event: String?, data: String) -> Unit,
    ) {
        var id: String? = null
        var event: String? = null
        val data = StringBuilder()
        while (isActive()) {
            val line = reader.readLine() ?: break
            if (line.isEmpty()) {
                if (data.isNotEmpty()) onEvent(id, event, data.toString())
                id = null; event = null; data.setLength(0)
                continue
            }
            if (line.startsWith(':')) continue
            val field = line.substringBefore(':')
            val value = line.substringAfter(':', "").removePrefix(" ")
            when (field) {
                "id" -> id = value
                "event" -> event = value
                "data" -> { if (data.isNotEmpty()) data.append('\n'); data.append(value) }
            }
        }
    }

    fun openStreamHttp(
        app: GrokBotApp,
        connection: Connection,
        path: String,
        lastId: String?,
        accept: String,
        sendForegroundHeader: Boolean,
        onConnecting: (HttpURLConnection?) -> Unit = {},
    ): HttpURLConnection {
        val baseServer = app.tailcat.resolveServer(app, connection)
        val http = URL(baseServer + path).openConnection() as HttpURLConnection
        onConnecting(http)
        http.instanceFollowRedirects = false
        http.connectTimeout = 15_000
        http.readTimeout = 45_000
        http.useCaches = false
        http.setRequestProperty("Authorization", "Bearer ${connection.token}")
        http.setRequestProperty("Accept", accept)
        if (sendForegroundHeader) http.setRequestProperty("X-GrokBot-Foreground", "1")
        if (!lastId.isNullOrEmpty()) http.setRequestProperty("Last-Event-ID", lastId)
        try {
            val status = http.responseCode
            if (status == 401) throw NotificationUnauthorizedException()
            if (status != 200) throw IOException("HTTP $status")
            return http
        } catch (error: Exception) {
            http.disconnect()
            onConnecting(null)
            throw error
        }
    }

    fun seedCursorIfNeeded(
        app: GrokBotApp,
        connection: Connection,
        onConnecting: (HttpURLConnection?) -> Unit = {},
    ) {
        if (app.connections.notificationCursor != null) return
        val http = openStreamHttp(app, connection, "/notifications", null, "application/json", sendForegroundHeader = false, onConnecting = onConnecting)
        val items = try {
            JSONObject(http.inputStream.use { it.readBytes().decodeToString() }).optJSONArray("items")
        } finally {
            http.disconnect()
            onConnecting(null)
        }
        app.connections.seedNotifications(connection.deviceId, items ?: org.json.JSONArray())
    }

    fun show(context: Context, item: JSONObject) {
        val agentId = item.optString("agentId")
        if (!Regex("^[A-Za-z0-9_-]{1,128}$").matches(agentId)) return
        val attention = item.optString("type") == "attention"
        val body = item.optString("body")
        val notification = Notification.Builder(context, if (attention) CHANNEL_ATTENTION else CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(item.optString("title").ifEmpty { "Grok Bot" })
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setContentIntent(openApp(context, agentId, idFor(agentId)))
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .build()
        try {
            context.getSystemService(NotificationManager::class.java).notify(idFor(agentId), notification)
        } catch (error: SecurityException) {
            Log.w("GrokBotNotify", "Notification permission missing")
        }
    }

    fun expired(context: Context) {
        val notification = Notification.Builder(context, CHANNEL_ATTENTION)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(Text.string(context, R.string.app_name))
            .setContentText(Text.string(context, R.string.pairing_expired))
            .setContentIntent(openApp(context, null, 1))
            .setAutoCancel(true)
            .build()
        try { context.getSystemService(NotificationManager::class.java).notify(ID_EXPIRED, notification) } catch (_: SecurityException) {}
    }

    fun cancelAgent(context: Context, agentId: String) =
        context.getSystemService(NotificationManager::class.java).cancel(idFor(agentId))

    fun cancelAll(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.activeNotifications.filter { it.id != ID_CONNECTION }.forEach { manager.cancel(it.id) }
    }
}

class NotificationUnauthorizedException : IOException()

/**
 * Background delivery without a cloud push service: a foreground service follows the
 * Host notification stream (`/notifications/events`), the same feed the iOS client reads,
 * and signals `X-GrokBot-Foreground: 1` when the workspace is in the foreground.
 */
class NotificationService : Service() {
    private val app get() = GrokBotApp.of(this)
    private val lock = Any()
    @Volatile private var destroyed = false
    @Volatile private var runToken = 0L
    @Volatile private var current: HttpURLConnection? = null
    @Volatile private var currentForegroundSent = false
    @Volatile private var lastReconnectAttemptMs = 0L
    private var worker: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        activeService = this
        val notification = Notifications.connection(this, reconnecting = false)
        if (Build.VERSION.SDK_INT >= 34) startForeground(Notifications.ID_CONNECTION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(Notifications.ID_CONNECTION, notification)
        if (app.gateway.connection == null || !app.settings.backgroundNotifications) {
            stopSelf()
            return START_NOT_STICKY
        }
        val restart = intent?.action == ACTION_RESTART
        startOrRestartWorker(forceDisconnect = restart)
        return START_STICKY
    }

    override fun onDestroy() {
        synchronized(lock) {
            destroyed = true
            runToken++
            if (activeService === this) activeService = null
            current?.disconnect()
            current = null
            worker?.interrupt()
            worker = null
        }
        super.onDestroy()
    }

    fun syncForegroundHeaderIfNeeded(inForeground: Boolean) {
        if (currentForegroundSent != inForeground) {
            reconnectNow()
        }
    }

    fun reconnectNow() {
        lastReconnectAttemptMs = android.os.SystemClock.elapsedRealtime()
        synchronized(lock) {
            current?.disconnect()
            worker?.interrupt()
        }
    }

    private fun startOrRestartWorker(forceDisconnect: Boolean) {
        synchronized(lock) {
            destroyed = false
            val alive = worker?.isAlive == true
            if (alive && !forceDisconnect) return
            val token = ++runToken
            if (forceDisconnect) {
                current?.disconnect()
                worker?.interrupt()
            }
            worker = Thread({ run(token) }, "grokbot-notifications-$token").apply {
                isDaemon = true
                start()
            }
        }
    }

    private fun run(myToken: Long) {
        var failures = 0
        while (!destroyed && myToken == runToken) {
            val connection = app.gateway.connection ?: break
            try {
                Notifications.seedCursorIfNeeded(app, connection) { current = it }
                stream(connection, myToken) { failures = 0 }
            } catch (_: NotificationUnauthorizedException) {
                if (app.gateway.connection !== connection || destroyed || myToken != runToken) continue
                app.connections.lastError = "unauthorized"
                Notifications.expired(this)
                break
            } catch (error: Exception) {
                if (destroyed || myToken != runToken) break
                Log.i(TAG, "notification stream: ${error.javaClass.simpleName}")
            }
            if (destroyed || myToken != runToken) break
            updateForeground(reconnecting = true)
            val delay = minOf(1000L shl minOf(failures++, 5), 30_000L)
            try { Thread.sleep(delay) } catch (_: InterruptedException) {
                // Interrupted by poke() / foreground switch -> reset backoff and reconnect immediately.
                failures = 0
            }
        }
        synchronized(lock) {
            if (!destroyed && myToken == runToken) stopSelf()
        }
    }

    private fun stream(connection: Connection, myToken: Long, onConnected: () -> Unit) {
        val sendFg = app.inForeground
        currentForegroundSent = sendFg
        lastReconnectAttemptMs = android.os.SystemClock.elapsedRealtime()
        val http = withWakeLock("GrokBot:NotifyConnect", 10_000L) {
            Notifications.openStreamHttp(
                app, connection, "/notifications/events", app.connections.notificationCursor,
                "text/event-stream", sendForegroundHeader = sendFg,
            ) { current = it }
        }
        onConnected()
        updateForeground(reconnecting = false)
        try {
            val reader = BufferedReader(InputStreamReader(http.inputStream, Charsets.UTF_8))
            Notifications.readSseEvents(reader, isActive = { !destroyed && myToken == runToken }) { id, event, data ->
                deliver(connection, id, event, data)
            }
        } finally {
            http.disconnect()
            if (current === http) current = null
        }
    }

    private fun deliver(connection: Connection, id: String?, event: String?, data: String) {
        if (event != "notification") return
        val item = try { JSONObject(data) } catch (_: Exception) { return }
        withWakeLock("GrokBot:NotifyShow", 5_000L) {
            Notifications.deliverIncoming(app, connection, item, explicitId = id)
        }
    }

    private inline fun <T> withWakeLock(tag: String, timeoutMs: Long, block: () -> T): T {
        val wake = runCatching {
            getSystemService(PowerManager::class.java)
                ?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, tag)
                ?.apply { acquire(timeoutMs) }
        }.getOrNull()
        return try {
            block()
        } finally {
            runCatching { if (wake?.isHeld == true) wake.release() }
        }
    }

    private fun updateForeground(reconnecting: Boolean) {
        try {
            getSystemService(NotificationManager::class.java)
                .notify(Notifications.ID_CONNECTION, Notifications.connection(this, reconnecting))
        } catch (_: SecurityException) {}
    }

    companion object {
        private const val TAG = "GrokBotNotify"
        private const val ACTION_ENSURE = "dev.grokbot.local.ENSURE_NOTIFICATIONS"
        private const val ACTION_RESTART = "dev.grokbot.local.RESTART_NOTIFICATIONS"
        @Volatile var activeService: NotificationService? = null

        /** Starts, ensures, or stops the service to match pairing and settings. */
        fun sync(context: Context, forceRestart: Boolean = false) {
            val app = GrokBotApp.of(context)
            val intent = Intent(context, NotificationService::class.java)
            if (app.gateway.connection != null && app.settings.backgroundNotifications) {
                if (!forceRestart && activeService != null) return
                try { context.startForegroundService(intent.setAction(if (forceRestart) ACTION_RESTART else ACTION_ENSURE)) }
                catch (error: Exception) { Log.w(TAG, "Cannot start background notifications: ${error.javaClass.simpleName}") }
            } else {
                context.stopService(intent)
            }
        }

        /** Wakes the active notification stream immediately if running, without foreground service start restrictions. */
        fun poke(context: Context) = pokeIfStale(context, maxAgeMs = 0L)

        fun pokeIfStale(context: Context, maxAgeMs: Long = 1500L) {
            val service = activeService
            if (service != null) {
                val age = android.os.SystemClock.elapsedRealtime() - service.lastReconnectAttemptMs
                if (maxAgeMs <= 0L || age >= maxAgeMs) service.reconnectNow()
            } else if (GrokBotApp.of(context).inForeground) {
                sync(context)
            }
        }

        fun syncForeground(context: Context, inForeground: Boolean) {
            activeService?.syncForegroundHeaderIfNeeded(inForeground)
        }
    }
}

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED)
            NotificationService.sync(context)
    }
}
