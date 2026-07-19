package com.ninthfreak.carfm

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * mDNS/Bonjour discovery of networked RTL-TCP servers via Android's NsdManager.
 * Browses for `_rtl_tcp._tcp` services, resolves each to host:port, and emits
 * VibeMdnsFound / VibeMdnsLost to JS — mirroring the iOS path folded into
 * VibePowerModule. No subnet scanning: we only see servers that advertise the
 * service (e.g. an rtl_tcp host running an mDNS advertiser).
 */
class VibeMdnsModule(private val reactCtx: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactCtx) {

    companion object {
        private const val TAG = "VibeMDNS"
        private const val SERVICE_TYPE = "_rtl_tcp._tcp."
        // VibeServer advertises its own service type so a discovered server is
        // known to speak the compressed VibeServer protocol (and whether it needs
        // a PIN) before the client connects.
        private const val VIBE_SERVICE_TYPE = "_vibesdr._tcp."

        private fun typeFor(proto: String) =
            if (proto == "vibeserver") VIBE_SERVICE_TYPE else SERVICE_TYPE
        private fun protoFor(serviceType: String) =
            if (serviceType.contains("vibesdr")) "vibeserver" else "rtltcp"
    }

    override fun getName() = "VibeMDNS"

    private val nsd: NsdManager? by lazy {
        reactCtx.getSystemService(Context.NSD_SERVICE) as? NsdManager
    }
    // One discovery listener per service type (NsdManager browses a single type
    // per listener), so we surface both RTL-TCP and VibeServer hosts at once.
    private val discoveryListeners = mutableListOf<NsdManager.DiscoveryListener>()

    // NsdManager.resolveService allows only one in-flight resolve at a time on
    // older APIs, so serialise them through a queue.
    private val resolveQueue = ConcurrentLinkedQueue<NsdServiceInfo>()
    private var resolving = false

    @ReactMethod
    fun startDiscovery() {
        val manager = nsd ?: return
        stopDiscovery()
        for (type in listOf(SERVICE_TYPE, VIBE_SERVICE_TYPE)) {
            val listener = object : NsdManager.DiscoveryListener {
                override fun onDiscoveryStarted(serviceType: String) {}
                override fun onDiscoveryStopped(serviceType: String) {}
                override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                    Log.w(TAG, "start discovery failed ($type): $errorCode")
                }
                override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
                override fun onServiceFound(info: NsdServiceInfo) {
                    enqueueResolve(info)
                }
                override fun onServiceLost(info: NsdServiceInfo) {
                    emit("VibeMdnsLost") { it.putString("name", info.serviceName) }
                }
            }
            try {
                manager.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, listener)
                discoveryListeners.add(listener)
            } catch (e: Exception) {
                Log.w(TAG, "discoverServices($type) threw: ${e.message}")
            }
        }
    }

    @ReactMethod
    fun stopDiscovery() {
        for (listener in discoveryListeners) {
            try { nsd?.stopServiceDiscovery(listener) } catch (_: Exception) {}
        }
        discoveryListeners.clear()
        resolveQueue.clear()
        resolving = false
    }

    private fun enqueueResolve(info: NsdServiceInfo) {
        resolveQueue.add(info)
        pumpResolve()
    }

    @Synchronized
    private fun pumpResolve() {
        if (resolving) return
        val manager = nsd ?: return
        val next = resolveQueue.poll() ?: return
        resolving = true
        val listener = object : NsdManager.ResolveListener {
            override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {
                resolving = false
                pumpResolve()
            }
            override fun onServiceResolved(info: NsdServiceInfo) {
                val host = info.host?.hostAddress
                val port = info.port
                if (host != null && port > 0) {
                    emit("VibeMdnsFound") {
                        it.putString("name", friendlyName(info))
                        it.putString("host", host)
                        it.putInt("port", port)
                        it.putString("proto", protoFor(info.serviceType ?: ""))
                        it.putBoolean("pin", txt(info, "pin") == "1")
                    }
                }
                resolving = false
                pumpResolve()
            }
        }
        try {
            manager.resolveService(next, listener)
        } catch (e: Exception) {
            Log.w(TAG, "resolveService threw: ${e.message}")
            resolving = false
            pumpResolve()
        }
    }

    /** Prefer the `name` TXT attribute; fall back to the service name. */
    private fun friendlyName(info: NsdServiceInfo): String {
        val n = txt(info, "name")
        return if (!n.isNullOrEmpty()) n else info.serviceName
    }

    /** Read a TXT attribute as UTF-8, or null. */
    private fun txt(info: NsdServiceInfo, key: String): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return null
        val raw = info.attributes?.get(key) ?: return null
        return try { String(raw, Charsets.UTF_8) } catch (_: Exception) { null }
    }

    // ── Advertise (register) THIS device's RTL-TCP server via mDNS ───────────
    private var registrationListener: NsdManager.RegistrationListener? = null

    /** Advertise an `_rtl_tcp._tcp` service so clients auto-discover this server.
     *  TXT `name` carries the friendly label. Re-registers if already advertising
     *  (e.g. the user edited the name). */
    @ReactMethod
    fun advertise(name: String, port: Int, proto: String, pinRequired: Boolean, promise: Promise) {
        val manager = nsd ?: run { promise.reject("no_nsd", "NSD unavailable"); return }
        stopAdvertiseInternal()
        val info = NsdServiceInfo().apply {
            serviceName = name
            serviceType = typeFor(proto)
            this.port = port
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                setAttribute("name", name)
                setAttribute("proto", proto)
                setAttribute("pin", if (pinRequired) "1" else "0")
            }
        }
        val listener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(info: NsdServiceInfo) {}
            override fun onRegistrationFailed(info: NsdServiceInfo, errorCode: Int) {
                Log.w(TAG, "advertise failed: $errorCode")
            }
            override fun onServiceUnregistered(info: NsdServiceInfo) {}
            override fun onUnregistrationFailed(info: NsdServiceInfo, errorCode: Int) {}
        }
        registrationListener = listener
        try {
            manager.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
            promise.resolve(null)
        } catch (e: Exception) {
            registrationListener = null
            promise.reject("advertise_threw", e.message)
        }
    }

    @ReactMethod
    fun stopAdvertise() { stopAdvertiseInternal() }

    private fun stopAdvertiseInternal() {
        val listener = registrationListener ?: return
        registrationListener = null
        try { nsd?.unregisterService(listener) } catch (_: Exception) {}
    }

    private fun emit(name: String, fill: (WritableMap) -> Unit) {
        try {
            val map = Arguments.createMap()
            fill(map)
            reactCtx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(name, map)
        } catch (e: Exception) {
            Log.w(TAG, "emit $name failed: ${e.message}")
        }
    }

    // NativeEventEmitter housekeeping (events arrive via RCTDeviceEventEmitter)
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Double) {}
}
