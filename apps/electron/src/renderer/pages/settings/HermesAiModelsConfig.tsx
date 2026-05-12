import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, Loader2, Save, Search } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  SettingsCard,
  SettingsCardContent,
  SettingsRow,
  SettingsSection,
} from '@/components/settings'

import openaiIcon from '@/assets/provider-icons/openai.svg'
import claudeIcon from '@/assets/provider-icons/claude.svg'
import openrouterIcon from '@/assets/provider-icons/openrouter.svg'
import googleIcon from '@/assets/provider-icons/google.svg'
import zaiIcon from '@/assets/provider-icons/zai.svg'
import kimiIcon from '@/assets/provider-icons/kimi.svg'
import ollamaIcon from '@/assets/provider-icons/ollama.svg'

/**
 * Provider catalog mirrored from the Hermes dashboard's "Set Main Model"
 * dialog. Keep this list aligned with the Hermes provider plugins. Auth
 * type describes what Craft connection/credential the embedded runtime consumes.
 */
type ProviderDef = {
  id: string
  name: string
  description: string
  icon: string
  authType: 'oauth' | 'api_key' | 'none' | 'custom'
  envKey?: string
  placeholder?: string
  helpText?: string
  helpUrl?: string
  recommended?: boolean
  popular?: boolean
}

const PROVIDERS: ProviderDef[] = [
  {
    id: 'openai-codex',
    name: 'OpenAI Codex',
    description: 'Free via ChatGPT Pro',
    icon: openaiIcon,
    authType: 'oauth',
    helpText: 'Usa a conexão ChatGPT Plus/Codex já autenticada no Craft. O auth-bridge propaga o token ao Hermes na inicialização.',
    popular: true,
  },
  {
    id: 'cliproxy',
    name: 'CLIProxy',
    description: 'Local proxy — Claude/Gemini/Codex',
    icon: claudeIcon,
    authType: 'custom',
    placeholder: 'http://127.0.0.1:8317/v1',
    helpText: 'Usa o CLIProxyAPI local configurado no Hermes. Os modelos são carregados dinamicamente de /v1/models.',
    recommended: true,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'API key required',
    icon: claudeIcon,
    authType: 'api_key',
    envKey: 'ANTHROPIC_API_KEY',
    placeholder: 'sk-ant-...',
    helpText: 'Console Anthropic → Settings → Keys.',
    helpUrl: 'https://console.anthropic.com/settings/keys',
    recommended: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'API key required',
    icon: openrouterIcon,
    authType: 'api_key',
    envKey: 'OPENROUTER_API_KEY',
    placeholder: 'sk-or-...',
    helpUrl: 'https://openrouter.ai/keys',
    popular: true,
  },
  {
    id: 'google',
    name: 'Google AI Studio',
    description: 'API key required',
    icon: googleIcon,
    authType: 'api_key',
    envKey: 'GEMINI_API_KEY',
    placeholder: 'AIza...',
    helpUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    description: 'API key required',
    icon: openaiIcon,
    authType: 'api_key',
    envKey: 'XAI_API_KEY',
    placeholder: 'xai-...',
    helpUrl: 'https://x.ai/api',
  },
  {
    id: 'zai',
    name: 'z.AI (GLM)',
    description: 'API key required',
    icon: zaiIcon,
    authType: 'api_key',
    envKey: 'ZAI_API_KEY',
    placeholder: 'sk-...',
  },
  {
    id: 'kimi-coding',
    name: 'Kimi (Coding)',
    description: 'API key required',
    icon: kimiIcon,
    authType: 'api_key',
    envKey: 'KIMI_API_KEY',
    placeholder: 'sk-...',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    description: 'Local — no API key',
    icon: ollamaIcon,
    authType: 'custom',
    placeholder: 'http://127.0.0.1:11434',
  },
]

interface ApiConfigShape {
  activeProvider?: string | null
  activeModel?: string | null
  hasApiKeys?: Record<string, boolean>
  providers?: Array<{ id?: string; envVar?: string; configured?: boolean }>
  config?: Record<string, unknown>
}

