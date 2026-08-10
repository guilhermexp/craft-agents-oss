/**
 * Runtime perf overlay.
 *
 * Rendered into its own React root (see `mount.ts`) so its 1 Hz updates never
 * enter the app's commit path — a monitor that re-renders the tree it measures
 * reports its own noise. The commit tracker is told to ignore this root for the
 * same reason.
 *
 * Styling is deliberately literal (fixed colors, no theme tokens): a diagnostic
 * surface must stay readable when the thing being diagnosed is the theme layer.
 */

import { useCallback, useState, useSyncExternalStore } from 'react'
import { buildPerfReport } from '../../lib/perf/report'
import {
  getPerfHistory,
  getPerfSnapshot,
  setPerfEnabled,
  subscribeToPerf,
  type PerfSnapshot,
} from '../../lib/perf/store'

type Tab = 'components' | 'interactions' | 'rpc' | 'jank' | 'procs'

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'components', label: 'React' },
  { id: 'interactions', label: 'Clicks' },
  { id: 'rpc', label: 'RPC' },
  { id: 'jank', label: 'Jank' },
  { id: 'procs', label: 'Procs' },
]

const ROWS = 12

/**
 * Above the whole app, deliberately outside the `--z-*` token scale (which tops
 * out at `--z-splash: 600`). The overlay lives in its own React root and must
 * stay visible over anything it is diagnosing, including the splash layer.
 */
const Z_PERF_OVERLAY = 2147483000

const shell: React.CSSProperties = {
  position: 'fixed',
  right: 12,
  bottom: 12,
  zIndex: Z_PERF_OVERLAY,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  lineHeight: 1.45,
  color: '#e6e6e6',
  background: 'rgba(12,12,14,0.94)',
  border: '1px solid rgba(255,255,255,0.14)',
  borderRadius: 8,
  boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
  backdropFilter: 'blur(8px)',
  overflow: 'hidden',
  userSelect: 'text',
}

