import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

/**
 * One VTDecompressionSession, recreated from the SPS and PPS that come with every keyframe.
 * All work runs on one serial queue; results reach the view on the main queue.
 *
 * iOS invalidates a decompression session when the app goes to the background
 * (kVTInvalidSessionErr on the next decode). That is reported like any other error: JavaScript
 * then waits for a keyframe, asks the daemon for one, and the keyframe's parameter sets build a
 * new session here.
 */
final class H264Decoder {
  private let queue = DispatchQueue(label: "sh.paseo.video.decode", qos: .userInteractive)
  private var session: VTDecompressionSession?
  private var format: CMVideoFormatDescription?
  private var sps: Data?
  private var pps: Data?
  /**
   * A decode failed and was reported: deltas are dropped without a word until a keyframe builds a
   * new session. Chunks already queued behind the failure would otherwise each report one, and
   * JavaScript gives up on video after a few.
   */
  private var waitingForKeyframe = false
  private let onFrame: (Int, CVImageBuffer) -> Void
  private let onError: (String) -> Void

  /** Both callbacks run on the main queue. */
  init(onFrame: @escaping (Int, CVImageBuffer) -> Void, onError: @escaping (String) -> Void) {
    self.onFrame = onFrame
    self.onError = onError
  }

  deinit {
    if let session {
      VTDecompressionSessionInvalidate(session)
    }
  }

  func decode(id: Int, sample: Data, key: Bool, sps: Data?, pps: Data?) {
    queue.async { self.decodeOnQueue(id: id, sample: sample, key: key, sps: sps, pps: pps) }
  }

  /** JavaScript dropped its state; the next chunk it sends is a keyframe. */
  func reset() {
    queue.async { self.invalidate() }
  }

  private func decodeOnQueue(id: Int, sample: Data, key: Bool, sps: Data?, pps: Data?) {
    if waitingForKeyframe && !key { return }
    if key, let sps, let pps, session == nil || sps != self.sps || pps != self.pps {
      let status = configure(sps: sps, pps: pps)
      if status != noErr {
        fail("Could not create the H.264 decoder (\(status))")
        return
      }
    }
    guard let session, let format else {
      fail("No decoder yet: waiting for a keyframe")
      return
    }
    guard let buffer = makeSampleBuffer(sample, format: format) else {
      fail("Could not wrap the H.264 sample")
      return
    }
    waitingForKeyframe = false
    var infoFlags = VTDecodeInfoFlags()
    var handlerStatus: OSStatus = noErr
    // Synchronous decode (no flags): the handler runs before this call returns, on this queue,
    // so it only records the outcome; the session is torn down after the call, not inside it.
    let status = VTDecompressionSessionDecodeFrame(
      session,
      sampleBuffer: buffer,
      flags: [],
      infoFlagsOut: &infoFlags
    ) { [weak self] status, _, image, _, _ in
      guard status == noErr, let image else {
        handlerStatus = status == noErr ? kVTVideoDecoderBadDataErr : status
        return
      }
      DispatchQueue.main.async { self?.onFrame(id, image) }
    }
    if status != noErr || handlerStatus != noErr {
      fail("H.264 decoding failed (\(status != noErr ? status : handlerStatus))")
    }
  }

  /** Reports once, then waits for a keyframe to build a new session. */
  private func fail(_ message: String) {
    invalidate()
    if waitingForKeyframe { return }
    waitingForKeyframe = true
    report(message)
  }

  private func configure(sps: Data, pps: Data) -> OSStatus {
    invalidate()
    let spsBytes = [UInt8](sps)
    let ppsBytes = [UInt8](pps)
    var newFormat: CMFormatDescription?
    let formatStatus = spsBytes.withUnsafeBufferPointer { spsPointer in
      ppsBytes.withUnsafeBufferPointer { ppsPointer -> OSStatus in
        guard let spsBase = spsPointer.baseAddress, let ppsBase = ppsPointer.baseAddress else {
          return kCMFormatDescriptionError_InvalidParameter
        }
        let pointers: [UnsafePointer<UInt8>] = [spsBase, ppsBase]
        let sizes: [Int] = [spsBytes.count, ppsBytes.count]
        return CMVideoFormatDescriptionCreateFromH264ParameterSets(
          allocator: kCFAllocatorDefault,
          parameterSetCount: 2,
          parameterSetPointers: pointers,
          parameterSetSizes: sizes,
          nalUnitHeaderLength: 4,
          formatDescriptionOut: &newFormat
        )
      }
    }
    guard formatStatus == noErr, let newFormat else { return formatStatus }

    let attributes: [CFString: Any] = [
      kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      // IOSurface-backed buffers display without a copy.
      kCVPixelBufferIOSurfacePropertiesKey: [CFString: Any]() as CFDictionary,
    ]
    var newSession: VTDecompressionSession?
    // No output callback: every frame is decoded with an output handler instead.
    let sessionStatus = VTDecompressionSessionCreate(
      allocator: kCFAllocatorDefault,
      formatDescription: newFormat,
      decoderSpecification: nil,
      imageBufferAttributes: attributes as CFDictionary,
      outputCallback: nil,
      decompressionSessionOut: &newSession
    )
    guard sessionStatus == noErr, let newSession else { return sessionStatus }
    VTSessionSetProperty(
      newSession, key: kVTDecompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    session = newSession
    format = newFormat
    self.sps = sps
    self.pps = pps
    return noErr
  }

  private func invalidate() {
    if let session {
      VTDecompressionSessionInvalidate(session)
    }
    session = nil
    format = nil
    sps = nil
    pps = nil
  }

  private func makeSampleBuffer(_ data: Data, format: CMVideoFormatDescription) -> CMSampleBuffer? {
    let length = data.count
    guard length > 0 else { return nil }
    var block: CMBlockBuffer?
    var status = CMBlockBufferCreateWithMemoryBlock(
      allocator: kCFAllocatorDefault,
      memoryBlock: nil,
      blockLength: length,
      blockAllocator: kCFAllocatorDefault,
      customBlockSource: nil,
      offsetToData: 0,
      dataLength: length,
      flags: kCMBlockBufferAssureMemoryNowFlag,
      blockBufferOut: &block
    )
    guard status == kCMBlockBufferNoErr, let block else { return nil }
    status = data.withUnsafeBytes { bytes -> OSStatus in
      guard let base = bytes.baseAddress else { return kCMBlockBufferBadPointerParameterErr }
      return CMBlockBufferReplaceDataBytes(
        with: base, blockBuffer: block, offsetIntoDestination: 0, dataLength: length)
    }
    guard status == kCMBlockBufferNoErr else { return nil }
    var sample: CMSampleBuffer?
    var sampleSize = length
    let sampleStatus = CMSampleBufferCreateReady(
      allocator: kCFAllocatorDefault,
      dataBuffer: block,
      formatDescription: format,
      sampleCount: 1,
      sampleTimingEntryCount: 0,
      sampleTimingArray: nil,
      sampleSizeEntryCount: 1,
      sampleSizeArray: &sampleSize,
      sampleBufferOut: &sample
    )
    return sampleStatus == noErr ? sample : nil
  }

  private func report(_ message: String) {
    DispatchQueue.main.async { self.onError(message) }
  }
}
