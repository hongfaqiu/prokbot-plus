package dev.grokbot.local

import android.app.Application
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import java.util.concurrent.Executors

class GrokBotApp : Application() {
    lateinit var connections: ConnectionStore
        private set
    lateinit var settings: ClientSettings
        private set
    lateinit var tailcat: TailcatNetwork
        private set
    lateinit var gateway: LocalGateway
        private set
    lateinit var push: PushManager
        private set
    lateinit var updater: Updater
        private set

    private val networkExecutor = Executors.newSingleThreadExecutor { Thread(it, "grokbot-net-monitor").apply { isDaemon = true } }

    /** The workspace activity while it exists; native calls that need a window use it. */
    @Volatile var host: MainActivity? = null
    /** The conversation shown in the workspace, so its own notifications stay quiet. */
    @Volatile var viewingAgentId: String? = null
    @Volatile var inForeground = false

    override fun onCreate() {
        super.onCreate()
        connections = ConnectionStore(this)
        settings = ClientSettings(this)
        tailcat = TailcatNetwork()
        Notifications.createChannels(this)
        gateway = LocalGateway(this)
        gateway.connection = connections.loadOrNull()
        push = PushManager(this)
        updater = Updater(this)
        tailcat.onTunnelReset = {
            gateway.closeSseStreams("tailcat-reset")
            NotificationService.poke(this)
            host?.emitReconnectStreams()
        }
        tailcat.registerNetworkMonitor(this) { hasNetwork ->
            val current = gateway.connection ?: return@registerNetworkMonitor
            if (!hasNetwork) {
                gateway.closeSseStreams("network-lost")
                return@registerNetworkMonitor
            }
            networkExecutor.execute {
                val active = gateway.connection ?: return@execute
                if (active !== current) return@execute
                if (active.tailcat) {
                    val probe = tailcat.probeAndRecover(this, active, timeoutMs = 2500, notifyOnReset = false)
                    if (probe.restarted || !probe.reachable || gateway.maxSseIdleMs() >= 5_000L) {
                        gateway.closeSseStreams("network-change")
                        NotificationService.poke(this)
                        host?.emitReconnectStreams()
                    }
                } else {
                    gateway.closeSseStreams("network-change")
                    NotificationService.poke(this)
                    host?.emitReconnectStreams()
                }
            }
        }
        gateway.start()
    }

    fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: ActivityNotFoundException) {
            Log.w("GrokBot", "No app can open ${uri.scheme} links")
        }
    }

    companion object {
        fun of(context: Context): GrokBotApp = context.applicationContext as GrokBotApp
    }
}
