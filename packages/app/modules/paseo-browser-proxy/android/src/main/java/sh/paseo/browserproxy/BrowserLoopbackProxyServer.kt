package sh.paseo.browserproxy

import android.util.Base64
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

internal data class BrowserProxySession(
  val sessionId: String,
  val host: String,
  val port: Int,
  val realm: String,
  val username: String,
  val password: String,
) {
  fun toMap(): Map<String, Any> = mapOf(
    "sessionId" to sessionId,
    "host" to host,
    "port" to port,
    "realm" to realm,
    "username" to username,
    "password" to password,
  )
}

internal class BrowserLoopbackProxyServer(
  private val emitEvent: (String, Map<String, Any?>) -> Unit,
) {
  companion object {
    private const val HOST = "127.0.0.1"
    private const val MAX_HEADER_BYTES = 64 * 1024
    private const val IO_BUFFER_BYTES = 32 * 1024
    private const val HEADER_TIMEOUT_MS = 15_000
    private const val ACCEPT_TIMEOUT_SECONDS = 20L
  }

  private val sessionId = UUID.randomUUID().toString()
  private val username = "paseo"
  private val password = randomCredential()
  private val realm = "PaseoBrowser-$sessionId"
  private val expectedAuthorization = "Basic " + Base64.encodeToString(
    "$username:$password".toByteArray(StandardCharsets.UTF_8),
    Base64.NO_WRAP,
  )
  private val running = AtomicBoolean(false)
  private val connections = ConcurrentHashMap<String, ProxyConnection>()
  private val clientSockets = ConcurrentHashMap.newKeySet<Socket>()
  private val connectionExecutor = Executors.newCachedThreadPool { runnable ->
    Thread(runnable, "paseo-browser-proxy-connection").apply { isDaemon = true }
  }
  private val timeoutExecutor: ScheduledExecutorService =
    Executors.newSingleThreadScheduledExecutor { runnable ->
      Thread(runnable, "paseo-browser-proxy-timeout").apply { isDaemon = true }
    }
  private var serverSocket: ServerSocket? = null

  lateinit var session: BrowserProxySession
    private set

  fun start(): BrowserProxySession {
    check(running.compareAndSet(false, true)) { "Browser proxy is already running." }
    val socket = ServerSocket()
    try {
      socket.reuseAddress = true
      socket.bind(InetSocketAddress(InetAddress.getByName(HOST), 0), 64)
    } catch (error: Exception) {
      running.set(false)
      runCatching { socket.close() }
      connectionExecutor.shutdownNow()
      timeoutExecutor.shutdownNow()
      throw error
    }
    serverSocket = socket
    session = BrowserProxySession(
      sessionId = sessionId,
      host = HOST,
      port = socket.localPort,
      realm = realm,
      username = username,
      password = password,
    )
    try {
      connectionExecutor.execute { acceptLoop(socket) }
    } catch (error: Exception) {
      stop("Browser proxy failed to start.")
      throw error
    }
    return session
  }

  fun acceptConnection(connectionId: String) {
    val connection = connections[connectionId] ?: return
    if (!connection.accepted.compareAndSet(false, true)) return
    try {
      connection.socket.soTimeout = 0
      connectionExecutor.execute { connection.readLoop() }
    } catch (error: Exception) {
      connection.close(error.message ?: "Browser proxy route changed.", true)
    }
  }

  fun rejectConnection(connectionId: String, statusCode: Int, message: String) {
    connections[connectionId]?.respondAndClose(statusCode.coerceIn(400, 599), message)
  }

  fun writeConnection(connectionId: String, binaryBase64: String) {
    val bytes = runCatching { Base64.decode(binaryBase64, Base64.DEFAULT) }.getOrElse {
      connections[connectionId]?.close("Invalid response data from Browser tunnel.", true)
      return
    }
    connections[connectionId]?.write(bytes)
  }

  fun closeConnection(connectionId: String, reason: String?) {
    connections[connectionId]?.close(reason ?: "Browser tunnel closed.", false)
  }

  fun stop(reason: String = "Browser proxy stopped.") {
    if (!running.compareAndSet(true, false)) return
    runCatching { serverSocket?.close() }
    serverSocket = null
    for (connection in connections.values) {
      connection.close(reason, true)
    }
    connections.clear()
    for (socket in clientSockets) {
      closeClientSocket(socket)
    }
    clientSockets.clear()
    connectionExecutor.shutdownNow()
    timeoutExecutor.shutdownNow()
  }

  private fun acceptLoop(server: ServerSocket) {
    while (running.get()) {
      val socket = try {
        server.accept()
      } catch (error: Exception) {
        if (running.get()) emitError(null, error.message ?: "Browser proxy accept failed.")
        break
      }
      if (!running.get()) {
        runCatching { socket.close() }
        break
      }
      clientSockets.add(socket)
      try {
        connectionExecutor.execute { prepareConnection(socket) }
      } catch (error: Exception) {
        closeClientSocket(socket)
        if (running.get()) emitError(null, error.message ?: "Browser proxy connection failed.")
      }
    }
  }

  private fun prepareConnection(socket: Socket) {
    val input: BufferedInputStream
    val output: BufferedOutputStream
    try {
      socket.tcpNoDelay = true
      socket.soTimeout = HEADER_TIMEOUT_MS
      input = BufferedInputStream(socket.getInputStream(), IO_BUFFER_BYTES)
      output = BufferedOutputStream(socket.getOutputStream(), IO_BUFFER_BYTES)
    } catch (error: Exception) {
      closeClientSocket(socket)
      if (running.get()) emitError(null, error.message ?: "Browser proxy request failed.")
      return
    }
    val headerBytes = try {
      readHeader(input)
    } catch (error: Exception) {
      closeClientSocket(socket)
      if (running.get()) emitError(null, error.message ?: "Browser proxy request failed.")
      return
    }
    if (headerBytes == null) {
      respondAndClose(output, socket, 431, "Browser proxy headers are too large.")
      return
    }
    if (!running.get()) {
      closeClientSocket(socket)
      return
    }

    when (val parsed = BrowserProxyRequestParser.parse(headerBytes, expectedAuthorization)) {
      BrowserProxyParseResult.AuthenticationRequired -> {
        val response =
          "HTTP/1.1 407 Proxy Authentication Required\r\n" +
            "Proxy-Authenticate: Basic realm=\"$realm\"\r\n" +
            "Content-Length: 0\r\nConnection: close\r\n\r\n"
        runCatching {
          output.write(response.toByteArray(StandardCharsets.ISO_8859_1))
          output.flush()
        }
        closeClientSocket(socket)
      }

      is BrowserProxyParseResult.Rejected -> {
        emitError(null, parsed.message)
        respondAndClose(output, socket, parsed.statusCode, parsed.message)
      }

      is BrowserProxyParseResult.Connect ->
        prepareConnectedWebSocket(parsed, socket, input, output)

      is BrowserProxyParseResult.Forward ->
        forwardConnection(parsed, socket, input, output)
    }
  }

  private fun prepareConnectedWebSocket(
    connect: BrowserProxyParseResult.Connect,
    socket: Socket,
    input: BufferedInputStream,
    output: BufferedOutputStream,
  ) {
    // Chromium uses CONNECT for proxied WebSockets, including plaintext ws://.
    // A successful CONNECT lets us inspect the first tunneled bytes: only a
    // validated plaintext WebSocket upgrade may open a daemon TCP tunnel.
    val connectedResponse = "HTTP/1.1 200 Connection Established\r\n\r\n"
    try {
      output.write(connectedResponse.toByteArray(StandardCharsets.ISO_8859_1))
      output.flush()
      input.mark(1)
      val firstByte = input.read()
      if (firstByte < 0) {
        closeClientSocket(socket)
        return
      }
      input.reset()
      if (BrowserProxyRequestParser.isTlsHandshake(firstByte)) {
        emitError(null, "HTTPS and WSS are not supported for localhost. Use HTTP or WS.")
        closeClientSocket(socket)
        return
      }
    } catch (error: Exception) {
      closeClientSocket(socket)
      if (running.get()) emitError(null, error.message ?: "Browser proxy CONNECT failed.")
      return
    }

    val headerBytes = try {
      readHeader(input)
    } catch (error: Exception) {
      closeClientSocket(socket)
      if (running.get()) emitError(null, error.message ?: "WebSocket proxy request failed.")
      return
    }
    if (headerBytes == null) {
      emitError(null, "Malformed WebSocket request after CONNECT.")
      closeClientSocket(socket)
      return
    }

    when (val parsed = BrowserProxyRequestParser.parseConnectedWebSocket(headerBytes, connect)) {
      is BrowserProxyParseResult.Forward ->
        forwardConnection(parsed, socket, input, output)

      is BrowserProxyParseResult.Rejected -> {
        emitError(null, parsed.message)
        closeClientSocket(socket)
      }

      BrowserProxyParseResult.AuthenticationRequired,
      is BrowserProxyParseResult.Connect -> {
        emitError(null, "Malformed WebSocket request after CONNECT.")
        closeClientSocket(socket)
      }
    }
  }

  private fun forwardConnection(
    parsed: BrowserProxyParseResult.Forward,
    socket: Socket,
    input: BufferedInputStream,
    output: BufferedOutputStream,
  ) {
    val connectionId = UUID.randomUUID().toString()
    val connection = ProxyConnection(connectionId, socket, input, output)
    connections[connectionId] = connection
    if (!running.get()) {
      connection.close("Browser proxy route changed.", false)
      return
    }
    emitEvent(
      "onProxyConnectionOpen",
      mapOf(
        "sessionId" to sessionId,
        "connectionId" to connectionId,
        "host" to parsed.host,
        "port" to parsed.port,
        "initialDataBase64" to Base64.encodeToString(parsed.initialData, Base64.NO_WRAP),
      ),
    )
    try {
      timeoutExecutor.schedule(
        {
          if (!connection.accepted.get()) {
            connection.respondAndClose(504, "Timed out connecting to the workspace host.")
          }
        },
        ACCEPT_TIMEOUT_SECONDS,
        TimeUnit.SECONDS,
      )
    } catch (error: Exception) {
      connection.close(error.message ?: "Browser proxy route changed.", true)
    }
  }

  private fun readHeader(input: BufferedInputStream): ByteArray? {
    val output = ByteArrayOutputStream()
    var matched = 0
    val terminator = byteArrayOf(13, 10, 13, 10)
    while (output.size() < MAX_HEADER_BYTES) {
      val value = input.read()
      if (value < 0) return null
      output.write(value)
      matched = if (value.toByte() == terminator[matched]) matched + 1 else if (value == 13) 1 else 0
      if (matched == terminator.size) return output.toByteArray()
    }
    return null
  }

  private fun respondAndClose(
    output: BufferedOutputStream,
    socket: Socket,
    statusCode: Int,
    message: String,
  ) {
    val body = message.toByteArray(StandardCharsets.UTF_8)
    val response =
      "HTTP/1.1 $statusCode ${reasonPhrase(statusCode)}\r\n" +
        "Content-Type: text/plain; charset=utf-8\r\n" +
        "Content-Length: ${body.size}\r\n" +
        "Connection: close\r\n\r\n"
    runCatching {
      output.write(response.toByteArray(StandardCharsets.ISO_8859_1))
      output.write(body)
      output.flush()
    }
    closeClientSocket(socket)
  }

  private fun emitError(connectionId: String?, message: String) {
    emitEvent(
      "onProxyConnectionError",
      mapOf("sessionId" to sessionId, "connectionId" to connectionId, "message" to message),
    )
  }

  private fun closeClientSocket(socket: Socket) {
    clientSockets.remove(socket)
    runCatching { socket.close() }
  }

  private inner class ProxyConnection(
    private val connectionId: String,
    val socket: Socket,
    private val input: BufferedInputStream,
    private val output: BufferedOutputStream,
  ) {
    val accepted = AtomicBoolean(false)
    private val closed = AtomicBoolean(false)

    fun readLoop() {
      val buffer = ByteArray(IO_BUFFER_BYTES)
      try {
        while (!closed.get()) {
          val count = input.read(buffer)
          if (count < 0) break
          if (count == 0) continue
          emitEvent(
            "onProxyConnectionData",
            mapOf(
              "sessionId" to sessionId,
              "connectionId" to connectionId,
              "binaryBase64" to Base64.encodeToString(buffer, 0, count, Base64.NO_WRAP),
            ),
          )
        }
        close("Browser closed the proxy connection.", true)
      } catch (error: Exception) {
        close(error.message ?: "Browser proxy connection failed.", true)
      }
    }

    fun write(bytes: ByteArray) {
      if (closed.get()) return
      try {
        synchronized(output) {
          output.write(bytes)
          output.flush()
        }
      } catch (error: Exception) {
        close(error.message ?: "Writing Browser proxy response failed.", true)
      }
    }

    fun respondAndClose(statusCode: Int, message: String) {
      if (!closed.compareAndSet(false, true)) return
      connections.remove(connectionId, this)
      this@BrowserLoopbackProxyServer.respondAndClose(output, socket, statusCode, message)
      emitClose(message)
    }

    fun close(reason: String, shouldEmit: Boolean) {
      if (!closed.compareAndSet(false, true)) return
      connections.remove(connectionId, this)
      closeClientSocket(socket)
      if (shouldEmit) emitClose(reason)
    }

    private fun emitClose(reason: String) {
      emitEvent(
        "onProxyConnectionClose",
        mapOf("sessionId" to sessionId, "connectionId" to connectionId, "reason" to reason),
      )
    }
  }

  private fun reasonPhrase(statusCode: Int): String = when (statusCode) {
    400 -> "Bad Request"
    403 -> "Forbidden"
    407 -> "Proxy Authentication Required"
    426 -> "Upgrade Required"
    431 -> "Request Header Fields Too Large"
    501 -> "Not Implemented"
    502 -> "Bad Gateway"
    504 -> "Gateway Timeout"
    else -> "Proxy Error"
  }

  private fun randomCredential(): String {
    val bytes = ByteArray(24)
    SecureRandom().nextBytes(bytes)
    return Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
  }
}
