/** @fileoverview Thread-CPU growth checks for scanners over caller- or upstream-sized text. */
import { expect } from 'vitest';

const baseSize = 5120;
/** Least per-call thread CPU (µs) over five trials of `calls` calls each. */
function perCallCpuUs(run: (input: string) => unknown, input: string, calls: number): number {
  let least = Number.POSITIVE_INFINITY;
  for (let trial = 0; trial < 5; trial++) {
    const start = process.threadCpuUsage();
    for (let call = 0; call < calls; call++) run(input);
    const used = process.threadCpuUsage(start);
    least = Math.min(least, (used.user + used.system) / calls);
  }
  return least;
}

/**
 * Doubles `shape` from 5120 characters to `maxSize` (default 327680, a 64× span). At each size the
 * per-call CPU must stay under `boundUsPerChar` microseconds per character, checked before the
 * next size runs, and the 5120-character baseline is timed again beside it. Each pair's growth is
 * extrapolated to the full span; the least of those, and the measured full-span pair itself, must
 * stay below 256 (linear reads about 64, quadratic about 4096). Keep `maxSize` below the size at
 * which a runtime's regex engine changes mode for the shape.
 */
export function expectLinearCpu(
  run: (input: string) => unknown,
  shape: (size: number) => string,
  { maxSize = 327_680, boundUsPerChar = 1 }: { maxSize?: number; boundUsPerChar?: number } = {},
): void {
  const base = shape(baseSize);
  for (let warmup = 0; warmup < 20; warmup++) run(base);
  const extrapolated: number[] = [];
  let fullSpan = Number.POSITIVE_INFINITY;
  for (let size = baseSize * 2; size <= maxSize; size *= 2) {
    const input = shape(size);
    const sizeUs = perCallCpuUs(run, input, Math.max(1, maxSize / size));
    expect(sizeUs, `${size} characters`).toBeLessThan(size * boundUsPerChar);
    const baseUs = Math.max(perCallCpuUs(run, base, maxSize / baseSize), 0.01);
    const ratio = sizeUs / baseUs;
    extrapolated.push(ratio ** (Math.log(maxSize / baseSize) / Math.log(size / baseSize)));
    if (size === maxSize) fullSpan = ratio;
  }
  expect(Math.min(...extrapolated)).toBeLessThan(256);
  expect(fullSpan).toBeLessThan(256);
}
