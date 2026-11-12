// Baseball field diagram (SVG, viewBox 0 0 200 200). Home plate at (100,185).
export const HOME = { x: 100, y: 185 };
// Cropped to the playable area; coordinates are still field units (0-200), stored as /200.
export const VB = [2, 38, 196, 156];

export function fieldSVG(inner = '', attrs = '') {
  return `<svg class="field" viewBox="${VB.join(' ')}" ${attrs} role="img" aria-label="Baseball field">
  <rect x="0" y="0" width="200" height="200" class="f-foul"/>
  <path class="f-grass" d="M100 185 L11.6 96.6 A125 125 0 0 1 188.4 96.6 Z"/>
  <path class="f-dirt" d="M100 185 L51.9 136.9 A68 68 0 0 1 148.1 136.9 Z"/>
  <path class="f-infield" d="M100 178 L122 156.5 L100 135 L78 156.5 Z"/>
  <line class="f-line" x1="100" y1="185" x2="11.6" y2="96.6"/>
  <line class="f-line" x1="100" y1="185" x2="188.4" y2="96.6"/>
  <path class="f-fence" d="M11.6 96.6 A125 125 0 0 1 188.4 96.6"/>
  <circle class="f-mound" cx="100" cy="158" r="4"/>
  <rect class="f-base" x="125.5" y="153.5" width="5" height="5" transform="rotate(45 128 156)"/>
  <rect class="f-base" x="97.5" y="125.5" width="5" height="5" transform="rotate(45 100 128)"/>
  <rect class="f-base" x="69.5" y="153.5" width="5" height="5" transform="rotate(45 72 156)"/>
  <path class="f-base" d="M97 183 h6 v2 l-3 3 l-3 -3 z"/>
  ${inner}
</svg>`;
}

/** Convert a pointer event on the field SVG to normalized 0..1 coordinates. */
export function pointToField(svg, evt) {
  const rect = svg.getBoundingClientRect();
  const x = (VB[0] + ((evt.clientX - rect.left) / rect.width) * VB[2]) / 200;
  const y = (VB[1] + ((evt.clientY - rect.top) / rect.height) * VB[3]) / 200;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}
