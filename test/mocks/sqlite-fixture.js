// Test fixture writer: a minimal SQLite database (and optional WAL) built from
// plain table specs, so the Antigravity reader can be tested with Node alone
// (no sqlite3 binary, no node:sqlite). Rowid tables only — the subset the
// reader supports — but real file-format pages: a 100-byte header, table
// b-tree leaf/interior pages, overflow chains and WAL frames with checksums.
//
//   writeDb(file, tables, { pageSize })        → the database image (pages[])
//   writeWal(file + '-wal', base, next, { uncommitted })
//     frames for every page of `next` that differs from `base`, the last one
//     carrying the commit mark; then `uncommitted` (another image) as frames
//     with NO commit mark — a reader must ignore those.
//
// tables: [{ name, sql, rows: [[col values…]] }] — values are null, integers,
// strings or Buffers; the rowid is the row's 1-based position.
'use strict';
const fs = require('fs');

function varint(v) {
  // SQLite varint: big-endian 7-bit groups, high bit = more (≤ 2^56 here).
  if (v < 0 || !Number.isSafeInteger(v)) throw new Error('varint out of range');
  const out = [v % 128];
  v = Math.floor(v / 128);
  while (v > 0) { out.unshift((v % 128) | 0x80); v = Math.floor(v / 128); }
  return Buffer.from(out);
}

function record(values) {
  const types = [], bodies = [];
  for (const v of values) {
    if (v === null || v === undefined) { types.push(0); bodies.push(Buffer.alloc(0)); }
    else if (Buffer.isBuffer(v)) { types.push(12 + 2 * v.length); bodies.push(v); }
    else if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); types.push(13 + 2 * b.length); bodies.push(b); }
    else if (Number.isInteger(v)) {
      if (v === 0) { types.push(8); bodies.push(Buffer.alloc(0)); continue; }
      if (v === 1) { types.push(9); bodies.push(Buffer.alloc(0)); continue; }
      const sizes = [[1, 1], [2, 2], [3, 3], [4, 4], [5, 6], [6, 8]];
      const [t, n] = sizes.find(([, len]) => v >= -(2 ** (8 * len - 1)) && v < 2 ** (8 * len - 1));
      const b = Buffer.alloc(n);
      let x = v < 0 ? 2 ** (8 * n) + v : v;
      for (let k = n - 1; k >= 0; k--) { b[k] = x % 256; x = Math.floor(x / 256); }
      types.push(t); bodies.push(b);
    } else throw new Error('unsupported value');
  }
  const typeBytes = Buffer.concat(types.map(varint));
  let hdrLen = typeBytes.length + 1;
  while (varint(hdrLen).length + typeBytes.length > hdrLen) hdrLen++;
  return Buffer.concat([varint(hdrLen), typeBytes, ...bodies]);
}

// Build the whole image. Page 1 = sqlite_master; pages 2..T+1 = each table's
// root (so roots stay put between two images of the same schema).
function buildImage(tables, pageSize) {
  const U = pageSize;
  const pages = [null]; // 1-based
  const alloc = () => { pages.push(Buffer.alloc(pageSize)); return pages.length - 1; };
  alloc(); // page 1
  const roots = tables.map(() => alloc());

  // One leaf cell (payload + overflow chain) → Buffer.
  const leafCell = (rowid, payload) => {
    const X = U - 35;
    const head = Buffer.concat([varint(payload.length), varint(rowid)]);
    if (payload.length <= X) return Buffer.concat([head, payload]);
    const M = Math.floor(((U - 12) * 32) / 255) - 23;
    const K = M + ((payload.length - M) % (U - 4));
    const local = K <= X ? K : M;
    let rest = payload.subarray(local);
    const first = alloc();
    let pg = first;
    while (rest.length) {
      const take = Math.min(rest.length, U - 4);
      rest.copy(pages[pg], 4, 0, take);
      rest = rest.subarray(take);
      if (rest.length) { const nx = alloc(); pages[pg].writeUInt32BE(nx, 0); pg = nx; }
    }
    const ptr = Buffer.alloc(4); ptr.writeUInt32BE(first, 0);
    return Buffer.concat([head, payload.subarray(0, local), ptr]);
  };

  // Write cells into page n as a b-tree page of `kind`.
  const writePage = (n, kind, cells, rightChild) => {
    const pg = pages[n];
    const base = n === 1 ? 100 : 0;
    const hdr = kind === 0x05 ? 12 : 8;
    let content = pageSize;
    pg[base] = kind;
    pg.writeUInt16BE(0, base + 1);
    pg.writeUInt16BE(cells.length, base + 3);
    cells.forEach((c, i) => {
      content -= c.length;
      c.copy(pg, content);
      pg.writeUInt16BE(content, base + hdr + 2 * i);
    });
    if (base + hdr + 2 * cells.length > content) throw new Error('page overflow');
    pg.writeUInt16BE(content === 65536 ? 0 : content, base + 5);
    pg[base + 7] = 0;
    if (kind === 0x05) pg.writeUInt32BE(rightChild, base + 8);
  };

  // A table: leaf pages filled greedily; >1 leaf → interior root.
  const writeTable = (root, rows, headerBase) => {
    const room = pageSize - headerBase - 8;
    const leaves = [[]];
    let used = 0;
    rows.forEach((vals, i) => {
      const cell = leafCell(i + 1, record(vals));
      if (used + cell.length + 2 > room && leaves[leaves.length - 1].length) { leaves.push([]); used = 0; }
      leaves[leaves.length - 1].push({ cell, rowid: i + 1 });
      used += cell.length + 2;
    });
    if (leaves.length === 1) { writePage(root, 0x0d, leaves[0].map((c) => c.cell)); return; }
    const leafPages = leaves.map((l) => { const n = alloc(); writePage(n, 0x0d, l.map((c) => c.cell)); return n; });
    const inner = leafPages.slice(0, -1).map((n, i) => {
      const p = Buffer.alloc(4); p.writeUInt32BE(n, 0);
      return Buffer.concat([p, varint(leaves[i][leaves[i].length - 1].rowid)]);
    });
    writePage(root, 0x05, inner, leafPages[leafPages.length - 1]);
  };

  tables.forEach((t, i) => writeTable(roots[i], t.rows, 0));
  writeTable(1, tables.map((t, i) => ['table', t.name, t.name, roots[i], t.sql]), 100);

  // Database header.
  const h = pages[1];
  h.write('SQLite format 3\u0000', 0, 'latin1');
  h.writeUInt16BE(pageSize === 65536 ? 1 : pageSize, 16);
  h[18] = 2; h[19] = 2; // WAL read/write versions
  h[20] = 0; h[21] = 64; h[22] = 32; h[23] = 32;
  h.writeUInt32BE(1, 24);               // change counter
  h.writeUInt32BE(pages.length - 1, 28); // size in pages
  h.writeUInt32BE(1, 40);               // schema cookie
  h.writeUInt32BE(4, 44);               // schema format
  h.writeUInt32BE(1, 56);               // UTF-8
  h.writeUInt32BE(1, 92);
  h.writeUInt32BE(3045000, 96);
  return pages.slice(1);
}

