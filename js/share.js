// Shareable summary image (drawn on a canvas, no libraries) and file sharing.

const C = {
  bg: '#fafaf8', card: '#ffffff', line: '#e6e4de', text: '#111110', text2: '#55544f', muted: '#8a8882',
  accent: '#1c5cab', foul: '#f0efeb', grass: '#cfe3c1', dirt: '#e6d4b5', infield: '#c2dcb0',
  weak: '#1baf7a', medium: '#2a78d6', hard: '#eb6834', none: '#8a8882',
};
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fitText(ctx, text, maxWidth, weight, size) {
  let s = size;
  do { ctx.font = `${weight} ${s}px ${FONT}`; s -= 2; } while (ctx.measureText(text).width > maxWidth && s > 18);
}

// Field geometry matches js/field.js (field units 0-200, home plate at 100,185).
function drawField(ctx, x, y, w, spray) {
  const vb = [2, 38, 196, 156];
  const s = w / vb[2];
  const h = vb[3] * s;
  ctx.save();
  roundRect(ctx, x, y, w, h, 28); ctx.clip();
  ctx.fillStyle = C.foul; ctx.fillRect(x, y, w, h);
  ctx.translate(x - vb[0] * s, y - vb[1] * s); ctx.scale(s, s);
  const wedge = (r, fill) => {
    ctx.beginPath(); ctx.moveTo(100, 185); ctx.arc(100, 185, r, Math.PI * 1.25, Math.PI * 1.75); ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
  };
  wedge(125, C.grass); wedge(68, C.dirt);
  ctx.beginPath(); ctx.moveTo(100, 178); ctx.lineTo(122, 156.5); ctx.lineTo(100, 135); ctx.lineTo(78, 156.5); ctx.closePath();
  ctx.fillStyle = C.infield; ctx.fill();
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(11.6, 96.6); ctx.lineTo(100, 185); ctx.lineTo(188.4, 96.6); ctx.stroke();
  ctx.strokeStyle = C.muted; ctx.beginPath(); ctx.arc(100, 185, 125, Math.PI * 1.25, Math.PI * 1.75); ctx.stroke();
  ctx.fillStyle = '#ffffff';
  for (const [bx, by] of [[128, 156], [100, 128], [72, 156], [100, 185]]) {
    ctx.save(); ctx.translate(bx, by); ctx.rotate(Math.PI / 4); ctx.fillRect(-2.5, -2.5, 5, 5); ctx.restore();
  }
  const R = { weak: 4.5, medium: 5.5, hard: 7 };
  for (const p of spray) {
    ctx.beginPath(); ctx.arc(p.x * 200, p.y * 200, R[p.contact] || 4.5, 0, Math.PI * 2);
    ctx.fillStyle = C[p.contact] || C.none; ctx.fill();
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.stroke();
  }
  ctx.restore();
  return h;
}

/**
 * data: { title, subtitle, headline, headlineLabel, stats: [{label, value, sub}], spray: [{x,y,contact}], footer }
 * Returns a 1080-wide canvas.
 */
export function renderSummary(data) {
  const W = 1080, P = 72;
  const hasSpray = data.spray.length > 0;
  const H = hasSpray ? 1810 : 980;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'alphabetic';

  let y = P + 28;
  ctx.fillStyle = C.accent; ctx.font = `700 26px ${FONT}`;
  ctx.fillText('AT-BAT LOG', P, y);
  y += 84;
  ctx.fillStyle = C.text; fitText(ctx, data.title, W - P * 2, 700, 68);
  ctx.fillText(data.title, P, y);
  y += 52;
  ctx.fillStyle = C.muted; fitText(ctx, data.subtitle, W - P * 2, 400, 34);
  ctx.fillText(data.subtitle, P, y);

  y += 112;
  ctx.fillStyle = C.text; fitText(ctx, data.headline, W - P * 2, 700, 92);
  ctx.fillText(data.headline, P, y);
  y += 46;
  ctx.fillStyle = C.muted; ctx.font = `400 30px ${FONT}`;
  ctx.fillText(data.headlineLabel, P, y);

  // 2 x 2 stat cards
  y += 56;
  const gap = 24, cw = (W - P * 2 - gap) / 2, ch = 184;
  data.stats.slice(0, 4).forEach((s, i) => {
    const cx = P + (i % 2) * (cw + gap), cy = y + Math.floor(i / 2) * (ch + gap);
    ctx.fillStyle = C.card; roundRect(ctx, cx, cy, cw, ch, 28); ctx.fill();
    ctx.strokeStyle = C.line; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = C.text2; ctx.font = `500 30px ${FONT}`; ctx.fillText(s.label, cx + 32, cy + 56);
    ctx.fillStyle = s.small ? C.muted : C.text; ctx.font = `700 68px ${FONT}`; ctx.fillText(s.value, cx + 32, cy + 132);
    ctx.fillStyle = C.muted; ctx.font = `400 26px ${FONT}`;
    ctx.textAlign = 'right'; ctx.fillText(s.sub, cx + cw - 32, cy + 132); ctx.textAlign = 'left';
  });
  y += ch * 2 + gap;

  if (hasSpray) {
    y += 48;
    const fh = drawField(ctx, P, y, W - P * 2, data.spray);
    y += fh + 52;
    // legend
    let lx = P;
    ctx.font = `400 28px ${FONT}`;
    for (const [k, label, r] of [['weak', 'Weak', 10], ['medium', 'Medium', 12], ['hard', 'Hard', 15]]) {
      const n = data.spray.filter((p) => p.contact === k).length;
      ctx.fillStyle = C[k]; ctx.beginPath(); ctx.arc(lx + 15, y - 10, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.text2; const t = `${label} contact (${n})`; ctx.fillText(t, lx + 40, y);
      lx += 40 + ctx.measureText(t).width + 36;
    }
  }

  ctx.fillStyle = C.muted; ctx.font = `400 26px ${FONT}`;
  ctx.fillText(data.footer, P, H - P + 8);
  return canvas;
}

/** Share a file through the phone's share sheet when possible, otherwise download it. Resolves true if it went out. */
export async function shareOrDownload(blob, filename, title) {
  const file = new File([blob], filename, { type: blob.type });
  const touch = window.matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return true; } catch (e) {
      if (e && e.name === 'AbortError') return false; // user closed the share sheet
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  return true;
}
