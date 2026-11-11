import ExpoModulesCore

/**
 * The server browser's video view. JavaScript (packages/app/src/server-browser) parses the
 * H.264 stream: it passes each picture as AVCC and, with every keyframe, the SPS and PPS. This
 * module only decodes (VideoToolbox) and shows (AVSampleBufferDisplayLayer).
 */
public class PaseoVideoModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PaseoVideo")

    View(PaseoVideoView.self) {
      Events("onFrame", "onDecoderError")

      AsyncFunction("decode") {
        (view: PaseoVideoView, id: Int, sample: Data, key: Bool, sps: Data?, pps: Data?) in
        view.decode(id: id, sample: sample, key: key, sps: sps, pps: pps)
      }

      AsyncFunction("reset") { (view: PaseoVideoView) in
        view.reset()
      }
    }
  }
}
