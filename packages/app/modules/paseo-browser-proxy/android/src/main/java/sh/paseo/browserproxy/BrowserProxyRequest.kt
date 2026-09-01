package sh.paseo.browserproxy

import java.net.URI
import java.nio.charset.StandardCharsets

internal sealed interface BrowserProxyParseResult {
  data object AuthenticationRequired : BrowserProxyParseResult

  data class Rejected(
    val statusCode: Int,
    val message: String,
  ) : BrowserProxyParseResult

  data class Forward(
    val host: String,
    val port: Int,
    val initialData: ByteArray,
  ) : BrowserProxyParseResult

  data class Connect(
    val host: String,
    val targetHostname: String,
    val port: Int,
  ) : BrowserProxyParseResult
}

internal object BrowserProxyRequestParser {
  private const val MAX_PORT = 65_535

  fun parse(headerBytes: ByteArray, expectedProxyAuthorization: String): BrowserProxyParseResult {
    val headerText = headerBytes.toString(StandardCharsets.ISO_8859_1)
    val lines = headerText.split("\r\n")
    val requestLine = lines.firstOrNull()?.trim().orEmpty()
    val requestParts = requestLine.split(' ', limit = 3)
    if (requestParts.size != 3) {
      return BrowserProxyParseResult.Rejected(400, "Malformed HTTP proxy request.")
    }

    val headers = parseHeaders(lines.drop(1))
      ?: return BrowserProxyParseResult.Rejected(400, "Malformed HTTP proxy headers.")
    val authorization = headers.firstOrNull {
      it.name.equals("Proxy-Authorization", ignoreCase = true)
    }?.value
    if (authorization != expectedProxyAuthorization) {
      return BrowserProxyParseResult.AuthenticationRequired
    }

    val method = requestParts[0]
    val target = requestParts[1]
    val version = requestParts[2]
    if (method.equals("CONNECT", ignoreCase = true)) {
      val destination = parseAuthority(target, 443)
        ?: return BrowserProxyParseResult.Rejected(400, "Malformed HTTPS tunnel target.")
      if (!isLoopbackHostname(destination.host)) {
        return BrowserProxyParseResult.Rejected(403, "Only loopback destinations may use this proxy.")
      }
      return BrowserProxyParseResult.Connect(
        host = tunnelHost(destination.host),
        targetHostname = destination.host,
        port = destination.port,
      )
    }

    val destination = parseHttpTarget(target, headers)
      ?: return BrowserProxyParseResult.Rejected(400, "Malformed HTTP proxy target.")
    if (!isLoopbackHostname(destination.host)) {
      return BrowserProxyParseResult.Rejected(403, "Only loopback destinations may use this proxy.")
    }
    if (destination.scheme != "http" && destination.scheme != "ws") {
      return BrowserProxyParseResult.Rejected(
        501,
        "HTTPS and WSS are not supported for localhost. Use HTTP or WS.",
      )
    }

    val isWebSocket =
      hasHeaderToken(headers, "Connection", "upgrade") &&
        hasHeaderToken(headers, "Upgrade", "websocket")
    val rewritten = buildString {
      append(method)
      append(' ')
      append(destination.originForm)
      append(' ')
      append(version)
      append("\r\n")
      for (header in headers) {
        if (
          header.name.equals("Proxy-Authorization", ignoreCase = true) ||
          header.name.equals("Proxy-Connection", ignoreCase = true) ||
          (!isWebSocket && header.name.equals("Connection", ignoreCase = true))
        ) {
          continue
        }
        append(header.name)
        append(": ")
        append(header.value)
        append("\r\n")
      }
      if (!isWebSocket) {
        append("Connection: close\r\n")
      }
      append("\r\n")
    }

    return BrowserProxyParseResult.Forward(
      host = tunnelHost(destination.host),
      port = destination.port,
      initialData = rewritten.toByteArray(StandardCharsets.ISO_8859_1),
    )
  }

