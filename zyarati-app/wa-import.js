/* زياراتي — قراءة ملف تصدير محادثة واتساب (zip) بدون مكتبات خارجية */
(function (root) {
  "use strict";
  const AR = "٠١٢٣٤٥٦٧٨٩", FA = "۰۱۲۳۴۵۶۷۸۹";
  const toLatin = s => String(s).replace(/[٠-٩]/g, d => AR.indexOf(d)).replace(/[۰-۹]/g, d => FA.indexOf(d));

  // ---------- minimal ZIP reader (stored + deflate) ----------
  async function inflateRaw(u8) {
    const ds = new DecompressionStream("deflate-raw");
    const buf = await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(buf);
  }
  async function readZip(buffer) {
    const u8 = new Uint8Array(buffer), dv = new DataView(buffer);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("ليس ملف zip صالحاً");
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder("utf-8"), files = {};
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;
      const lnl = dv.getUint16(lho + 26, true), lxl = dv.getUint16(lho + 28, true);
      const start = lho + 30 + lnl + lxl;
      const raw = u8.subarray(start, start + csize);
      files[name.split("/").pop()] = { method, raw, get: async () => (method === 0 ? raw : inflateRaw(raw)) };
    }
    return files;
  }

  // ---------- chat text parser ----------
  const LINE = /^‎?\[?(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm]|ص|م)?\]?\s*[-–]?\s*([^:]+?):\s(.*)$/;
  function parseChat(text) {
    const msgs = [];
    for (let raw of text.split(/\r?\n/)) {
      raw = raw.replace(/[‎‏‪-‮]/g, "");
      const m = raw.match(LINE);
      if (m) {
        let [, d, mo, y, h, mi, ap, who, body] = m;
        if (y.length === 2) y = "20" + y;
        h = +h; if (/p|م/i.test(ap || "") && h < 12) h += 12; if (/a|ص/i.test(ap || "") && h === 12) h = 0;
        msgs.push({ date: `${d.padStart(2, "0")}/${mo.padStart(2, "0")}/${y}`, t: h * 60 + +mi, who: who.trim(), text: body });
      } else if (msgs.length) msgs[msgs.length - 1].text += "\n" + raw;
    }
    return msgs;
  }
  const imgName = s => { const m = s.match(/([\w-]+\.(?:jpe?g|png|webp))/i); return m ? m[1] : null; };

  /** Build the subscriber list for one day.
   *  clerk = the person who sends the images; me = the other person (the technician). */
  function buildDay(msgs, date) {
    if (!msgs.length) return { date: null, subs: [] };
    const imgCount = {};
    msgs.forEach(m => { if (imgName(m.text)) imgCount[m.who] = (imgCount[m.who] || 0) + 1; });
    const clerk = Object.keys(imgCount).sort((a, b) => imgCount[b] - imgCount[a])[0];
    const dates = [...new Set(msgs.filter(m => m.who === clerk && imgName(m.text)).map(m => m.date))];
    date = date || dates[dates.length - 1] || msgs[msgs.length - 1].date;
    // task notes: consecutive messages of the technician (same day, <60 min apart)
    const tasks = {}, extraPhones = {};
    let batch = null; const batches = [];
    for (const m of msgs) {
      if (m.who === clerk || /end-to-end|مشفرة/i.test(m.text)) { batch = null; continue; }
      if (!batch || batch.date !== m.date || m.t - batch.last > 60) { batch = { date: m.date, last: m.t, msgs: [] }; batches.push(batch); }
      batch.msgs.push(m); batch.last = m.t;
    }
    for (const b of batches) {
      const nums = [], notes = [];
      for (const m of b.msgs) {
        const tx = toLatin(m.text);
        const found = [...tx.matchAll(/^\s*(\d{4,7})\b/gm)].map(x => x[1]);
        nums.push(...found);
        const ph = tx.match(/\b07[789]\d{7}\b/g) || [];
        if (found.length === 1 && ph.length) (extraPhones[found[0]] = extraPhones[found[0]] || []).push(...ph);
        for (let l of tx.split("\n")) { l = l.trim(); if (!l || /^\d/.test(l) || /^(اربد|إربد|جرش|عجلون|المفرق)$/.test(l)) continue; notes.push(l); }
      }
      const note = [...new Set(notes)].join(" · ");
      if (note) nums.forEach(n => (tasks[n] = note));
    }
    const subs = []; let cur = null;
    for (const m of msgs) {
      if (m.date !== date || m.who !== clerk) continue;
      const tx = toLatin(m.text).trim(), img = imgName(tx);
      if (img) { if (cur) cur.images.push(img); }
      else if (/^\d{4,7}$/.test(tx)) { cur = { id: tx, images: [], task: tasks[tx] || "", extraPhones: extraPhones[tx] || [] }; subs.push(cur); }
    }
    return { date, clerk, dates, subs };
  }

  root.WAImport = { readZip, parseChat, buildDay, toLatin };
})(typeof window !== "undefined" ? window : globalThis);
