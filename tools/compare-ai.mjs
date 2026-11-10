#!/usr/bin/env node
/**
 * The object models side by side: each one (a row) clicks the same things in
 * a photo (the columns) in the development editor (demo/: the site ships only one model), and the outlines are drawn into
 * one picture (zoomed in on each target), with how long each look and click took.
 *
 *   node tools/compare-ai.mjs [out.png] [photo] [targets]
 *
 * photo: part of a name in the photo list (default Charleston); targets: JSON
 * [[name, x, y], …] in a 480 × 360 frame of it (scaled to the picture). The
 * times are headless Chrome's, one thread, no GPU — a real browser is faster.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [out = 'compare-ai.png', photo = 'Charleston', targetsJson] = process.argv.slice(2);
const targets = targetsJson ? JSON.parse(targetsJson)
    : [['the SUV', 190, 246], ['the horse', 325, 237], ['a person', 109, 238], ['the pink house', 205, 150], ['a palm tree', 290, 135]];

const js = `(async () => {
  const D = mzDemo, S = D.selection, targets = ${JSON.stringify(targets)};
  const pick = document.getElementById('photo');
  pick.selectedIndex = [...pick.options].findIndex((o) => o.text.includes(${JSON.stringify(photo)}));
  await pick.onchange();
  document.getElementById('play').checked = false;
  const src = document.getElementById('source'), W = src.width, H = src.height;
  const pic = document.createElement('canvas'); pic.width = W; pic.height = H; pic.getContext('2d').drawImage(src, 0, 0);
  const msg = () => document.getElementById('select-msg').textContent;
  const choose = document.getElementById('select-ai-model');
  const keys = [...choose.options].map((o) => o.value);
  const rows = [];
  document.getElementById('select-ai').click();
  for (const key of keys) {
    const name = D.ai.models[key].name;
    choose.value = key; choose.onchange();
    for (let i = 0; i < 2400 && !msg().includes(name + ' looked in') && !/not available/.test(msg()); i++) await new Promise((r) => setTimeout(r, 250));
    const row = { name, look: D.ai.model.lookMs, cells: [] };
    for (const [what, tx, ty] of targets) {
      D.ai.key('Escape');
      const x = Math.round(tx * W / 480), y = Math.round(ty * H / 360);
      const t0 = performance.now();
      await D.ai.click(x, y, false);
      row.cells.push({ what, x, y, ms: performance.now() - t0, mask: S.state.preview && S.state.preview.slice() });
    }
    D.ai.key('Escape');
    rows.push(row);
  }
  // the sheet: a row per model, a column per target
  const cw = 1200 / targets.length, ch = Math.round(cw * H / W), head = 20;
  const sheet = document.createElement('canvas'); sheet.width = 1200; sheet.height = rows.length * (ch + head) + head;
  const g = sheet.getContext('2d');
  g.fillStyle = '#111'; g.fillRect(0, 0, sheet.width, sheet.height);
  g.font = '13px system-ui, sans-serif'; g.fillStyle = '#fff';
  targets.forEach(([what], j) => g.fillText(what, j * cw + 6, 14));
  const cell = document.createElement('canvas'); cell.width = W; cell.height = H;
  const cg = cell.getContext('2d');
  rows.forEach((row, r) => {
    const top = head + r * (ch + head);
    g.fillStyle = '#ffd54f'; g.fillText(row.name + ' — looked in ' + (row.look / 1000).toFixed(1) + ' s', 6, top + 14);
    row.cells.forEach((c, j) => {
      cg.drawImage(pic, 0, 0);
      const im = cg.getImageData(0, 0, W, H);
      let area = 0;
      if (c.mask) for (let i = 0; i < c.mask.length; i++) if (c.mask[i]) { area++; im.data[i * 4] = im.data[i * 4] * 0.35 + 255 * 0.65; im.data[i * 4 + 1] = im.data[i * 4 + 1] * 0.35 + 213 * 0.65; im.data[i * 4 + 2] *= 0.35; }
      cg.putImageData(im, 0, 0);
      cg.fillStyle = '#e03a3a'; cg.beginPath(); cg.arc(c.x, c.y, Math.max(3, W / 120), 0, Math.PI * 2); cg.fill();
      // zoomed in on the target: a third of the picture round it
      const zw = W / 3, zh = H / 3, zx = Math.max(0, Math.min(W - zw, c.x - zw / 2)), zy = Math.max(0, Math.min(H - zh, c.y - zh / 2));
      g.drawImage(cell, zx, zy, zw, zh, j * cw, top + head, cw - 2, ch);
      g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(j * cw, top + head + ch - 18, cw - 2, 18);
      g.fillStyle = '#fff'; g.fillText(c.mask ? area + ' px, ' + Math.round(c.ms) + ' ms' : 'nothing (' + Math.round(c.ms) + ' ms)', j * cw + 6, top + head + ch - 5);
    });
  });
  document.body.innerHTML = ''; document.body.style.margin = '0'; document.body.append(sheet);
  return rows.map((row) => row.name + ': look ' + (row.look / 1000).toFixed(1) + ' s; ' + row.cells.map((c) => c.what + ' ' + (c.mask ? c.mask.reduce((a, b) => a + b, 0) + ' px' : '-') + ' ' + Math.round(c.ms) + ' ms').join(', ')).join('\\n');
})()`;

const shot = fileURLToPath(new URL('shot.mjs', import.meta.url));
const run = spawnSync(process.execPath, [shot, '/demo/index.html', js, out], { stdio: 'inherit', env: { ...process.env, SHOT_TIMEOUT: process.env.SHOT_TIMEOUT || '900000' } });
process.exit(run.status ?? 1);
