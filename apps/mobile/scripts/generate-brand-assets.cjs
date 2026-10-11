/* global __dirname */
// Export the approved artwork without regenerating or redrawing the faces.
const path = require('node:path')
const fs = require('node:fs/promises')
const Jimp = require('jimp-compact')
const { PNG } = require('pngjs')

const assets = path.resolve(__dirname, '../assets')
const SIZE = 1024

function inkMask(source, color = 0) {
  const mask = source.clone()
  mask.scan(0, 0, mask.bitmap.width, mask.bitmap.height, function (x, y, i) {
    const data = this.bitmap.data
    const luminance = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
    // Remove near-white paper noise, retaining antialiased ink edges.
    const alpha = Math.round(Math.max(0, Math.min(255, (245 - luminance) * 255 / 235)))
    data[i] = data[i + 1] = data[i + 2] = color
    data[i + 3] = alpha
  })
  return mask.rgba(true)
}

function fitInkInCircle(mask, radius) {
  let minX = mask.bitmap.width, minY = mask.bitmap.height, maxX = -1, maxY = -1
  mask.scan(0, 0, mask.bitmap.width, mask.bitmap.height, function (x, y, i) {
    if (this.bitmap.data[i + 3] === 0) return
    minX = Math.min(minX, x); minY = Math.min(minY, y)
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
  })
  if (maxX < 0) throw new Error('The source contains no visible artwork.')
  const cropped = mask.clone().crop(minX, minY, maxX - minX + 1, maxY - minY + 1)
  let extent = 0
  cropped.scan(0, 0, cropped.bitmap.width, cropped.bitmap.height, function (x, y, i) {
    if (this.bitmap.data[i + 3] === 0) return
    extent = Math.max(extent, Math.hypot(x - (cropped.bitmap.width - 1) / 2, y - (cropped.bitmap.height - 1) / 2))
  })
  const scale = (radius - 2) / extent
  cropped.resize(Math.round(cropped.bitmap.width * scale), Math.round(cropped.bitmap.height * scale), Jimp.RESIZE_BICUBIC)
  return new Jimp(SIZE, SIZE, 0x00000000).composite(cropped,
    Math.round((SIZE - cropped.bitmap.width) / 2), Math.round((SIZE - cropped.bitmap.height) / 2))
}

async function save(image, name, opaque = false) {
  // Explicit RGBA input avoids corrupting channels when exporting RGB PNGs.
  const png = PNG.sync.write(image.bitmap, {
    colorType: opaque ? 2 : 6,
    inputColorType: 6,
    inputHasAlpha: true,
  })
  await fs.writeFile(path.join(assets, name), png)
  console.log(`Wrote assets/${name}`)
}

async function main() {
  const source = await Jimp.read(path.join(assets, 'brand/crew-speech-source.png'))
  if (source.bitmap.width !== source.bitmap.height) throw new Error('The approved source must be square.')
  const icon = source.clone().resize(SIZE, SIZE, Jimp.RESIZE_BICUBIC)
  await save(icon.clone(), 'icon.png', true)
  await save(icon.clone().resize(64, 64, Jimp.RESIZE_BICUBIC), 'favicon.png', true)

  const mask = inkMask(source)
  // Android's 108dp layers have a 66dp safe area. Keep all ink inside a
  // slightly smaller 64dp circle, including on circular launcher masks.
  const adaptive = fitInkInCircle(mask, SIZE * 32 / 108)
  await save(adaptive.clone(), 'android-icon-foreground.png')
  await save(adaptive.clone(), 'android-icon-monochrome.png')
  await save(new Jimp(SIZE, SIZE, 0xffffffff), 'android-icon-background.png', true)
  const legacy = fitInkInCircle(mask, SIZE * 0.46)
  await save(new Jimp(SIZE, SIZE, 0xffffffff).composite(legacy, 0, 0), 'android-icon.png', true)

  // At a native imageWidth of 180, this fits Android's 192dp splash circle.
  await save(mask.clone().resize(SIZE, SIZE, Jimp.RESIZE_BICUBIC), 'splash-icon.png')
  await save(inkMask(source, 255).resize(SIZE, SIZE, Jimp.RESIZE_BICUBIC), 'splash-icon-dark.png')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
