package sh.paseo.browserproxy

import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PortForwardListenersTest {
  private val events = LinkedBlockingQueue<Pair<String, Map<String, Any?>>>()
  private val listeners = PortForwardListeners { name, payload -> events.add(name to payload) }

  private fun freePort(): Int = ServerSocket(0).use { it.localPort }

  @Test
  fun `binds the same port on 127_0_0_1 and hands each connection to JS`() {
    val port = freePort()
    val result = listeners.start("forward-1", port, false)
    assertEquals(mapOf("state" to "forwarding", "localPort" to port), result)

    Socket(InetAddress.getByName("127.0.0.1"), port).use {
      val (name, payload) = events.poll(5, TimeUnit.SECONDS)!!
      assertEquals(PortForwardListeners.OPEN_EVENT, name)
      assertEquals("forward-1", payload["forwardId"])
    }
    listeners.stopAll()
  }

  @Test
  fun `reports a taken port, and binds a free one only when asked`() {
    ServerSocket(0, 50, InetAddress.getByName("127.0.0.1")).use { taken ->
      assertEquals(mapOf("state" to "port-in-use"), listeners.start("a", taken.localPort, false))
      val fallback = listeners.start("b", taken.localPort, true)
      assertEquals("forwarding", fallback["state"])
      assertNotEquals(taken.localPort, fallback["localPort"])
    }
    listeners.stopAll()
  }

  @Test
  fun `stopping a forward closes its listener`() {
    val port = freePort()
    listeners.start("forward-1", port, false)
    assertEquals(1, listeners.forwardCount)
    listeners.stop("forward-1")
    assertEquals(0, listeners.forwardCount)
    // Binding the port again proves the listener let it go. A connect that expects a refusal
    // does not: `freePort` is an ephemeral port, and Linux can connect a socket to itself when
    // it picks that same port as the source, which failed CI once with nothing listening.
    val rebound = runCatching {
      ServerSocket(port, 50, InetAddress.getByName("127.0.0.1")).close()
    }
    assertTrue(rebound.isSuccess)
  }

  @Test
  fun `writes never block the caller when the browser stops reading, and close past the cap`() {
    val port = freePort()
    listeners.start("forward-1", port, false)
    Socket(InetAddress.getByName("127.0.0.1"), port).use { browser ->
      val (_, open) = events.poll(5, TimeUnit.SECONDS)!!
      val connectionId = open["connectionId"] as String
      // The browser never reads. Each call must return at once, however much is queued.
      val chunk = ByteArray(1024 * 1024)
      val started = System.nanoTime()
      repeat(12) { listeners.writeBytes(connectionId, chunk) }
      val elapsedMs = (System.nanoTime() - started) / 1_000_000
      assertTrue("writes took ${elapsedMs} ms", elapsedMs < 1_000)
      val (name, closed) = events.poll(5, TimeUnit.SECONDS)!!
      assertEquals(PortForwardListeners.CLOSE_EVENT, name)
      assertEquals(connectionId, closed["connectionId"])
      browser.close()
    }
    listeners.stopAll()
  }
}
