/**
 * Where a bundled image's size comes from on each platform.
 */
import { Image } from 'react-native'

import { assetSize } from '../assetSize'

afterEach(() => jest.restoreAllMocks())

describe('assetSize', () => {
  it('on the tablet, asks the asset registry about the id', () => {
    const resolve = jest
      .spyOn(Image, 'resolveAssetSource')
      .mockReturnValue({ uri: 'x', width: 2172, height: 724, scale: 1 })
    expect(assetSize(7)).toMatchObject({ width: 2172, height: 724 })
    expect(resolve).toHaveBeenCalledWith(7)
  })

  it('in a browser, reads the size off the asset — there is no registry call to make', () => {
    const resolve = jest.spyOn(Image, 'resolveAssetSource').mockImplementation(() => {
      throw new TypeError('Image.resolveAssetSource is not a function')
    })
    const asset = { uri: '/assets/branding/start.png', width: 2172, height: 724 }
    expect(assetSize(asset)).toEqual({ width: 2172, height: 724 })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('does not trust an object that carries no size', () => {
    const resolve = jest
      .spyOn(Image, 'resolveAssetSource')
      .mockReturnValue({ uri: 'x', width: 10, height: 5, scale: 1 })
    expect(assetSize({ uri: 'https://example.invalid/x.png' })).toMatchObject({ width: 10 })
    expect(resolve).toHaveBeenCalledTimes(1)
  })
})
