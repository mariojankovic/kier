import AVFoundation

// Kier's "done" sound: two soft notes going up, made here rather than borrowed from macOS, so a thing getting done
// sounds like Kier. Each note blooms quickly and fades over most of a second, with a quiet octave for shimmer.
@MainActor
enum Chime {
  private static let engine = AVAudioEngine()
  private static let player = AVAudioPlayerNode()
  private static let format = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 1)!
  private static var ready = false

  static func done(volume: Float = 0.4) {
    if !ready {
      engine.attach(player)
      engine.connect(player, to: engine.mainMixerNode, format: format)
      ready = (try? engine.start()) != nil
    }
    guard ready else { return }
    player.volume = volume
    player.scheduleBuffer(notes, at: nil)
    if !player.isPlaying { player.play() }
  }

  // E6, then B6 a fifth above, a ninth of a second later.
  private static let notes: AVAudioPCMBuffer = {
    let rate = 44100.0
    let frames = AVAudioFrameCount(rate * 1.1)
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
    buffer.frameLength = frames
    let out = buffer.floatChannelData![0]
    let parts: [(start: Double, hz: Double)] = [(0, 1318.5), (0.11, 1975.5)]
    for i in 0..<Int(frames) {
      let t = Double(i) / rate
      var v = 0.0
      for p in parts where t >= p.start {
        let u = t - p.start
        let envelope = min(1, u / 0.005) * exp(-u * 5)
        v += envelope * (sin(2 * .pi * p.hz * u) * 0.62 + sin(4 * .pi * p.hz * u) * 0.1)
      }
      out[i] = Float(v * 0.42)
    }
    return buffer
  }()
}