function getProviderById(id: string | null): ProviderDef | null {
  if (!id) return null
  return PROVIDERS.find(p => p.id === id) ?? null
}

export function HermesAiModelsConfig() {
  const [config, setConfig] = useState<ApiConfigShape | null>(null)
  const [selectedProvider, setSelectedProvider] = useState<string>('')
  const [baseUrl, setBaseUrl] = useState<string>('')
  const [models, setModels] = useState<string[]>([])
  const [selectedModel, setSelectedModel] = useState<string>('')
  const [loadingConfig, setLoadingConfig] = useState(true)
  const [loadingModels, setLoadingModels] = useState(false)
  const [savingProvider, setSavingProvider] = useState(false)
  const [savingModel, setSavingModel] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const provider = useMemo(() => getProviderById(selectedProvider || null), [selectedProvider])

  const loadConfig = useCallback(async () => {
    setLoadingConfig(true)
    setError(null)
    try {
      const result = await window.electronAPI.getHermesApiConfig()
      if (!result.success) {
        setError(result.error)
        return
      }
      const data = (result.data ?? {}) as ApiConfigShape
      setConfig(data)
      const initialProvider = (data.activeProvider as string | undefined) || PROVIDERS[0]!.id
      setSelectedProvider(initialProvider)
      setSelectedModel((data.activeModel as string | undefined) || '')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingConfig(false)
    }
  }, [])

  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

  const loadModels = useCallback(async (providerId: string) => {
    if (!providerId) return
    setLoadingModels(true)
    setError(null)
    try {
      const result = await window.electronAPI.getHermesProviderModels(providerId)
      if (!result.success) {
        setError(result.error)
        setModels([])
        return
      }
      const raw = result.data as { models?: Array<{ id?: string }> } | Array<{ id?: string }> | null
      const list = Array.isArray(raw) ? raw : (raw?.models ?? [])
      const ids = list
        .map((m: { id?: string }) => (typeof m?.id === 'string' ? m.id : null))
        .filter((id): id is string => Boolean(id))
        .slice(0, 50)
      setModels(ids)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setModels([])
    } finally {
      setLoadingModels(false)
    }
  }, [])

  useEffect(() => {
    if (!selectedProvider) return
    void loadModels(selectedProvider)
  }, [loadModels, selectedProvider])

  const handleProviderChange = (id: string) => {
    setSelectedProvider(id)
    setBaseUrl('')
    if (config?.activeProvider !== id) {
      setSelectedModel('')
    }
  }

  const handleSaveProvider = async () => {
    if (!provider) return
    setSavingProvider(true)
    setError(null)
    try {
      const body: { config: Record<string, unknown>; env?: Record<string, string> } = {
        config: { provider: provider.id },
      }
      if ((provider.id === 'ollama' || provider.authType === 'custom') && baseUrl.trim()) {
        body.config.base_url = baseUrl.trim()
      }
      const result = await window.electronAPI.patchHermesApiConfig(body)
      if (!result.success) {
        setError(result.error)
        toast.error('Falha ao salvar provider', { description: result.error })
        return
      }
      toast.success(`Provider ${provider.name} salvo`)
      await loadConfig()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      toast.error('Falha ao salvar provider', { description: msg })
    } finally {
      setSavingProvider(false)
    }
  }

  const handleSaveModel = async (modelId: string) => {
    if (!provider) return
    setSavingModel(true)
    setError(null)
    try {
      const result = await window.electronAPI.patchHermesApiConfig({
        config: { provider: provider.id, model: modelId },
      })
      if (!result.success) {
        setError(result.error)
        toast.error('Falha ao salvar modelo', { description: result.error })
        return
      }
      setSelectedModel(modelId)
      toast.success(`Modelo ${modelId} salvo`)
      await loadConfig()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      toast.error('Falha ao salvar modelo', { description: msg })
    } finally {
      setSavingModel(false)
    }
  }

  const isCurrentProvider = config?.activeProvider === selectedProvider
  const apiKeyAlreadyConfigured =
    provider?.envKey && (config?.hasApiKeys?.[provider.envKey] ?? false)

  const activeProviderDef = useMemo(
    () => getProviderById(config?.activeProvider ?? null) ?? provider,
    [config?.activeProvider, provider],
  )

  return (
    <SettingsSection title="Provider & Modelo">
      <SettingsCard>
        <SettingsCardContent className="space-y-4">
          {loadingConfig ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Carregando configuração do Hermes…
            </div>
          ) : (
            <>
              <StatusBar
                modeLabel="Hermes embedded"
                providerDef={activeProviderDef}
                modelLabel={config?.activeModel || '—'}
                providerConfigured={Boolean(apiKeyAlreadyConfigured) || provider?.authType === 'oauth'}
              />

              <div className="grid gap-3 md:grid-cols-2">
                <ProviderField
                  selected={provider}
                  onSelect={handleProviderChange}
                  disabled={savingProvider || loadingConfig}
                />
                <ModelField
                  models={models}
                  selectedModel={selectedModel}
                  onSelect={(m) => void handleSaveModel(m)}
                  disabled={!provider || loadingModels || savingModel}
                  loading={loadingModels}
                />
              </div>

              {provider?.authType === 'api_key' && (
                <div className="rounded-xl border border-border/60 p-3 space-y-1">
                  <div className="text-xs font-medium">
                    {apiKeyAlreadyConfigured ? 'Provider connected' : 'Credencial não detectada'}
                  </div>
                  <div className="text-[11px] text-muted-foreground leading-relaxed">
                    {apiKeyAlreadyConfigured
                      ? `Usando conexão/credencial do Craft para ${provider.name} (${provider.envKey}). API keys ficam no gerenciador do Craft.`
                      : `Configure ${provider.name} em Settings → AI Connections; o Hermes recebe a chave automaticamente.`}
                  </div>
                  {provider.helpUrl && (
                    <a
                      href={provider.helpUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] text-primary hover:underline inline-block pt-1"
                    >
                      Abrir console do provider ↗
                    </a>
                  )}
                </div>
              )}

              {provider?.authType === 'oauth' && (
                <div className="rounded-xl border border-border/60 p-3 space-y-1">
                  <div className="text-xs font-medium">Provider connected</div>
                  <div className="text-[11px] text-muted-foreground leading-relaxed">
                    {provider.id === 'openai-codex'
                      ? 'Usando sua conexão ChatGPT Pro/Codex via auth-bridge. Reautentique no Craft se falhar.'
                      : 'OAuth herdado da conexão Craft.'}
                  </div>
                </div>
              )}

              {(provider?.authType === 'custom' || provider?.id === 'ollama') && (
                <SettingsRow label="Base URL" description={provider.helpText}>
                  <input
                    type="text"
                    className="bg-background border border-border rounded-md text-sm px-2 py-1 min-w-[280px] font-mono"
                    placeholder={provider.placeholder}
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                  />
                </SettingsRow>
              )}

              <div className="flex items-center gap-2 pt-1">
                <Button size="sm" onClick={handleSaveProvider} disabled={savingProvider || !provider}>
                  {savingProvider ? <Loader2 className="size-3.5 mr-1.5 animate-spin" /> : <Save className="size-3.5 mr-1.5" />}
                  {isCurrentProvider ? 'Atualizar provider' : 'Ativar provider'}
                </Button>
              </div>

              {error && (
                <div className="text-xs text-red-500 bg-red-500/10 rounded-md p-2 border border-red-500/30">
                  {error}
                </div>
              )}
            </>
          )}
        </SettingsCardContent>
      </SettingsCard>
    </SettingsSection>
  )
}

