import type { PixelCircle } from "../domain/types";

export interface SyntheticMoon {
  luminance: Float32Array;
  width: number;
  height: number;
  circle: PixelCircle;
}

export interface SyntheticMoonOptions {
  width?: number;
  height?: number;
  centerX?: number;
  centerY?: number;
  radius?: number;
  crescentCut?: number;
  surfaceLevel?: number;
  texture?: number;
  background?: number;
}

export function syntheticMoon(options: SyntheticMoonOptions = {}): SyntheticMoon {
  const width = options.width ?? 128;
  const height = options.height ?? 96;
  const circle: PixelCircle = {
    centerX: options.centerX ?? width * 0.5,
    centerY: options.centerY ?? height * 0.5,
    radius: options.radius ?? Math.min(width, height) * 0.24,
  };
  const background = options.background ?? 8;
  const surfaceLevel = options.surfaceLevel ?? 190;
  const texture = options.texture ?? 22;
  const crescentCut = options.crescentCut ?? -1;
  const luminance = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = (x + 0.5 - circle.centerX) / circle.radius;
      const dy = (y + 0.5 - circle.centerY) / circle.radius;
      const inDisc = dx * dx + dy * dy <= 1;
      const illuminated = inDisc && dx >= crescentCut;
      const variation = texture * (
        0.55 * Math.sin((x - circle.centerX) * 0.58) * Math.cos((y - circle.centerY) * 0.47) +
        0.45 * Math.sin((x + y) * 0.31)
      );
      luminance[y * width + x] = illuminated
        ? Math.min(255, Math.max(0, surfaceLevel + variation))
        : background;
    }
  }
  return { luminance, width, height, circle };
}

export function boxBlur(
  input: Float32Array,
  width: number,
  height: number,
  radius: number,
  horizontalOnly = false,
): Float32Array {
  const boundedRadius = Math.max(0, Math.floor(radius));
  if (boundedRadius === 0) return new Float32Array(input);
  const horizontal = new Float32Array(input.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let total = 0;
      let count = 0;
      for (let offset = -boundedRadius; offset <= boundedRadius; offset += 1) {
        const sampleX = Math.min(width - 1, Math.max(0, x + offset));
        total += input[y * width + sampleX] ?? 0;
        count += 1;
      }
      horizontal[y * width + x] = total / count;
    }
  }
  if (horizontalOnly) return horizontal;

  const output = new Float32Array(input.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let total = 0;
      let count = 0;
      for (let offset = -boundedRadius; offset <= boundedRadius; offset += 1) {
        const sampleY = Math.min(height - 1, Math.max(0, y + offset));
        total += horizontal[sampleY * width + x] ?? 0;
        count += 1;
      }
      output[y * width + x] = total / count;
    }
  }
  return output;
}

export function addDeterministicNoise(
  input: Float32Array,
  amplitude: number,
  seed = 0x12345678,
): Float32Array {
  let state = seed >>> 0;
  const output = new Float32Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const unit = (state >>> 0) / 0x1_0000_0000;
    output[index] = Math.min(255, Math.max(0, (input[index] ?? 0) + (unit * 2 - 1) * amplitude));
  }
  return output;
}
