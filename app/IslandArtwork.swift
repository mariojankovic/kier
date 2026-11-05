import Foundation
import CoreGraphics
import ImageIO
import Metal

// Decode Sol's cutout once, with explicit sRGB color and premultiplied alpha. The shader and the island's existing
// bgra8Unorm layer both work in sRGB values, so the texture must not perform an extra sRGB-to-linear conversion.
enum IslandArtwork {
  enum LoadError: Error { case image, pixels, texture, command }

  static func load(device: MTLDevice, url: URL) throws -> MTLTexture {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw LoadError.image }
    let width = image.width, height = image.height, row = width * 4
    var pixels = [UInt8](repeating: 0, count: row * height)
    let decoded = pixels.withUnsafeMutableBytes { bytes -> Bool in
      guard let context = CGContext(data: bytes.baseAddress, width: width, height: height,
                                    bitsPerComponent: 8, bytesPerRow: row,
                                    space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                    bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue)
      else { return false }
      context.setBlendMode(.copy)
      context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
      return true
    }
    guard decoded else { throw LoadError.pixels }
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: width, height: height, mipmapped: true)
    descriptor.usage = .shaderRead
    descriptor.storageMode = .shared
    guard let texture = device.makeTexture(descriptor: descriptor) else { throw LoadError.texture }
    texture.label = "Sol Sealed Sun"
    pixels.withUnsafeBytes { bytes in
      texture.replace(region: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0,
                      withBytes: bytes.baseAddress!, bytesPerRow: row)
    }
    // The small orb samples prefiltered levels, including while it shrinks into the notch. No image work per frame.
    guard let queue = device.makeCommandQueue(), let command = queue.makeCommandBuffer(),
          let blit = command.makeBlitCommandEncoder() else { throw LoadError.command }
    blit.generateMipmaps(for: texture)
    blit.endEncoding()
    command.commit()
    command.waitUntilCompleted()
    guard command.status == .completed else { throw command.error ?? LoadError.command }
    return texture
  }
}
