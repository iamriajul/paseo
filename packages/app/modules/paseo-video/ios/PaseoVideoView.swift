import AVFoundation
import CoreMedia
import ExpoModulesCore
import UIKit

/**
 * Shows decoded frames in an AVSampleBufferDisplayLayer, aspect-fit like the JPEG view, each
 * marked to display immediately: the viewer shows the newest frame, it does not play a timeline.
 * Every frame on screen is reported (`onFrame`) so JavaScript can ack it to the daemon.
 */
final class PaseoVideoView: ExpoView {
  let onFrame = EventDispatcher()
  let onDecoderError = EventDispatcher()
  private let displayLayer = AVSampleBufferDisplayLayer()
  /**
   * Set once in init. Not lazy: decode() may run off the main queue while frames land on it, and
   * a lazy property's first access is not thread-safe.
   */
  private var decoder: H264Decoder!

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    decoder = H264Decoder(
      onFrame: { [weak self] id, image in self?.show(id: id, image: image) },
      onError: { [weak self] message in self?.onDecoderError(["message": message]) }
    )
    clipsToBounds = true
    backgroundColor = UIColor(white: 17.0 / 255.0, alpha: 1)
    displayLayer.videoGravity = .resizeAspect
    layer.addSublayer(displayLayer)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    displayLayer.frame = bounds
    CATransaction.commit()
  }

  func decode(id: Int, sample: Data, key: Bool, sps: Data?, pps: Data?) {
    decoder.decode(id: id, sample: sample, key: key, sps: sps, pps: pps)
  }

  /** Keeps the last frame on screen; only the decoder starts over. */
  func reset() {
    decoder.reset()
  }

  /** Main queue. */
  private func show(id: Int, image: CVImageBuffer) {
    guard let sample = makeDisplaySample(image) else { return }
    // A failed layer (for example after the app returned from the background) shows nothing
    // until flushed.
    if displayLayer.status == .failed {
      displayLayer.flush()
    }
    displayLayer.enqueue(sample)
    onFrame(["id": id])
  }

  private func makeDisplaySample(_ image: CVImageBuffer) -> CMSampleBuffer? {
    var format: CMVideoFormatDescription?
    guard
      CMVideoFormatDescriptionCreateForImageBuffer(
        allocator: kCFAllocatorDefault, imageBuffer: image, formatDescriptionOut: &format) == noErr,
      let format
    else { return nil }
    var timing = CMSampleTimingInfo(
      duration: .invalid,
      presentationTimeStamp: CMClockGetTime(CMClockGetHostTimeClock()),
      decodeTimeStamp: .invalid
    )
    var sample: CMSampleBuffer?
    guard
      CMSampleBufferCreateReadyWithImageBuffer(
        allocator: kCFAllocatorDefault,
        imageBuffer: image,
        formatDescription: format,
        sampleTiming: &timing,
        sampleBufferOut: &sample
      ) == noErr,
      let sample
    else { return nil }
    if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true),
      CFArrayGetCount(attachments) > 0
    {
      let first = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
      CFDictionarySetValue(
        first,
        Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
        Unmanaged.passUnretained(kCFBooleanTrue).toOpaque()
      )
    }
    return sample
  }
}
