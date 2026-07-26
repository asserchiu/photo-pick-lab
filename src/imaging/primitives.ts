import type { Point2D, Rect } from "../domain/types";

export interface SobelResult {
  gx: Float32Array;
  gy: Float32Array;
  magnitude: Float32Array;
  direction: Float32Array;
}

export interface ConnectedComponent {
  label: number;
  area: number;
  bbox: Rect;
  centroid: Point2D;
  perimeter: number;
  circularity: number;
  pixels: Uint32Array;
}

function pixelCount(width: number, height: number): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return 0;
  }
  return width * height;
}

function requireLength(data: ArrayLike<number>, width: number, height: number): number {
  const count = pixelCount(width, height);
  if (count === 0) return 0;
  if (data.length < count) {
    throw new RangeError(`Expected at least ${count} samples, received ${data.length}`);
  }
  return count;
}

export function rgbaToLuminance(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
): Float32Array {
  const count = pixelCount(width, height);
  if (count === 0) return new Float32Array();
  if (rgba.length < count * 4) {
    throw new RangeError(`Expected at least ${count * 4} RGBA values, received ${rgba.length}`);
  }

  const output = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const offset = index * 4;
    const red = rgba[offset] ?? 0;
    const green = rgba[offset + 1] ?? 0;
    const blue = rgba[offset + 2] ?? 0;
    output[index] = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  }
  return output;
}

export function histogram(
  data: ArrayLike<number>,
  bins = 256,
  minimum = 0,
  maximum = 255,
): Uint32Array {
  if (!Number.isInteger(bins) || bins <= 0 || !Number.isFinite(minimum) ||
      !Number.isFinite(maximum) || maximum <= minimum) {
    return new Uint32Array();
  }

  const result = new Uint32Array(bins);
  const scale = bins / (maximum - minimum);
  for (let index = 0; index < data.length; index += 1) {
    const value = data[index];
    if (value === undefined || !Number.isFinite(value)) continue;
    const bin = Math.min(bins - 1, Math.max(0, Math.floor((value - minimum) * scale)));
    result[bin] = (result[bin] ?? 0) + 1;
  }
  return result;
}

