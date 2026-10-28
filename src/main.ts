import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import './style.css';
import { createRoom } from './scene/room';
import { CameraRig, HELPER_LAYER } from './rig/CameraRig';
import { Capturer, type CaptureFrame } from './capture/capture';
import { reconstruct, type PointCloud } from './recon/depthFusion';
import { estimateStereo } from './recon/stereo';
import { PointCloudView } from './recon/PointCloudView';
import { evaluate, sampleSurface, type Metrics } from './eval/metrics';
import { createGui, type GuiHandle, type Settings } from './ui/gui';
import { downloadDataset, downloadPly } from './export/export';
import { LENS_PRESETS } from './camera/models';
import { IDEAL_SENSOR } from './camera/sensor';
import { PERFECT_CALIBRATION } from './camera/calibration';
import { mulberry32 } from './util/random';

/** How well stereo ranges match the ideal sensor's, per pixel (diagnostic). */
interface StereoStats {
  /** Fraction of lens pixels that got a range estimate. */
  density: number;
  /** Median |stereo − true| / true over estimated pixels. */
  medianRelError: number;
  /** Fraction of estimated pixels within 5% of the true range. */
  within5pct: number;
}

class App {
  readonly settings: Settings = {
    rig: {
      preset: 'ring',
      count: 8,
      radius: 0.1,
      pitchDeg: 0,
      eyeSeparation: 0.065,
      vergenceDeg: 0,
      yawDeg: 0,
      centerX: 0,
      centerY: 1.4,
      centerZ: 0,
      lens: { ...LENS_PRESETS[0].lens },
      width: 320,
      height: 240,
      near: 0.05,
      far: 20,
    },
    sensor: { ...IDEAL_SENSOR },
    calibration: { ...PERFECT_CALIBRATION },
    seed: 1,
    fusion: { source: 'sensor', stride: 1, noiseSigma: 0, noiseQuadratic: 0, voxelSize: 0, maxDepth: 20 },
    stereo: {
      neighbors: 2,
      planes: 0,
      minRange: 0.3,
      maxRange: 12,
      windowRadius: 3,
      minScore: 0.6,
      minTexture: 0.01,
      consistencyViews: 1,
      consistencyTol: 0.05,
    },
    view: {
      showRoom: true,
      roomOpacity: 1,
      showCloud: true,
      showFrustums: true,
      pointSize: 0.015,
      colorMode: 'rgb',
      thumbnails: 'image',
    },
    evaluation: { threshold: 0.05, gtSamples: 300000 },
  };

  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly viewCamera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly room = createRoom();
  readonly rig: CameraRig;
  readonly cloudView = new PointCloudView();
  readonly capturer: Capturer;
  readonly gui: GuiHandle;

  frames: CaptureFrame[] = [];
  cloud?: PointCloud;
  metrics?: Metrics;
  stereoStats?: StereoStats;
  private stereoKey = '';
  private busy = false;
  private gt?: { samples: number; points: Float32Array };

