import * as THREE from 'three';
import { buildModel, rayMap, type CameraModel, type LensConfig } from '../camera/models';
import { applySensor, type SensorConfig } from '../camera/sensor';
import { perturbModel, perturbPose, type CalibrationError } from '../camera/calibration';
import { mulberry32 } from '../util/random';

export interface CaptureSettings {
  lens: LensConfig;
  width: number;
  height: number;
  near: number;
  far: number;
  sensor: SensorConfig;
  calibration: CalibrationError;
  seed: number;
}

/**
 * One image captured by one rig camera. Per-pixel arrays are row-major with the TOP row
 * first (standard image convention, matches the exported PNGs).
 */
export interface CaptureFrame {
  index: number;
  name: string;
  /** Calibration the reconstruction is allowed to use (true calibration + calibration error). */
  model: CameraModel;
  cameraToWorld: THREE.Matrix4;
  /** Ground truth used to form the image; only for evaluation/debugging. */
  trueModel: CameraModel;
  trueCameraToWorld: THREE.Matrix4;
  near: number;
  far: number;
  /** Final 8-bit sRGB image. */
  image: ImageData;
  /** `image` decoded to linear RGB, 3 floats per pixel. */
  color: Float32Array;
  /**
   * Ideal depth sensor: distance in meters from the optical center along each pixel's
   * TRUE ray to the first surface; 0 = no hit or outside the lens.
   */
  range: Float32Array;
  /** Range estimated from the images alone (filled in by multi-view stereo). */
  stereoRange?: Float32Array;
}

/** Writes the Euclidean distance from the camera center (meters) into the red channel. */
function createRangeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec3 vViewPos;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewPos = mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vViewPos;
      void main() {
        gl_FragColor = vec4(length(vViewPos), 0.0, 0.0, 1.0);
      }`,
  });
}

/**
 * Looks up a cube map along each pixel's lens ray. `rays` holds the per-pixel ray in the
 * OpenCV camera frame (w = 1 if valid); `rotation` takes OpenGL camera axes to world axes.
 */
function createResampleMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      cube: { value: null },
      rays: { value: null },
      rotation: { value: new THREE.Matrix3() },
    },
    depthTest: false,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform samplerCube cube;
      uniform sampler2D rays;
      uniform mat3 rotation;
      varying vec2 vUv;
      void main() {
        vec4 r = texture2D(rays, vUv);
        if (r.w < 0.5) { gl_FragColor = vec4(0.0); return; }
        vec3 dir = rotation * vec3(r.x, -r.y, -r.z); // OpenCV → OpenGL camera axes → world
        gl_FragColor = vec4(textureCube(cube, dir).rgb, 1.0);
      }`,
  });
}

/**
 * Renders what a real camera would record:
 *  1. a cube map (6 perspective renders) of color and of range from the camera's true position,
 *  2. resampled through the lens model (distortion / fisheye) into the output image,
 *  3. passed through the sensor model (blur, vignetting, exposure, noise, 8-bit),
 * and attaches the slightly wrong calibration a real rig would have.
 */