export function percentile(data: ArrayLike<number>, quantile: number): number | null {
  if (data.length === 0 || !Number.isFinite(quantile)) return null;
  const values: number[] = [];
  for (let index = 0; index < data.length; index += 1) {
    const value = data[index];
    if (value !== undefined && Number.isFinite(value)) values.push(value);
  }
  if (values.length === 0) return null;

  values.sort((left, right) => left - right);
  const bounded = Math.min(1, Math.max(0, quantile));
  const position = bounded * (values.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = values[lowerIndex] ?? 0;
  const upper = values[upperIndex] ?? lower;
  return lower + (upper - lower) * (position - lowerIndex);
}

export function median(data: ArrayLike<number>): number | null {
  return percentile(data, 0.5);
}

export function medianAbsoluteDeviation(data: ArrayLike<number>): number | null {
  const center = median(data);
  if (center === null) return null;
  const deviations = new Float64Array(data.length);
  let count = 0;
  for (let index = 0; index < data.length; index += 1) {
    const value = data[index];
    if (value === undefined || !Number.isFinite(value)) continue;
    deviations[count] = Math.abs(value - center);
    count += 1;
  }
  return median(deviations.subarray(0, count));
}

export function robustStandardDeviation(data: ArrayLike<number>): number | null {
  const deviation = medianAbsoluteDeviation(data);
  return deviation === null ? null : deviation * 1.4826;
}

export function trimmedMean(data: ArrayLike<number>, trimFraction = 0.1): number | null {
  const values: number[] = [];
  for (let index = 0; index < data.length; index += 1) {
    const value = data[index];
    if (value !== undefined && Number.isFinite(value)) values.push(value);
  }
  if (values.length === 0) return null;
  values.sort((left, right) => left - right);
  const trim = Math.min(Math.floor(values.length / 2), Math.max(0, Math.floor(values.length * trimFraction)));
  let sum = 0;
  for (let index = trim; index < values.length - trim; index += 1) {
    sum += values[index] ?? 0;
  }
  const count = values.length - trim * 2;
  return count > 0 ? sum / count : null;
}

export function winsorize(
  data: ArrayLike<number>,
  lowerQuantile = 0.05,
  upperQuantile = 0.95,
): Float64Array {
  const lower = percentile(data, lowerQuantile);
  const upper = percentile(data, upperQuantile);
  if (lower === null || upper === null) return new Float64Array();
  const output = new Float64Array(data.length);
  for (let index = 0; index < data.length; index += 1) {
    const value = data[index];
    output[index] = value === undefined || !Number.isFinite(value)
      ? Number.NaN
      : Math.min(upper, Math.max(lower, value));
  }
  return output;
}

export function otsuThreshold(data: ArrayLike<number>): number | null {
  if (data.length === 0) return null;
  const bins = histogram(data);
  let total = 0;
  let weightedTotal = 0;
  for (let index = 0; index < bins.length; index += 1) {
    const count = bins[index] ?? 0;
    total += count;
    weightedTotal += index * count;
  }
  if (total === 0) return null;

  let backgroundCount = 0;
  let backgroundWeighted = 0;
  let bestVariance = -1;
  let bestThreshold = 0;
  for (let index = 0; index < bins.length; index += 1) {
    const count = bins[index] ?? 0;
    backgroundCount += count;
    if (backgroundCount === 0) continue;
    const foregroundCount = total - backgroundCount;
    if (foregroundCount === 0) break;
    backgroundWeighted += index * count;
    const backgroundMean = backgroundWeighted / backgroundCount;
    const foregroundMean = (weightedTotal - backgroundWeighted) / foregroundCount;
    const difference = backgroundMean - foregroundMean;
    const variance = backgroundCount * foregroundCount * difference * difference;
    if (variance > bestVariance) {
      bestVariance = variance;
      bestThreshold = index;
    }
  }
  return bestThreshold;
}

export function sobel(
  data: ArrayLike<number>,
  width: number,
  height: number,
): SobelResult {
  const count = requireLength(data, width, height);
  const gx = new Float32Array(count);
  const gy = new Float32Array(count);
  const magnitude = new Float32Array(count);
  const direction = new Float32Array(count);
  if (width < 3 || height < 3 || count === 0) return { gx, gy, magnitude, direction };

  const valueAt = (x: number, y: number): number => data[y * width + x] ?? 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const horizontal =
        -valueAt(x - 1, y - 1) + valueAt(x + 1, y - 1) -
        2 * valueAt(x - 1, y) + 2 * valueAt(x + 1, y) -
        valueAt(x - 1, y + 1) + valueAt(x + 1, y + 1);
      const vertical =
        valueAt(x - 1, y - 1) + 2 * valueAt(x, y - 1) + valueAt(x + 1, y - 1) -
        valueAt(x - 1, y + 1) - 2 * valueAt(x, y + 1) - valueAt(x + 1, y + 1);
      const index = y * width + x;
      gx[index] = horizontal;
      gy[index] = vertical;
      magnitude[index] = Math.hypot(horizontal, vertical);
      direction[index] = Math.atan2(vertical, horizontal);
    }
  }
  return { gx, gy, magnitude, direction };
}

