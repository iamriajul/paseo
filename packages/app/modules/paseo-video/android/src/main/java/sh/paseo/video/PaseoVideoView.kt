package sh.paseo.video

import android.content.Context
import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.os.Handler
import android.os.Looper
import android.view.Surface
import android.view.TextureView
import android.view.ViewGroup
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/**
 * Renders decoded frames into a TextureView that fills the view, aspect-fit like the JPEG Image.
 * Every frame rendered is reported (`onFrame`) so JavaScript can ack it to the daemon.
 */
class PaseoVideoView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext), TextureView.SurfaceTextureListener {

  private val onFrame by EventDispatcher<Map<String, Int>>()
  private val onDecoderError by EventDispatcher<Map<String, String>>()
  private val main = Handler(Looper.getMainLooper())
  private val textureView = TextureView(context)
  private var videoWidth = 0
  private var videoHeight = 0

  private val decoder = H264Decoder(
    onFrame = { id -> main.post { onFrame(mapOf("id" to id)) } },
    onError = { message -> main.post { onDecoderError(mapOf("message" to message)) } },
    onSize = { width, height ->
      main.post {
        videoWidth = width
        videoHeight = height
        fit()
      }
    },
  )

  // React Native does not lay out a native view's own children; let Android do it.
  override val shouldUseAndroidLayout = true

  init {
    setBackgroundColor(BACKGROUND)
    textureView.surfaceTextureListener = this
    addView(
      textureView,
      LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )
  }

  fun decode(id: Int, sample: ByteArray, key: Boolean, sps: ByteArray?, pps: ByteArray?) {
    decoder.decode(id, sample, key, sps, pps)
  }

  /** Keeps the last frame on screen; only the decoder starts over. */
  fun reset() {
    decoder.reset()
  }

  /** The view is gone for good (OnViewDestroys); a detach alone may be followed by a reattach. */
  fun destroy() {
    decoder.release()
  }

  override fun onSurfaceTextureAvailable(texture: SurfaceTexture, width: Int, height: Int) {
    decoder.setSurface(Surface(texture))
    fit()
  }

  override fun onSurfaceTextureSizeChanged(texture: SurfaceTexture, width: Int, height: Int) {
    fit()
  }

  override fun onSurfaceTextureDestroyed(texture: SurfaceTexture): Boolean {
    decoder.setSurface(null)
    return true
  }

  override fun onSurfaceTextureUpdated(texture: SurfaceTexture) = Unit

  /** Scales the stretched texture back to the video's aspect ratio, centred. */
  private fun fit() {
    val viewWidth = textureView.width.toFloat()
    val viewHeight = textureView.height.toFloat()
    if (viewWidth <= 0f || viewHeight <= 0f || videoWidth <= 0 || videoHeight <= 0) return
    val scale = minOf(viewWidth / videoWidth, viewHeight / videoHeight)
    val matrix = Matrix()
    matrix.setScale(
      videoWidth * scale / viewWidth,
      videoHeight * scale / viewHeight,
      viewWidth / 2f,
      viewHeight / 2f,
    )
    textureView.setTransform(matrix)
  }

  private companion object {
    const val BACKGROUND = 0xFF111111.toInt()
  }
}