  fun parseConnectedWebSocket(
    headerBytes: ByteArray,
    connect: BrowserProxyParseResult.Connect,
  ): BrowserProxyParseResult {
    val headerText = headerBytes.toString(StandardCharsets.ISO_8859_1)
    val lines = headerText.split("\r\n")
    val requestParts = lines.firstOrNull()?.trim().orEmpty().split(' ', limit = 3)
    if (requestParts.size != 3 || !requestParts[0].equals("GET", ignoreCase = true)) {
      return BrowserProxyParseResult.Rejected(
        501,
        "HTTPS and WSS are not supported for localhost. Use HTTP or WS.",
      )
    }

    val headers = parseHeaders(lines.drop(1))
      ?: return BrowserProxyParseResult.Rejected(400, "Malformed WebSocket proxy headers.")
    val isWebSocket =
      hasHeaderToken(headers, "Connection", "upgrade") &&
        hasHeaderToken(headers, "Upgrade", "websocket")
    if (!isWebSocket) {
      return BrowserProxyParseResult.Rejected(
        501,
        "HTTPS and WSS are not supported for localhost. Use HTTP or WS.",
      )
    }

    val destination = parseHttpTarget(requestParts[1], headers)
      ?: return BrowserProxyParseResult.Rejected(400, "Malformed WebSocket proxy target.")
    if (
      destination.host != connect.targetHostname ||
      destination.port != connect.port ||
      (destination.scheme != "http" && destination.scheme != "ws")
    ) {
      return BrowserProxyParseResult.Rejected(403, "WebSocket tunnel target changed after CONNECT.")
    }

    val rewritten = buildString {
      append(requestParts[0])
      append(' ')
      append(destination.originForm)
      append(' ')
      append(requestParts[2])
      append("\r\n")
      for (header in headers) {
        if (
          header.name.equals("Proxy-Authorization", ignoreCase = true) ||
          header.name.equals("Proxy-Connection", ignoreCase = true)
        ) {
          continue
        }
        append(header.name)
        append(": ")
        append(header.value)
        append("\r\n")
      }
      append("\r\n")
    }
    return BrowserProxyParseResult.Forward(
      host = connect.host,
      port = connect.port,
      initialData = rewritten.toByteArray(StandardCharsets.ISO_8859_1),
    )
  }

  fun isTlsHandshake(firstByte: Int): Boolean = firstByte == 0x16 || (firstByte and 0x80) != 0

  private data class Header(val name: String, val value: String)

  private data class Destination(
    val scheme: String,
    val host: String,
    val port: Int,
    val originForm: String,
  )

  private data class Authority(val host: String, val port: Int)

  private fun parseHeaders(lines: List<String>): List<Header>? {
    val headers = mutableListOf<Header>()
    for (line in lines) {
      if (line.isEmpty()) {
        break
      }
      val separator = line.indexOf(':')
      if (separator <= 0) {
        return null
      }
      headers += Header(line.substring(0, separator).trim(), line.substring(separator + 1).trim())
    }
    return headers
  }

  private fun hasHeaderToken(headers: List<Header>, name: String, token: String): Boolean =
    headers.any { header ->
      header.name.equals(name, ignoreCase = true) &&
        header.value.split(',').any { value -> value.trim().equals(token, ignoreCase = true) }
    }

  private fun parseHttpTarget(target: String, headers: List<Header>): Destination? {
    val absolute = runCatching { URI(target) }.getOrNull()
    if (absolute?.isAbsolute == true) {
      val scheme = absolute.scheme?.lowercase() ?: return null
      val host = absolute.host ?: return null
      val defaultPort = if (scheme == "https" || scheme == "wss") 443 else 80
      val port = if (absolute.port >= 0) absolute.port else defaultPort
      if (port !in 1..MAX_PORT) return null
      val path = absolute.rawPath?.takeIf { it.isNotEmpty() } ?: "/"
      val originForm = absolute.rawQuery?.let { "$path?$it" } ?: path
      return Destination(scheme, normalizeHostname(host), port, originForm)
    }

    val hostHeader = headers.firstOrNull { it.name.equals("Host", ignoreCase = true) }?.value
      ?: return null
    val authority = parseAuthority(hostHeader, 80) ?: return null
    val originForm = if (target.startsWith('/')) target else "/$target"
    return Destination("http", authority.host, authority.port, originForm)
  }

  private fun parseAuthority(value: String, defaultPort: Int): Authority? {
    val trimmed = value.trim()
    if (trimmed.isEmpty()) return null
    val uri = runCatching { URI("http://$trimmed") }.getOrNull() ?: return null
    val host = uri.host ?: return null
    val port = if (uri.port >= 0) uri.port else defaultPort
    if (port !in 1..MAX_PORT) return null
    return Authority(normalizeHostname(host), port)
  }

  private fun normalizeHostname(value: String): String =
    value.trim().lowercase().removePrefix("[").removeSuffix("]").removeSuffix(".")

  private fun isIpv6Loopback(host: String): Boolean {
    val normalized = normalizeHostname(host)
    return normalized == "::1"
  }

  private fun tunnelHost(host: String): String = if (isIpv6Loopback(host)) "ipv6" else "ipv4"

  private fun isIpv4Loopback(host: String): Boolean {
    val parts = normalizeHostname(host).split('.')
    return parts.size == 4 &&
      parts[0] == "127" &&
      parts.drop(1).all { part -> part.toIntOrNull()?.let { it in 0..255 } == true }
  }

  internal fun isLoopbackHostname(host: String): Boolean {
    val normalized = normalizeHostname(host)
    return normalized == "localhost" ||
      normalized.endsWith(".localhost") ||
      normalized == "::1" ||
      isIpv4Loopback(normalized)
  }
}
