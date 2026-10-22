import { loadFont } from '@remotion/fonts'
import { staticFile } from 'remotion'

/**
 * Load the player's subtitle fonts through Remotion's font loader.
 *
 * `loadFont()` registers the files as `FontFace`s and keeps the Remotion render
 * blocked until they are ready, so captions never flash with fallback glyphs.
 * The old `@font-face` rules used `local()` only (no `url()`), so they silently
 * fell back to system fonts unless the fonts happened to be installed.
 *
 * Both files live in `public/` and are addressed with `staticFile()` so the dev
 * server and the production build resolve the same URL.
 *
 * Browser-only: the SSR shell imports this module too, but the player and
 * `document.fonts` only exist on the client.
 */
if (typeof document !== 'undefined') {
  void loadFont({
    family: 'Smiley Sans',
    url: staticFile('SmileySans-Oblique.ttf'),
    weight: '400',
    style: 'normal',
  })
  // Only the bold cut ships with the project; expose it as the normal weight so
  // the stack uses the real file instead of synthesising a bold face.
  void loadFont({
    family: 'JetBrains Mono',
    url: staticFile('JetBrainsMono-Bold.ttf'),
    weight: '400',
    style: 'normal',
  })
}
