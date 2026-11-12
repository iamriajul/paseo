package sh.paseo.browserproxy

import android.util.Base64
import java.io.InputStream
import java.io.OutputStream
import java.net.BindException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * "Open on this phone": one listener per forwarded port on the phone's 127.0.0.1. Each accepted
 * socket is handed to JS, which opens the daemon TCP tunnel and pipes bytes through
 * writeConnection and the data events. Reading starts only once JS accepts the connection, so
 * no byte is read before its tunnel exists. Everything else (which ports, when to stop, the
 * tunnel) lives in JS.
 */
internal class PortForwardListeners(
  private val emitEvent: (String, Map<String, Any?>) -> Unit,
) {
  companion object {
    const val OPEN_EVENT = "onForwardConnectionOpen"
    const val DATA_EVENT = "onForwardConnectionData"
    const val CLOSE_EVENT = "onForwardConnectionClose"
    private const val HOST = "127.0.0.1"
    private const val IO_BUFFER_BYTES = 32 * 1024
  }

  private class Forward(val forwardId: String, val server: ServerSocket) {
    val connections: MutableSet<String> = ConcurrentHashMap.newKeySet()
  }

  private inner class Connection(val connectionId: String, val forward: Forward, val socket: Socket) {
    val accepted = AtomicBoolean(false)
    val closed = AtomicBoolean(false)
    private val output: OutputStream = socket.getOutputStream()

    fun readLoop() {
      val input: InputStream = socket.getInputStream()
      val buffer = ByteArray(IO_BUFFER_BYTES)
      try {
        while (!closed.get()) {
          val read = input.read(buffer)
          if (read < 0) break
          if (read == 0) continue
          emitEvent(
            DATA_EVENT,
            mapOf(
              "connectionId" to connectionId,
              "binaryBase64" to Base64.encodeToString(buffer, 0, read, Base64.NO_WRAP),
            ),
          )
        }
        close("Connection closed by this phone's browser.", true)
      } catch (error: Exception) {
        close(error.message ?: "Connection failed.", true)
      }
    }

    @Synchronized
    fun write(bytes: ByteArray) {
      if (closed.get()) return
      try {
        output.write(bytes)
        output.flush()
      } catch (error: Exception) {
        close(error.message ?: "Write failed.", true)
      }
    }

    fun close(reason: String, notify: Boolean) {
      if (!closed.compareAndSet(false, true)) return
      connections.remove(connectionId)
      forward.connections.remove(connectionId)
      runCatching { socket.close() }
      if (notify) {
        emitEvent(CLOSE_EVENT, mapOf("connectionId" to connectionId, "reason" to reason))
      }
    }
  }

  private val forwards = ConcurrentHashMap<String, Forward>()
  private val connections = ConcurrentHashMap<String, Connection>()
  private val executor: ExecutorService = Executors.newCachedThreadPool { runnable ->
    Thread(runnable, "paseo-port-forward").apply { isDaemon = true }
  }

  val forwardCount: Int
    get() = forwards.size

  /**
   * Binds `port` (or, when taken and `fallbackToAnyPort`, a free one). Returns the state JS
   * shows in the menu: forwarding with the local port, port-in-use, or failed.
   */
  fun start(forwardId: String, port: Int, fallbackToAnyPort: Boolean): Map<String, Any> {
    forwards[forwardId]?.let { existing ->
      return mapOf("state" to "forwarding", "localPort" to existing.server.localPort)
    }
    val server = try {
      bind(port)
    } catch (error: BindException) {
      if (!fallbackToAnyPort) return mapOf("state" to "port-in-use")
      try {
        bind(0)
      } catch (fallbackError: Exception) {
        return mapOf("state" to "failed", "error" to (fallbackError.message ?: "Bind failed."))
      }
    } catch (error: Exception) {
      return mapOf("state" to "failed", "error" to (error.message ?: "Bind failed."))
    }
    val forward = Forward(forwardId, server)
    forwards[forwardId] = forward
    executor.execute { acceptLoop(forward) }
    return mapOf("state" to "forwarding", "localPort" to server.localPort)
  }

  fun acceptConnection(connectionId: String) {
    val connection = connections[connectionId] ?: return
    if (!connection.accepted.compareAndSet(false, true)) return
    executor.execute { connection.readLoop() }
  }

  fun writeConnection(connectionId: String, binaryBase64: String) {
    val connection = connections[connectionId] ?: return
    val bytes = runCatching { Base64.decode(binaryBase64, Base64.DEFAULT) }.getOrElse {
      connection.close("Invalid data from the host tunnel.", true)
      return
    }
    connection.write(bytes)
  }

  fun closeConnection(connectionId: String, reason: String?) {
    connections[connectionId]?.close(reason ?: "Host tunnel closed.", false)
  }

  fun stop(forwardId: String) {
    val forward = forwards.remove(forwardId) ?: return
    runCatching { forward.server.close() }
    for (connectionId in forward.connections.toList()) {
      connections[connectionId]?.close("Forward stopped.", true)
    }
  }

  fun stopAll() {
    for (forwardId in forwards.keys.toList()) stop(forwardId)
  }

  private fun bind(port: Int): ServerSocket {
    val server = ServerSocket()
    try {
      // No SO_REUSEADDR: a port another app on this phone listens on must read as in use.
      server.reuseAddress = false
      server.bind(InetSocketAddress(InetAddress.getByName(HOST), port), 64)
      return server
    } catch (error: Exception) {
      runCatching { server.close() }
      throw error
    }
  }

  private fun acceptLoop(forward: Forward) {
    while (forwards[forward.forwardId] === forward) {
      val socket = try {
        forward.server.accept()
      } catch (error: Exception) {
        break
      }
      if (forwards[forward.forwardId] !== forward) {
        runCatching { socket.close() }
        break
      }
      runCatching { socket.tcpNoDelay = true }
      val connectionId = UUID.randomUUID().toString()
      val connection = try {
        Connection(connectionId, forward, socket)
      } catch (error: Exception) {
        runCatching { socket.close() }
        continue
      }
      connections[connectionId] = connection
      forward.connections.add(connectionId)
      emitEvent(
        OPEN_EVENT,
        mapOf("forwardId" to forward.forwardId, "connectionId" to connectionId),
      )
    }
  }
}
