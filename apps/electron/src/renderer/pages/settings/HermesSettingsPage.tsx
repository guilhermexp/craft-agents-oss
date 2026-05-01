import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, FileText, FolderOpen, PlugZap, RefreshCw, ScrollText, Wrench } from 'lucide-react'
import { toast } from 'sonner'
import { Spinner } from '@craft-agent/ui'

import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  SettingsCard,
  SettingsCardContent,
  SettingsRow,
  SettingsSection,
} from '@/components/settings'
import { HermesAiModelsConfig } from './HermesAiModelsConfig'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type {
  HermesHomeFileInfo,
  HermesLogFileInfo,
  HermesRuntimeDetailsResult,
  HermesSkillInfo,
} from '@craft-agent/shared/protocol'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'hermes',
}

function formatBytes(size?: number): string {
  if (size === undefined) return '—'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(ms?: number): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString()
}

function formatHermesReleaseDate(runtime?: HermesRuntimeDetailsResult | null): string | undefined {
  const tag = runtime?.sourceRepoReleaseTag?.trim()
  const versionDate = tag?.match(/^v?(\d{4})\.(\d{1,2})\.(\d{1,2})$/)
  if (versionDate) return `${versionDate[1]}.${versionDate[2]}.${versionDate[3]}`

  const commitDate = runtime?.sourceRepoCommitDate?.trim()
  if (!commitDate) return undefined
  const parsed = commitDate.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!parsed) return commitDate
  return `${parsed[1]}.${Number(parsed[2])}.${Number(parsed[3])}`
}

function formatHermesVersionLine(runtime?: HermesRuntimeDetailsResult | null): string {
  const version = runtime?.version?.trim()
  const releaseDate = formatHermesReleaseDate(runtime)
  const origin = runtime?.sourceRepoRemote?.includes('guilhermexp/hermes-agent')
    ? 'fork'
    : runtime?.sourceRepoRemote?.includes('NousResearch/hermes-agent')
      ? 'upstream'
      : runtime?.runtimeSource === 'bundled'
        ? 'bundled'
        : 'system'
  const upstream = runtime?.sourceRepoUpstreamRemote ? 'upstream synced' : origin
  const commit = runtime?.sourceRepoCommit ? ` · ${runtime.sourceRepoCommit}${runtime.sourceRepoDirty ? '+dirty' : ''}` : ''
  const label = version ? `Hermes Agent v${version}` : 'Hermes Agent'
  return `${label}${releaseDate ? ` (${releaseDate})` : ''} · ${upstream}${commit}`
}

