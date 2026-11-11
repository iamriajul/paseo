package sh.paseo.video

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The server browser's video view. JavaScript (packages/app/src/server-browser) parses the H.264
 * stream: it passes each picture in Annex B and, with every keyframe, the SPS and PPS. This module
 * only decodes and renders, with MediaCodec onto a TextureView.
 */
class PaseoVideoModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PaseoVideo")

    View(PaseoVideoView::class) {
      Events("onFrame", "onDecoderError")

      AsyncFunction("decode") {
        view: PaseoVideoView, id: Int, sample: ByteArray, key: Boolean, sps: ByteArray?, pps: ByteArray? ->
        view.decode(id, sample, key, sps, pps)
      }

      AsyncFunction("reset") { view: PaseoVideoView -> view.reset() }

      OnViewDestroys { view: PaseoVideoView -> view.destroy() }
    }
  }
}
