import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpen, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  SettingsCard,
  SettingsCardContent,
  SettingsSection,
} from '@/components/settings'
import type { HermesLogFileInfo } from '@craft-agent/shared/protocol'

const LEVEL_OPTIONS = [
  { value: 'ALL', label: 'All levels' },
  { value: 'DEBUG', label: 'Debug' },
  { value: 'INFO', label: 'Info' },
  { value: 'WARNING', label: 'Warning' },
  { value: 'ERROR', label: 'Error' },
] as const

const COMPONENT_OPTIONS = [
  { value: 'all', label: 'All components' },
  { value: 'gateway', label: 'Gateway' },
  { value: 'agent', label: 'Agent' },
  { value: 'tools', label: 'Tools' },
  { value: 'cli', label: 'CLI' },
  { value: 'cron', label: 'Cron' },
] as const

const LINE_COUNT_OPTIONS = [
  { value: 50, label: '50 lines' },
  { value: 100, label: '100 lines' },
  { value: 200, label: '200 lines' },
  { value: 500, label: '500 lines' },
  { value: 0, label: 'All lines' },
] as const

type Level = (typeof LEVEL_OPTIONS)[number]['value']
type Component = (typeof COMPONENT_OPTIONS)[number]['value']

function classifyLine(line: string): 'error' | 'warning' | 'debug' | 'info' {
  const u = line.toUpperCase()
  if (u.includes(' ERROR') || u.includes('CRITICAL') || u.includes('FATAL')) return 'error'
  if (u.includes(' WARNING') || u.includes(' WARN')) return 'warning'
  if (u.includes(' DEBUG')) return 'debug'
  return 'info'
}

const LINE_COLOR: Record<ReturnType<typeof classifyLine>, string> = {
  error: 'text-red-400',
  warning: 'text-amber-400',
  info: 'text-muted-foreground',
  debug: 'text-cyan-400/70',
}

function matchesLevel(line: string, level: Level): boolean {
  if (level === 'ALL') return true
  const cls = classifyLine(line)
  if (level === 'ERROR') return cls === 'error'
  if (level === 'WARNING') return cls === 'warning' || cls === 'error'
  if (level === 'INFO') return cls !== 'debug'
  return true
}

function matchesComponent(line: string, comp: Component): boolean {
  if (comp === 'all') return true
  return line.toLowerCase().includes(comp)
}

export function HermesLogsConfig({
  logs,
  onOpenFolder,
  onReadLog,
}: {
  logs: HermesLogFileInfo[]
  onOpenFolder: () => void
  onReadLog: (name: string) => Promise<{ success: boolean; content?: string; truncated?: boolean; error?: string }>
}) {
  const [selectedFile, setSelectedFile] = useState<string>('')
  const [level, setLevel] = useState<Level>('ALL')
  const [component, setComponent] = useState<Component>('all')
  const [lineCount, setLineCount] = useState<number>(100)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [content, setContent] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!selectedFile && logs.length > 0) {
      const preferred = logs.find(l => l.name.startsWith('agent')) ?? logs[0]
      if (preferred) setSelectedFile(preferred.name)
    }
  }, [logs, selectedFile])

  const loadLog = useCallback(async () => {
    if (!selectedFile) return
    setLoading(true)
    try {
      const res = await onReadLog(selectedFile)
      if (!res.success) {
        toast.error('Falha ao ler log', { description: res.error })
        setContent('')
        setTruncated(false)
        return
      }
      setContent(res.content ?? '')
      setTruncated(Boolean(res.truncated))
      setTimeout(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }, 30)
    } finally {
      setLoading(false)
    }
  }, [selectedFile, onReadLog])

  useEffect(() => { void loadLog() }, [loadLog])

  useEffect(() => {
    if (!autoRefresh) return
    const id = setInterval(() => { void loadLog() }, 5000)
    return () => clearInterval(id)
  }, [autoRefresh, loadLog])

  const lines = useMemo(() => {
    if (!content) return []
    const all = content.split(/\r?\n/)
    const filtered = all.filter(line =>
      line.length > 0 && matchesLevel(line, level) && matchesComponent(line, component),
    )
    if (lineCount === 0) return filtered
    return filtered.slice(-lineCount)
  }, [content, level, component, lineCount])

  return (
    <SettingsSection title="Logs">
      <div className="space-y-3">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <SelectFilter
            value={selectedFile}
            onChange={setSelectedFile}
            options={logs.map(l => ({ value: l.name, label: l.name }))}
            placeholder="Selecione log"
          />
          <SelectFilter
            value={level}
            onChange={(v) => setLevel(v as Level)}
            options={LEVEL_OPTIONS as readonly { value: string; label: string }[]}
          />
          <SelectFilter
            value={component}
            onChange={(v) => setComponent(v as Component)}
            options={COMPONENT_OPTIONS as readonly { value: string; label: string }[]}
          />
          <SelectFilter
            value={String(lineCount)}
            onChange={(v) => setLineCount(Number(v))}
            options={LINE_COUNT_OPTIONS.map(o => ({ value: String(o.value), label: o.label }))}
          />
        </div>

        <div className="flex items-center justify-end gap-3">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded border-border accent-primary"
            />
            Auto-refresh
          </label>
          <Button variant="outline" size="sm" onClick={() => void loadLog()} disabled={loading}>
            {loading
              ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
            Refresh
          </Button>
          <Button variant="ghost" size="sm" onClick={onOpenFolder}>
            <FolderOpen className="h-3.5 w-3.5 mr-1.5" /> Pasta
          </Button>
        </div>

        <SettingsCard>
          <SettingsCardContent className="p-0">
            <div
              ref={scrollRef}
              className="min-h-[420px] max-h-[640px] overflow-auto rounded-lg bg-background/40 p-3 font-mono text-[11px] leading-[1.6]"
            >
              {truncated && (
                <div className="text-amber-400 pb-2 border-b border-border/40 mb-2">
                  [conteúdo truncado para as últimas linhas]
                </div>
              )}
              {lines.length === 0 ? (
                <div className="text-muted-foreground py-12 text-center text-xs">
                  {loading ? 'Carregando…' : selectedFile ? 'Nenhuma linha corresponde aos filtros.' : 'Selecione um arquivo de log.'}
                </div>
              ) : (
                lines.map((line, i) => (
                  <div key={i} className={`whitespace-pre-wrap break-all ${LINE_COLOR[classifyLine(line)]}`}>
                    {line}
                  </div>
                ))
              )}
            </div>
          </SettingsCardContent>
        </SettingsCard>

        <div className="text-[11px] text-muted-foreground text-right">
          {lines.length} linha(s) exibidas
        </div>
      </div>
    </SettingsSection>
  )
}

function SelectFilter({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  options: readonly { value: string; label: string }[]
  placeholder?: string
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-3 py-2 rounded-lg bg-background border border-border/60 text-sm hover:border-border focus:outline-none focus:border-primary/60 transition"
    >
      {!value && placeholder && <option value="">{placeholder}</option>}
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  )
}