function renderFileTree(files: HermesHomeFileInfo[], openPath: (path?: string) => void, level = 0) {
  return files.map((file) => (
    <div key={file.relativePath}>
      <button
        type="button"
        className="w-full grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-2 py-1 rounded-md hover:bg-muted/60 text-left"
        style={{ paddingLeft: 8 + level * 14 }}
        onClick={() => openPath(file.relativePath)}
      >
        <span className="min-w-0 flex items-center gap-2 text-xs leading-5">
          {file.type === 'directory' ? <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" /> : <FileText className="h-3.5 w-3.5 text-muted-foreground" />}
          <span className="truncate">{file.name}</span>
        </span>
        <span className="text-[11px] text-muted-foreground shrink-0">{file.type === 'file' ? formatBytes(file.size) : 'pasta'}</span>
      </button>
      {file.children && file.children.length > 0 && renderFileTree(file.children, openPath, level + 1)}
    </div>
  ))
}

export default function HermesSettingsPage() {
  const { t } = useTranslation()
  const [runtime, setRuntime] = useState<HermesRuntimeDetailsResult | null>(null)
  const [logs, setLogs] = useState<HermesLogFileInfo[]>([])
  const [files, setFiles] = useState<HermesHomeFileInfo[]>([])
  const [skills, setSkills] = useState<HermesSkillInfo[]>([])
  const [selectedLogName, setSelectedLogName] = useState<string | null>(null)
  const [selectedLogContent, setSelectedLogContent] = useState<string>('')
  const [isLoading, setIsLoading] = useState(true)
  const [isOpeningDashboard, setIsOpeningDashboard] = useState(false)

  const connectors = useMemo(() => {
    const builtin = runtime?.providers ?? []
    const custom = runtime?.customProviders ?? []
    return { builtin, custom }
  }, [runtime])

  const loadHermes = useCallback(async () => {
    setIsLoading(true)
    try {
      const [runtimeDetails, logsResult, filesResult, skillsResult] = await Promise.all([
        window.electronAPI.getHermesRuntimeDetails(),
        window.electronAPI.listHermesLogs(),
        window.electronAPI.listHermesHomeFiles(),
        window.electronAPI.listHermesSkills(),
      ])
      setRuntime(runtimeDetails)
      setLogs(logsResult.files)
      setFiles(filesResult.files)
      setSkills(skillsResult.skills)
      if (!logsResult.success && logsResult.error) toast.error('Falha ao listar logs do Hermes', { description: logsResult.error })
      if (!filesResult.success && filesResult.error) toast.error('Falha ao listar arquivos do Hermes', { description: filesResult.error })
      if (!skillsResult.success && skillsResult.error) toast.error('Falha ao listar skills do Hermes', { description: skillsResult.error })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error('Falha ao carregar Hermes', { description: message })
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadHermes()
  }, [loadHermes])

  const openHermesPath = useCallback(async (target?: string) => {
    const result = await window.electronAPI.openHermesPath(target)
    if (!result.success) toast.error('Não foi possível abrir caminho do Hermes', { description: result.error })
  }, [])

  const revealAbsolutePath = useCallback(async (path?: string) => {
    if (!path) return
    try {
      await window.electronAPI.showInFolder(path)
    } catch (error) {
      toast.error('Não foi possível abrir caminho', { description: error instanceof Error ? error.message : String(error) })
    }
  }, [])

  const openSkillPath = useCallback((skill: HermesSkillInfo) => {
    if (skill.source === 'home') {
      void openHermesPath(`skills/${skill.relativePath ?? skill.name}`)
      return
    }
    void revealAbsolutePath(skill.path)
  }, [openHermesPath, revealAbsolutePath])

  const openBundledSkillsPath = useCallback(() => {
    if (runtime?.agentRoot) {
      void revealAbsolutePath(`${runtime.agentRoot}/skills`)
      return
    }
    void openHermesPath('skills')
  }, [openHermesPath, revealAbsolutePath, runtime?.agentRoot])

  const openDashboard = useCallback(async () => {
    setIsOpeningDashboard(true)
    try {
      const dashboard = await window.electronAPI.startHermesDashboard()
      if (!dashboard.success || !dashboard.url) {
        toast.error('Dashboard Hermes não abriu', { description: dashboard.error })
        return
      }

      const browserPane = window.electronAPI.browserPane
      if (browserPane?.create) {
        const instanceId = await browserPane.create({ show: true, url: dashboard.url })
        await browserPane.focus(instanceId)
      } else {
        await window.electronAPI.openUrl(dashboard.url)
      }
      toast.success('Dashboard Hermes aberto')
      await loadHermes()
    } catch (error) {
      toast.error('Dashboard Hermes não abriu', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setIsOpeningDashboard(false)
    }
  }, [loadHermes])

  const readLog = useCallback(async (name: string) => {
    setSelectedLogName(name)
    const result = await window.electronAPI.readHermesLog(name)
    if (!result.success) {
      setSelectedLogContent('')
      toast.error('Falha ao ler log Hermes', { description: result.error })
      return
    }
    setSelectedLogContent(`${result.truncated ? '[conteúdo truncado para as últimas linhas]\n\n' : ''}${result.content ?? ''}`)
  }, [])

  if (isLoading && !runtime) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <PanelHeader title={t('settings.hermes.title', 'Hermes')} />
      <ScrollArea className="flex-1">
        <div className="px-5 py-7 max-w-4xl mx-auto space-y-5">
          <SettingsSection title="Runtime Hermes">
            <SettingsCard>
              <SettingsRow label="Status" description={runtime?.found ? 'Runtime detectado e pronto para sessões ACP.' : runtime?.error ?? 'Runtime não detectado'}>
                <span className={`text-xs font-medium ${runtime?.found ? 'text-emerald-500' : 'text-destructive'}`}>
                  {runtime?.found ? 'Ativo' : 'Indisponível'}
                </span>
              </SettingsRow>
              <SettingsRow label="Versão" description={formatHermesVersionLine(runtime)}>
                <span className="text-[11px] text-muted-foreground">
                  {runtime?.sourceRepoReleaseTag ?? runtime?.sourceRepoCommitDate ?? 'sem tag'}
                </span>
              </SettingsRow>
              <SettingsRow label="Origem" description={runtime?.runtimeSource === 'bundled' ? 'Runtime embutido do Craft' : 'CLI do sistema'}>
                <code className="text-[11px] text-muted-foreground max-w-[260px] truncate">{runtime?.resolvedCommand ?? runtime?.command}</code>
              </SettingsRow>
              <SettingsRow label="Agent root" description="Código Python do Hermes que o Craft está carregando via ACP.">
                <button type="button" className="text-[11px] text-muted-foreground max-w-[260px] truncate hover:text-foreground" onClick={() => revealAbsolutePath(runtime?.agentRoot)}>
                  {runtime?.agentRoot ?? 'não publicado'}
                </button>
              </SettingsRow>
              <SettingsRow label="Repo Hermes" description={runtime?.sourceRepoRemote ?? 'Repo source usado pelo dashboard em modo dev'}>
                <button type="button" className="text-[11px] text-muted-foreground max-w-[260px] truncate hover:text-foreground" onClick={() => revealAbsolutePath(runtime?.sourceRepoPath)}>
                  {runtime?.sourceRepoCommit ? `${runtime.sourceRepoCommit}${runtime.sourceRepoDirty ? ' + dirty' : ''}` : (runtime?.sourceRepoPath ?? 'não encontrado')}
                </button>
              </SettingsRow>
              <SettingsRow label="HERMES_HOME" description="Config, memória, logs, skills e sessões isolados do app.">
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => openHermesPath()}>
                  <FolderOpen className="h-3.5 w-3.5 mr-1.5" /> Abrir
                </Button>
              </SettingsRow>
              <SettingsRow label="Config" description={runtime?.configExists ? runtime.configPath : 'config.yaml ainda não existe no home isolado'}>
                <span className="text-xs text-muted-foreground">{runtime?.configExists ? 'ok' : 'ausente'}</span>
              </SettingsRow>
            </SettingsCard>
            <div className="flex flex-wrap gap-2 pt-2">
              <Button size="sm" onClick={openDashboard} disabled={isOpeningDashboard}>
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" /> Abrir Dashboard Hermes
              </Button>
              <Button size="sm" variant="ghost" onClick={loadHermes}>
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Recarregar
              </Button>
            </div>
          </SettingsSection>

          <HermesAiModelsConfig />

          <SettingsSection title="Modelo & fallback do Hermes">
            <SettingsCard>
              <SettingsCardContent className="space-y-3">
                <div className="text-xs text-muted-foreground leading-relaxed">
                  Lido em tempo real de <code className="px-1 rounded bg-muted/60">{runtime?.configPath ?? '~/.hermes/config.yaml'}</code>.
                  Edite no Dashboard Hermes — Craft envia overrides por sessão via ACP <code className="px-1 rounded bg-muted/60">set_model</code>,
                  mas estes são os defaults que o runtime usa quando não há override e a chain que ele tenta em fallback automático.
                </div>
                <SettingsRow label="Modelo principal" description="config.yaml › model.default + model.provider">
                  <div className="text-xs">
                    {runtime?.defaultModel ? (
                      <>
                        <span className="font-medium">{runtime.defaultModel}</span>
                        {runtime.defaultProvider && (
                          <span className="text-muted-foreground"> · {runtime.defaultProvider}</span>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">não definido</span>
                    )}
                  </div>
                </SettingsRow>
                <SettingsRow label="Modelo de fallback" description="config.yaml › fallback_model">
                  <div className="text-xs">
                    {runtime?.fallbackModel ? (
                      <span className="font-medium">{runtime.fallbackModel}</span>
                    ) : (
                      <span className="text-muted-foreground">não definido</span>
                    )}
                  </div>
                </SettingsRow>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                    Cadeia de fallback de providers
                  </div>
                  <div className="text-xs text-muted-foreground mb-2">
                    Ordem que o Hermes tenta automaticamente quando o provider primário falha (config.yaml › fallback_providers).
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {(runtime?.fallbackProviders ?? []).length === 0 ? (
                      <span className="text-xs text-muted-foreground">vazio — sem fallback configurado</span>
                    ) : (
                      runtime!.fallbackProviders!.map((provider, idx) => (
                        <span key={`${provider}-${idx}`} className="flex items-center gap-1">
                          <span className="px-2 py-1 rounded-md bg-muted text-xs">{provider}</span>
                          {idx < runtime!.fallbackProviders!.length - 1 && (
                            <span className="text-muted-foreground text-xs">→</span>
                          )}
                        </span>
                      ))
                    )}
                  </div>
                </div>
              </SettingsCardContent>
            </SettingsCard>
          </SettingsSection>

          <SettingsSection title="Conectores do Hermes">
            <SettingsCard>
              <SettingsCardContent className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <PlugZap className="h-4 w-4" /> Providers, plugins e modelos do repo/config Hermes
                </div>
                <div className="space-y-3">
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Configurados</div>
                    <div className="flex flex-wrap gap-2">
                      {connectors.builtin.length === 0 && connectors.custom.length === 0 ? (
                        <span className="text-xs text-muted-foreground">Nenhum provider configurado ainda no HERMES_HOME. Configure pelo Dashboard Hermes.</span>
                      ) : (
                        <>
                          {connectors.builtin.map((provider) => (
                            <span key={provider} className="px-2 py-1 rounded-md bg-muted text-xs">{provider}</span>
                          ))}
                          {connectors.custom.map((provider) => (
                            <span key={`${provider.name}:${provider.model}`} className="px-2 py-1 rounded-md bg-muted text-xs">
                              {provider.name}:{provider.model ?? 'default'}
                            </span>
                          ))}
                        </>
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Disponíveis no repo Hermes</div>
                    <div className="flex flex-wrap gap-2">
                      {(runtime?.availableProviders ?? []).length === 0 ? (
                        <span className="text-xs text-muted-foreground">Lista de providers não encontrada no agent root.</span>
                      ) : runtime!.availableProviders!.map((provider) => (
                        <span key={provider} className="px-2 py-1 rounded-md bg-muted/70 text-xs">{provider}</span>
                      ))}
                    </div>
                  </div>
                  {(runtime?.pluginNames ?? []).length > 0 && (
                    <div>
                      <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Plugins</div>
                      <div className="flex flex-wrap gap-2">
                        {runtime!.pluginNames!.map((plugin) => (
                          <span key={plugin} className="px-2 py-1 rounded-md bg-muted/70 text-xs">{plugin}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </SettingsCardContent>
            </SettingsCard>
          </SettingsSection>

          <SettingsSection title="Skills do Hermes">
            <SettingsCard>
              <SettingsCardContent className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-medium"><Wrench className="h-4 w-4" /> {skills.length} skill(s) do repo/runtime</div>
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={openBundledSkillsPath}>Abrir pasta</Button>
                </div>
                {skills.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Nenhuma skill encontrada no HERMES_HOME nem no agent root.</p>
                ) : (
                  <div className="max-h-56 overflow-auto rounded-lg border border-border/60 p-1">
                    {skills.map((skill) => (
                      <button key={skill.path} type="button" className="w-full text-left px-2 py-1 rounded-md hover:bg-muted/60" onClick={() => openSkillPath(skill)}>
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-xs font-medium leading-5">{skill.name}</span>
                          <span className="shrink-0 text-[10px] text-muted-foreground">{skill.source ?? 'home'}</span>
                        </div>
                        {skill.description && <div className="text-[11px] leading-4 text-muted-foreground truncate">{skill.description}</div>}
                      </button>
                    ))}
                  </div>
                )}
              </SettingsCardContent>
            </SettingsCard>
          </SettingsSection>

          <SettingsSection title="Logs">
            <SettingsCard>
              <SettingsCardContent className="grid gap-3 md:grid-cols-[260px_1fr]">
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2 text-sm font-medium"><ScrollText className="h-4 w-4" /> Ver logs</div>
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => openHermesPath('logs')}>Pasta</Button>
                  </div>
                  {logs.length === 0 ? (
                    <p className="text-xs text-muted-foreground">Nenhum log encontrado.</p>
                  ) : logs.map((log) => (
                    <button key={log.path} type="button" onClick={() => readLog(log.name)} className={`w-full text-left px-2 py-1.5 rounded-md text-xs hover:bg-muted/60 ${selectedLogName === log.name ? 'bg-muted' : ''}`}>
                      <div className="font-medium truncate">{log.name}</div>
                      <div className="text-[11px] text-muted-foreground">{formatBytes(log.size)} · {formatDate(log.modifiedAt)}</div>
                    </button>
                  ))}
                </div>
                <pre className="min-h-[180px] max-h-[360px] overflow-auto rounded-lg bg-muted/50 p-3 text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
                  {selectedLogContent || 'Selecione um log para visualizar.'}
                </pre>
              </SettingsCardContent>
            </SettingsCard>
          </SettingsSection>

          <SettingsSection title="HERMES_HOME">
            <SettingsCard>
              <SettingsCardContent className="space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 text-xs leading-5 text-muted-foreground">
                    Listagem compacta do home isolado. Sessões, logs e skills ficam em userData e não entram no release/git; secrets são omitidos.
                  </p>
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => openHermesPath()}>Abrir home</Button>
                </div>
                <div className="max-h-56 overflow-auto rounded-lg border border-border/60 p-1">
                  {files.length === 0 ? <p className="px-2 py-2 text-xs text-muted-foreground">Sem arquivos listados.</p> : renderFileTree(files, openHermesPath)}
                </div>
              </SettingsCardContent>
            </SettingsCard>
          </SettingsSection>
        </div>
      </ScrollArea>
    </div>
  )
}
