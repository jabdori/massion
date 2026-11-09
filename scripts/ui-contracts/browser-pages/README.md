# Local browser reference pages

The HTML/CSS reference pages are served only on loopback. `capture-browser-pages.mjs` invokes the production CDP capture in memory. The CLI writes only structural metadata, source/image hashes and boolean privacy reports; it never writes page PNGs. `browser-fixtures.ts` lazily captures reference images in process memory for active browser-pane verification. Payment approval is waiting, so B4 shows only structure.

The primitive fixture draws a private value with CSS segments. Its different pixel variants deliberately remain distinguishable, while capture/settle/backup and restart checks prove those bytes never persist. The field/label fixtures separately verify default masking.
