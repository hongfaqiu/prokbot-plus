package dev.grokbot.local

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

/** JNI bindings to Go mobile Tailcat tunnel compiled into libgroktailcat.so / libgroktailcatjni.so. */
object TailcatBridge {
    init {
        System.loadLibrary("groktailcat")
        System.loadLibrary("groktailcatjni")
    }

    @JvmStatic external fun nativeIdentity(): String
    @JvmStatic external fun nativeStart(configJson: String): String
    @JvmStatic external fun nativeStatus(handle: Int): String
    @JvmStatic external fun nativeStop(handle: Int)
}

/** Manages the active user-space Tailcat forward tunnel on loopback, mirroring iOS GBNetwork.m. */
class TailcatNetwork {
    class TunnelSession(
        val handle: Int,
        val localUrl: String,
        val link: String,
        val identityJson: String,
        @Volatile var path: String = "unknown",
    )

    private val lock = Any()
    private var active: TunnelSession? = null
    private var unhealthySinceMs = 0L
    private var wasReady = false
    private var lastAttemptMs = 0L
    private var failures = 0
    @Volatile var onTunnelReset: (() -> Unit)? = null
    @Volatile private var monitorRegistered = false
    @Volatile private var lastNetSignature: String? = null

    fun registerNetworkMonitor(context: Context, onNetworkChange: (Boolean) -> Unit) {
        if (monitorRegistered) return
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return
        monitorRegistered = true
        lastNetSignature = currentNetworkSignature(cm)
        runCatching {
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    handleNetworkChange(cm, onNetworkChange)
                }

                override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                    handleNetworkChange(cm, onNetworkChange)
                }

