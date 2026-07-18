// Typing a LAN URL on a phone keyboard at 5am is a tax. No library, no CDN: this is the
// smallest correct encoder that covers a feed URL. Verified against the `qrcode` reference
// implementation, matrix for matrix, at every version it can emit.

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();
const gmul = (a, b) => (a && b ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0);

// Per version at ECC level M: [ecWordsPerBlock, g1Blocks, g1DataWords, g2Blocks, g2DataWords].
// Stops at version 9 ON PURPOSE: from version 10 the byte-mode character-count field widens
// from 8 bits to 16, and pushing an 8-bit count into a v10 symbol yields a code that renders
// beautifully and scans as nothing. v9 holds 180 bytes — a LAN feed URL is under 40.
const QR_MAX_VERSION = 9;
const QR_M = [
  null,
  [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37],
];
const QR_ALIGN = [
  null, [], [6, 18], [6, 22], [6, 26], [6, 30],
  [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46],
];
const QR_REMAINDER = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0];

function rsGenerator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const ng = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      ng[j] ^= g[j];
      ng[j + 1] ^= gmul(g[j], GF_EXP[i]);
    }
    g = ng;
  }
  return g;
}

function rsEncode(data, ecLen) {
  const g = rsGenerator(ecLen);
  const rem = new Array(ecLen).fill(0);
  for (const d of data) {
    const factor = d ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let j = 0; j < ecLen; j++) rem[j] ^= gmul(g[j + 1], factor);
  }
  return rem;
}

// Remainder of value<<deg modulo poly, for the format (BCH 15,5) and version (BCH 18,6) bits.
function bch(value, poly, deg) {
  let v = value << deg;
  const width = poly.toString(2).length;
  while (v.toString(2).length >= width) v ^= poly << (v.toString(2).length - width);
  return v;
}

function qrMatrix(text) {
  const bytes = new TextEncoder().encode(text);
  let ver = 0;
  for (let v = 1; v <= QR_MAX_VERSION; v++) {
    const [, g1, d1, g2, d2] = QR_M[v];
    // -2 words: the 4-bit mode nibble plus the 8-bit byte count.
    if (bytes.length <= g1 * d1 + g2 * d2 - 2) { ver = v; break; }
  }
  if (!ver) return null;

  const [ecLen, g1, d1, g2, d2] = QR_M[ver];
  const totalData = g1 * d1 + g2 * d2;

  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);                       // byte mode
  push(bytes.length, 8);                 // 8-bit count field: versions 1-9 only
  for (const b of bytes) push(b, 8);
  for (let i = 0; i < 4 && bits.length < totalData * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);

  const words = [];
  for (let i = 0; i < bits.length; i += 8) {
    words.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  }
  for (let i = 0; words.length < totalData; i++) words.push(i % 2 ? 0x11 : 0xec);

  const blocks = [];
  let at = 0;
  for (let i = 0; i < g1; i++) { blocks.push(words.slice(at, at + d1)); at += d1; }
  for (let i = 0; i < g2; i++) { blocks.push(words.slice(at, at + d2)); at += d2; }
  const ecs = blocks.map((b) => rsEncode(b, ecLen));

  const final = [];
  for (let i = 0; i < Math.max(d1, d2); i++) {
    for (const b of blocks) if (i < b.length) final.push(b[i]);
  }
  for (let i = 0; i < ecLen; i++) for (const e of ecs) final.push(e[i]);

  const dataBits = [];
  for (const w of final) for (let i = 7; i >= 0; i--) dataBits.push((w >> i) & 1);
  for (let i = 0; i < QR_REMAINDER[ver]; i++) dataBits.push(0);

  const size = ver * 4 + 17;
  const m = new Int8Array(size * size).fill(-1);
  const fn = new Uint8Array(size * size);   // function modules: never masked, never data
  const set = (r, c, v) => { m[r * size + c] = v; fn[r * size + c] = 1; };

  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r, cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const ring = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                     (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(rr, cc, ring || core ? 1 : 0);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    set(6, i, v);
    set(i, 6, v);
  }

  for (const r of QR_ALIGN[ver]) {
    for (const c of QR_ALIGN[ver]) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          set(r + dr, c + dc, ring === 1 ? 0 : 1);
        }
      }
    }
  }

  set(size - 8, 8, 1);                       // the dark module

  const reserve = (r, c) => { if (m[r * size + c] === -1) set(r, c, 0); };
  for (let i = 0; i < 9; i++) { reserve(8, i); reserve(i, 8); }
  for (let i = 0; i < 8; i++) { reserve(8, size - 1 - i); reserve(size - 1 - i, 8); }
  if (ver >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) { reserve(i, size - 11 + j); reserve(size - 11 + j, i); }
    }
  }

  let bi = 0, dir = -1, row = size - 1;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;                    // the vertical timing column is not a data column
    for (;;) {
      for (let k = 0; k < 2; k++) {
        const cc = col - k;
        if (!fn[row * size + cc]) m[row * size + cc] = bi < dataBits.length ? dataBits[bi++] : 0;
      }
      row += dir;
      if (row < 0 || row >= size) { row -= dir; dir = -dir; break; }
    }
  }

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  let best = null, bestScore = Infinity;
  for (let mk = 0; mk < 8; mk++) {
    const t = Int8Array.from(m);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!fn[r * size + c] && MASKS[mk](r, c)) t[r * size + c] ^= 1;
      }
    }
    const raw = (0b00 << 3) | mk;            // ECC level M is 0b00
    const fmt = ((raw << 10) | bch(raw, 0x537, 10)) ^ 0x5412;
    // The 15 format bits go down MSB first: bit 14 lands at (8,0). Placing them LSB-first
    // produces a code that looks right and scans as garbage.
    const fbit = (i) => (fmt >> (14 - i)) & 1;
    for (let i = 0; i <= 5; i++) t[8 * size + i] = fbit(i);
    t[8 * size + 7] = fbit(6);
    t[8 * size + 8] = fbit(7);
    t[7 * size + 8] = fbit(8);
    for (let i = 9; i <= 14; i++) t[(14 - i) * size + 8] = fbit(i);
    // Second copy: 7 bits up the left column, 8 along the top row. (size-8,8) is the dark
    // module, not a format bit.
    for (let i = 0; i <= 6; i++) t[(size - 1 - i) * size + 8] = fbit(i);
    for (let i = 7; i <= 14; i++) t[8 * size + (size - 15 + i)] = fbit(i);
    t[(size - 8) * size + 8] = 1;

    if (ver >= 7) {
      const vinfo = (ver << 12) | bch(ver, 0x1f25, 12);
      for (let i = 0; i < 18; i++) {
        const b = (vinfo >> i) & 1;
        t[Math.floor(i / 3) * size + (size - 11 + (i % 3))] = b;
        t[(size - 11 + (i % 3)) * size + Math.floor(i / 3)] = b;
      }
    }

    const s = qrPenalty(t, size);
    if (s < bestScore) { bestScore = s; best = t; }
  }

  const out = [];
  for (let r = 0; r < size; r++) out.push(Array.from(best.slice(r * size, r * size + size)));
  return out;
}

