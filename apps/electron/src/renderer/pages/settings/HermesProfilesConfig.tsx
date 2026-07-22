import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, ChevronDown, Copy, Pencil, Plus, Save, Trash2, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import { Spinner } from '@craft-agent/ui'

import { Button } from '@/components/ui/button'
import {
  SettingsCard,
  SettingsCardContent,
  SettingsRow,
  SettingsSection,
} from '@/components/settings'
import type { HermesProfileInfo } from '@craft-agent/shared/protocol'

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name)
}

function modelLabel(profile: HermesProfileInfo): string {
  if (!profile.model) return 'modelo não definido'
  return profile.provider ? `${profile.model} (${profile.provider})` : profile.model
}

export function HermesProfilesConfig() {
  const [profiles, setProfiles] = useState<HermesProfileInfo[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [cloneFromDefault, setCloneFromDefault] = useState(true)
  const [isCreating, setIsCreating] = useState(false)
  const [settingActive, setSettingActive] = useState<string | null>(null)
  const [renamingFrom, setRenamingFrom] = useState<string | null>(null)
  const [renameTo, setRenameTo] = useState('')
  const [editingSoulFor, setEditingSoulFor] = useState<string | null>(null)
  const [soulText, setSoulText] = useState('')
  const [isSavingSoul, setIsSavingSoul] = useState(false)
  const activeSoulRequest = useRef<string | null>(null)

  const loadProfiles = useCallback(async () => {
    setIsLoading(true)
    try {
      const result = await window.electronAPI.listHermesProfiles()
      if (!result.success) {
        toast.error('Falha ao listar profiles do Hermes', { description: result.error })
        return
      }
      setProfiles(result.profiles)
    } catch (error) {
      toast.error('Falha ao listar profiles do Hermes', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadProfiles()
  }, [loadProfiles])

  const createProfile = useCallback(async () => {
    const name = newName.trim()
    if (!name) {
      toast.error('Informe o nome do profile')
      return
    }
    if (!isValidProfileName(name)) {
      toast.error('Nome de profile inválido', {
        description: 'Use letras minúsculas, dígitos, _ e -. Deve começar com letra ou dígito e ter até 64 caracteres.',
      })
      return
    }
    setIsCreating(true)
    try {
      const result = await window.electronAPI.createHermesProfile({ name, cloneFromDefault })
      if (!result.success) {
        toast.error('Falha ao criar profile Hermes', { description: result.error })
        return
      }
      toast.success(`Profile criado: ${name}`)
      setNewName('')
      await loadProfiles()
    } catch (error) {
      toast.error('Falha ao criar profile Hermes', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setIsCreating(false)
    }
  }, [cloneFromDefault, loadProfiles, newName])

  const submitRename = useCallback(async () => {
    if (!renamingFrom) return
    const target = renameTo.trim()
    if (!target || target === renamingFrom) {
      setRenamingFrom(null)
      setRenameTo('')
      return
    }
    if (!isValidProfileName(target)) {
      toast.error('Nome de profile inválido', {
        description: 'Use letras minúsculas, dígitos, _ e -. Deve começar com letra ou dígito e ter até 64 caracteres.',
      })
      return
    }
    const result = await window.electronAPI.renameHermesProfile(renamingFrom, target)
    if (!result.success) {
      toast.error('Falha ao renomear profile Hermes', { description: result.error })
      return
    }
    toast.success(`Profile renomeado: ${renamingFrom} → ${target}`)
    setRenamingFrom(null)
    setRenameTo('')
    await loadProfiles()
  }, [loadProfiles, renameTo, renamingFrom])

  const deleteProfile = useCallback(async (profile: HermesProfileInfo) => {
    if (profile.isDefault) return
    const confirmed = window.confirm(`Deletar o profile "${profile.name}"? Isso remove config, chaves, memórias, sessões, skills e cron jobs desse profile.`)
    if (!confirmed) return
    const result = await window.electronAPI.deleteHermesProfile(profile.name)
    if (!result.success) {
      toast.error('Falha ao deletar profile Hermes', { description: result.error })
      return
    }
    toast.success(`Profile deletado: ${profile.name}`)
    await loadProfiles()
  }, [loadProfiles])

  const copySetupCommand = useCallback(async (name: string) => {
    const result = await window.electronAPI.getHermesProfileSetupCommand(name)
    if (!result.success || !result.command) {
      toast.error('Falha ao obter comando do profile Hermes', { description: result.error })
      return
    }
    await navigator.clipboard.writeText(result.command)
    toast.success(`Comando copiado: ${result.command}`)
  }, [])

  const toggleSoulEditor = useCallback(async (name: string) => {
    if (editingSoulFor === name) {
      activeSoulRequest.current = null
      setEditingSoulFor(null)
      setSoulText('')
      return
    }
    setEditingSoulFor(name)
    setSoulText('')
    activeSoulRequest.current = name
    const result = await window.electronAPI.getHermesProfileSoul(name)
    if (activeSoulRequest.current !== name) return
    if (!result.success) {
      toast.error('Falha ao carregar SOUL.md do profile', { description: result.error })
      return
    }
    setSoulText(result.content ?? '')
  }, [editingSoulFor])

  const saveSoul = useCallback(async (name: string) => {
    setIsSavingSoul(true)
    try {
      const result = await window.electronAPI.updateHermesProfileSoul(name, soulText)
      if (!result.success) {
        toast.error('Falha ao salvar SOUL.md do profile', { description: result.error })
        return
      }
      toast.success(`SOUL.md salvo: ${name}`)
    } finally {
      setIsSavingSoul(false)
    }
  }, [soulText])

  const setActiveProfile = useCallback(async (profile: HermesProfileInfo) => {
    if (profile.isActive) return
    setSettingActive(profile.name)
    try {
      const result = await window.electronAPI.setActiveHermesProfile(profile.name)
      if (!result.success) {
        toast.error('Falha ao ativar profile Hermes', { description: result.error })
        return
      }
      toast.success(`Profile ativo: ${result.name ?? profile.name}`)
      await loadProfiles()
    } catch (error) {
      toast.error('Falha ao ativar profile Hermes', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setSettingActive(null)
    }
  }, [loadProfiles])

  const activeProfile = profiles.find(profile => profile.isActive)?.name ?? 'default'

  return (
    <SettingsSection title="Profiles">
      <SettingsCard>
        <SettingsCardContent className="space-y-4">
          <div className="text-xs text-muted-foreground leading-relaxed">
            Profiles são instâncias Hermes isoladas para multi-agentes. Cada profile tem seu próprio config, chaves, memória, sessões, skills e cron.
          </div>

          <div className="grid gap-3 rounded-md border border-border/60 p-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Plus className="size-4" /> Novo profile
            </div>
            <SettingsRow label="Nome" description="Letras minúsculas, dígitos, _ e -. Até 64 caracteres.">
              <input
                className="min-w-[260px] rounded-md border border-border bg-background px-2 py-1 text-sm"
                placeholder="coder, writer, reviewer"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return
                  if (event.key === 'Enter') void createProfile()
                }}
                aria-label="Nome"
              />
            </SettingsRow>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={cloneFromDefault}
                onChange={(event) => setCloneFromDefault(event.target.checked)}
              />
              Clonar config do profile default
            </label>
            <div>
              <Button size="sm" onClick={createProfile} disabled={isCreating}>
                <Plus className="size-3.5 mr-1.5" /> {isCreating ? 'Criando...' : 'Criar'}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Users className="size-4" /> Profiles ({profiles.length})
              <span className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] uppercase text-emerald-600 dark:text-emerald-400">
                ativo: {activeProfile}
              </span>
            </div>
            {isLoading ? (
              <div className="flex h-20 items-center justify-center">
                <Spinner />
              </div>
            ) : profiles.length === 0 ? (
              <p className="rounded-md border border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">
                Nenhum profile encontrado.
              </p>
            ) : (
              <div className="space-y-2">
                {profiles.map((profile) => {
                  const isRenaming = renamingFrom === profile.name
                  const isEditingSoul = editingSoulFor === profile.name
                  return (
                    <div key={profile.name} className="rounded-md border border-border/60">
                      <div className="flex items-center gap-3 p-3">
                        <div className="min-w-0 flex-1">
                          <div className="mb-1 flex min-w-0 flex-wrap items-center gap-2">
                            {isRenaming ? (
                              <input
                                autoFocus
                                className="max-w-xs rounded-md border border-border bg-background px-2 py-1 text-sm"
                                value={renameTo}
                                onChange={(event) => setRenameTo(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.nativeEvent.isComposing) return
                                  if (event.key === 'Enter') void submitRename()
                                  if (event.key === 'Escape') {
                                    setRenamingFrom(null)
                                    setRenameTo('')
                                  }
                                }}
                                aria-label="Renomear profile"
                              />
                            ) : (
                              <span className="truncate text-sm font-medium">{profile.name}</span>
                            )}
                            {profile.isDefault && <span className="rounded-md bg-muted px-2 py-0.5 text-[10px] uppercase text-muted-foreground">default</span>}
                            {profile.isActive && <span className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] uppercase text-emerald-600 dark:text-emerald-400">ativo</span>}
                            {profile.hasEnv && <span className="rounded-md border border-border px-2 py-0.5 text-[10px] uppercase text-muted-foreground">env</span>}
                          </div>
                          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                            <span>{modelLabel(profile)}</span>
                            <span>Skills: {profile.skillCount}</span>
                            <span className="max-w-[32rem] truncate font-mono">{profile.path}</span>
                          </div>
                        </div>

                        <div className="flex shrink-0 items-center gap-1">
                          {isRenaming ? (
                            <>
                              <Button size="sm" variant="ghost" className="h-7 px-2" onClick={submitRename}>
                                <Save className="size-3.5" />
                              </Button>
                              <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => {
                                setRenamingFrom(null)
                                setRenameTo('')
                              }}>
                                <X className="size-3.5" />
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button
                                size="sm"
                                variant={profile.isActive ? 'secondary' : 'ghost'}
                                className="h-7 px-2"
                                title={profile.isActive ? 'Profile ativo no chat Hermes' : 'Ativar no chat Hermes'}
                                disabled={profile.isActive || settingActive === profile.name}
                                onClick={() => setActiveProfile(profile)}
                              >
                                <CheckCircle2 className="size-3.5" />
                              </Button>
                              <Button size="sm" variant="ghost" className="h-7 px-2" title="Editar SOUL.md" onClick={() => toggleSoulEditor(profile.name)}>
                                {isEditingSoul ? <ChevronDown className="size-3.5" /> : <span className="text-xs font-bold">S</span>}
                              </Button>
                              <Button size="sm" variant="ghost" className="h-7 px-2" title="Copiar comando de setup" onClick={() => copySetupCommand(profile.name)}>
                                <Copy className="size-3.5" />
                              </Button>
                              {!profile.isDefault && (
                                <Button size="sm" variant="ghost" className="h-7 px-2" title="Renomear" onClick={() => {
                                  setRenamingFrom(profile.name)
                                  setRenameTo(profile.name)
                                }}>
                                  <Pencil className="size-3.5" />
                                </Button>
                              )}
                              {!profile.isDefault && (
                                <Button size="sm" variant="ghost" className="h-7 px-2" title="Deletar" onClick={() => deleteProfile(profile)}>
                                  <Trash2 className="size-3.5 text-destructive" />
                                </Button>
                              )}
                            </>
                          )}
                        </div>
                      </div>

                      {isEditingSoul && (
                        <div className="space-y-2 border-t border-border/60 p-3">
                          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">SOUL.md</div>
                          <textarea
                            className="min-h-[180px] w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs leading-relaxed"
                            placeholder="Instruções, personalidade e contexto persistente desse profile."
                            value={soulText}
                            onChange={(event) => setSoulText(event.target.value)}
                            aria-label="SOUL.md"
                          />
                          <Button size="sm" onClick={() => saveSoul(profile.name)} disabled={isSavingSoul}>
                            <Save className="size-3.5 mr-1.5" /> {isSavingSoul ? 'Salvando...' : 'Salvar SOUL.md'}
                          </Button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </SettingsCardContent>
      </SettingsCard>
    </SettingsSection>
  )
}
