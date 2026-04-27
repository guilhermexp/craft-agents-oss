import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, Pencil } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useBrowserProfiles } from '@/hooks/useBrowserProfiles'
import { DEFAULT_BROWSER_PROFILE_ID, type BrowserProfile } from '@craft-agent/shared/config/types'
import { cn } from '@/lib/utils'

const COLORS = [
  '#22c55e',
  '#3b82f6',
  '#f97316',
  '#a855f7',
  '#ec4899',
  '#14b8a6',
] as const

interface BrowserProfilePickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (profileId: string) => void
}

type Mode = { kind: 'list' } | { kind: 'create' }

export function BrowserProfilePicker({
  open,
  onOpenChange,
  onSelect,
}: BrowserProfilePickerProps) {
  const {
    profiles,
    alwaysAsk,
    createProfile,
    deleteProfile,
    renameProfile,
    setAlwaysAsk,
  } = useBrowserProfiles()
  const [mode, setMode] = useState<Mode>({ kind: 'list' })

  useEffect(() => {
    if (open) setMode({ kind: 'list' })
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>Quem está usando o navegador?</DialogTitle>
          <DialogDescription>
            Cada perfil tem cookies, sessões e armazenamento próprios — perfeito
            para separar contas pessoais e de trabalho.
          </DialogDescription>
        </DialogHeader>

        {mode.kind === 'list' ? (
          <ProfileGrid
            profiles={profiles}
            onPick={(id) => {
              onSelect(id)
              onOpenChange(false)
            }}
            onCreateClick={() => setMode({ kind: 'create' })}
            onRename={renameProfile}
            onDelete={deleteProfile}
          />
        ) : (
          <ProfileCreateForm
            onSubmit={async (input) => {
              const profile = await createProfile(input)
              setMode({ kind: 'list' })
              onSelect(profile.id)
              onOpenChange(false)
            }}
            onCancel={() => setMode({ kind: 'list' })}
          />
        )}

        <DialogFooter className="sm:justify-start">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={alwaysAsk}
              onChange={(e) => void setAlwaysAsk(e.target.checked)}
            />
            Sempre perguntar antes de abrir
          </label>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface ProfileGridProps {
  profiles: BrowserProfile[]
  onPick: (id: string) => void
  onCreateClick: () => void
  onRename: (id: string, name: string) => Promise<BrowserProfile>
  onDelete: (id: string) => Promise<void>
}

function ProfileGrid({ profiles, onPick, onCreateClick, onRename, onDelete }: ProfileGridProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 py-2">
      {profiles.map((p) => {
        const isDefault = p.id === DEFAULT_BROWSER_PROFILE_ID
        const isRenaming = renamingId === p.id
        return (
          <div
            key={p.id}
            className="group relative flex flex-col items-center gap-2 rounded-lg border border-border p-4 hover:bg-foreground/5 transition cursor-pointer"
            onClick={() => !isRenaming && onPick(p.id)}
          >
            <ProfileAvatar profile={p} size={56} />
            {isRenaming ? (
              <Input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    void onRename(p.id, renameValue).finally(() => setRenamingId(null))
                  } else if (e.key === 'Escape') {
                    setRenamingId(null)
                  }
                }}
                onBlur={() => {
                  if (renameValue.trim() && renameValue !== p.name) {
                    void onRename(p.id, renameValue)
                  }
                  setRenamingId(null)
                }}
                className="h-7 text-xs text-center"
              />
            ) : (
              <div className="text-sm text-center truncate w-full" title={p.name}>
                {p.name}
              </div>
            )}
            <div className="absolute top-1 right-1 hidden group-hover:flex gap-1">
              <button
                type="button"
                className="rounded p-1 hover:bg-foreground/10"
                title="Renomear"
                onClick={(e) => {
                  e.stopPropagation()
                  setRenameValue(p.name)
                  setRenamingId(p.id)
                }}
              >
                <Pencil className="size-3" />
              </button>
              {!isDefault && (
                <button
                  type="button"
                  className="rounded p-1 hover:bg-destructive/20 text-destructive"
                  title="Apagar perfil"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (confirm(`Apagar perfil "${p.name}"? Cookies e sessões serão perdidos.`)) {
                      void onDelete(p.id)
                    }
                  }}
                >
                  <Trash2 className="size-3" />
                </button>
              )}
            </div>
          </div>
        )
      })}
      <button
        type="button"
        onClick={onCreateClick}
        className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border p-4 hover:bg-foreground/5 transition min-h-[112px]"
      >
        <div className="size-14 rounded-full bg-foreground/10 flex items-center justify-center">
          <Plus className="size-6" />
        </div>
        <div className="text-sm">Adicionar</div>
      </button>
    </div>
  )
}

interface ProfileCreateFormProps {
  onSubmit: (input: { name: string; color: string }) => Promise<void>
  onCancel: () => void
}

function ProfileCreateForm({ onSubmit, onCancel }: ProfileCreateFormProps) {
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(COLORS[0])
  const [busy, setBusy] = useState(false)
  const valid = useMemo(() => name.trim().length > 0, [name])

  async function handleSubmit() {
    if (!valid || busy) return
    setBusy(true)
    try {
      await onSubmit({ name: name.trim(), color })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <div className="flex items-center gap-3">
        <div
          className="size-14 rounded-full flex items-center justify-center text-white text-lg font-semibold"
          style={{ backgroundColor: color }}
        >
          {(name.trim().charAt(0) || '?').toUpperCase()}
        </div>
        <div className="flex-1">
          <label className="text-xs text-muted-foreground">Nome do perfil</label>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSubmit()
            }}
            placeholder="Ex.: Trabalho, Pessoal"
          />
        </div>
      </div>
      <div>
        <div className="text-xs text-muted-foreground mb-2">Cor do avatar</div>
        <div className="flex gap-2">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className={cn(
                'size-8 rounded-full ring-offset-2 ring-offset-background',
                color === c && 'ring-2 ring-foreground',
              )}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancelar
        </Button>
        <Button onClick={handleSubmit} disabled={!valid || busy}>
          {busy ? 'Criando…' : 'Criar perfil'}
        </Button>
      </div>
    </div>
  )
}

interface ProfileAvatarProps {
  profile: BrowserProfile
  size?: number
}

export function ProfileAvatar({ profile, size = 32 }: ProfileAvatarProps) {
  const initial = (profile.name?.trim().charAt(0) || '?').toUpperCase()
  return (
    <div
      className="rounded-full flex items-center justify-center text-white font-semibold"
      style={{
        backgroundColor: profile.color,
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
      }}
    >
      {initial}
    </div>
  )
}
