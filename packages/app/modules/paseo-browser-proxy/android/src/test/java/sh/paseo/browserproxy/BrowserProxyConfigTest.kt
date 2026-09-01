package sh.paseo.browserproxy

import androidx.webkit.ProxyConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BrowserProxyConfigTest {
  @Test
  fun `explicit loopback rules follow the implicit bypass removal rule`() {
    val config = buildBrowserProxyConfig(
      BrowserProxySession(
        sessionId = "session",
        host = "127.0.0.1",
        port = 43123,
        realm = "realm",
        username = "user",
        password = "password",
      ),
    )

    val implicitBypassRemovalIndex = config.bypassRules.indexOf("<-loopback>")
    assertTrue(implicitBypassRemovalIndex >= 0)
    val explicitLoopbackRules = listOf(
      "localhost",
      "*.localhost",
      "localhost.",
      "*.localhost.",
      "127.*",
      "[::1]",
      "[::]",
      "0.0.0.0",
    )
    for (loopbackRule in explicitLoopbackRules) {
      assertTrue(
        "$loopbackRule must take precedence over <-loopback>",
        config.bypassRules.indexOf(loopbackRule) > implicitBypassRemovalIndex,
      )
    }
    assertTrue(config.isReverseBypassEnabled)
    assertEquals("http://127.0.0.1:43123", config.proxyRules.single().url)
    assertEquals(ProxyConfig.MATCH_ALL_SCHEMES, config.proxyRules.single().schemeFilter)
  }
}
