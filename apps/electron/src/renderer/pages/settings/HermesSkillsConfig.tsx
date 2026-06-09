import { useMemo, useState } from 'react'
import { CheckCircle2, FolderOpen, Search } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  SettingsCard,
  SettingsCardContent,
  SettingsSection,
} from '@/components/settings'
import type { HermesSkillInfo } from '@craft-agent/shared/protocol'

type Tab = 'hub' | 'installed'

export function HermesSkillsConfig({
  skills,
  onOpenSkill,
  onOpenFolder,
}: {
  skills: HermesSkillInfo[]
  onOpenSkill: (skill: HermesSkillInfo) => void
  onOpenFolder: () => void
}) {
  const [tab, setTab] = useState<Tab>('installed')
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    if (!query.trim()) return skills
    const q = query.toLowerCase()
    return skills.filter(s =>
      s.name.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q),
    )
  }, [skills, query])

  return (
    <SettingsSection title="Skills do Hermes">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-muted/40">
          <button
            type="button"
            onClick={() => setTab('hub')}
            disabled
            className={`text-sm font-medium py-1.5 rounded-lg transition opacity-50 cursor-not-allowed ${
              tab === 'hub' ? 'bg-background shadow-xs' : ''
            }`}
            title="HermesHub estará disponível em uma próxima versão"
          >
            HermesHub <span className="text-[10px] text-muted-foreground ml-1">(em breve)</span>
          </button>
          <button
            type="button"
            onClick={() => setTab('installed')}
            className={`text-sm font-medium py-1.5 rounded-lg transition ${
              tab === 'installed' ? 'bg-background shadow-xs' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Instaladas
          </button>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-xl bg-muted/40 border border-border/40">
            <Search className="size-3.5 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar skills…"
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              aria-label="Buscar skills"
            />
          </div>
          <Button variant="outline" size="sm" onClick={onOpenFolder}>
            <FolderOpen className="size-3.5 mr-1.5" /> Pasta
          </Button>
        </div>

        {filtered.length === 0 ? (
          <SettingsCard>
            <SettingsCardContent>
              <p className="text-xs text-muted-foreground py-6 text-center">
                {query ? 'Nenhuma skill encontrada para esta busca.' : 'Nenhuma skill instalada no runtime Hermes.'}
              </p>
            </SettingsCardContent>
          </SettingsCard>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {filtered.map((skill) => (
              <SkillCard key={skill.path} skill={skill} onOpen={() => onOpenSkill(skill)} />
            ))}
          </div>
        )}

        <div className="text-[11px] text-muted-foreground text-center pt-1">
          {filtered.length} de {skills.length} skill(s) do repo/runtime
        </div>
      </div>
    </SettingsSection>
  )
}

function SkillCard({
  skill,
  onOpen,
}: {
  skill: HermesSkillInfo
  onOpen: () => void
}) {
  const initial = skill.name.charAt(0).toUpperCase()
  const segments = skill.name.split('/')
  const display = segments[segments.length - 1] ?? skill.name
  const category = segments.length > 1 ? segments.slice(0, -1).join('/') : null
  const isOfficial = skill.source === 'bundled' || skill.source === 'optional'

  return (
    <button
      type="button"
      onClick={onOpen}
      className="text-left rounded-xl border border-border/60 bg-muted/20 p-3 hover:bg-muted/40 hover:border-border transition flex flex-col gap-2"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="relative shrink-0">
          <div className="size-9 rounded-lg bg-muted flex items-center justify-center text-sm font-bold text-foreground/80">
            {initial}
          </div>
          {skill.installed && (
            <CheckCircle2 className="size-3.5 text-emerald-500 absolute -bottom-0.5 -right-0.5 bg-background rounded-full" />
          )}
        </div>
        <span className="shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-500">
          Instalada
        </span>
      </div>

      <div>
        {category && (
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">{category}</div>
        )}
        <div className="text-sm font-semibold leading-5 truncate">{display}</div>
      </div>

      {skill.description && (
        <div className="text-[11px] text-muted-foreground leading-4 line-clamp-2">
          {skill.description}
        </div>
      )}

      <div className="flex items-center gap-1.5 mt-auto pt-1">
        {isOfficial && (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md bg-blue-500/15 text-blue-400">
            OFFICIAL
          </span>
        )}
        <span className="text-[10px] text-muted-foreground">{skill.source ?? 'home'}</span>
      </div>
    </button>
  )
}
