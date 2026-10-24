// Headless end-to-end check: loads the app, runs capture → reconstruct → evaluate
// for a few rig configurations, prints metrics and saves screenshots.
// Usage: npm run build && node scripts/smoke-test.mjs [outDir]
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

const configs = [
  { name: 'ring-4', rig: { preset: 'ring', count: 4 } },
  { name: 'ring-8', rig: { preset: 'ring', count: 8 } },
  { name: 'cube-6 fov90', rig: { preset: 'cube', fovDeg: 90 } },
  { name: 'sphere-20', rig: { preset: 'sphere', count: 20 } },
  { name: 'sphere-20 noise 1cm', rig: { preset: 'sphere', count: 20 }, fusion: { noiseSigma: 0.01 } },
];
let failed = errors.length > 0;
for (const c of configs) {
  const m = await page.evaluate(({ rig, fusion }) => {
    const app = window.app;
    Object.assign(app.settings.rig, { preset: 'ring', count: 8, fovDeg: 70 }, rig);
    Object.assign(app.settings.fusion, { noiseSigma: 0 }, fusion ?? {});
    app.rebuildRig();
    return app.runAll();
  }, c);
  console.log(
    `${c.name.padEnd(22)} points=${String(m.reconPoints).padStart(8)} precision=${(m.precision * 100).toFixed(2)}% ` +
      `completeness=${(m.completeness * 100).toFixed(2)}% F=${(m.fscore * 100).toFixed(2)}% meanErr=${(m.meanError * 1000).toFixed(1)}mm`,
  );
  if (!c.fusion && m.precision < 0.99) failed = true; // noise-free back-projection must land on the surface
}
await page.screenshot({ path: `${outDir}/screenshot-scene.png` });
await page.evaluate(() => {
  Object.assign(window.app.settings.view, { showRoom: false, colorMode: 'rgb' });
  Object.assign(window.app.settings.fusion, { noiseSigma: 0 });
  window.app.runAll();
  window.app.applyView();
  window.app.viewCamera.position.set(0.5, 6.5, 5.5);
});
await page.waitForTimeout(300);
await page.screenshot({ path: `${outDir}/screenshot-reconstruction.png` });
if (errors.length) console.error('Page errors:', errors);
await browser.close();
await server.close();
process.exit(failed ? 1 : 0);