                override fun onLost(network: Network) {
                    handleNetworkChange(cm, onNetworkChange)
                }
            })
        }.onFailure { monitorRegistered = false }
    }

    private fun handleNetworkChange(cm: ConnectivityManager, onNetworkChange: (Boolean) -> Unit) {
        val sig = currentNetworkSignature(cm)
        if (sig == lastNetSignature) return
        lastNetSignature = sig
        Log.i(TAG, "Network changed: $sig")
        synchronized(lock) {
            unhealthySinceMs = 0L
            failures = 0
            lastAttemptMs = 0L
        }
        onNetworkChange(sig != "none")
    }

    private fun currentNetworkSignature(cm: ConnectivityManager): String {
        val activeNet = cm.activeNetwork ?: return "none"
        val caps = cm.getNetworkCapabilities(activeNet) ?: return "unknown"
        val transports = buildString {
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) append('W')
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) append('C')
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) append('E')
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) append('V')
        }
        return "${activeNet.networkHandle}:$transports"
    }

    fun normalizeLink(context: Context, input: String): String {
        val raw = Pairing.halfWidth(input)
        val invalid = PairingException(
            Text.t(context, "请输入有效的 Tailcat 连接链接。", "Enter a valid Tailcat connection link."),
        )
        if (RAW_ADDRESS.matches(raw)) return "tailcat://connect/$raw?port=8000"
        val uri = try { URI(raw) } catch (_: Exception) { throw invalid }
        val scheme = uri.scheme?.lowercase()
        val host = uri.host?.lowercase()
        val address = uri.rawPath?.removePrefix("/") ?: ""
        val query = uri.rawQuery ?: ""
        val portMatch = PORT_QUERY.matchEntire(query)
        val port = portMatch?.groupValues?.get(1)?.toIntOrNull() ?: 0
        if (scheme != "tailcat" || host != "connect" || uri.rawUserInfo != null || uri.rawFragment != null ||
            !RAW_ADDRESS.matches(address) || port !in 1..65535
        ) {
            throw invalid
        }
        return "tailcat://connect/$address?port=$port"
    }

    fun startPending(context: Context, input: String, reuseIdentity: String? = null): TunnelSession {
        val link = normalizeLink(context, input)
        val identityJson = reuseIdentity?.takeIf { it.isNotBlank() } ?: TailcatBridge.nativeIdentity()
        val identityObj = try { JSONObject(identityJson) } catch (_: Exception) {
            JSONObject(TailcatBridge.nativeIdentity())
        }
        val config = JSONObject()
            .put("mode", "forward")
            .put("link", link)
            .put("identity", identityObj)
        val reply = try {
            JSONObject(TailcatBridge.nativeStart(config.toString()))
        } catch (_: Exception) {
            throw PairingException(Text.t(context, "无法启动 Tailcat 连接。", "Could not start Tailcat."))
        }
        val handle = reply.optInt("handle", 0)
        val status = reply.optJSONObject("status")
        val localUrl = status?.optString("localURL").orEmpty()
        val listening = status?.optBoolean("listening") == true
        if (handle <= 0 || !listening || !localUrl.startsWith("http://127.0.0.1:")) {
            if (handle > 0) TailcatBridge.nativeStop(handle)
            throw PairingException(Text.t(context, "无法连接，请检查 Tailcat 链接后重试。", "Could not connect. Check the Tailcat link and try again."))
        }
        return TunnelSession(
            handle = handle,
            localUrl = localUrl,
            link = link,
            identityJson = identityObj.toString(),
            path = status?.optString("path", "unknown").orEmpty().ifEmpty { "unknown" },
        )
    }

    fun commitPending(pending: TunnelSession) {
        val old: TunnelSession?
        synchronized(lock) {
            old = active
            active = pending
            unhealthySinceMs = 0L
            wasReady = false
            lastAttemptMs = 0L
            failures = 0
        }
        if (old != null && old.handle != pending.handle) {
            TailcatBridge.nativeStop(old.handle)
            onTunnelReset?.invoke()
        }
    }

    fun dropPending(pending: TunnelSession?) {
        if (pending == null) return
        val isActive = synchronized(lock) { active?.handle == pending.handle }
        if (!isActive) TailcatBridge.nativeStop(pending.handle)
    }

    data class ProbeResult(val reachable: Boolean, val restarted: Boolean)

    fun resolveServer(context: Context, connection: Connection, notifyOnReset: Boolean = true): String {
        if (!connection.tailcat) return connection.server
        var restartedTunnel = false
        val url = synchronized(lock) {
            val now = SystemClock.elapsedRealtime()
            val current = active
            if (current != null && current.link == connection.server) {
                val status = parseStatus(TailcatBridge.nativeStatus(current.handle))
                val listening = status?.optBoolean("listening") == true
                if (listening) {
                    val path = status?.optString("path").orEmpty().ifEmpty { "unknown" }
                    current.path = path
                    val state = status?.optString("state").orEmpty()
                    val error = status?.optString("error").orEmpty()
                    if (state == "ready" && error.isEmpty()) {
                        unhealthySinceMs = 0L
                        wasReady = true
                        return@synchronized current.localUrl
                    }
                    if (unhealthySinceMs == 0L || now < unhealthySinceMs) unhealthySinceMs = now
                    val graceMs = if (wasReady) PEER_RECOVERY_GRACE_MS else PEER_INITIAL_GRACE_MS
                    if (error.isEmpty() && now - unhealthySinceMs < graceMs) return@synchronized current.localUrl
                }
            }
            val backoffMs = minOf(10_000L, 500L shl minOf(failures, 4))
            if (failures > 0 && now >= lastAttemptMs && now - lastAttemptMs < backoffMs) {
                if (current != null) return@synchronized current.localUrl
            }
            lastAttemptMs = now
            active = null
            if (current != null) {
                TailcatBridge.nativeStop(current.handle)
                restartedTunnel = true
            }
            try {
                val restarted = startPending(context, connection.server, reuseIdentity = connection.networkIdentity)
                active = restarted
                unhealthySinceMs = now
                wasReady = false
                failures = 0
                restarted.localUrl
            } catch (error: Exception) {
                failures = minOf(failures + 1, 8)
                Log.w(TAG, "Tailcat start failed: ${error.message}")
                throw error
            }
        }
        if (restartedTunnel && notifyOnReset) onTunnelReset?.invoke()
        return url
    }

    /** Probes Host `/health` through direct or Tailcat link; restarts Tailcat immediately if unreachable. */
    fun probeAndRecover(
        context: Context,
        connection: Connection,
        timeoutMs: Int = 2500,
        notifyOnReset: Boolean = true,
    ): ProbeResult {
        val base = try { resolveServer(context, connection, notifyOnReset = notifyOnReset) } catch (_: Exception) {
            return ProbeResult(reachable = false, restarted = false)
        }
        if (probeHealth(base, timeoutMs)) return ProbeResult(reachable = true, restarted = false)
        if (!connection.tailcat) return ProbeResult(reachable = false, restarted = false)
        Log.i(TAG, "Tailcat health probe failed; restarting tunnel")
        val old: TunnelSession?
        synchronized(lock) {
            old = active
            active = null
            unhealthySinceMs = 0L
            wasReady = false
            lastAttemptMs = 0L
            failures = 0
        }
        if (old != null) TailcatBridge.nativeStop(old.handle)
        val restarted = try { resolveServer(context, connection, notifyOnReset = false) } catch (_: Exception) { null }
        if (notifyOnReset) onTunnelReset?.invoke()
        return ProbeResult(reachable = restarted != null, restarted = true)
    }

    private fun probeHealth(baseUrl: String, timeoutMs: Int): Boolean {
        val conn = runCatching { URL("$baseUrl/health").openConnection() as HttpURLConnection }.getOrNull() ?: return false
        return try {
            conn.instanceFollowRedirects = false
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
            conn.useCaches = false
            conn.responseCode in 200..299
        } catch (_: Exception) {
            false
        } finally {
            conn.disconnect()
        }
    }

    fun transportPath(connection: Connection?): String {
        if (connection == null || !connection.tailcat) return "direct"
        val current = synchronized(lock) { active } ?: return "unknown"
        val status = parseStatus(TailcatBridge.nativeStatus(current.handle)) ?: return current.path
        val path = status.optString("path").orEmpty().ifEmpty { current.path }
        current.path = path
        return path
    }

    fun clear() {
        val old: TunnelSession?
        synchronized(lock) {
            old = active
            active = null
            unhealthySinceMs = 0L
            wasReady = false
            lastAttemptMs = 0L
            failures = 0
        }
        if (old != null) {
            TailcatBridge.nativeStop(old.handle)
            onTunnelReset?.invoke()
        }
    }

    private fun parseStatus(raw: String): JSONObject? =
        try { JSONObject(raw) } catch (_: Exception) { null }

    companion object {
        private const val TAG = "GrokBotTailcat"
        private const val PEER_INITIAL_GRACE_MS = 25_000L
        private const val PEER_RECOVERY_GRACE_MS = 10_000L
        private val RAW_ADDRESS = Regex("^tc[A-Za-z0-9_-]{30,16384}$")
        private val PORT_QUERY = Regex("^port=([1-9][0-9]{0,4})$")
    }
}
