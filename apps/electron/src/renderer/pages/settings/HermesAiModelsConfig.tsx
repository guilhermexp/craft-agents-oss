import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Save } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  SettingsCard,
  SettingsCardContent,
  SettingsRow,
  SettingsSection,
} from '@/components/settings'

/**
 * Provider catalog mirrored from the Hermes dashboard's "Set Main Model"
 * dialog. Keep this list aligned with the Hermes provider plugins. Auth
 * type describes what Craft connection/credential the embedded runtime consumes.
 */
type ProviderDef = {
  id: string
  name: string
  description: string
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
    description: 'ChatGPT Plus / Pro subscription',
    authType: 'oauth',
    helpText: 'Usa a conexão ChatGPT Plus/Codex já autenticada no Craft. O auth-bridge propaga o token ao Hermes na inicialização.',
    popular: true,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'API key (Claude direto)',
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
    description: 'API key — múltiplos modelos',
    authType: 'api_key',
    envKey: 'OPENROUTER_API_KEY',
    placeholder: 'sk-or-...',
    helpUrl: 'https://openrouter.ai/keys',
    popular: true,
  },
  {
    id: 'google',
    name: 'Google AI Studio',
    description: 'API key (Gemini)',
    authType: 'api_key',
    envKey: 'GEMINI_API_KEY',
    placeholder: 'AIza...',
    helpUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    description: 'API key',
    authType: 'api_key',
    envKey: 'XAI_API_KEY',
    placeholder: 'xai-...',
    helpUrl: 'https://x.ai/api',
  },
  {
    id: 'zai',
    name: 'z.AI (GLM)',
    description: 'API key',
    authType: 'api_key',
    envKey: 'ZAI_API_KEY',
    placeholder: 'sk-...',
  },
  {
    id: 'kimi-coding',
    name: 'Kimi (Coding)',
    description: 'API key',
    authType: 'api_key',
    envKey: 'KIMI_API_KEY',
    placeholder: 'sk-...',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    description: 'Local — sem API key',
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

  return (
    <SettingsSection title="Provider & Modelo">
      <SettingsCard>
        <SettingsCardContent className="space-y-4">
          <div className="text-xs text-muted-foreground leading-relaxed">
            O Hermes embutido usa as conexões e credenciais já cadastradas no Craft como fonte de verdade.
            Esta tela só escolhe o provider/modelo ativo no runtime isolado do app; API keys e subscriptions continuam
            no gerenciador de credenciais do Craft.
          </div>

          {loadingConfig ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Carregando configuração do Hermes…
            </div>
          ) : (
            <>
              <SettingsRow
                label="Provider"
                description={
                  isCurrentProvider
                    ? 'Provider ativo no Hermes (config.yaml)'
                    : 'Selecione um provider para ativá-lo'
                }
              >
                <select
                  className="bg-background border border-border rounded-md text-sm px-2 py-1 min-w-[220px]"
                  value={selectedProvider}
                  onChange={(e) => handleProviderChange(e.target.value)}
                >
                  {PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.recommended ? ' · recomendado' : p.popular ? ' · popular' : ''}
                    </option>
                  ))}
                </select>
              </SettingsRow>

              {provider?.description && (
                <div className="text-xs text-muted-foreground -mt-2 ml-1">{provider.description}</div>
              )}

              {provider?.authType === 'api_key' && (
                <div className="text-xs text-muted-foreground bg-muted/30 rounded-md p-2">
                  {apiKeyAlreadyConfigured
                    ? `Usando conexão/credencial do Craft para ${provider.name} (${provider.envKey}).`
                    : `Nenhuma credencial Craft detectada para ${provider.name} (${provider.envKey}). Configure a conexão em Settings → AI Connections; o Hermes receberá a chave automaticamente ao iniciar.`}
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

              {provider?.authType === 'oauth' && (
                <div className="text-xs text-muted-foreground bg-muted/30 rounded-md p-2">
                  Provider OAuth — a autenticação vem da conexão/subscription do Craft (ex.: ChatGPT Plus/Codex).
                  Os tokens são propagados ao Hermes pelo auth-bridge; se falhar, reautentique a conexão no Craft.
                </div>
              )}

              <div className="flex items-center gap-2">
                <Button size="sm" onClick={handleSaveProvider} disabled={savingProvider || !provider}>
                  {savingProvider ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
                  {isCurrentProvider ? 'Atualizar provider' : 'Ativar provider'}
                </Button>
                {provider?.helpUrl && (
                  <a
                    href={provider.helpUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-muted-foreground hover:underline"
                  >
                    {provider.helpUrl}
                  </a>
                )}
              </div>

              <div className="border-t border-border/60 pt-3">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">
                  Modelos disponíveis em {provider?.name ?? selectedProvider}
                </div>
                {loadingModels ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Carregando modelos…
                  </div>
                ) : models.length === 0 ? (
                  <div className="text-xs text-muted-foreground">
                    Nenhum modelo disponível. Verifique se há uma conexão Craft autenticada para este provider e reinicie o dashboard Hermes para ele herdar as credenciais.
                  </div>
                ) : (
                  <div className="max-h-64 overflow-auto rounded-lg border border-border/60 p-1">
                    {models.map((modelId) => {
                      const isActive = selectedModel === modelId && isCurrentProvider
                      return (
                        <button
                          key={modelId}
                          type="button"
                          onClick={() => handleSaveModel(modelId)}
                          disabled={savingModel}
                          className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/40 transition ${
                            isActive ? 'bg-muted/60 font-medium' : ''
                          }`}
                        >
                          <span className="font-mono text-xs">{modelId}</span>
                          {isActive && <span className="text-[11px] text-muted-foreground">ativo</span>}
                        </button>
                      )
                    })}
                  </div>
                )}
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
