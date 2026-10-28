import GUI, { type Controller } from 'lil-gui';
import type { RigConfig } from '../rig/CameraRig';
import type { FusionParams } from '../recon/depthFusion';
import type { StereoParams } from '../recon/stereo';
import type { ColorMode } from '../recon/PointCloudView';
import { LENS_PRESETS } from '../camera/models';
import { IDEAL_SENSOR, REALISTIC_SENSOR, type SensorConfig } from '../camera/sensor';
import { PERFECT_CALIBRATION, type CalibrationError } from '../camera/calibration';

export type ThumbnailMode = 'image' | 'sensor depth' | 'stereo depth';

export interface ViewSettings {
  showRoom: boolean;
  roomOpacity: number;
  showCloud: boolean;
  showFrustums: boolean;
  pointSize: number;
  colorMode: ColorMode;
  thumbnails: ThumbnailMode;
}

export interface EvalSettings {
  threshold: number;
  gtSamples: number;
}

export interface Settings {
  rig: RigConfig;
  sensor: SensorConfig;
  calibration: CalibrationError;
  seed: number;
  fusion: FusionParams;
  stereo: StereoParams;
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

/** "Realistic" calibration: what a careful checkerboard + rig calibration typically leaves. */
const TYPICAL_CALIBRATION: CalibrationError = { positionMm: 1, rotationDeg: 0.1, focalPct: 0.3, principalPx: 0.5 };

export interface GuiHandle {
  gui: GUI;
  /** Re-reads all settings into the panel (values, labels, visibility) after changes made from code. */
  refresh(): void;
}

export function createGui(settings: Settings, actions: GuiActions): GuiHandle {
  const gui = new GUI({ title: 'Inside-out reconstruction', container: document.getElementById('viewport')! });
  const { rig, sensor, calibration, fusion, stereo, view, evaluation } = settings;
  const refresh = () => gui.controllersRecursive().forEach((c) => c.updateDisplay());

  gui.add({ run: () => actions.runAll() }, 'run').name('▶ Capture + reconstruct + evaluate');
  gui.add(fusion, 'source', { 'ideal depth sensor': 'sensor', 'stereo (images only)': 'stereo' }).name('depth from').onChange(() => {
    syncVisibility();
    actions.onFusionChange();
  });

  // --- Rig -------------------------------------------------------------------
  const r = gui.addFolder('Camera rig');
  const countCtrl = r.add(rig, 'count', 1, 64, 1).name('cameras');
  r.add(rig, 'preset', ['ring', 'sphere', 'cube', 'eyes']).name('layout').onChange(() => syncVisibility());
  r.add(rig, 'radius', 0, 1, 0.01).name('radius (m)');
  const pitchCtrl = r.add(rig, 'pitchDeg', -60, 60, 1);
  const eyesOnly: Controller[] = [
    r.add(rig, 'eyeSeparation', 0.01, 0.5, 0.005).name('eye separation (m)'),
    r.add(rig, 'vergenceDeg', 0, 15, 0.5).name('eye toe-in (°)'),
  ];
  r.add(rig, 'yawDeg', -180, 180, 1).name('rig yaw (°)');
  r.add(rig, 'centerX', -3.8, 3.8, 0.05).name('center x');
  r.add(rig, 'centerY', 0.1, 2.9, 0.05).name('center y');
  r.add(rig, 'centerZ', -2.8, 2.8, 0.05).name('center z');
  r.add(rig, 'width', 32, 1024, 1).name('image width');
  r.add(rig, 'height', 32, 1024, 1).name('image height');
  r.add(rig, 'near', 0.01, 1, 0.01);
  r.add(rig, 'far', 1, 50, 0.5);
  r.onChange(() => actions.onRigChange());

  // --- Lens --------------------------------------------------------------------
  const l = gui.addFolder('Lens');
  const lensPreset = { preset: LENS_PRESETS[0].name };
  l.add(lensPreset, 'preset', LENS_PRESETS.map((p) => p.name)).name('preset').onChange((name: string) => {
    Object.assign(rig.lens, LENS_PRESETS.find((p) => p.name === name)!.lens);
    refresh();
    syncVisibility();
  });
  l.add(rig.lens, 'type', ['pinhole', 'fisheye']).name('model').onChange(() => syncVisibility());
  const fovCtrl = l.add(rig.lens, 'fovDeg', 20, 240, 1);
  l.add(rig.lens, 'k1', -0.5, 0.5, 0.001);
  l.add(rig.lens, 'k2', -0.2, 0.2, 0.001);
  const pinholeOnly: Controller[] = [l.add(rig.lens, 'p1', -0.01, 0.01, 0.0001), l.add(rig.lens, 'p2', -0.01, 0.01, 0.0001)];
  const fisheyeOnly: Controller[] = [l.add(rig.lens, 'k3', -0.05, 0.05, 0.0001), l.add(rig.lens, 'k4', -0.02, 0.02, 0.0001)];
  l.onChange(() => actions.onRigChange());

  // --- Sensor ------------------------------------------------------------------
  const s = gui.addFolder('Sensor');
  const sensorPreset = { preset: 'ideal' };
  s.add(sensorPreset, 'preset', ['ideal', 'realistic']).onChange((v: string) => {
    Object.assign(sensor, v === 'ideal' ? IDEAL_SENSOR : REALISTIC_SENSOR);
    refresh();
  });
  s.add(sensor, 'blurSigma', 0, 3, 0.05).name('lens blur σ (px)');
  s.add(sensor, 'vignetting', 0, 1, 0.01);
  s.add(sensor, 'exposureEV', -3, 3, 0.1).name('exposure (EV)');
  s.add(sensor, 'exposureJitterEV', 0, 1, 0.01).name('exposure mismatch σ (EV)');
  s.add(sensor, 'whiteBalanceJitter', 0, 0.2, 0.005).name('white balance σ');
  s.add(sensor, 'fullWellElectrons', 0, 20000, 100).name('full well (e⁻), 0 = no noise');
  s.add(sensor, 'readNoiseElectrons', 0, 30, 0.5).name('read noise (e⁻)');
  s.add(settings, 'seed', 0, 1000, 1).name('random seed');

  // --- Calibration error ------------------------------------------------------------
  const c = gui.addFolder('Calibration error');
  const calibPreset = { preset: 'perfect' };
  c.add(calibPreset, 'preset', ['perfect', 'typical']).onChange((v: string) => {
    Object.assign(calibration, v === 'perfect' ? PERFECT_CALIBRATION : TYPICAL_CALIBRATION);
    refresh();
  });
  c.add(calibration, 'positionMm', 0, 20, 0.1).name('position σ (mm)');
  c.add(calibration, 'rotationDeg', 0, 2, 0.01).name('rotation σ (°)');
  c.add(calibration, 'focalPct', 0, 5, 0.05).name('focal σ (%)');
  c.add(calibration, 'principalPx', 0, 10, 0.1).name('principal point σ (px)');

  // --- Reconstruction ------------------------------------------------------------------
  const f = gui.addFolder('Reconstruction');
  f.add(fusion, 'stride', 1, 16, 1).name('pixel stride');
  const sensorNoise: Controller[] = [
    f.add(fusion, 'noiseSigma', 0, 0.1, 0.001).name('sensor noise σ (m)'),
    f.add(fusion, 'noiseQuadratic', 0, 0.05, 0.001).name('sensor noise ∝ r² (1/m)'),
  ];
  f.add(fusion, 'voxelSize', 0, 0.2, 0.005).name('voxel merge (m)');
  f.add(fusion, 'maxDepth', 0.5, 50, 0.5).name('max range (m)');
  f.onFinishChange(() => actions.onFusionChange());

  const st = gui.addFolder('Stereo matching');
  st.add(stereo, 'neighbors', 1, 6, 1).name('neighbour views');
  st.add(stereo, 'planes', 0, 256, 1).name('depth planes (0 = auto)');
  st.add(stereo, 'minRange', 0.1, 3, 0.05).name('min range (m)');
  st.add(stereo, 'maxRange', 2, 30, 0.5).name('max range (m)');
  st.add(stereo, 'windowRadius', 1, 7, 1).name('window radius (px)');
  st.add(stereo, 'minScore', -1, 1, 0.01).name('min NCC score');
  st.add(stereo, 'minTexture', 0, 0.1, 0.001).name('min texture σ');
  st.add(stereo, 'consistencyViews', 0, 4, 1).name('consistent views ≥');
  st.add(stereo, 'consistencyTol', 0.005, 0.2, 0.005).name('consistency tol (rel.)');

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
  v.add(view, 'thumbnails', ['image', 'sensor depth', 'stereo depth']).name('thumbnails');
  v.onChange(() => actions.onViewChange());

  const x = gui.addFolder('Steps & export');
  x.add({ c: () => actions.capture() }, 'c').name('1. Capture');
  x.add({ r: () => actions.reconstruct() }, 'r').name('2. Reconstruct');
  x.add({ e: () => actions.evaluate() }, 'e').name('3. Evaluate');
  x.add({ d: () => actions.exportDataset() }, 'd').name('Download dataset (.zip)');
  x.add({ p: () => actions.exportPly() }, 'p').name('Download point cloud (.ply)');

  function syncVisibility() {
    countCtrl.enable(rig.preset !== 'cube');
    countCtrl.name(rig.preset === 'eyes' ? 'eye pairs' : 'cameras');
    pitchCtrl.name(rig.preset === 'eyes' ? 'pitch (°)' : 'ring pitch (°)');
    pitchCtrl.show(rig.preset === 'ring' || rig.preset === 'eyes');
    eyesOnly.forEach((ctrl) => ctrl.show(rig.preset === 'eyes'));
    const fisheye = rig.lens.type === 'fisheye';
    fovCtrl.name(fisheye ? 'image circle FOV (°)' : 'vertical FOV (°)');
    pinholeOnly.forEach((ctrl) => ctrl.show(!fisheye));
    fisheyeOnly.forEach((ctrl) => ctrl.show(fisheye));
    sensorNoise.forEach((ctrl) => ctrl.show(fusion.source === 'sensor'));
    st.show(fusion.source === 'stereo');
  }
  syncVisibility();
  for (const folder of [l, s, c, f, st, e, x]) folder.close();
  return {
    gui,
    refresh: () => {
      refresh();
      syncVisibility();
    },
  };
}
