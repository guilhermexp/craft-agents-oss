/**
 * Markdown report over the retained perf history.
 *
 * The overlay shows the last second; a diagnosis needs the accumulated picture.
 * This rolls every retained window into one ranked document that can be pasted
 * into an issue or handed to another agent.
 */

import type { PerfSnapshot } from './store'
import { interactionDisplay } from './interactions'

/** Rows per table — enough to see the tail, short enough to read. */
const TOP_N = 15

interface Accumulated {
  renders: number
  wasted: number
  selfMs: number
  maxSelfMs: number
  props: Map<string, number>
}

function formatMs(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1)
}

export function buildPerfReport(history: readonly PerfSnapshot[]): string {
  if (history.length === 0) return '# Craft runtime perf\n\nNo samples collected.\n'

  const usable = history.filter((w) => !w.discontinuity)
  const windows = usable.length === 0 ? history : usable
  const seconds = windows.reduce((sum, w) => sum + w.windowMs, 0) / 1000 || 1
  const first = windows[0]!
  const last = windows[windows.length - 1]!

  const lines: string[] = []
  lines.push('# Craft runtime perf')
  lines.push('')
  lines.push(`- Window: ${new Date(first.ts).toISOString()} → ${new Date(last.ts).toISOString()} (${seconds.toFixed(0)}s, ${windows.length} samples)`)
  if (usable.length !== history.length) {
    lines.push(`- Discarded ${history.length - usable.length} sample(s) with a wall-clock discontinuity`)
  }
  lines.push(`- React commit durations: ${last.commits.durationsAvailable ? 'available' : 'unavailable (production build — counts only)'}`)
  lines.push('')

  // --- headline ------------------------------------------------------------
  const fpsValues = windows.map((w) => w.frames.fps).filter((v): v is number => v !== null)
  const totalCommits = windows.reduce((sum, w) => sum + w.commits.commits, 0)
  const totalRenderMs = windows.reduce((sum, w) => sum + w.commits.totalSelfMs, 0)
  const totalLongTaskMs = windows.reduce((sum, w) => sum + w.frames.longTaskMsPerSec * (w.windowMs / 1000), 0)
  const trackerMs = windows.reduce((sum, w) => sum + w.commits.trackerSelfMs, 0)

  lines.push('## Headline')
  lines.push('')
  lines.push('|Metric|Value|')
  lines.push('|---|---|')
  lines.push(`|FPS (mean / min)|${fpsValues.length ? `${(fpsValues.reduce((a, b) => a + b, 0) / fpsValues.length).toFixed(0)} / ${Math.min(...fpsValues)}` : 'n/a (hidden)'}|`)
  lines.push(`|React commits|${totalCommits} (${(totalCommits / seconds).toFixed(1)}/s)|`)
  lines.push(`|React render time|${formatMs(totalRenderMs)} ms (${(totalRenderMs / seconds).toFixed(1)} ms/s)|`)
  lines.push(`|Long-task time|${formatMs(totalLongTaskMs)} ms (${((totalLongTaskMs / seconds) / 10).toFixed(1)}% of main thread)|`)
  lines.push(`|Peak DOM nodes|${Math.max(...windows.map((w) => w.frames.domNodes))}|`)
  lines.push(`|Monitor overhead|${formatMs(trackerMs)} ms (${((trackerMs / seconds) / 10).toFixed(2)}%)|`)
  lines.push('')

  // --- components ----------------------------------------------------------
  const components = new Map<string, Accumulated>()
  for (const window of windows) {
    for (const stat of window.commits.components) {
      const bucket = components.get(stat.name) ?? { renders: 0, wasted: 0, selfMs: 0, maxSelfMs: 0, props: new Map() }
      bucket.renders += stat.renders
      bucket.wasted += stat.wasted
      bucket.selfMs += stat.selfMs
      bucket.maxSelfMs = Math.max(bucket.maxSelfMs, stat.maxSelfMs)
      for (const prop of stat.topProps) bucket.props.set(prop, (bucket.props.get(prop) ?? 0) + 1)
      components.set(stat.name, bucket)
    }
  }

  const ranked = [...components.entries()].sort((a, b) => b[1].selfMs - a[1].selfMs || b[1].renders - a[1].renders)

  lines.push('## Components by render time')
  lines.push('')
  lines.push('`wasted` = rendered with no prop and no state change — driven by a parent render or a context value.')
  lines.push('')
  lines.push('|Component|Renders|Wasted|Self ms|Max ms|Changed props|')
  lines.push('|---|---:|---:|---:|---:|---|')
  for (const [name, stat] of ranked.slice(0, TOP_N)) {
    const props = [...stat.props.keys()].slice(0, 4).join(', ') || '—'
    lines.push(`|${name}|${stat.renders}|${stat.wasted}|${formatMs(stat.selfMs)}|${formatMs(stat.maxSelfMs)}|${props}|`)
  }
  lines.push('')

  const byWaste = ranked.filter(([, s]) => s.wasted > 0).sort((a, b) => b[1].wasted - a[1].wasted)
  if (byWaste.length > 0) {
    lines.push('## Components by wasted renders')
    lines.push('')
    lines.push('|Component|Wasted|Total renders|Waste %|')
    lines.push('|---|---:|---:|---:|')
    for (const [name, stat] of byWaste.slice(0, TOP_N)) {
      lines.push(`|${name}|${stat.wasted}|${stat.renders}|${((stat.wasted / stat.renders) * 100).toFixed(0)}%|`)
    }
    lines.push('')
  }

  // --- blocking scripts ----------------------------------------------------
  const scripts = new Map<string, { ms: number; count: number; forcedLayoutMs: number }>()
  for (const window of windows) {
    for (const script of window.frames.scripts) {
      const bucket = scripts.get(script.label) ?? { ms: 0, count: 0, forcedLayoutMs: 0 }
      bucket.ms += script.ms
      bucket.count += script.count
      bucket.forcedLayoutMs += script.forcedLayoutMs
      scripts.set(script.label, bucket)
    }
  }
  if (scripts.size > 0) {
    lines.push('## Blocking scripts (long animation frames)')
    lines.push('')
    lines.push('|Script|Blocking ms|Calls|Forced layout ms|')
    lines.push('|---|---:|---:|---:|')
    for (const [label, stat] of [...scripts.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, TOP_N)) {
      lines.push(`|${label}|${formatMs(stat.ms)}|${stat.count}|${formatMs(stat.forcedLayoutMs)}|`)
    }
    lines.push('')
  }

  // --- RPC -----------------------------------------------------------------
  const channels = new Map<string, { calls: number; totalMs: number; maxMs: number; errors: number }>()
  for (const window of windows) {
    for (const stat of window.rpc) {
      const bucket = channels.get(stat.channel) ?? { calls: 0, totalMs: 0, maxMs: 0, errors: 0 }
      bucket.calls += stat.calls
      bucket.totalMs += stat.totalMs
      bucket.maxMs = Math.max(bucket.maxMs, stat.maxMs)
      bucket.errors += stat.errors
      channels.set(stat.channel, bucket)
    }
  }
  if (channels.size > 0) {
    lines.push('## RPC channels')
    lines.push('')
    lines.push('|Channel|Calls|Total ms|Mean ms|Max ms|Errors|')
    lines.push('|---|---:|---:|---:|---:|---:|')
    for (const [channel, stat] of [...channels.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs).slice(0, TOP_N)) {
      lines.push(`|${channel}|${stat.calls}|${formatMs(stat.totalMs)}|${formatMs(stat.totalMs / stat.calls)}|${formatMs(stat.maxMs)}|${stat.errors}|`)
    }
    lines.push('')
  }

  // --- interactions --------------------------------------------------------
  // Interactions are a rolling list, not a per-window delta, so the last
  // snapshot already holds every retained one; summing across windows would
  // count each click as many times as it stayed in the buffer.
  const interactions = last.interactions
  const display = interactionDisplay(last.commitTrackingAvailable)
  if (!display.showSettle) {
    // Settle latency comes from the React commit hook, which is absent in a
    // packaged build. Reporting the resulting all-zero timings as real numbers
    // is worse than saying nothing, so the section is a warning, not a table.
    lines.push('## Recent interactions')
    lines.push('')
    lines.push('Settle latency unavailable in this build (packaged renderer — no React commit hook); interaction timings omitted.')
    lines.push('')
  } else if (interactions.length > 0) {
    lines.push('## Recent interactions')
    lines.push('')
    lines.push('`settled` = input event → the UI stopped committing. That is the number the user feels.')
    lines.push('')
    lines.push('|Target|First commit ms|Settled ms|Commits|')
    lines.push('|---|---:|---:|---:|')
    for (const item of [...interactions].sort((a, b) => b.settledMs - a.settledMs).slice(0, TOP_N)) {
      const firstCommit = item.firstCommitMs === null ? '—' : formatMs(item.firstCommitMs)
      lines.push(`|${item.label}|${firstCommit}|${formatMs(item.settledMs)}${item.timedOut ? ' (timeout)' : ''}|${item.commits}|`)
    }
    lines.push('')
  }

  // --- processes -----------------------------------------------------------
  if (last.main) {
    lines.push('## Processes (last sample)')
    lines.push('')
    lines.push('|Process|PID|CPU %|RSS MB|')
    lines.push('|---|---:|---:|---:|')
    for (const proc of last.main.processes) {
      lines.push(`|${proc.label}|${proc.pid}|${proc.cpuPercent.toFixed(1)}|${proc.rssMb.toFixed(0)}|`)
    }
    lines.push('')
    const loopMax = Math.max(...windows.map((w) => w.main?.eventLoop.maxMs ?? 0))
    lines.push(`Main event loop: mean ${last.main.eventLoop.meanMs} ms, worst ${loopMax.toFixed(1)} ms over the run.`)
    lines.push('')
  }

  return lines.join('\n')
}
