/**
 * Dev-only memory profiler for workflow step execution.
 * Stores memory snapshots in-process; accessed via /api/dev/memory.
 * Zero overhead in production — all functions early-return when not local dev.
 */

import { getEnv } from '#env';

type MemorySample = {
  timestamp: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  workflow: string;
  label: string;
};

const samples: MemorySample[] = [];
let enabled = false;

export function initMemoryProfiler(): void {
  if (getEnv().NODE_ENV !== 'development') return;
  enabled = true;
}

export function getMemorySamples(): MemorySample[] {
  return samples;
}

export function clearMemorySamples(): void {
  samples.length = 0;
}

export function isMemoryProfilerEnabled(): boolean {
  return enabled;
}