function ProviderBadge({ provider }: { provider: ProviderDef }) {
  if (provider.recommended) {
    return (
      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-500">
        Recommended
      </span>
    )
  }
  if (provider.popular) {
    return (
      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-violet-500/15 text-violet-400">
        Popular
      </span>
    )
  }
  return null
}

function StatusBar({
  modeLabel,
  providerDef,
  modelLabel,
  providerConfigured,
}: {
  modeLabel: string
  providerDef: ProviderDef | null
  modelLabel: string
  providerConfigured: boolean
}) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-px rounded-xl overflow-hidden border border-border/60 bg-border/40">
      <Cell label="Mode" value={modeLabel} />
      <Cell
        label="Provider"
        value={providerDef?.name ?? '—'}
        leading={providerDef && <img src={providerDef.icon} alt="" className="size-4" />}
      />
      <Cell label="Model" value={modelLabel} mono />
      <Cell
        label="Auth"
        value={providerConfigured ? 'Connected' : 'Not configured'}
        valueClassName={providerConfigured ? 'text-emerald-500' : 'text-muted-foreground'}
      />
    </div>
  )
}

function Cell({
  label,
  value,
  leading,
  mono,
  valueClassName,
}: {
  label: string
  value: string
  leading?: React.ReactNode
  mono?: boolean
  valueClassName?: string
}) {
  return (
    <div className="bg-background px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`flex items-center gap-1.5 mt-0.5 text-sm ${mono ? 'font-mono text-xs' : 'font-medium'} ${valueClassName ?? ''}`}>
        {leading}
        <span className="truncate">{value}</span>
      </div>
    </div>
  )
}

