// Headless end-to-end check: loads the app, runs capture → reconstruct → evaluate
// for several rig / lens / sensor configurations, prints metrics and saves screenshots.
// Usage: node scripts/smoke-test.mjs [outDir]
import { createRequire } from 'node:module';
import { createServer } from 'vite';

// require() so a globally installed Playwright also resolves (install locally with `npm i -D playwright`).
const { chromium } = createRequire(import.meta.url)('playwright');

const outDir = process.argv[2] ?? '.';
const server = await createServer({ server: { port: 5199 }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto('http://localhost:5199/');
await page.waitForFunction(() => window.app);

const pinhole = { type: 'pinhole', fovDeg: 70, k1: 0, k2: 0, p1: 0, p2: 0, k3: 0, k4: 0 };
const wide = { type: 'pinhole', fovDeg: 80, k1: -0.22, k2: 0.05, p1: 0.0008, p2: 0.0004, k3: 0, k4: 0 };
const fisheye = { type: 'fisheye', fovDeg: 200, k1: 0.01, k2: -0.002, p1: 0, p2: 0, k3: 0, k4: 0 };
const realistic = { blurSigma: 0.6, vignetting: 0.35, exposureEV: 0, exposureJitterEV: 0.15, whiteBalanceJitter: 0.03, fullWellElectrons: 1500, readNoiseElectrons: 4 };
const typicalCalib = { positionMm: 1, rotationDeg: 0.1, focalPct: 0.3, principalPx: 0.5 };

// minPrecision: noise-free ideal-sensor runs must land on the surface (validates the lens math).
const configs = [
  { name: 'ring-8 pinhole', rig: { count: 8, lens: pinhole }, minPrecision: 0.99 },
  { name: 'ring-8 wide distorted', rig: { count: 8, lens: wide }, minPrecision: 0.99 },
  { name: 'ring-2 fisheye 200°', rig: { count: 2, lens: fisheye }, minPrecision: 0.99 },
  { name: 'cube-6 fisheye 200°', rig: { preset: 'cube', lens: fisheye }, minPrecision: 0.99 },
  { name: 'ring-8 real sensor+calib', rig: { count: 8, lens: pinhole }, sensor: realistic, calibration: typicalCalib },
  { name: 'STEREO ring-8 r=0.1', rig: { count: 8, lens: pinhole }, source: 'stereo' },
  { name: 'STEREO ring-12 r=0.3', rig: { count: 12, radius: 0.3, lens: pinhole }, source: 'stereo' },
  { name: 'STEREO ring-12 r=0.3 real', rig: { count: 12, radius: 0.3, lens: pinhole }, sensor: realistic, calibration: typicalCalib, source: 'stereo' },
  { name: 'STEREO cube fisheye r=0.3', rig: { preset: 'cube', radius: 0.3, lens: fisheye }, source: 'stereo' },
];
const ideal = { blurSigma: 0, vignetting: 0, exposureEV: 0, exposureJitterEV: 0, whiteBalanceJitter: 0, fullWellElectrons: 0, readNoiseElectrons: 0 };
const perfect = { positionMm: 0, rotationDeg: 0, focalPct: 0, principalPx: 0 };

let failed = false;
for (const c of configs) {
  const t0 = Date.now();
  const r = await page.evaluate(
    async ({ c, ideal, perfect }) => {
      const app = window.app;
      Object.assign(app.settings.rig, { preset: 'ring', count: 8, radius: 0.1 }, c.rig);
      app.settings.rig.lens = { ...c.rig.lens };
      Object.assign(app.settings.sensor, ideal, c.sensor ?? {});
      Object.assign(app.settings.calibration, perfect, c.calibration ?? {});
      app.settings.fusion.source = c.source ?? 'sensor';
      app.rebuildRig();
      const m = await app.runAll();
      return { m, s: app.stereoStats };
    },
    { c, ideal, perfect },
  );
  const { m, s } = r;
  const pct = (x) => `${(x * 100).toFixed(1)}%`.padStart(6);
  console.log(
    `${c.name.padEnd(28)} pts=${String(m.reconPoints).padStart(8)} P=${pct(m.precision)} C=${pct(m.completeness)} F=${pct(m.fscore)}` +
      (s && c.source === 'stereo' ? `  | stereo density=${pct(s.density)} medErr=${pct(s.medianRelError)} ≤5%=${pct(s.within5pct)}` : '') +
      `  (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );
  if (c.minPrecision && m.precision < c.minPrecision) {
    console.error(`  FAIL: precision below ${c.minPrecision}`);
    failed = true;
  }
}

await page.evaluate(() => {
  Object.assign(window.app.settings.view, { showRoom: false, thumbnails: 'stereo depth' });
  window.app.applyView();
  window.app.viewCamera.position.set(0.5, 6.5, 5.5);
});
await page.waitForTimeout(300);
await page.screenshot({ path: `${outDir}/screenshot-stereo.png` });
if (errors.length) {
  console.error('Page errors:', errors);
  failed = true;
}
await browser.close();
await server.close();
process.exit(failed ? 1 : 0);
