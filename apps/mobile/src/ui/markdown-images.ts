/**
 * Which images a markdown message may load (react-native-markdown-display 7, `allowedImageHandlers` and
 * `defaultImageHandler`). Only inline data images and https. Android allows plain http to every host
 * (ADR-045), so a message must not make the phone fetch an image in plain text. A source without an
 * allowed prefix shows no image: the library's default would put `https://` in front and fetch it anyway.
 */
export const MARKDOWN_IMAGE_SOURCES: { allowedImageHandlers: string[]; defaultImageHandler: string | null } = {
  allowedImageHandlers: ['data:image/png;base64', 'data:image/gif;base64', 'data:image/jpeg;base64', 'https://'],
  defaultImageHandler: null
}