function morphology(
  mask: ArrayLike<number>,
  width: number,
  height: number,
  radius: number,
  operation: "dilate" | "erode",
): Uint8Array {
  const count = requireLength(mask, width, height);
  if (count === 0) return new Uint8Array();
  const boundedRadius = Math.max(0, Math.floor(radius));
  const result = new Uint8Array(count);
  if (boundedRadius === 0) {
    for (let index = 0; index < count; index += 1) result[index] = mask[index] ? 1 : 0;
    return result;
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let output = operation === "erode" ? 1 : 0;
      scan: for (let dy = -boundedRadius; dy <= boundedRadius; dy += 1) {
        for (let dx = -boundedRadius; dx <= boundedRadius; dx += 1) {
          if (dx * dx + dy * dy > boundedRadius * boundedRadius) continue;
          const sampleX = x + dx;
          const sampleY = y + dy;
          const active = sampleX >= 0 && sampleX < width && sampleY >= 0 && sampleY < height
            ? Boolean(mask[sampleY * width + sampleX])
            : false;
          if (operation === "dilate" ? active : !active) {
            output = operation === "dilate" ? 1 : 0;
            break scan;
          }
        }
      }
      result[y * width + x] = output;
    }
  }
  return result;
}

export function dilateBinary(
  mask: ArrayLike<number>,
  width: number,
  height: number,
  radius = 1,
): Uint8Array {
  return morphology(mask, width, height, radius, "dilate");
}

export function erodeBinary(
  mask: ArrayLike<number>,
  width: number,
  height: number,
  radius = 1,
): Uint8Array {
  return morphology(mask, width, height, radius, "erode");
}

export function openBinary(
  mask: ArrayLike<number>,
  width: number,
  height: number,
  radius = 1,
): Uint8Array {
  return dilateBinary(erodeBinary(mask, width, height, radius), width, height, radius);
}

export function closeBinary(
  mask: ArrayLike<number>,
  width: number,
  height: number,
  radius = 1,
): Uint8Array {
  return erodeBinary(dilateBinary(mask, width, height, radius), width, height, radius);
}

export function connectedComponents(
  mask: ArrayLike<number>,
  width: number,
  height: number,
  connectivity: 4 | 8 = 8,
): ConnectedComponent[] {
  const count = requireLength(mask, width, height);
  if (count === 0) return [];
  const labels = new Int32Array(count);
  const queue = new Uint32Array(count);
  const components: ConnectedComponent[] = [];
  const offsets = connectivity === 8
    ? [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]] as const
    : [[0, -1], [-1, 0], [1, 0], [0, 1]] as const;
  let nextLabel = 1;

  for (let start = 0; start < count; start += 1) {
    if (!mask[start] || labels[start] !== 0) continue;
    let read = 0;
    let write = 0;
    queue[write] = start;
    write += 1;
    labels[start] = nextLabel;
    const pixels: number[] = [];
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let sumX = 0;
    let sumY = 0;
    let perimeter = 0;

    while (read < write) {
      const index = queue[read] ?? 0;
      read += 1;
      pixels.push(index);
      const x = index % width;
      const y = Math.floor(index / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      sumX += x;
      sumY += y;

      const cardinal = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;
      for (const [dx, dy] of cardinal) {
        const neighborX = x + dx;
        const neighborY = y + dy;
        if (neighborX < 0 || neighborX >= width || neighborY < 0 || neighborY >= height ||
            !mask[neighborY * width + neighborX]) {
          perimeter += 1;
        }
      }

      for (const [dx, dy] of offsets) {
        const neighborX = x + dx;
        const neighborY = y + dy;
        if (neighborX < 0 || neighborX >= width || neighborY < 0 || neighborY >= height) continue;
        const neighbor = neighborY * width + neighborX;
        if (!mask[neighbor] || labels[neighbor] !== 0) continue;
        labels[neighbor] = nextLabel;
        queue[write] = neighbor;
        write += 1;
      }
    }

    const area = pixels.length;
    components.push({
      label: nextLabel,
      area,
      bbox: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
      centroid: { x: sumX / area, y: sumY / area },
      perimeter,
      circularity: perimeter > 0 ? Math.min(1, 4 * Math.PI * area / (perimeter * perimeter)) : 0,
      pixels: Uint32Array.from(pixels),
    });
    nextLabel += 1;
  }

  return components;
}
