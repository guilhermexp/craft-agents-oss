/**
 * Runtime performance monitor — wire types.
 *
 * These describe the 1 Hz sample the Electron main process pushes to a
 * subscribed renderer while the perf overlay is running. Renderer-local
 * metrics (React commits, frames, long tasks, RPC latency) never cross the
 * wire; they are collected and aggregated in the renderer itself.
 */

/** CPU/memory for one OS process in the app's process tree. */
export interface PerfProcessSample {
  /** Stable identity across samples: `main`, `gpu`, `tab:<pid>`, `utility:<pid>`. */
  readonly key: string
  /** Human label — process type plus, when known, the window/service name. */
  readonly label: string
  readonly pid: number
  /** Percent of a single core, averaged over the sample window. */
  readonly cpuPercent: number
  /** Resident set size in MiB. */
  readonly rssMb: number
}

/** Event-loop responsiveness of the main process over the sample window. */
export interface PerfEventLoopSample {
  /** Mean lag beyond the scheduled interval, in ms. */
  readonly meanMs: number
  /** Worst lag observed in the window, in ms. */
  readonly maxMs: number
}

/** Heap/GC health of the main process. */
export interface PerfMainHeapSample {
  readonly heapUsedMb: number
  readonly heapTotalMb: number
  readonly externalMb: number
  readonly rssMb: number
  /** Milliseconds spent in GC per second of wall time. `null` when unobservable. */
  readonly gcMsPerSec: number | null
}

/** One 1 Hz main-process sample. */
export interface PerfMainSample {
  /** `Date.now()` at the end of the sample window. */
  readonly ts: number
  /** Actual window length in ms — never assume exactly 1000. */
  readonly windowMs: number
  readonly processes: readonly PerfProcessSample[]
  readonly eventLoop: PerfEventLoopSample
  readonly heap: PerfMainHeapSample
  /** Cost of producing this sample, in ms — the monitor measuring itself. */
  readonly selfMs: number
}
