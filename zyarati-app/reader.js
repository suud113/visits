/* زياراتي — قارئ أرقام صور جداول النظام (إحداثيات + هواتف) — يعمل بالكامل على الجهاز */
(function (root) {
  "use strict";

  // ---------- image helpers (gray Uint8/Float arrays, row-major) ----------
  function boxBlurReflect(src, W, H, k) {           // cv2.blur with BORDER_REFLECT_101
    const r = k >> 1, out = new Float32Array(W * H), tmp = new Float32Array(W * H);
    const refl = (i, n) => (i < 0 ? -i : i >= n ? 2 * n - 2 - i : i);
    for (let y = 0; y < H; y++) {
      const row = y * W; let s = 0;
      for (let i = -r; i <= r; i++) s += src[row + refl(i, W)];
      for (let x = 0; x < W; x++) {
        tmp[row + x] = s;
        s += src[row + refl(x + r + 1, W)] - src[row + refl(x - r, W)];
      }
    }
    const inv = 1 / (k * k);
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += tmp[refl(i, H) * W + x];
      for (let y = 0; y < H; y++) {
        out[y * W + x] = s * inv;
        s += tmp[refl(y + r + 1, H) * W + x] - tmp[refl(y - r, H) * W + x];
      }
    }
    return out;
  }
  // separable min/max filter over offsets [a0..a1] (out-of-image samples ignored, like OpenCV's default border)
  function morph1D(src, W, H, a0, a1, horiz, isMax) {
    const out = new (src.constructor)(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let v = isMax ? -Infinity : Infinity;
      for (let o = a0; o <= a1; o++) {
        const xx = horiz ? x + o : x, yy = horiz ? y : y + o;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const s = src[yy * W + xx]; if (isMax ? s > v : s < v) v = s;
      }
      out[y * W + x] = v;
    }
    return out;
  }
  const kOff = k => [-(k >> 1), (k - 1) - (k >> 1)];   // OpenCV default anchor
  function dilateRect(src, W, H, kw, kh) { let [a, b] = kOff(kw); let t = morph1D(src, W, H, a, b, true, true); [a, b] = kOff(kh); return morph1D(t, W, H, a, b, false, true); }
  function erodeRect(src, W, H, kw, kh) { let [a, b] = kOff(kw); let t = morph1D(src, W, H, a, b, true, false); [a, b] = kOff(kh); return morph1D(t, W, H, a, b, false, false); }
  // fast binary opening with an odd-length 1-D line (run-length based). Matches OpenCV exactly,
  // including its border rule (outside counts as ink while eroding): a run touching one image edge
  // survives from half the length, a run spanning the whole row/column always survives.
  function openLine(m, W, H, len, horiz) {
    const out = new Uint8Array(W * H), half = (len + 1) >> 1;
    const keep = (s, e, n) => (s === 0 && e === n) || e - s >= ((s === 0 || e === n) ? half : len);
    if (horiz) {
      for (let y = 0; y < H; y++) { let x = 0; const row = y * W;
        while (x < W) { if (!m[row + x]) { x++; continue; } let e = x; while (e < W && m[row + e]) e++;
          if (keep(x, e, W)) for (let i = x; i < e; i++) out[row + i] = 1; x = e; } }
    } else {
      for (let x = 0; x < W; x++) { let y = 0;
        while (y < H) { if (!m[y * W + x]) { y++; continue; } let e = y; while (e < H && m[e * W + x]) e++;
          if (keep(y, e, H)) for (let i = y; i < e; i++) out[i * W + x] = 1; y = e; } }
    }
    return out;
  }

  function binarize(g, W, H, opt) {
    opt = Object.assign({ block: 41, offset: 60, darkMax: 80 }, opt || {});
    const bgBlur = boxBlurReflect(g, W, H, opt.block);
    const dil = dilateRect(g, W, H, 9, 9);
    let m = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const bg = Math.max(bgBlur[i], dil[i] * 0.9);
      m[i] = (bg - g[i] > opt.offset && g[i] < opt.darkMax) ? 1 : 0;
    }
    const hl = openLine(m, W, H, 31, true), vl = openLine(m, W, H, 31, false);
    for (let i = 0; i < W * H; i++) if (hl[i] || vl[i]) m[i] = 0;
    // opening with a 2x2 square (same anchor as OpenCV)
    m = dilateRect(erodeRect(m, W, H, 2, 2), W, H, 2, 2);
    return m;
  }

  function components(m, W, H, minArea) {
    minArea = minArea || 6;
    const lab = new Int32Array(W * H), comps = [], stack = new Int32Array(W * H);
    let n = 0;
    for (let p = 0; p < W * H; p++) {
      if (!m[p] || lab[p]) continue;
      n++; let sp = 0; stack[sp++] = p; lab[p] = n;
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, a = 0, sx = 0, sy = 0;
      while (sp) {
        const q = stack[--sp], qx = q % W, qy = (q / W) | 0;
        a++; sx += qx; sy += qy;
        if (qx < x0) x0 = qx; if (qx > x1) x1 = qx; if (qy < y0) y0 = qy; if (qy > y1) y1 = qy;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = qx + dx, ny = qy + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const r = ny * W + nx; if (m[r] && !lab[r]) { lab[r] = n; stack[sp++] = r; }
        }
      }
      if (a >= minArea) comps.push({ i: n, x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, a, cx: sx / a, cy: sy / a });
    }
    return { comps, lab };
  }

  function estimateH(comps) {
    const ok = comps.filter(c => c.a > 25 && c.h / Math.max(c.w, 1) < 5 && c.h < 120).sort((a, b) => a.h - b.h);
    if (!ok.length) return comps.length ? median(comps.map(c => c.h)) : 10;
    const tot = ok.reduce((s, c) => s + c.a, 0); let acc = 0;
    for (let i = 0; i < ok.length; i++) { acc += ok[i].a; if (acc >= tot / 2) return ok[i].h; }
    return ok[ok.length - 1].h;
  }
  // remove leftover grid-line pieces: tall-thin / long-flat components and specks forming a vertical dotted line
  function dropLines(m, W, H, th) {
    const { comps, lab } = components(m, W, H, 1);
    if (!comps.length) return m;
    const n = comps.length ? comps[comps.length - 1].i + 1 : 1, line = new Uint8Array(n), small = new Uint8Array(n);
    for (const c of comps) {
      if ((c.h > 2 * th && c.w < 0.5 * th) || (c.w > 0.8 * th && c.h < 0.25 * th) || (c.w > 4 * th && c.h < 0.3 * th)) line[c.i] = 1;
      if (c.a < 0.025 * th * th && c.w <= 0.2 * th + 2) small[c.i] = 1;
    }
    const sm = new Uint8Array(W * H);
    for (let p = 0; p < W * H; p++) if (lab[p] && small[lab[p]]) sm[p] = 1;
    const kc = Math.max(2, Math.round(0.4 * th)), ko = 2 * Math.round(th) + 1;
    const col = openLine(dilateRect(sm, W, H, 5, kc), W, H, ko, false);
    const bad = line.slice();
    for (let p = 0; p < W * H; p++) if (col[p] && sm[p]) bad[lab[p]] = 1;
    const out = new Uint8Array(W * H);
    for (let p = 0; p < W * H; p++) out[p] = m[p] && !bad[lab[p]] ? 1 : 0;
    return out;
  }
  function wordBoxes(m, W, H, th) {
    const kw = Math.max(3, Math.round(0.8 * th)), kh = Math.max(1, Math.round(0.2 * th));
    m = dropLines(m, W, H, th);
    const d = dilateRect(m, W, H, kw, kh);
    const { comps } = components(d, W, H, 1);
    const out = [];
    for (const c of comps) {
      if (c.h < 0.55 * th || c.h > 1.8 * th || c.w < 2 * th) continue;
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
      for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) if (m[y * W + x]) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (n >= 10) out.push([x0, y0, x1 - x0 + 1, y1 - y0 + 1]);
    }
    return out;
  }
  const median = arr => { const s = arr.slice().sort((a, b) => a - b), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };

  // ---------- CNN + CTC line reader ----------
  let NET = null;
  function setNet(d) {
    const dec = b64 => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Float32Array(u.buffer); };
    NET = { ch: d.ch, ht: d.ht, L: {} };
    for (const k in d.layers) { const s = d.layers[k].shape; NET.L[k] = { w: dec(d.layers[k].w), b: dec(d.layers[k].b), s: s.length === 3 ? [s[0], s[1], 1, s[2]] : s }; }
  }
  // conv2d, stride 1, zero padding (ph, pw); x: [C][H][W] flat
  function conv2d(x, C, H, W, L, ph, pw) {
    const [O, , KH, KW] = L.s, Ho = H + 2 * ph - KH + 1, Wo = W + 2 * pw - KW + 1, y = new Float32Array(O * Ho * Wo);
    if (KW === 3 && pw === 1 && KH === 3 && ph === 1 && W >= 2) {   // fast path: whole 3x3 window per output in one pass
      const W2 = W + 2, P = new Float32Array(C * (H + 2) * W2);   // zero-padded copy of the input
      for (let c = 0; c < C; c++) for (let yy = 0; yy < H; yy++) P.set(x.subarray((c * H + yy) * W, (c * H + yy + 1) * W), (c * (H + 2) + yy + 1) * W2 + 1);
      for (let o = 0; o < O; o++) {
        const yo = o * Ho * Wo; y.fill(L.b[o], yo, yo + Ho * Wo);
        for (let c = 0; c < C; c++) {
          const wb = (o * C + c) * 9, w = L.w;
          const a0 = w[wb], a1 = w[wb + 1], a2 = w[wb + 2], b0 = w[wb + 3], b1 = w[wb + 4], b2 = w[wb + 5], c0 = w[wb + 6], c1 = w[wb + 7], c2 = w[wb + 8];
          const base = c * (H + 2) * W2;
          for (let i = 0; i < Ho; i++) {
            const r0 = base + i * W2, r1 = r0 + W2, r2 = r1 + W2, yr = yo + i * Wo;
            for (let j = 0; j < Wo; j++)
              y[yr + j] += a0 * P[r0 + j] + a1 * P[r0 + j + 1] + a2 * P[r0 + j + 2]
                         + b0 * P[r1 + j] + b1 * P[r1 + j + 1] + b2 * P[r1 + j + 2]
                         + c0 * P[r2 + j] + c1 * P[r2 + j + 1] + c2 * P[r2 + j + 2];
          }
        }
      }
      return { y, C: O, H: Ho, W: Wo };
    }
    if (KW === 3 && pw === 1 && W >= 2) {   // 1x3 (conv1d) path
      for (let o = 0; o < O; o++) {
        const yo = o * Ho * Wo; y.fill(L.b[o], yo, yo + Ho * Wo);
        for (let c = 0; c < C; c++) for (let ky = 0; ky < KH; ky++) {
          const wb = ((o * C + c) * KH + ky) * 3, w0 = L.w[wb], w1 = L.w[wb + 1], w2 = L.w[wb + 2];
          for (let i = 0; i < Ho; i++) {
            const yy = i + ky - ph; if (yy < 0 || yy >= H) continue;
            const xr = (c * H + yy) * W, yr = yo + i * Wo;
            y[yr] += w1 * x[xr] + w2 * x[xr + 1];
            for (let j = 1; j < W - 1; j++) y[yr + j] += w0 * x[xr + j - 1] + w1 * x[xr + j] + w2 * x[xr + j + 1];
            y[yr + W - 1] += w0 * x[xr + W - 2] + w1 * x[xr + W - 1];
          }
        }
      }
      return { y, C: O, H: Ho, W: Wo };
    }
    for (let o = 0; o < O; o++) {
      const yo = o * Ho * Wo; y.fill(L.b[o], yo, yo + Ho * Wo);
      for (let c = 0; c < C; c++) for (let ky = 0; ky < KH; ky++) for (let kx = 0; kx < KW; kx++) {
        const wv = L.w[((o * C + c) * KH + ky) * KW + kx]; if (!wv) continue;
        for (let i = 0; i < Ho; i++) {
          const yy = i + ky - ph; if (yy < 0 || yy >= H) continue;
          const xr = (c * H + yy) * W, yr = yo + i * Wo;
          const j0 = Math.max(0, pw - kx), j1 = Math.min(Wo, W + pw - kx);
          for (let j = j0; j < j1; j++) y[yr + j] += wv * x[xr + j + kx - pw];
        }
      }
    }
    return { y, C: O, H: Ho, W: Wo };
  }
  const relu = a => { for (let i = 0; i < a.length; i++) if (a[i] < 0) a[i] = 0; return a; };
  function pool(t, ph, pw) {
    const Ho = Math.floor(t.H / ph), Wo = Math.floor(t.W / pw), y = new Float32Array(t.C * Ho * Wo);
    for (let c = 0; c < t.C; c++) for (let i = 0; i < Ho; i++) for (let j = 0; j < Wo; j++) {
      let m = -Infinity;
      for (let a = 0; a < ph; a++) for (let b = 0; b < pw; b++) { const v = t.y[(c * t.H + i * ph + a) * t.W + j * pw + b]; if (v > m) m = v; }
      y[(c * Ho + i) * Wo + j] = m;
    }
    return { y, C: t.C, H: Ho, W: Wo };
  }
  function netRead(img, W) {            // img: Float32Array ht*W (already normalized)
    let t = { y: img, C: 1, H: NET.ht, W };
    const cv = (n, ph, pw) => { const r = conv2d(t.y, t.C, t.H, t.W, NET.L[n], ph, pw); relu(r.y); return r; };
    t = pool(cv("c1", 1, 1), 2, 2); t = pool(cv("c2", 1, 1), 2, 2); t = pool(cv("c3", 1, 1), 2, 1); t = pool(cv("c4", 1, 1), 2, 1);
    t = cv("c5", 0, 0);                   // H=1
    t = cv("c6", 0, 1);                   // conv1d as 1xK conv (weights shaped [O,C,K] -> treat as KH=1)
    const L = NET.L.fc, O = L.s[0], T = t.W, C = t.C, z = new Float32Array(O); let out = "", prev = -1; const conf = [];
    for (let j = 0; j < T; j++) {
      let bi = 0, bv = -Infinity;
      for (let o = 0; o < O; o++) { let s = L.b[o]; for (let c = 0; c < C; c++) s += L.w[o * C + c] * t.y[c * T + j]; z[o] = s; if (s > bv) { bv = s; bi = o; } }
      if (bi !== O - 1) {
        let den = 0; for (let o = 0; o < O; o++) den += Math.exp(z[o] - bv);
        const pr = 1 / den;
        if (bi !== prev) { out += NET.ch[bi]; conf.push(pr); } else conf[conf.length - 1] = Math.max(conf[conf.length - 1], pr);
      }
      prev = bi;
    }
    return { s: out, conf: conf.length ? Math.min(...conf) : 0 };
  }
  function cropNorm(g, W, H, box) {       // mirrors crnn.norm_resize(area_resize)
    const [x0, y0, x1, y1] = box, w = x1 - x0, h = y1 - y0, HT = NET.ht;
    const Wt = Math.max(8, Math.min(320, Math.round(w * HT / h))), r = new Float32Array(HT * Wt);
    for (let i = 0; i < HT; i++) for (let j = 0; j < Wt; j++) {
      let s = 0;
      for (let a = 0; a < 3; a++) { const yy = Math.min(h - 1, Math.trunc((i + (a + 0.5) / 3) * h / HT));
        for (let b = 0; b < 3; b++) { const xx = Math.min(w - 1, Math.trunc((j + (b + 0.5) / 3) * w / Wt)); s += g[(y0 + yy) * W + x0 + xx]; } }
      r[i * Wt + j] = s / 9;
    }
    const sorted = Array.from(r).sort((a, b) => a - b), q = p => { const k = (sorted.length - 1) * p, f = Math.floor(k), c = Math.min(sorted.length - 1, f + 1); return sorted[f] + (sorted[c] - sorted[f]) * (k - f); };
    const lo = q(0.05), hi = q(0.95), den = Math.max(hi - lo, 1);
    for (let i = 0; i < r.length; i++) r[i] = Math.min(1.5, Math.max(-0.5, (hi - r[i]) / den));
    return { img: r, W: Wt };
  }

  // ---------- reading ----------
  const roundEven = x => { const f = Math.floor(x), d = x - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1); };  // = Python round()
  const parseCoord = s => { const m = s.match(/^(3[1256]),(\d{2,8})$/); return m ? parseFloat(m[1] + "." + m[2]) : null; };
  const parsePhone = s => (/^07[789]\d{7}$/.test(s) ? s : null);

  function readGray(g, W, H) {
    const m = binarize(g, W, H);
    const { comps } = components(m, W, H);
    const th = estimateH(comps);
    const lats = [], lngs = [], pad = roundEven(0.25 * th);
    let phones = [], nb = 0;
    for (const [x, y, w, h] of wordBoxes(m, W, H, th)) {
      nb++;
      const box = [Math.max(0, x - pad), Math.max(0, y - pad), Math.min(W, x + w + pad), Math.min(H, y + h + pad)];
      const { img, W: Wt } = cropNorm(g, W, H, box);
      const { s, conf } = netRead(img, Wt), cy = y + h / 2;
      const v = parseCoord(s);
      if (v !== null) { (v < 34 ? lats : lngs).push([v, cy]); continue; }
      const p = parsePhone(s); if (p) phones.push([p, cy, conf]);
    }
    // subscriber screen (many fields, no coordinate table): only the approved mobile (top-most) counts;
    // the other numbers there belong to staff (meter reader etc.)
    if (nb >= 50 && lats.length + lngs.length < 5 && phones.length) phones = [phones.reduce((a, b) => (b[1] < a[1] ? b : a))];
    return { lats, lngs, phones, screen: nb >= 50 && lats.length + lngs.length < 5 };
  }

  async function grayFromBlob(blob, maxSide) {
    maxSide = maxSide || 1600;
    const bmp = await createImageBitmap(blob);
    const sc = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const W = Math.round(bmp.width * sc), H = Math.round(bmp.height * sc);
    const cv = (typeof OffscreenCanvas !== "undefined") ? new OffscreenCanvas(W, H) : Object.assign(document.createElement("canvas"), { width: W, height: H });
    const ctx = cv.getContext("2d"); ctx.drawImage(bmp, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data, g = new Float32Array(W * H);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = Math.round(0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]);
    return { g, W, H };
  }

  const FAKE = /^07(\d)\1{7}$/;
  function pick(vals) {
    if (!vals.length) return null;
    const r = vals.map(([v, y]) => [Math.round(v * 1e4) / 1e4, y]), cnt = new Map();
    r.forEach(([v]) => cnt.set(v, (cnt.get(v) || 0) + 1));
    const top = Math.max(...cnt.values()), cands = [...cnt.keys()].filter(v => cnt.get(v) === top);
    return cands.reduce((best, v) => { const yv = Math.max(...r.filter(x => x[0] === v).map(x => x[1])); return (best === null || yv > best[1]) ? [v, yv] : best; }, null)[0];
  }
  // phones: fold 1-digit variants (misreads of the same number) into the stronger reading
  function mergePhones(reads) {
    const cnt = new Map(), cs = new Map();
    reads.forEach(([p, c]) => { cnt.set(p, (cnt.get(p) || 0) + 1); cs.set(p, (cs.get(p) || 0) + c); });
    const order = [...cnt.keys()].sort((a, b) => (cnt.get(b) - cnt.get(a)) || (cs.get(b) - cs.get(a)));
    const out = new Map();
    const ham1 = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d === 1; };
    for (const p of order) {
      const t = [...out.keys()].find(q => ham1(p, q));
      if (t) { const o = out.get(t); o.n += cnt.get(p); o.alt.push(p); } else out.set(p, { n: cnt.get(p), alt: [] });
    }
    return [...out.entries()].sort((a, b) => b[1].n - a[1].n).map(([p, o]) => ({ p, n: o.n, alt: o.alt }));
  }
  function combine(results) {
    const la = [], ln = [], ph = [];
    results.forEach(r => { la.push(...r.lats); ln.push(...r.lngs); r.phones.forEach(([p, , c]) => { if (!FAKE.test(p)) ph.push([p, c]); }); });
    let lat = pick(la), lng = pick(ln);
    if (lat !== null && !(lat > 29 && lat < 34)) lat = null;
    if (lng !== null && !(lng > 34.5 && lng < 39.5)) lng = null;
    return { lat, lng, phones: mergePhones(ph), nLat: la.length, nLng: ln.length };
  }

  root.VisitReader = { binarize, components, estimateH, dropLines, wordBoxes, setNet, netRead, cropNorm, readGray, grayFromBlob, combine, pick, mergePhones, roundEven };
})(typeof window !== "undefined" ? window : globalThis);
