import { gaussian } from '../util/random';

/**
 * Image-formation effects applied after the ideal (linear-light) image is rendered.
 * Order follows the physical pipeline: optics → exposure → photon/electron noise → ADC.
 */
export interface SensorConfig {
  /** Lens softness: Gaussian blur σ in pixels. */
  blurSigma: number;
  /** Brightness falloff toward the image edge: 0 = none, 1 = black at the corners/circle edge. */
  vignetting: number;
  /** Global exposure compensation in stops (EV). */
  exposureEV: number;
  /** Per-camera random exposure difference, σ in stops (auto-exposure / gain mismatch). */
  exposureJitterEV: number;
  /** Per-camera random white-balance error, σ of each channel's gain. */
  whiteBalanceJitter: number;
  /** Electrons collected at full white; lower = noisier (smaller pixels, higher ISO). 0 disables noise. */
  fullWellElectrons: number;
  /** Read noise in electrons. */
  readNoiseElectrons: number;
}

export const IDEAL_SENSOR: SensorConfig = {
  blurSigma: 0,
  vignetting: 0,
  exposureEV: 0,
  exposureJitterEV: 0,
  whiteBalanceJitter: 0,
  fullWellElectrons: 0,
  readNoiseElectrons: 0,
};

export const REALISTIC_SENSOR: SensorConfig = {
  blurSigma: 0.6,
  vignetting: 0.35,
  exposureEV: 0,
  exposureJitterEV: 0.15,
  whiteBalanceJitter: 0.03,
  fullWellElectrons: 1500,
  readNoiseElectrons: 4,
};

function gaussianKernel(sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) sum += k[i + radius] = Math.exp((-i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/** Separable Gaussian blur of an interleaved image with `channels` floats per pixel; edges clamp. */
export function blur(img: Float32Array, w: number, h: number, channels: number, sigma: number): Float32Array {
  if (!(sigma > 0)) return img;
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) / 2;
  const tmp = new Float32Array(img.length);
  const out = new Float32Array(img.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < channels; c++) {
        let s = 0;
        for (let i = -r; i <= r; i++) {
          const xx = Math.min(w - 1, Math.max(0, x + i));
          s += k[i + r] * img[(y * w + xx) * channels + c];
        }
        tmp[(y * w + x) * channels + c] = s;
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < channels; c++) {
        let s = 0;
        for (let i = -r; i <= r; i++) {
          const yy = Math.min(h - 1, Math.max(0, y + i));
          s += k[i + r] * tmp[(yy * w + x) * channels + c];
        }
        out[(y * w + x) * channels + c] = s;
      }
    }
  }
  return out;
}

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgbByte(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}

export interface SensorOutput {
  /** Final 8-bit sRGB image (what a real camera would save). */
  image: ImageData;
  /** The same image decoded back to linear RGB floats (3 per pixel) — what reconstruction may use. */
  color: Float32Array;
}

/**
 * @param linear  ideal linear RGB, 3 floats per pixel, top row first
 * @param valid   1 where the pixel sees through the lens (fisheye corners are 0)
 * @param offAxis normalized distance from the image center (0 center, 1 at the lens' field edge), per pixel
 */
export function applySensor(
  linear: Float32Array,
  valid: Uint8Array,
  offAxis: Float32Array,
  w: number,
  h: number,
  cfg: SensorConfig,
  rand: () => number,
): SensorOutput {
  const img = blur(linear, w, h, 3, cfg.blurSigma);
  const gain = Math.pow(2, cfg.exposureEV + gaussian(rand) * cfg.exposureJitterEV);
  const wb = [0, 1, 2].map(() => Math.max(0, 1 + gaussian(rand) * cfg.whiteBalanceJitter));
  const fw = cfg.fullWellElectrons;

  const image = new ImageData(w, h);
  const color = new Float32Array(w * h * 3);
  for (let p = 0; p < w * h; p++) {
    image.data[p * 4 + 3] = 255;
    if (!valid[p]) continue;
    const r = offAxis[p];
    const vig = 1 - cfg.vignetting * Math.min(1, r * r);
    for (let c = 0; c < 3; c++) {
      let s = img[p * 3 + c] * gain * wb[c] * vig;
      if (fw > 0) {
        // Shot noise: Poisson(e) ≈ Normal(e, √e) in electrons, plus Gaussian read noise.
        const e = Math.max(0, s) * fw;
        s = (e + gaussian(rand) * Math.sqrt(e + cfg.readNoiseElectrons * cfg.readNoiseElectrons)) / fw;
      }
      // Saturation + 8-bit quantization.
      const byte = linearToSrgbByte(s);
      image.data[p * 4 + c] = byte;
      color[p * 3 + c] = SRGB_TO_LINEAR[byte];
    }
  }
  return { image, color };
}
