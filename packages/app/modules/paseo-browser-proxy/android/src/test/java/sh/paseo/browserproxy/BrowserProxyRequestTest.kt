package sh.paseo.browserproxy

import java.nio.charset.StandardCharsets
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BrowserProxyRequestTest {
  private val authorization = "Basic cGFzZW86c2VjcmV0"

  @Test
  fun `requires the generated proxy credential`() {
    val result = parse(
      "GET http://localhost:3000/ HTTP/1.1\r\nHost: localhost:3000\r\n\r\n",
    )

    assertEquals(BrowserProxyParseResult.AuthenticationRequired, result)
  }

  @Test
  fun `rejects a credential from an earlier proxy session`() {
    val result = BrowserProxyRequestParser.parse(
      (
        "GET http://localhost:3000/ HTTP/1.1\r\n" +
          "Host: localhost:3000\r\n" +
          "Proxy-Authorization: Basic b2xkOnNlc3Npb24=\r\n\r\n"
      ).toByteArray(StandardCharsets.ISO_8859_1),
      authorization,
    )

    assertEquals(BrowserProxyParseResult.AuthenticationRequired, result)
  }

  @Test
  fun `rewrites loopback absolute requests and strips proxy credentials`() {
    val result = parse(
      "GET http://localhost:5173/src/main.ts?x=1 HTTP/1.1\r\n" +
        "Host: localhost:5173\r\n" +
        "Proxy-Authorization: $authorization\r\n" +
        "Proxy-Connection: keep-alive\r\n" +
        "Connection: keep-alive\r\n\r\n",
    ) as BrowserProxyParseResult.Forward

    assertEquals("ipv4", result.host)
    assertEquals(5173, result.port)
    assertEquals(
      "GET /src/main.ts?x=1 HTTP/1.1\r\nHost: localhost:5173\r\nConnection: close\r\n\r\n",
      result.initialData.toString(StandardCharsets.ISO_8859_1),
    )
  }

  @Test
  fun `preserves websocket upgrades`() {
    val request =
      "GET ws://127.0.0.1:24678/socket HTTP/1.1\r\n" +
        "Host: 127.0.0.1:24678\r\n" +
        "Proxy-Authorization: $authorization\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n\r\n"
    val result = parse(request) as BrowserProxyParseResult.Forward

    assertArrayEquals(
      (
        "GET /socket HTTP/1.1\r\n" +
          "Host: 127.0.0.1:24678\r\n" +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n\r\n"
      ).toByteArray(StandardCharsets.ISO_8859_1),
      result.initialData,
    )
  }

  @Test
  fun `holds CONNECT until it can distinguish plaintext WebSocket from TLS`() {
    val connect = parse(
      "CONNECT localhost:443 HTTP/1.1\r\n" +
        "Host: localhost:443\r\n" +
        "Proxy-Authorization: $authorization\r\n\r\n",
    ) as BrowserProxyParseResult.Connect

    assertEquals("ipv4", connect.host)
    assertEquals(443, connect.port)
    assertTrue(BrowserProxyRequestParser.isTlsHandshake(0x16))
    assertTrue(BrowserProxyRequestParser.isTlsHandshake(0x80))
    assertFalse(BrowserProxyRequestParser.isTlsHandshake('G'.code))
  }

  @Test
  fun `forwards a plaintext WebSocket handshake after CONNECT`() {
    val connect = parse(
      "CONNECT localhost:24678 HTTP/1.1\r\n" +
        "Host: localhost:24678\r\n" +
        "Proxy-Authorization: $authorization\r\n\r\n",
    ) as BrowserProxyParseResult.Connect
    val result = BrowserProxyRequestParser.parseConnectedWebSocket(
      (
        "GET /socket HTTP/1.1\r\n" +
          "Host: localhost:24678\r\n" +
          "Proxy-Authorization: $authorization\r\n" +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n\r\n"
      ).toByteArray(StandardCharsets.ISO_8859_1),
      connect,
    ) as BrowserProxyParseResult.Forward

    assertEquals("ipv4", result.host)
    assertEquals(24678, result.port)
    assertTrue(result.initialData.toString(StandardCharsets.ISO_8859_1).contains("Upgrade: websocket"))
    assertFalse(
      result.initialData.toString(StandardCharsets.ISO_8859_1).contains("Proxy-Authorization"),
    )
  }

  @Test
  fun `rejects plaintext non-WebSocket traffic after CONNECT`() {
    val connect = parse(
      "CONNECT localhost:8443 HTTP/1.1\r\n" +
        "Host: localhost:8443\r\n" +
        "Proxy-Authorization: $authorization\r\n\r\n",
    ) as BrowserProxyParseResult.Connect
    val result = BrowserProxyRequestParser.parseConnectedWebSocket(
      "GET / HTTP/1.1\r\nHost: localhost:8443\r\n\r\n"
        .toByteArray(StandardCharsets.ISO_8859_1),
      connect,
    ) as BrowserProxyParseResult.Rejected

    assertEquals(501, result.statusCode)
    assertTrue(result.message.contains("HTTPS"))
  }

  @Test
  fun `rejects a WebSocket destination change after CONNECT`() {
    val connect = parse(
      "CONNECT localhost:24678 HTTP/1.1\r\n" +
        "Host: localhost:24678\r\n" +
        "Proxy-Authorization: $authorization\r\n\r\n",
    ) as BrowserProxyParseResult.Connect
    val result = BrowserProxyRequestParser.parseConnectedWebSocket(
      (
        "GET /socket HTTP/1.1\r\n" +
          "Host: app.localhost:24678\r\n" +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n\r\n"
      ).toByteArray(StandardCharsets.ISO_8859_1),
      connect,
    ) as BrowserProxyParseResult.Rejected

    assertEquals(403, result.statusCode)
  }

  @Test
  fun `rejects CONNECT to a non-loopback destination`() {
    val result = parse(
      "CONNECT example.com:443 HTTP/1.1\r\n" +
        "Host: example.com:443\r\n" +
        "Proxy-Authorization: $authorization\r\n\r\n",
    ) as BrowserProxyParseResult.Rejected

    assertEquals(403, result.statusCode)
  }

  @Test
  fun `rejects non-loopback destinations that reach the proxy`() {
    val result = parse(
      "GET http://example.com/ HTTP/1.1\r\n" +
        "Host: example.com\r\n" +
        "Proxy-Authorization: $authorization\r\n\r\n",
    ) as BrowserProxyParseResult.Rejected

    assertEquals(403, result.statusCode)
  }

  @Test
  fun `does not treat a hostname beginning with 127 as an IPv4 loopback address`() {
    val result = parse(
      "GET http://127.example.com/ HTTP/1.1\r\n" +
        "Host: 127.example.com\r\n" +
        "Proxy-Authorization: $authorization\r\n\r\n",
    ) as BrowserProxyParseResult.Rejected

    assertEquals(403, result.statusCode)
  }

  @Test
  fun `rejects unspecified listen addresses instead of forwarding them`() {
    val result = parse(
      "GET http://0.0.0.0:3000/ HTTP/1.1\r\n" +
        "Host: 0.0.0.0:3000\r\n" +
        "Proxy-Authorization: $authorization\r\n\r\n",
    ) as BrowserProxyParseResult.Rejected

    assertEquals(403, result.statusCode)
  }

  @Test
  fun `maps IPv6 loopback to the daemon IPv6 family`() {
    val result = parse(
      "GET http://[::1]:8080/ HTTP/1.1\r\n" +
        "Host: [::1]:8080\r\n" +
        "Proxy-Authorization: $authorization\r\n\r\n",
    ) as BrowserProxyParseResult.Forward

    assertEquals("ipv6", result.host)
    assertEquals(8080, result.port)
  }

  private fun parse(request: String): BrowserProxyParseResult =
    BrowserProxyRequestParser.parse(
      request.toByteArray(StandardCharsets.ISO_8859_1),
      authorization,
    )
}
