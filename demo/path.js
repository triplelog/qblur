/**
 * A path drawn on the picture (Make it move's Ken Burns: where the view's center goes over time). Points are 0–1 of the
 * picture. No DOM, so test/path.test.js runs it in Node.
 *
 *   const path = makePath(points);   // smoothed, then spaced evenly along its length (so the speed is steady)
 *   pointAt(path, 0.25);             // where it is a quarter of the way along
 *   progress(t, period, back);       // 0 → 1 over `period` (and back to 0 over the next, with `back`), looping
 */

/** Smoothed (a moving average over `smooth` points each side) and resampled to `n` points evenly spaced by arc length. */
export function makePath(points, { n = 64, smooth = 3 } = {}) {
  const pts = points.filter((p, i) => i === 0 || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 1e-6);
  if (pts.length < 2) return pts.length ? [pts[0], pts[0]] : [];
  const soft = pts.map((_, i) => {
    let x = 0, y = 0, k = 0;
    for (let j = Math.max(0, i - smooth); j <= Math.min(pts.length - 1, i + smooth); j++) { x += pts[j][0]; y += pts[j][1]; k++; }
    return i === 0 || i === pts.length - 1 ? pts[i] : [x / k, y / k];        // the ends stay where they were drawn
  });
  const along = [0];
  for (let i = 1; i < soft.length; i++) along.push(along[i - 1] + Math.hypot(soft[i][0] - soft[i - 1][0], soft[i][1] - soft[i - 1][1]));
  const total = along[along.length - 1];
  const out = [];
  for (let k = 0, i = 1; k < n; k++) {
    const d = (k / (n - 1)) * total;
    while (i < soft.length - 1 && along[i] < d) i++;
    const f = along[i] === along[i - 1] ? 0 : (d - along[i - 1]) / (along[i] - along[i - 1]);
    out.push([soft[i - 1][0] + (soft[i][0] - soft[i - 1][0]) * f, soft[i - 1][1] + (soft[i][1] - soft[i - 1][1]) * f]);
  }
  return out;
}

/** The point `p` (0–1) of the way along a made path, eased in and out at the ends so the camera starts and stops gently. */
export function pointAt(path, p) {
  if (!path.length) return [0.5, 0.5];
  const e = Math.min(1, Math.max(0, p)), eased = e * e * (3 - 2 * e);
  const f = eased * (path.length - 1), i = Math.min(path.length - 2, Math.floor(f)), k = f - i;
  return [path[i][0] + (path[i + 1][0] - path[i][0]) * k, path[i][1] + (path[i + 1][1] - path[i][1]) * k];
}

/** How far along at time t: 0 → 1 over `period`, then (with `back`) 1 → 0 over the next, or straight back to 0; looping. */
export function progress(t, period, back = true) {
  const u = t / period;
  if (!back) return u - Math.floor(u);
  const v = (u / 2) - Math.floor(u / 2);                 // 0–1 over two periods
  return 1 - Math.abs(1 - 2 * v);
}
