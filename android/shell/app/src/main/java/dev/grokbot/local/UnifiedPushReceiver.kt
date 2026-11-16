package dev.grokbot.local

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.util.Log
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Receives UnifiedPush distributor broadcasts without external SDK dependencies
 * (supports UnifiedPush v2/v3 connector actions: NEW_ENDPOINT, MESSAGE, UNREGISTERED, REGISTRATION_FAILED).
 */
class UnifiedPushReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        val app = context.applicationContext as? GrokBotApp ?: return
        val hasToken = intent.hasExtra("token")
        val token = intent.getStringExtra("token")?.trim().orEmpty()

        when (action) {
            ACTION_NEW_ENDPOINT -> {
                val endpoint = intent.getStringExtra("endpoint")?.trim().orEmpty()
                if (endpoint.isEmpty() || !app.push.isValidUnifiedPushBroadcast(token, hasToken, requireToken = true)) return
                dispatchAsync(context) {
                    Log.i(TAG, "UnifiedPush endpoint received")
                    runCatching { app.push.onUnifiedPushEndpoint(endpoint, token)?.get(8_000L, TimeUnit.MILLISECONDS) }
                }
            }
            ACTION_UNREGISTERED -> {
                if (!app.push.isValidUnifiedPushBroadcast(token, hasToken, requireToken = true)) return
                dispatchAsync(context) {
                    Log.i(TAG, "UnifiedPush unregistered")
                    runCatching { app.push.onUnifiedPushUnregistered(token)?.get(8_000L, TimeUnit.MILLISECONDS) }
                }
            }
            ACTION_REGISTRATION_FAILED -> {
                if (!app.push.isValidUnifiedPushBroadcast(token, hasToken, requireToken = false)) return
                val message = intent.getStringExtra("message")?.trim().orEmpty()
                dispatchAsync(context) {
                    Log.w(TAG, "UnifiedPush registration failed: $message")
                    runCatching { app.push.onUnifiedPushFailed(message, token, hasToken)?.get(8_000L, TimeUnit.MILLISECONDS) }
                }
            }
            ACTION_MESSAGE -> {
                if (!app.push.isValidUnifiedPushBroadcast(token, hasToken, requireToken = false)) return
                val raw = intent.getByteArrayExtra("bytesMessage")?.takeIf { it.isNotEmpty() }?.decodeToString()
                    ?: intent.getStringExtra("message")
                    ?: return
                dispatchAsync(context) {
                    val parsed = try { JSONObject(raw) } catch (_: Exception) { null }
                    val connection = app.gateway.connection ?: app.connections.loadOrNull()
                    if (parsed != null && connection != null) {
                        val itemId = parsed.optString("notificationId").ifEmpty { parsed.optString("id") }
                        if (itemId.isNotEmpty()) {
                            Notifications.deliverIncoming(app, connection, parsed, updateCursor = false)
                        } else {
                            NotificationService.poke(app)
                        }
                    } else {
                        NotificationService.poke(app)
                    }
                }
            }
        }
    }

    private fun dispatchAsync(context: Context, block: () -> Unit) {
        val pending = goAsync()
        val power = context.getSystemService(PowerManager::class.java)
        val wakeLock = try {
            power?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "GrokBot:UnifiedPush")
                ?.apply { acquire(10_000L) }
        } catch (_: Exception) { null }
        try {
            executor.execute {
                try {
                    block()
                } catch (error: Exception) {
                    Log.w(TAG, "UnifiedPush broadcast task failed: ${error.javaClass.simpleName}")
                } finally {
                    try { if (wakeLock?.isHeld == true) wakeLock.release() } catch (_: Exception) {}
                    try { pending.finish() } catch (_: Exception) {}
                }
            }
        } catch (_: Exception) {
            try { if (wakeLock?.isHeld == true) wakeLock.release() } catch (_: Exception) {}
            try { pending.finish() } catch (_: Exception) {}
        }
    }

    companion object {
        private const val TAG = "GrokBotUP"
        private val executor = Executors.newCachedThreadPool { task ->
            Thread(task, "grokbot-up-receiver").apply { isDaemon = true }
        }
        const val ACTION_MESSAGE = "org.unifiedpush.android.connector.MESSAGE"
        const val ACTION_NEW_ENDPOINT = "org.unifiedpush.android.connector.NEW_ENDPOINT"
        const val ACTION_UNREGISTERED = "org.unifiedpush.android.connector.UNREGISTERED"
        const val ACTION_REGISTRATION_FAILED = "org.unifiedpush.android.connector.REGISTRATION_FAILED"
    }
}
