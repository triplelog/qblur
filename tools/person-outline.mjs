#!/usr/bin/env node
/**
 * `node tools/person-outline.mjs portrait.jpg` — a sample photo's person, outlined ahead of time for the profile-picture
 * page (so opening it doesn't download the model): opens /demo/avatar/ on that photo in headless Chrome (tools/shot.mjs),
 * lets MobileSAM outline the person from its usual guess, and writes demo/photos/<name>.person.png (white = the person,
 * the size of the model's copy) and the photo's "person" entry in demo/photos/index.json. Needs ImageMagick (`magick`).
 */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const photo = process.argv[2];
const listFile = join(ROOT, 'demo/photos/index.json');
const list = JSON.parse(await readFile(listFile, 'utf8'));
const entry = list.find((p) => p.file === photo);
if (!entry) { console.error('usage: node tools/person-outline.mjs <a photo listed in demo/photos/index.json>'); process.exit(1); }
const save = () => writeFile(listFile, JSON.stringify(list, null, 2) + '\n');
delete entry.person;                                       // the page must run the model, not read the old outline
await save();

const expr = `(async () => {
  const s = qblurApp.state, sample = document.getElementById('sample');
  sample.value = [...sample.options].find((o) => o.textContent === ${JSON.stringify(entry.title || entry.file)}).value;
  sample.dispatchEvent(new Event('change'));
  await new Promise((r) => setTimeout(r, 500));
  for (let i = 0; i < 1000 && !s.personMask; i++) await new Promise((r) => setTimeout(r, 200));
  if (!s.person) return '';
  const c = document.createElement('canvas'); c.width = s.small.width; c.height = s.small.height;
  const g = c.getContext('2d'), img = g.createImageData(c.width, c.height);
  s.personMask.forEach((v, i) => { const x = v ? 255 : 0; img.data.set([x, x, x, 255], i * 4); });
  g.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
})()`;
const tmp = join(tmpdir(), `qblur-outline-${process.pid}`);
const out = execFileSync('node', [join(ROOT, 'tools/shot.mjs'), '/demo/avatar/index.html', expr, `${tmp}-shot.png`], {
    env: { ...process.env, SHOT_TIMEOUT: '300000', SHOT_READY: 'Boolean(window.qblurApp)', SHOT_FULL: '1' }, encoding: 'utf8', maxBuffer: 64 << 20 });
const url = /RESULT: "data:image\/png;base64,([^"]+)"/.exec(out)?.[1];
await rm(`${tmp}-shot.png`, { force: true });
if (!url) { console.error('the model found no person in', photo); process.exit(1); }
await writeFile(`${tmp}.png`, Buffer.from(url, 'base64'));
const name = photo.replace(/\.[^.]+$/, '.person.png');
execFileSync('magick', [`${tmp}.png`, '-alpha', 'off', '-colorspace', 'Gray', '-threshold', '50%', '-type', 'bilevel', join(ROOT, 'demo/photos', name)]);
await rm(`${tmp}.png`, { force: true });
entry.person = name;
await save();
console.log(`demo/photos/${name}, and "person" in index.json`);