function qrPenalty(t, size) {
  let score = 0;
  const at = (r, c) => t[r * size + c];

  for (let i = 0; i < size; i++) {
    for (const horiz of [true, false]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const a = horiz ? at(i, j) : at(j, i);
        const b = horiz ? at(i, j - 1) : at(j - 1, i);
        if (a === b) run++;
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
    }
  }
  const PAT = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  for (let i = 0; i < size; i++) {
    for (let j = 0; j + 11 <= size; j++) {
      let h = true, v = true;
      for (let k = 0; k < 11; k++) {
        if (at(i, j + k) !== PAT[k]) h = false;
        if (at(j + k, i) !== PAT[k]) v = false;
      }
      if (h) score += 40;
      if (v) score += 40;
    }
  }
  let dark = 0;
  for (let i = 0; i < size * size; i++) if (t[i]) dark++;
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

function renderQR(host, text) {
  host.textContent = "";
  let grid = null;
  try {
    grid = qrMatrix(text);
  } catch (e) {
    console.error("qr encode failed", e);
  }
  if (!grid) {
    // Longer than v9 can hold, or the encoder blew up. The URL still has to be readable.
    host.dispatchEvent(new CustomEvent("qr-overflow", { bubbles: true }));
    host.hidden = true;
    return;
  }
  const n = grid.length;
  const q = 2;                                 // quiet zone, in modules
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${n + q * 2} ${n + q * 2}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `QR code for ${text}`);
  const bg = document.createElementNS(NS, "rect");
  bg.setAttribute("width", String(n + q * 2));
  bg.setAttribute("height", String(n + q * 2));
  bg.setAttribute("fill", "#fff");             // scanners want a white quiet zone, not a dark one
  svg.appendChild(bg);
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (grid[r][c]) d += `M${c + q} ${r + q}h1v1h-1z`;
  }
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "#000");
  svg.appendChild(path);
  host.appendChild(svg);
}