  private readonly viewport = document.getElementById('viewport')!;
  private readonly thumbs = document.getElementById('thumbs')!;
  private readonly metricsEl = document.getElementById('metrics')!;
  private readonly statusEl = document.getElementById('status')!;

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.viewport.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x111318);
    this.scene.add(this.room.group);
    this.rig = new CameraRig(this.settings.rig);
    this.scene.add(this.rig.group);
    this.scene.add(this.cloudView.points);

    this.viewCamera = new THREE.PerspectiveCamera(60, 1, 0.01, 100);
    this.viewCamera.layers.enable(HELPER_LAYER);
    this.viewCamera.position.set(3.2, 2.6, 4.2);
    this.controls = new OrbitControls(this.viewCamera, this.renderer.domElement);
    this.controls.target.set(0, 1.2, 0);
    this.controls.enableDamping = true;
    this.controls.update();

    this.capturer = new Capturer(this.renderer);

    this.gui = createGui(this.settings, {
      onRigChange: () => this.rebuildRig(),
      onFusionChange: () => this.frames.length && this.guarded(() => this.reconstruct()),
      onViewChange: () => this.applyView(),
      runAll: () => this.guarded(() => this.runAll()),
      capture: () => this.guarded(async () => this.capture()),
      reconstruct: () => this.guarded(() => this.reconstruct()),
      evaluate: () => this.guarded(async () => this.evaluate()),
      exportDataset: () => this.guarded(() => this.exportDataset()),
      exportPly: () => (this.cloud ? downloadPly(this.cloud) : this.status('Nothing to export: reconstruct first.')),
    });

    new ResizeObserver(() => this.resize()).observe(this.viewport);
    this.resize();
    this.applyView();
    this.renderMetrics();
    this.status(`Rig: ${this.rig.cameras.length} cameras. Press "Capture + reconstruct + evaluate".`);
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.viewCamera);
    });
  }

  rebuildRig(): void {
    this.rig.rebuild(this.settings.rig);
    // Keep the panel in sync when settings are changed from code (console / tests).
    this.gui.refresh();
    this.applyView();
    this.status(`Rig: ${this.rig.cameras.length} cameras (capture is out of date).`);
  }

  capture(): CaptureFrame[] {
    const t0 = performance.now();
    // Capture must see the real, opaque room regardless of the viewer settings.
    const roomVisible = this.room.group.visible;
    this.room.group.visible = true;
    this.room.setOpacity(1);
    const { rig, sensor, calibration, seed } = this.settings;
    this.frames = this.capturer.capture(this.scene, this.rig.cameras, {
      lens: rig.lens,
      width: rig.width,
      height: rig.height,
      near: rig.near,
      far: rig.far,
      sensor,
      calibration,
      seed,
    });
    this.room.group.visible = roomVisible;
    this.room.setOpacity(this.settings.view.roomOpacity);
    this.stereoKey = '';
    this.stereoStats = undefined;
    this.renderThumbnails();
    this.status(`Captured ${this.frames.length} views in ${(performance.now() - t0).toFixed(0)} ms.`);
    return this.frames;
  }

  /** Runs stereo matching if the depth source needs it and it is not up to date. */
  async ensureStereo(): Promise<void> {
    const key = JSON.stringify(this.settings.stereo);
    if (this.stereoKey === key) return;
    const t0 = performance.now();
    await estimateStereo(this.frames, this.settings.stereo, (done, total) =>
      this.status(`Stereo matching… ${Math.round((100 * done) / total)}%`),
    );
    this.stereoKey = key;
    this.stereoStats = this.computeStereoStats();
    this.renderThumbnails();
    this.status(`Stereo matching took ${((performance.now() - t0) / 1000).toFixed(1)} s.`);
  }

  async reconstruct(): Promise<PointCloud | undefined> {
    if (!this.frames.length) {
      this.status('Capture first.');
      return undefined;
    }
    if (this.settings.fusion.source === 'stereo') await this.ensureStereo();
    const t0 = performance.now();
    this.cloud = reconstruct(this.frames, this.settings.fusion);
    this.cloudView.setCloud(this.cloud, this.frames.length, this.settings.view.colorMode);
    this.metrics = undefined;
    this.renderMetrics();
    this.status(`Reconstructed ${this.cloud.count.toLocaleString()} points in ${(performance.now() - t0).toFixed(0)} ms.`);
    return this.cloud;
  }

  evaluate(): Metrics | undefined {
    if (!this.cloud) {
      this.status('Reconstruct first.');
      return undefined;
    }
    const t0 = performance.now();
    const samples = this.settings.evaluation.gtSamples;
    if (!this.gt || this.gt.samples !== samples) {
      this.gt = { samples, points: sampleSurface(this.room.surfaces, samples, mulberry32(42)) };
    }
    this.metrics = evaluate(this.cloud.positions, this.gt.points, this.settings.evaluation.threshold);
    this.renderMetrics();
    this.status(`Evaluated in ${(performance.now() - t0).toFixed(0)} ms.`);
    return this.metrics;
  }

  async runAll(): Promise<Metrics | undefined> {
    this.capture();
    await this.reconstruct();
    return this.evaluate();
  }

  async exportDataset(): Promise<void> {
    if (!this.frames.length) {
      this.status('Nothing to export: capture first.');
      return;
    }
    this.status('Building zip…');
    await downloadDataset(this.frames, this.rig.config, this.settings, this.cloud);
    this.status('Dataset downloaded.');
  }

  applyView(): void {
    const v = this.settings.view;
    this.room.group.visible = v.showRoom;
    this.room.setOpacity(v.roomOpacity);
    this.cloudView.points.visible = v.showCloud;
    this.cloudView.size = v.pointSize;
    this.cloudView.setColorMode(v.colorMode);
    this.rig.setHelpersVisible(v.showFrustums);
    this.renderThumbnails();
  }

  /** Runs one action at a time; long ones (stereo) are async. */
  private async guarded(action: () => Promise<unknown>): Promise<void> {
    if (this.busy) {
      this.status('Busy — wait for the current step to finish.');
      return;
    }
    this.busy = true;
    try {
      await action();
    } catch (err) {
      console.error(err);
      this.status(`Error: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private computeStereoStats(): StereoStats {
    let lens = 0;
    let estimated = 0;
    let within = 0;
    const errors: number[] = [];
    for (const f of this.frames) {
      const s = f.stereoRange;
      if (!s) continue;
      for (let i = 0; i < f.range.length; i++) {
        if (!(f.range[i] > 0)) continue;
        lens++;
        if (!(s[i] > 0)) continue;
        estimated++;
        const e = Math.abs(s[i] - f.range[i]) / f.range[i];
        if (e <= 0.05) within++;
        if (i % 7 === 0) errors.push(e); // subsample for the median
      }
    }
    errors.sort((a, b) => a - b);
    return {
      density: lens ? estimated / lens : 0,
      medianRelError: errors.length ? errors[errors.length >> 1] : NaN,
      within5pct: estimated ? within / estimated : 0,
    };
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.viewport;
    this.renderer.setSize(w, h);
    this.viewCamera.aspect = w / Math.max(1, h);
    this.viewCamera.updateProjectionMatrix();
  }

  /** Color-mapped range image: near = warm, far = cool, no value = black. */
  private rangeImage(range: Float32Array, w: number, h: number): ImageData {
    const img = new ImageData(w, h);
    const c = new THREE.Color();
    const maxR = 8;
    for (let i = 0; i < w * h; i++) {
      img.data[i * 4 + 3] = 255;
      const r = range[i];
      if (!(r > 0)) continue;
      c.setHSL(Math.min(1, r / maxR) * 0.7, 0.9, 0.5);
      img.data[i * 4] = c.r * 255;
      img.data[i * 4 + 1] = c.g * 255;
      img.data[i * 4 + 2] = c.b * 255;
    }
    return img;
  }

  private renderThumbnails(): void {
    const mode = this.settings.view.thumbnails;
    this.thumbs.replaceChildren(
      ...this.frames.map((f) => {
        const { width: w, height: h } = f.model;
        let img = f.image;
        if (mode === 'sensor depth') img = this.rangeImage(f.range, w, h);
        if (mode === 'stereo depth') img = this.rangeImage(f.stereoRange ?? new Float32Array(w * h), w, h);
        const fig = document.createElement('figure');
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d')!.putImageData(img, 0, 0);
        const cap = document.createElement('figcaption');
        cap.textContent = f.name;
        fig.append(canvas, cap);
        return fig;
      }),
    );
  }

  private renderMetrics(): void {
    const m = this.metrics;
    const s = this.stereoStats;
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    const rows: [string, string][] = [
      ['Cameras', String(this.rig.cameras.length)],
      ['Depth from', this.settings.fusion.source === 'stereo' ? 'stereo' : 'ideal sensor'],
      ['Points', this.cloud ? this.cloud.count.toLocaleString() : '—'],
      ['Threshold τ', m ? `${(m.threshold * 100).toFixed(1)} cm` : '—'],
      ['Precision', m ? pct(m.precision) : '—'],
      ['Completeness', m ? pct(m.completeness) : '—'],
      ['F-score', m ? pct(m.fscore) : '—'],
      ['Mean error', m ? `${(m.meanError * 1000).toFixed(1)} mm` : '—'],
    ];
    if (s && this.settings.fusion.source === 'stereo') {
      rows.push(
        ['Stereo density', pct(s.density)],
        ['Stereo median error', pct(s.medianRelError)],
        ['Stereo within 5%', pct(s.within5pct)],
      );
    }
    this.metricsEl.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  }

  private status(text: string): void {
    this.statusEl.textContent = text;
  }
}

const app = new App();
// Handy for experiments from the devtools console and for automated tests.
(window as unknown as { app: App }).app = app;
