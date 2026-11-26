/**
 * The authored pixel size of a bundled image.
 *
 * On the tablet `require('x.png')` is a number — an id in the asset registry
 * — and `Image.resolveAssetSource` looks it up. In a browser Metro compiles
 * the same `require` to the asset itself, `{ uri, width, height }` (read
 * from the built web bundle, 2026-11-26), and react-native-web's `Image` has
 * no `resolveAssetSource` to call: the art buttons were the one thing that
 * threw on the PC version's first render.
 */
import { Image, type ImageSourcePropType } from 'react-native'

export function assetSize(source: unknown): { width: number; height: number } {
  if (typeof source === 'object' && source !== null) {
    const { width, height } = source as { width?: unknown; height?: unknown }
    if (typeof width === 'number' && typeof height === 'number') return { width, height }
  }
  return Image.resolveAssetSource(source as ImageSourcePropType)
}
