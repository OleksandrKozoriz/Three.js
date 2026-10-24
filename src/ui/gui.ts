import GUI from 'lil-gui';
import type { RigConfig } from '../rig/CameraRig';
import type { FusionParams } from '../recon/depthFusion';
import type { ColorMode } from '../recon/PointCloudView';

export interface ViewSettings {
  showRoom: boolean;
  roomOpacity: number;
  showCloud: boolean;
  showFrustums: boolean;
  pointSize: number;
  colorMode: ColorMode;
}

export interface EvalSettings {
  threshold: number;
  gtSamples: number;
}

export interface Settings {
  rig: RigConfig;
  fusion: FusionParams;
  view: ViewSettings;
  evaluation: EvalSettings;
}

export interface GuiActions {
  onRigChange(): void;
  onFusionChange(): void;
  onViewChange(): void;
  runAll(): void;
  capture(): void;
  reconstruct(): void;
  evaluate(): void;
  exportDataset(): void;
  exportPly(): void;
}

export function createGui(settings: Settings, actions: GuiActions): GUI {
  const gui = new GUI({ title: 'Inside-out reconstruction', container: document.getElementById('viewport')! });
  const { rig, fusion, view, evaluation } = settings;

  gui.add({ run: () => actions.runAll() }, 'run').name('▶ Capture + reconstruct + evaluate');

  const r = gui.addFolder('Camera rig');
  const countCtrl = r.add(rig, 'count', 1, 64, 1).name('cameras');
  r.add(rig, 'preset', ['ring', 'sphere', 'cube'])
    .name('layout')
    .onChange(() => countCtrl.enable(rig.preset !== 'cube'));
  r.add(rig, 'radius', 0, 1, 0.01).name('radius (m)');
  r.add(rig, 'pitchDeg', -60, 60, 1).name('ring pitch (°)');
  r.add(rig, 'yawDeg', -180, 180, 1).name('rig yaw (°)');
  r.add(rig, 'centerX', -3.8, 3.8, 0.05).name('center x');
  r.add(rig, 'centerY', 0.1, 2.9, 0.05).name('center y');
  r.add(rig, 'centerZ', -2.8, 2.8, 0.05).name('center z');
  r.add(rig, 'fovDeg', 20, 150, 1).name('vertical FOV (°)');
  r.add(rig, 'width', 32, 1024, 1).name('image width');
  r.add(rig, 'height', 32, 1024, 1).name('image height');
  r.add(rig, 'near', 0.01, 1, 0.01);
  r.add(rig, 'far', 1, 50, 0.5);
  r.onChange(() => actions.onRigChange());

  const f = gui.addFolder('Reconstruction (depth fusion)');
  f.add(fusion, 'stride', 1, 16, 1).name('pixel stride');
  f.add(fusion, 'noiseSigma', 0, 0.1, 0.001).name('depth noise σ (m)');
  f.add(fusion, 'noiseQuadratic', 0, 0.05, 0.001).name('noise ∝ z² (1/m)');
  f.add(fusion, 'voxelSize', 0, 0.2, 0.005).name('voxel merge (m)');
  f.add(fusion, 'maxDepth', 0.5, 50, 0.5).name('max depth (m)');
  f.onFinishChange(() => actions.onFusionChange());

  const e = gui.addFolder('Evaluation');
  e.add(evaluation, 'threshold', 0.005, 0.2, 0.005).name('threshold τ (m)');
  e.add(evaluation, 'gtSamples', 10000, 1000000, 10000).name('GT samples');

  const v = gui.addFolder('View');
  v.add(view, 'showRoom').name('show room');
  v.add(view, 'roomOpacity', 0.05, 1, 0.05).name('room opacity');
  v.add(view, 'showCloud').name('show point cloud');
  v.add(view, 'showFrustums').name('show cameras');
  v.add(view, 'pointSize', 0.002, 0.08, 0.001).name('point size');
  v.add(view, 'colorMode', ['rgb', 'camera']).name('point color');
  v.onChange(() => actions.onViewChange());

  const s = gui.addFolder('Steps & export');
  s.add({ c: () => actions.capture() }, 'c').name('1. Capture');
  s.add({ r: () => actions.reconstruct() }, 'r').name('2. Reconstruct');
  s.add({ e: () => actions.evaluate() }, 'e').name('3. Evaluate');
  s.add({ d: () => actions.exportDataset() }, 'd').name('Download dataset (.zip)');
  s.add({ p: () => actions.exportPly() }, 'p').name('Download point cloud (.ply)');

  countCtrl.enable(rig.preset !== 'cube');
  f.close();
  e.close();
  return gui;
}