function writeDb(file, tables, { pageSize = 4096 } = {}) {
  const img = buildImage(tables, pageSize);
  fs.writeFileSync(file, Buffer.concat(img));
  return img;
}

function walChecksum(buf, s1, s2) {
  for (let i = 0; i < buf.length; i += 8) {
    s1 = (s1 + buf.readUInt32LE(i) + s2) >>> 0;
    s2 = (s2 + buf.readUInt32LE(i + 4) + s1) >>> 0;
  }
  return [s1, s2];
}

function writeWal(file, base, next, { uncommitted = null } = {}) {
  const pageSize = next[0].length;
  const salt1 = 0x1234abcd, salt2 = 0x0badf00d;
  const hdr = Buffer.alloc(32);
  hdr.writeUInt32BE(0x377f0682, 0); // little-endian checksums
  hdr.writeUInt32BE(3007000, 4);
  hdr.writeUInt32BE(pageSize, 8);
  hdr.writeUInt32BE(0, 12);
  hdr.writeUInt32BE(salt1, 16);
  hdr.writeUInt32BE(salt2, 20);
  let [s1, s2] = walChecksum(hdr.subarray(0, 24), 0, 0);
  hdr.writeUInt32BE(s1, 24); hdr.writeUInt32BE(s2, 28);
  const out = [hdr];
  const frames = (img, prev, commit) => {
    const changed = [];
    img.forEach((pg, i) => { if (!prev[i] || !pg.equals(prev[i])) changed.push(i + 1); });
    changed.forEach((n, k) => {
      const fh = Buffer.alloc(24);
      fh.writeUInt32BE(n, 0);
      fh.writeUInt32BE(commit && k === changed.length - 1 ? img.length : 0, 4);
      fh.writeUInt32BE(salt1, 8); fh.writeUInt32BE(salt2, 12);
      [s1, s2] = walChecksum(fh.subarray(0, 8), s1, s2);
      [s1, s2] = walChecksum(img[n - 1], s1, s2);
      fh.writeUInt32BE(s1, 16); fh.writeUInt32BE(s2, 20);
      out.push(fh, img[n - 1]);
    });
  };
  frames(next, base, true);
  if (uncommitted) frames(uncommitted, next, false);
  fs.writeFileSync(file, Buffer.concat(out));
}

// ---- protobuf wire-format writer (varint + length-delimited fields only) ----
function pbVarint(v) {
  const out = [];
  do { let b = v % 128; v = Math.floor(v / 128); if (v > 0) b |= 0x80; out.push(b); } while (v > 0);
  return Buffer.from(out);
}
// pb([[field, value], …]) — value: integer → varint, Buffer/string → bytes,
// array → nested message.
function pb(fields) {
  return Buffer.concat(fields.map(([f, v]) => {
    if (typeof v === 'number') return Buffer.concat([pbVarint(f * 8), pbVarint(v)]);
    const b = Array.isArray(v) ? pb(v) : Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8');
    return Buffer.concat([pbVarint(f * 8 + 2), pbVarint(b.length), b]);
  }));
}

module.exports = { writeDb, writeWal, buildImage, record, pb };