export class Capturer {
  private readonly rangeMaterial = createRangeMaterial();
  private readonly resampleMaterial = createResampleMaterial();
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    if (!renderer.extensions.has('EXT_color_buffer_float')) {
      throw new Error('EXT_color_buffer_float is not supported: float render targets are required for capture.');
    }
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.resampleMaterial);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
  }

  capture(scene: THREE.Scene, cameras: THREE.Camera[], settings: CaptureSettings): CaptureFrame[] {
    const { width: w, height: h } = settings;
    const renderer = this.renderer;
    const trueModel = buildModel(settings.lens, w, h);

    // Cube texel ≈ output pixel at the image center, with some supersampling.
    const faceSize = Math.min(2048, Math.max(128, Math.ceil(2.5 * trueModel.fx)));
    const colorCube = new THREE.WebGLCubeRenderTarget(faceSize, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
    const rangeCube = new THREE.WebGLCubeRenderTarget(faceSize, {
      type: THREE.FloatType,
      minFilter: THREE.NearestFilter, // never blend foreground and background distances
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
    });
    const cubeCamera = new THREE.CubeCamera(settings.near, settings.far, colorCube);
    const output = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.FloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
    });

    // Per-pixel rays of the true lens, uploaded with the bottom row first (GL texture order).
    const rays = rayMap(trueModel);
    const raysGL = new Float32Array(rays.length);
    for (let v = 0; v < h; v++) raysGL.set(rays.subarray(v * w * 4, (v + 1) * w * 4), (h - 1 - v) * w * 4);
    const rayTexture = new THREE.DataTexture(raysGL, w, h, THREE.RGBAFormat, THREE.FloatType);
    rayTexture.needsUpdate = true;

    const valid = new Uint8Array(w * h);
    const offAxis = new Float32Array(w * h);
    const edgeRadius = trueModel.type === 'fisheye' ? h / 2 : Math.hypot(w / 2, h / 2);
    for (let v = 0; v < h; v++) {
      for (let u = 0; u < w; u++) {
        const p = v * w + u;
        valid[p] = rays[p * 4 + 3];
        offAxis[p] = Math.hypot(u + 0.5 - trueModel.cx, v + 0.5 - trueModel.cy) / edgeRadius;
      }
    }

    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevBackground = scene.background;
    const prevOverride = scene.overrideMaterial;
    scene.updateMatrixWorld(true);

    const rgba = new Float32Array(w * h * 4);
    const readOutput = (cube: THREE.WebGLCubeRenderTarget, rotation: THREE.Matrix3) => {
      this.resampleMaterial.uniforms.cube.value = cube.texture;
      this.resampleMaterial.uniforms.rays.value = rayTexture;
      this.resampleMaterial.uniforms.rotation.value.copy(rotation);
      renderer.setRenderTarget(output);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(this.quadScene, this.quadCamera);
      renderer.readRenderTargetPixels(output, 0, 0, w, h, rgba);
    };

    const frames = cameras.map((camera, index) => {
      camera.updateMatrixWorld(true);
      const trueCameraToWorld = camera.matrixWorld.clone();
      const rotation = new THREE.Matrix3().setFromMatrix4(trueCameraToWorld);
      cubeCamera.position.setFromMatrixPosition(trueCameraToWorld);
      cubeCamera.updateMatrixWorld(true);

      // Color cube.
      scene.overrideMaterial = prevOverride;
      scene.background = prevBackground;
      renderer.setClearColor(0x000000, 1);
      cubeCamera.renderTarget = colorCube;
      cubeCamera.update(renderer, scene);
      readOutput(colorCube, rotation);
      const linear = new Float32Array(w * h * 3);
      for (let v = 0; v < h; v++) {
        const src = (h - 1 - v) * w; // GL rows start at the bottom
        for (let u = 0; u < w; u++) {
          for (let c = 0; c < 3; c++) linear[(v * w + u) * 3 + c] = Math.max(0, rgba[(src + u) * 4 + c]);
        }
      }

      // Range cube (empty background so "no hit" reads as 0).
      scene.overrideMaterial = this.rangeMaterial;
      scene.background = null;
      renderer.setClearColor(0x000000, 0);
      cubeCamera.renderTarget = rangeCube;
      cubeCamera.update(renderer, scene);
      readOutput(rangeCube, rotation);
      const range = new Float32Array(w * h);
      for (let v = 0; v < h; v++) {
        const src = (h - 1 - v) * w;
        for (let u = 0; u < w; u++) range[v * w + u] = valid[v * w + u] ? rgba[(src + u) * 4] : 0;
      }

      const rand = mulberry32(settings.seed * 7919 + index * 104729 + 1);
      const { image, color } = applySensor(linear, valid, offAxis, w, h, settings.sensor, rand);
      return {
        index,
        name: `cam_${String(index).padStart(3, '0')}`,
        model: perturbModel(trueModel, settings.calibration, rand),
        cameraToWorld: perturbPose(trueCameraToWorld, settings.calibration, rand),
        trueModel,
        trueCameraToWorld,
        near: settings.near,
        far: settings.far,
        image,
        color,
        range,
      };
    });

    scene.overrideMaterial = prevOverride;
    scene.background = prevBackground;
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.setRenderTarget(prevTarget);
    colorCube.dispose();
    rangeCube.dispose();
    output.dispose();
    rayTexture.dispose();
    return frames;
  }

  dispose(): void {
    this.rangeMaterial.dispose();
    this.resampleMaterial.dispose();
  }
}
