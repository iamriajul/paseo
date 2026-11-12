package sh.paseo.video

import android.media.MediaCodec
import android.media.MediaFormat
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.view.Surface
import java.nio.ByteBuffer

/**
 * One MediaCodec H.264 decoder, recreated from the SPS and PPS that come with every keyframe, in
 * asynchronous mode. Everything (the calls from JavaScript, MediaCodec's callbacks) runs on one
 * HandlerThread, so the state below needs no locking. Callbacks to the view run on that thread too.
 *
 * Each chunk's id travels as its presentation time, so the frame MediaCodec renders names the
 * chunk to ack. After a failure the decoder reports once and drops deltas until a keyframe
 * rebuilds it: chunks already queued behind a failure would otherwise each report one, and
 * JavaScript gives up on video after a few.
 */
class H264Decoder(
  private val onFrame: (id: Int) -> Unit,
  /** `interrupted`: the surface went away or changed, the stream itself decoded fine. */
  private val onError: (message: String, interrupted: Boolean) -> Unit,
  private val onSize: (width: Int, height: Int) -> Unit,
) {
  private class Chunk(val id: Int, val data: ByteArray, val key: Boolean)

  private val thread = HandlerThread("PaseoVideoDecoder").apply { start() }
  private val handler = Handler(thread.looper)
  private var codec: MediaCodec? = null
  private var surface: Surface? = null
  private var sps: ByteArray? = null
  private var pps: ByteArray? = null
  private val pending = ArrayDeque<Chunk>()
  private val freeInputs = ArrayDeque<Int>()
  private var waitingForKeyframe = false
  /** Bumped per codec: callbacks of a released codec are ignored. */
  private var generation = 0

  fun decode(id: Int, data: ByteArray, key: Boolean, sps: ByteArray?, pps: ByteArray?) {
    handler.post { decodeOnThread(id, data, key, sps, pps) }
  }

  /** JavaScript dropped its state; the next chunk it sends is a keyframe. */
  fun reset() {
    handler.post { releaseCodec() }
  }

  /**
   * A codec renders into one surface: a new one needs a new codec, built at the next keyframe.
   * Once a surface is back, JavaScript hears about it (interrupted) so it asks for that keyframe;
   * while there is none, the keyframes that arrive are dropped without a word.
   */
  fun setSurface(next: Surface?) {
    handler.post {
      val old = surface
      surface = next
      if (codec != null || waitingForKeyframe) {
        releaseCodec()
        waitingForKeyframe = true
        if (next != null) onError("The video surface changed", true)
      }
      // After the old codec's release task, which releaseCodec just queued: it renders into this surface.
      if (old != null && old != next) handler.post { old.release() }
    }
  }

  fun release() {
    handler.post {
      releaseCodec()
      // After the codec's own release task, which releaseCodec just queued.
      handler.post {
        surface?.release()
        surface = null
        thread.quitSafely()
      }
    }
  }

  private fun decodeOnThread(id: Int, data: ByteArray, key: Boolean, sps: ByteArray?, pps: ByteArray?) {
    if (waitingForKeyframe && !key) return
    if (key && sps != null && pps != null &&
      (codec == null || !sps.contentEquals(this.sps) || !pps.contentEquals(this.pps))
    ) {
      val target = surface
      if (target == null) {
        // The view is off screen; setSurface reports when it is back.
        fail("No video surface yet", interrupted = true)
        return
      }
      val problem = configure(sps, pps, target)
      if (problem != null) {
        fail(problem)
        return
      }
    }
    if (codec == null) {
      fail("No decoder yet: waiting for a keyframe")
      return
    }
    waitingForKeyframe = false
    pending.addLast(Chunk(id, data, key))
    feed()
  }

  /** Returns why the codec could not start, or null. */
  private fun configure(sps: ByteArray, pps: ByteArray, target: Surface): String? {
    releaseCodec()
    // Released below if it never starts: decoder instances are finite per process.
    var created: MediaCodec? = null
    return try {
      // The size is a hint: the decoder takes the real one from the SPS (onOutputFormatChanged).
      val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, 1600, 1600)
      format.setByteBuffer("csd-0", ByteBuffer.wrap(START_CODE + sps))
      format.setByteBuffer("csd-1", ByteBuffer.wrap(START_CODE + pps))
      format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, MAX_INPUT_BYTES)
      // Realtime: decode each frame as it comes rather than for throughput.
      format.setInteger(MediaFormat.KEY_PRIORITY, 0)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        format.setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
      }
      val next = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
      created = next
      val gen = ++generation
      next.setCallback(callback(gen), handler)
      next.configure(format, target, null, 0)
      next.start()
      codec = next
      this.sps = sps
      this.pps = pps
      null
    } catch (error: Exception) {
      // Its callbacks, if setCallback registered them, see an old generation from here on.
      generation++
      try {
        created?.release()
      } catch (_: Exception) {
      }
      "Could not start the H.264 decoder: ${error.message}"
    }
  }

  private fun callback(gen: Int) = object : MediaCodec.Callback() {
    override fun onInputBufferAvailable(codec: MediaCodec, index: Int) {
      if (gen != generation) return
      freeInputs.addLast(index)
      feed()
    }

    override fun onOutputBufferAvailable(codec: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
      if (gen != generation) return
      try {
        // true: render this buffer to the surface now.
        codec.releaseOutputBuffer(index, info.size > 0)
      } catch (error: IllegalStateException) {
        fail("Could not render a decoded frame: ${error.message}")
        return
      }
      if (info.size > 0) onFrame(info.presentationTimeUs.toInt())
    }

    override fun onError(codec: MediaCodec, error: MediaCodec.CodecException) {
      if (gen != generation) return
      fail("H.264 decoding failed: ${error.diagnosticInfo}")
    }

    override fun onOutputFormatChanged(codec: MediaCodec, format: MediaFormat) {
      if (gen != generation) return
      var width = format.getInteger(MediaFormat.KEY_WIDTH)
      var height = format.getInteger(MediaFormat.KEY_HEIGHT)
      // The decoded picture may be padded (16-pixel macroblocks); the crop is what to show.
      if (format.containsKey(KEY_CROP_RIGHT) && format.containsKey(KEY_CROP_LEFT)) {
        width = format.getInteger(KEY_CROP_RIGHT) - format.getInteger(KEY_CROP_LEFT) + 1
      }
      if (format.containsKey(KEY_CROP_BOTTOM) && format.containsKey(KEY_CROP_TOP)) {
        height = format.getInteger(KEY_CROP_BOTTOM) - format.getInteger(KEY_CROP_TOP) + 1
      }
      onSize(width, height)
    }
  }

  private fun feed() {
    val current = codec ?: return
    while (freeInputs.isNotEmpty() && pending.isNotEmpty()) {
      val index = freeInputs.removeFirst()
      val chunk = pending.removeFirst()
      try {
        val buffer = current.getInputBuffer(index) ?: continue
        buffer.clear()
        if (chunk.data.size > buffer.capacity()) {
          fail("A video chunk did not fit the decoder's input buffer")
          return
        }
        buffer.put(chunk.data)
        val flags = if (chunk.key) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0
        current.queueInputBuffer(index, 0, chunk.data.size, chunk.id.toLong(), flags)
      } catch (error: IllegalStateException) {
        fail("Could not queue a video chunk: ${error.message}")
        return
      }
    }
  }

  /** Reports once, then waits for a keyframe to build a new codec. */
  private fun fail(message: String, interrupted: Boolean = false) {
    releaseCodec()
    if (waitingForKeyframe) return
    waitingForKeyframe = true
    onError(message, interrupted)
  }

  /**
   * Detaches the codec at once (its later callbacks see an old generation and do nothing) and
   * stops it in a task of its own: this may run inside one of its callbacks, where stopping it is
   * not allowed.
   */
  private fun releaseCodec() {
    generation++
    freeInputs.clear()
    pending.clear()
    val current = codec ?: return
    codec = null
    sps = null
    pps = null
    handler.post {
      try {
        current.stop()
      } catch (_: IllegalStateException) {
      }
      current.release()
    }
  }

  private companion object {
    val START_CODE = byteArrayOf(0, 0, 0, 1)
    /** Comfortably above a 1600-pixel keyframe at the daemon's bitrates. */
    const val MAX_INPUT_BYTES = 4 * 1024 * 1024
    const val KEY_CROP_LEFT = "crop-left"
    const val KEY_CROP_RIGHT = "crop-right"
    const val KEY_CROP_TOP = "crop-top"
    const val KEY_CROP_BOTTOM = "crop-bottom"
  }
}
