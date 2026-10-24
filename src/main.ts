import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import './style.css';
import { createRoom, mulberry32 } from './scene/room';
import { CameraRig, HELPER_LAYER } from './rig/CameraRig';
import { Capturer, type CaptureFrame } from './capture/capture';
import { reconstruct, type PointCloud } from './recon/depthFusion';
import { PointCloudView } from './recon/PointCloudView';
import { evaluate, sampleSurface, type Metrics } from './eval/metrics';
import type GUI from 'lil-gui';
import { createGui, type Settings } from './ui/gui';
import { downloadDataset, downloadPly } from './export/export';

class App {
  readonly settings: Settings = {
    rig: {
      preset: 'ring',
      count: 8,
      radius: 0.1,
      pitchDeg: 0,
      yawDeg: 0,
      centerX: 0,
      centerY: 1.4,
      centerZ: 0,
      fovDeg: 70,
      width: 320,
      height: 240,
      near: 0.05,
      far: 20,
    },
    fusion: { stride: 1, noiseSigma: 0, noiseQuadratic: 0, voxelSize: 0, maxDepth: 20 },
    view: { showRoom: true, roomOpacity: 1, showCloud: true, showFrustums: true, pointSize: 0.015, colorMode: 'rgb' },
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
  readonly gui: GUI;

  frames: CaptureFrame[] = [];
  cloud?: PointCloud;
  metrics?: Metrics;
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
      onFusionChange: () => this.frames.length && this.reconstruct(),
      onViewChange: () => this.applyView(),
      runAll: () => this.runAll(),
      capture: () => this.capture(),
      reconstruct: () => this.reconstruct(),
      evaluate: () => this.evaluate(),
      exportDataset: () => this.exportDataset(),
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
    this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
    this.applyView();
    this.status(`Rig: ${this.rig.cameras.length} cameras (capture is out of date).`);
  }

  capture(): CaptureFrame[] {
    const t0 = performance.now();
    // Capture must see the real, opaque room regardless of the viewer settings.
    const roomVisible = this.room.group.visible;
    this.room.group.visible = true;
    this.room.setOpacity(1);
    this.frames = this.capturer.capture(this.scene, this.rig.cameras, this.rig.intrinsics);
    this.room.group.visible = roomVisible;
    this.room.setOpacity(this.settings.view.roomOpacity);
    this.renderThumbnails();
    this.status(`Captured ${this.frames.length} views in ${(performance.now() - t0).toFixed(0)} ms.`);
    return this.frames;
  }

  reconstruct(): PointCloud | undefined {
    if (!this.frames.length) {
      this.status('Capture first.');
      return undefined;
    }
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

  runAll(): Metrics | undefined {
    this.capture();
    this.reconstruct();
    return this.evaluate();
  }

  async exportDataset(): Promise<void> {
    if (!this.frames.length) {
      this.status('Nothing to export: capture first.');
      return;
    }
    this.status('Building zip…');
    await downloadDataset(this.frames, this.rig.config, this.cloud);
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
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.viewport;
    this.renderer.setSize(w, h);
    this.viewCamera.aspect = w / Math.max(1, h);
    this.viewCamera.updateProjectionMatrix();
  }

  private renderThumbnails(): void {
    this.thumbs.replaceChildren(
      ...this.frames.map((f) => {
        const fig = document.createElement('figure');
        const canvas = document.createElement('canvas');
        canvas.width = f.image.width;
        canvas.height = f.image.height;
        canvas.getContext('2d')!.putImageData(f.image, 0, 0);
        const cap = document.createElement('figcaption');
        cap.textContent = f.name;
        fig.append(canvas, cap);
        return fig;
      }),
    );
  }

  private renderMetrics(): void {
    const m = this.metrics;
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    const rows: [string, string][] = [
      ['Cameras', String(this.rig.cameras.length)],
      ['Points', this.cloud ? this.cloud.count.toLocaleString() : '—'],
      ['Threshold τ', m ? `${(m.threshold * 100).toFixed(1)} cm` : '—'],
      ['Precision', m ? pct(m.precision) : '—'],
      ['Completeness', m ? pct(m.completeness) : '—'],
      ['F-score', m ? pct(m.fscore) : '—'],
      ['Mean error', m ? `${(m.meanError * 1000).toFixed(1)} mm` : '—'],
    ];
    this.metricsEl.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  }

  private status(text: string): void {
    this.statusEl.textContent = text;
  }
}

const app = new App();
// Handy for experiments from the devtools console and for automated tests.
(window as unknown as { app: App }).app = app;
