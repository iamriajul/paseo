package sh.paseo.browserproxy

import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewDatabase
import androidx.core.content.ContextCompat
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executor

class PaseoBrowserProxyModule : Module() {
  companion object {
    private const val OPEN_EVENT = "onProxyConnectionOpen"
    private const val DATA_EVENT = "onProxyConnectionData"
    private const val CLOSE_EVENT = "onProxyConnectionClose"
    private const val ERROR_EVENT = "onProxyConnectionError"
  }

  private var proxyServer: BrowserLoopbackProxyServer? = null
  private var proxyGeneration = 0L

  @Synchronized
  private fun nextProxyGeneration(): Long {
    proxyGeneration += 1
    return proxyGeneration
  }

  @Synchronized
  private fun isCurrentProxyGeneration(generation: Long): Boolean =
    proxyGeneration == generation

  override fun definition() = ModuleDefinition {
    Name("PaseoBrowserProxy")
    Events(OPEN_EVENT, DATA_EVENT, CLOSE_EVENT, ERROR_EVENT)

    Function("getSupportStatus") {
      mapOf(
        "proxyOverride" to WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE),
        "reverseBypass" to WebViewFeature.isFeatureSupported(
          WebViewFeature.PROXY_OVERRIDE_REVERSE_BYPASS,
        ),
      )
    }

    AsyncFunction("startProxy") { promise: Promise ->
      val generation = nextProxyGeneration()
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("ERR_BROWSER_PROXY_CONTEXT", "Android application context is unavailable.", null)
        return@AsyncFunction
      }
      if (
        !WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE) ||
        !WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE_REVERSE_BYPASS)
      ) {
        promise.reject(
          "ERR_BROWSER_PROXY_UNSUPPORTED",
          "Update Android System WebView to use Browser.",
          null,
        )
        return@AsyncFunction
      }

      val executor = ContextCompat.getMainExecutor(context)
      clearCurrentProxy(executor) {
        if (!isCurrentProxyGeneration(generation)) {
          promise.reject("ERR_BROWSER_PROXY_CANCELED", "Browser proxy start was superseded.", null)
          return@clearCurrentProxy
        }
        try {
          val server = BrowserLoopbackProxyServer { eventName, payload ->
            sendEvent(eventName, payload)
          }
          val session = server.start()
          if (!isCurrentProxyGeneration(generation)) {
            server.stop("Browser proxy start was superseded.")
            promise.reject("ERR_BROWSER_PROXY_CANCELED", "Browser proxy start was superseded.", null)
            return@clearCurrentProxy
          }
          proxyServer = server
          val config = ProxyConfig.Builder()
            .addProxyRule("http://${session.host}:${session.port}", ProxyConfig.MATCH_ALL_SCHEMES)
            .addBypassRule("localhost")
            .addBypassRule("*.localhost")
            .addBypassRule("localhost.")
            .addBypassRule("*.localhost.")
            .addBypassRule("127.*")
            .addBypassRule("[::1]")
            // Unspecified addresses are not valid tunnel targets. Sink them into the
            // authenticated proxy so they fail closed instead of reaching the phone.
            .addBypassRule("[::]")
            .addBypassRule("0.0.0.0")
            .removeImplicitRules()
            .setReverseBypassEnabled(true)
            .build()
          ProxyController.getInstance().setProxyOverride(config, executor) {
            if (isCurrentProxyGeneration(generation) && proxyServer === server) {
              promise.resolve(session.toMap())
            } else {
              server.stop("Browser proxy start was superseded.")
              promise.reject(
                "ERR_BROWSER_PROXY_CANCELED",
                "Browser proxy start was superseded.",
                null,
              )
            }
          }
        } catch (error: Exception) {
          if (isCurrentProxyGeneration(generation)) {
            proxyServer?.stop("Browser proxy failed to start.")
            proxyServer = null
          }
          promise.reject("ERR_BROWSER_PROXY_START", error.message, error)
        }
      }
    }

    AsyncFunction("stopProxy") { promise: Promise ->
      nextProxyGeneration()
      val context = appContext.reactContext
      if (context == null) {
        proxyServer?.stop()
        proxyServer = null
        promise.resolve(null)
        return@AsyncFunction
      }
      clearCurrentProxy(ContextCompat.getMainExecutor(context)) {
        promise.resolve(null)
      }
    }

    Function("acceptConnection") { connectionId: String ->
      proxyServer?.acceptConnection(connectionId)
    }

    Function("rejectConnection") { connectionId: String, statusCode: Int, message: String ->
      proxyServer?.rejectConnection(connectionId, statusCode, message)
    }

    Function("writeConnection") { connectionId: String, binaryBase64: String ->
      proxyServer?.writeConnection(connectionId, binaryBase64)
    }

    Function("closeConnection") { connectionId: String, reason: String? ->
      proxyServer?.closeConnection(connectionId, reason)
    }

    AsyncFunction("clearBrowserData") { promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("ERR_BROWSER_DATA_CONTEXT", "Android application context is unavailable.", null)
        return@AsyncFunction
      }
      val executor = ContextCompat.getMainExecutor(context)
      executor.execute {
        try {
          WebStorage.getInstance().deleteAllData()
          WebViewDatabase.getInstance(context).apply {
            clearFormData()
            clearHttpAuthUsernamePassword()
          }
          val webView = WebView(context)
          webView.clearCache(true)
          webView.clearFormData()
          webView.clearHistory()
          webView.destroy()
          CookieManager.getInstance().removeAllCookies {
            CookieManager.getInstance().flush()
            promise.resolve(null)
          }
        } catch (error: Exception) {
          promise.reject("ERR_BROWSER_DATA_CLEAR", error.message, error)
        }
      }
    }

    OnDestroy {
      nextProxyGeneration()
      proxyServer?.stop("Android Browser module was destroyed.")
      proxyServer = null
      val context = appContext.reactContext
      if (
        context != null &&
        WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)
      ) {
        val executor = ContextCompat.getMainExecutor(context)
        ProxyController.getInstance().clearProxyOverride(executor) {}
      }
    }
  }

  private fun clearCurrentProxy(executor: Executor, onCleared: () -> Unit) {
    proxyServer?.stop("Android Browser proxy route changed.")
    proxyServer = null
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
      onCleared()
      return
    }
    ProxyController.getInstance().clearProxyOverride(executor, onCleared)
  }
}