function ProviderField({
  selected,
  onSelect,
  disabled,
}: {
  selected: ProviderDef | null
  onSelect: (id: string) => void
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium text-muted-foreground">Provider</div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-background border border-border/60 hover:border-border transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {selected ? (
              <>
                <img src={selected.icon} alt="" className="size-5" />
                <span className="text-sm font-medium truncate">{selected.name}</span>
                <ProviderBadge provider={selected} />
              </>
            ) : (
              <span className="text-sm text-muted-foreground">Selecione…</span>
            )}
            <ChevronDown className="size-4 text-muted-foreground ml-auto" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[--radix-popover-trigger-width] p-1"
          style={{ width: 'var(--radix-popover-trigger-width)' }}
        >
          <div className="max-h-[320px] overflow-y-auto">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => { onSelect(p.id); setOpen(false) }}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left hover:bg-muted/60 ${
                  selected?.id === p.id ? 'bg-muted/40' : ''
                }`}
              >
                <img src={p.icon} alt="" className="size-5" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium truncate">{p.name}</span>
                    <ProviderBadge provider={p} />
                  </div>
                  <div className="text-[10px] text-muted-foreground truncate">{p.description}</div>
                </div>
                {selected?.id === p.id && <Check className="size-3.5 text-primary" />}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}

function ModelField({
  models,
  selectedModel,
  onSelect,
  disabled,
  loading,
}: {
  models: string[]
  selectedModel: string
  onSelect: (id: string) => void
  disabled: boolean
  loading: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    if (!query.trim()) return models
    const q = query.toLowerCase()
    return models.filter(m => m.toLowerCase().includes(q))
  }, [models, query])

  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium text-muted-foreground">Model</div>
      <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery('') }}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-background border border-border/60 hover:border-border transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span className={`text-sm flex-1 text-left truncate ${selectedModel ? 'font-mono text-xs' : 'text-muted-foreground'}`}>
              {loading ? 'Carregando…' : selectedModel || (models.length === 0 ? 'Sem modelos' : 'Selecione…')}
            </span>
            <ChevronDown className="size-4 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[--radix-popover-trigger-width] p-1"
          style={{ width: 'var(--radix-popover-trigger-width)' }}
        >
          <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border/40 mb-1">
            <Search className="size-3.5 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              autoFocus
            />
          </div>
          <div className="max-h-[280px] overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted-foreground text-center">Nenhum modelo</div>
            ) : (
              filtered.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => { onSelect(m); setOpen(false) }}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left font-mono text-xs hover:bg-muted/60 ${
                    selectedModel === m ? 'bg-muted/40' : ''
                  }`}
                >
                  <span className="flex-1 truncate">{m}</span>
                  {selectedModel === m && <Check className="size-3.5 text-primary" />}
                </button>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