const cell: React.CSSProperties = { padding: '1px 6px', whiteSpace: 'nowrap' }
const numeric: React.CSSProperties = { ...cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
const headCell: React.CSSProperties = { ...cell, color: '#8d8d96', fontWeight: 400, textAlign: 'left' }
const headNumeric: React.CSSProperties = { ...numeric, color: '#8d8d96', fontWeight: 400 }

function fmt(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—'
  return value >= 100 ? value.toFixed(0) : value.toFixed(digits)
}

/** Green under budget, amber approaching it, red over — one glance, one answer. */
function severity(value: number, warn: number, bad: number): string {
  if (value >= bad) return '#ff6b6b'
  if (value >= warn) return '#ffc857'
  return '#7ddf9a'
}

function Table({ head, rows }: { head: readonly string[]; rows: readonly (readonly React.ReactNode[])[] }) {
  if (rows.length === 0) {
    return <div style={{ padding: '8px 10px', color: '#75757e' }}>No samples yet.</div>
  }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          {head.map((label, index) => (
            <th key={label} style={index === 0 ? headCell : headNumeric}>{label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
            {row.map((value, index) => (
              <td key={index} style={index === 0 ? cell : numeric}>{value}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ComponentsTab({ snapshot }: { snapshot: PerfSnapshot }) {
  const { commits } = snapshot
  return (
    <>
      {!commits.durationsAvailable && (
        <div style={{ padding: '4px 10px', color: '#ffc857' }}>
          Render timings unavailable in this build — counts only.
        </div>
      )}
      <Table
        head={['Component', 'Rndr', 'Wasted', 'Self ms', 'Changed props']}
        rows={commits.components.slice(0, ROWS).map((stat) => [
          stat.name,
          stat.renders,
          <span style={{ color: stat.wasted > 0 ? '#ffc857' : undefined }}>{stat.wasted}</span>,
          fmt(stat.selfMs),
          <span style={{ color: '#8d8d96' }}>{stat.topProps.join(', ') || '—'}</span>,
        ])}
      />
    </>
  )
}

function InteractionsTab({ snapshot }: { snapshot: PerfSnapshot }) {
  const recent = [...snapshot.interactions].reverse()
  return (
    <Table
      head={['Clicked', 'First ms', 'Settled ms', 'Commits']}
      rows={recent.slice(0, ROWS).map((item) => [
        item.label,
        item.firstCommitMs === null ? '—' : fmt(item.firstCommitMs),
        <span style={{ color: severity(item.settledMs, 200, 500) }}>
          {fmt(item.settledMs)}{item.timedOut ? '+' : ''}
        </span>,
        item.commits,
      ])}
    />
  )
}

function RpcTab({ snapshot }: { snapshot: PerfSnapshot }) {
  return (
    <Table
      head={['Channel', 'Calls', 'Mean ms', 'Max ms', 'Err']}
      rows={snapshot.rpc.slice(0, ROWS).map((stat) => [
        stat.channel,
        stat.calls,
        fmt(stat.totalMs / Math.max(1, stat.calls)),
        <span style={{ color: severity(stat.maxMs, 50, 200) }}>{fmt(stat.maxMs)}</span>,
        stat.errors || '',
      ])}
    />
  )
}

function JankTab({ snapshot }: { snapshot: PerfSnapshot }) {
  const { frames } = snapshot
  return (
    <>
      <div style={{ padding: '4px 10px', color: '#8d8d96' }}>
        long tasks <span style={{ color: severity(frames.longTaskMsPerSec, 100, 300) }}>{frames.longTaskMsPerSec} ms/s</span>
        {' · '}worst frame gap {frames.worstFrameGapMs} ms
        {' · '}worst input {frames.worstInteractionMs} ms{frames.worstInteractionName ? ` (${frames.worstInteractionName})` : ''}
      </div>
      <Table
        head={['Blocking script', 'ms', 'Calls', 'Layout ms']}
        rows={frames.scripts.slice(0, ROWS).map((script) => [
          script.label,
          fmt(script.ms),
          script.count,
          <span style={{ color: script.forcedLayoutMs > 4 ? '#ffc857' : undefined }}>{fmt(script.forcedLayoutMs)}</span>,
        ])}
      />
    </>
  )
}

function ProcsTab({ snapshot }: { snapshot: PerfSnapshot }) {
  const main = snapshot.main
  if (!main) {
    return <div style={{ padding: '8px 10px', color: '#75757e' }}>Waiting for the main-process sampler…</div>
  }
  return (
    <>
      <div style={{ padding: '4px 10px', color: '#8d8d96' }}>
        loop mean <span style={{ color: severity(main.eventLoop.meanMs, 10, 50) }}>{main.eventLoop.meanMs} ms</span>
        {' · '}max {main.eventLoop.maxMs} ms
        {' · '}heap {main.heap.heapUsedMb} MB
        {main.heap.gcMsPerSec !== null && ` · gc ${main.heap.gcMsPerSec} ms/s`}
        {' · '}sampler {main.selfMs} ms
      </div>
      <Table
        head={['Process', 'PID', 'CPU %', 'RSS MB']}
        rows={main.processes.slice(0, ROWS).map((proc) => [
          proc.label,
          proc.pid,
          <span style={{ color: severity(proc.cpuPercent, 30, 70) }}>{fmt(proc.cpuPercent)}</span>,
          proc.rssMb.toFixed(0),
        ])}
      />
    </>
  )
}

export function PerfOverlay() {
  const snapshot = useSyncExternalStore(subscribeToPerf, getPerfSnapshot)
  const [tab, setTab] = useState<Tab>('components')
  const [expanded, setExpanded] = useState(true)
  const [copied, setCopied] = useState(false)

  const copyReport = useCallback(() => {
    void navigator.clipboard.writeText(buildPerfReport(getPerfHistory())).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      },
      () => setCopied(false),
    )
  }, [])

  if (!snapshot.enabled) return null

  const { smoothed, frames, commits } = snapshot
  const monitorCostPercent = (commits.trackerSelfMs / Math.max(1, snapshot.windowMs)) * 100

  return (
    <div style={{ ...shell, width: expanded ? 560 : 'auto' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '5px 8px',
          background: 'rgba(255,255,255,0.04)',
          cursor: 'pointer',
        }}
        onClick={() => setExpanded((value) => !value)}
      >
        <span style={{ color: severity(60 - (smoothed.fps ?? 60), 15, 30) }}>
          {/* windowMs 0 is the priming snapshot published on toggle — no frames
              have been counted yet, which is not the same as an occluded window. */}
          {snapshot.windowMs === 0 ? '—' : smoothed.fps === null ? 'hidden' : `${smoothed.fps.toFixed(0)} fps`}
        </span>
        <span style={{ color: severity(smoothed.renderSelfMsPerSec, 50, 150) }}>
          react {smoothed.renderSelfMsPerSec.toFixed(0)} ms/s
        </span>
        <span style={{ color: '#8d8d96' }}>{smoothed.commitsPerSec.toFixed(0)} commits/s</span>
        <span style={{ color: severity(smoothed.longTaskMsPerSec, 100, 300) }}>
          block {smoothed.longTaskMsPerSec.toFixed(0)} ms/s
        </span>
        {smoothed.rendererCpuPercent !== null && (
          <span style={{ color: severity(smoothed.rendererCpuPercent, 30, 70) }}>
            cpu {smoothed.rendererCpuPercent.toFixed(0)}%
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button
            type="button"
            style={{ background: 'none', border: 'none', color: copied ? '#7ddf9a' : '#8d8d96', cursor: 'pointer', font: 'inherit' }}
            onClick={(event) => {
              event.stopPropagation()
              copyReport()
            }}
          >
            {copied ? 'copied' : 'copy report'}
          </button>
          <button
            type="button"
            style={{ background: 'none', border: 'none', color: '#8d8d96', cursor: 'pointer', font: 'inherit' }}
            onClick={(event) => {
              event.stopPropagation()
              setPerfEnabled(false)
            }}
          >
            ×
          </button>
        </span>
      </div>

      {expanded && (
        <>
          <div style={{ display: 'flex', gap: 2, padding: '4px 6px', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setTab(entry.id)}
                style={{
                  background: tab === entry.id ? 'rgba(255,255,255,0.12)' : 'none',
                  border: 'none',
                  borderRadius: 4,
                  color: tab === entry.id ? '#f2f2f2' : '#8d8d96',
                  cursor: 'pointer',
                  font: 'inherit',
                  padding: '1px 8px',
                }}
              >
                {entry.label}
              </button>
            ))}
          </div>

          <div style={{ maxHeight: 320, overflowY: 'auto', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
            {tab === 'components' && <ComponentsTab snapshot={snapshot} />}
            {tab === 'interactions' && <InteractionsTab snapshot={snapshot} />}
            {tab === 'rpc' && <RpcTab snapshot={snapshot} />}
            {tab === 'jank' && <JankTab snapshot={snapshot} />}
            {tab === 'procs' && <ProcsTab snapshot={snapshot} />}
          </div>

          <div style={{ padding: '3px 10px', color: '#5f5f68', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
            {commits.renderedFibers} fibers rendered / {commits.visitedFibers} walked
            {' · '}dom {frames.domNodes}
            {frames.heapUsedMb !== null && ` · heap ${frames.heapUsedMb} MB`}
            {' · '}monitor {monitorCostPercent.toFixed(2)}%
            {snapshot.discontinuity && ' · clock jump (window discarded)'}
          </div>
        </>
      )}
    </div>
  )
}
