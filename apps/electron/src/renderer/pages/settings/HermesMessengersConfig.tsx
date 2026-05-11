import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Loader2, X } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  SettingsCard,
  SettingsCardContent,
  SettingsSection,
} from '@/components/settings'
import type { HermesEnvVar } from '@craft-agent/shared/protocol'

import telegramIcon from '@/assets/messaging-icons/telegram.svg'
import discordIcon from '@/assets/messaging-icons/discord.svg'
import slackIcon from '@/assets/messaging-icons/slack.svg'
import signalIcon from '@/assets/messaging-icons/signal.svg'
import whatsappIcon from '@/assets/messaging-icons/whatsapp.svg'
import matrixIcon from '@/assets/messaging-icons/matrix.svg'
import emailIcon from '@/assets/messaging-icons/email.svg'
import homeassistantIcon from '@/assets/messaging-icons/homeassistant.svg'
import smsIcon from '@/assets/messaging-icons/sms.svg'
import dingtalkIcon from '@/assets/messaging-icons/dingtalk.svg'
import feishuIcon from '@/assets/messaging-icons/feishu.svg'
import mattermostIcon from '@/assets/messaging-icons/mattermost.svg'
import bluebubblesIcon from '@/assets/messaging-icons/bluebubbles.svg'

type MessengerEntry = {
  id: string
  name: string
  description: string
  icon: string
  requiredEnv: string[]
  optionalEnv?: string[]
  helpUrl?: string
  /** Telegram-specific allowlist behavior. */
  allowlistEnv?: string
  allowlistLabel?: string
  setupSteps?: string[]
}

const MESSENGERS: MessengerEntry[] = [
  {
    id: 'telegram',
    name: 'Telegram',
    description: 'Connect a Telegram bot to receive and send messages',
    icon: telegramIcon,
    requiredEnv: ['TELEGRAM_BOT_TOKEN'],
    optionalEnv: ['TELEGRAM_ALLOWED_USERS', 'TELEGRAM_HOME_CHANNEL'],
    helpUrl: 'https://t.me/BotFather',
    allowlistEnv: 'TELEGRAM_ALLOWED_USERS',
    allowlistLabel: 'Allowed Telegram user IDs',
    setupSteps: [
      'Abra o Telegram e fale com @BotFather',
      'Use /newbot e siga os passos para nomear o bot',
      'Copie o token e cole abaixo',
    ],
  },
  {
    id: 'discord',
    name: 'Discord',
    description: 'Connect a Discord bot to interact with your server',
    icon: discordIcon,
    requiredEnv: ['DISCORD_BOT_TOKEN'],
    optionalEnv: ['DISCORD_ALLOWED_USERS', 'DISCORD_ALLOWED_CHANNELS', 'DISCORD_HOME_CHANNEL'],
    helpUrl: 'https://discord.com/developers/applications',
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Connect a Slack workspace via Socket Mode',
    icon: slackIcon,
    requiredEnv: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
    optionalEnv: ['SLACK_FREE_RESPONSE_CHANNELS', 'SLACK_HOME_CHANNEL'],
    helpUrl: 'https://api.slack.com/apps',
  },
  {
    id: 'signal',
    name: 'Signal',
    description: 'Connect Signal via signal-cli for private messaging',
    icon: signalIcon,
    requiredEnv: ['SIGNAL_HTTP_URL', 'SIGNAL_ACCOUNT'],
    optionalEnv: ['SIGNAL_HOME_CHANNEL'],
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    description: 'Connect WhatsApp via Node.js bridge',
    icon: whatsappIcon,
    requiredEnv: ['WHATSAPP_ENABLED'],
    optionalEnv: ['WHATSAPP_MODE'],
  },
  {
    id: 'matrix',
    name: 'Matrix',
    description: 'Connect to a Matrix homeserver for decentralized messaging',
    icon: matrixIcon,
    requiredEnv: ['MATRIX_HOMESERVER'],
    optionalEnv: ['MATRIX_ACCESS_TOKEN', 'MATRIX_PASSWORD', 'MATRIX_USER_ID'],
  },
  {
    id: 'email',
    name: 'Email',
    description: 'Connect email via IMAP/SMTP for email-based messaging',
    icon: emailIcon,
    requiredEnv: ['EMAIL_ADDRESS', 'EMAIL_PASSWORD', 'EMAIL_IMAP_HOST', 'EMAIL_SMTP_HOST'],
    optionalEnv: ['EMAIL_IMAP_PORT', 'EMAIL_SMTP_PORT'],
  },
  {
    id: 'homeassistant',
    name: 'Home Assistant',
    description: 'Connect to Home Assistant for smart home automation',
    icon: homeassistantIcon,
    requiredEnv: ['HASS_TOKEN'],
    optionalEnv: ['HASS_URL'],
  },
  {
    id: 'sms',
    name: 'SMS (Twilio)',
    description: 'Send and receive SMS via Twilio',
    icon: smsIcon,
    requiredEnv: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER'],
    optionalEnv: ['SMS_WEBHOOK_URL', 'SMS_WEBHOOK_PORT'],
  },
  {
    id: 'dingtalk',
    name: 'DingTalk',
    description: 'Connect a DingTalk chatbot via Stream Mode',
    icon: dingtalkIcon,
    requiredEnv: ['DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET'],
  },
  {
    id: 'feishu',
    name: 'Feishu / Lark',
    description: 'Connect a Feishu or Lark bot',
    icon: feishuIcon,
    requiredEnv: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'],
    optionalEnv: ['FEISHU_VERIFICATION_TOKEN'],
  },
  {
    id: 'mattermost',
    name: 'Mattermost',
    description: 'Connect to a Mattermost server',
    icon: mattermostIcon,
    requiredEnv: ['MATTERMOST_TOKEN', 'MATTERMOST_URL'],
  },
  {
    id: 'bluebubbles',
    name: 'BlueBubbles (iMessage)',
    description: 'Connect iMessage via BlueBubbles on macOS',
    icon: bluebubblesIcon,
    requiredEnv: ['BLUEBUBBLES_SERVER_URL', 'BLUEBUBBLES_PASSWORD'],
  },
]

function isConfigured(entry: MessengerEntry, envByKey: Map<string, HermesEnvVar>): boolean {
  return entry.requiredEnv.every(k => envByKey.get(k)?.isSet)
}

function parseAllowlist(value: string | undefined): string[] {
  if (!value) return []
  return value.split(',').map(s => s.trim()).filter(Boolean)
}

export function HermesMessengersConfig() {
  const [envByKey, setEnvByKey] = useState<Map<string, HermesEnvVar>>(new Map())
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<MessengerEntry | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.electronAPI.listHermesEnv()
      if (!res.success) {
        toast.error('Falha ao ler env do Hermes', { description: res.error })
        setEnvByKey(new Map())
        return
      }
      const map = new Map<string, HermesEnvVar>()
      for (const v of res.vars ?? []) map.set(v.key, v)
      setEnvByKey(map)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  return (
    <SettingsSection title="Messengers">
      <SettingsCard>
        <SettingsCardContent className="space-y-3">
          <div className="text-xs text-muted-foreground leading-relaxed">
            Conecte plataformas de mensageria ao Hermes embarcado. Cada conector grava as variáveis no <code className="px-1 rounded bg-muted/60">.env</code> do
            runtime isolado. O gateway do Hermes é reiniciado automaticamente após mudanças de credenciais.
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Carregando status…
            </div>
          ) : (
            <div className="grid gap-2 md:grid-cols-2">
              {MESSENGERS.map((m) => {
                const configured = isConfigured(m, envByKey)
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setOpen(m)}
                    className="group flex items-center gap-3 rounded-xl border border-border/60 bg-muted/20 px-3 py-3 text-left hover:bg-muted/50 hover:border-border transition-colors"
                  >
                    <img
                      src={m.icon}
                      alt=""
                      width={32}
                      height={32}
                      className="h-8 w-8 rounded-lg flex-shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium leading-5 truncate">{m.name}</span>
                        {configured && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" />}
                      </div>
                      <div className="text-[11px] text-muted-foreground leading-4 mt-0.5 line-clamp-2">
                        {m.description}
                      </div>
                    </div>
                    <span
                      className={`shrink-0 text-[10px] font-medium px-2.5 py-1 rounded-full border ${
                        configured
                          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                          : 'border-border bg-background text-foreground group-hover:border-primary/40'
                      }`}
                    >
                      {configured ? 'Configurado' : 'Conectar'}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </SettingsCardContent>
      </SettingsCard>

      {open && (
        <MessengerModal entry={open} envByKey={envByKey} onClose={() => setOpen(null)} onChange={refresh} />
      )}
    </SettingsSection>
  )
}

function MessengerModal({
  entry,
  envByKey,
  onClose,
  onChange,
}: {
  entry: MessengerEntry
  envByKey: Map<string, HermesEnvVar>
  onClose: () => void
  onChange: () => Promise<void>
}) {
  const allKeys = useMemo(
    () => [...entry.requiredEnv, ...(entry.optionalEnv ?? [])],
    [entry],
  )

  const [values, setValues] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {}
    for (const k of allKeys) seed[k] = ''
    return seed
  })
  const [saving, setSaving] = useState(false)

  const allowlist = useMemo(() => {
    if (!entry.allowlistEnv) return null
    const current = envByKey.get(entry.allowlistEnv)
    return parseAllowlist(current?.redactedValue)
  }, [entry.allowlistEnv, envByKey])

  const setValue = (key: string, v: string) => setValues(prev => ({ ...prev, [key]: v }))

  const handleSave = async () => {
    setSaving(true)
    try {
      const dirty = Object.entries(values).filter(([, v]) => v.trim().length > 0)
      if (dirty.length === 0) {
        toast.message('Nada para salvar', { description: 'Preencha pelo menos um campo.' })
        return
      }
      for (const [key, value] of dirty) {
        const res = await window.electronAPI.setHermesEnv({ key, value: value.trim() })
        if (!res.success) {
          toast.error(`Falha ao salvar ${key}`, { description: res.error })
          return
        }
      }
      toast.success('Credenciais salvas no Hermes')
      await onChange()
      setValues(prev => {
        const next = { ...prev }
        for (const [k] of dirty) next[k] = ''
        return next
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md p-0 gap-0">
        <DialogHeader className="p-4 border-b border-border/60">
          <DialogTitle className="flex items-center gap-2.5 text-sm font-semibold">
            <img src={entry.icon} alt="" className="h-7 w-7 rounded-md" />
            {entry.name}
          </DialogTitle>
        </DialogHeader>

        <div className="p-4 space-y-3 max-h-[70vh] overflow-y-auto">
          <div className="text-xs text-muted-foreground leading-relaxed">{entry.description}</div>

          {entry.setupSteps && (
            <ol className="text-xs text-muted-foreground leading-relaxed list-decimal pl-4 space-y-1">
              {entry.setupSteps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          )}

          {entry.helpUrl && (
            <a
              href={entry.helpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:underline"
            >
              Abrir documentação ↗
            </a>
          )}

          <div className="space-y-2 pt-2">
            {allKeys.filter(k => k !== entry.allowlistEnv).map((key) => {
              const current = envByKey.get(key)
              const isRequired = entry.requiredEnv.includes(key)
              return (
                <div key={key} className="space-y-1">
                  <label className="text-[11px] font-medium text-muted-foreground flex items-center gap-1">
                    {key}
                    {isRequired && <span className="text-destructive">*</span>}
                    {current?.isSet && (
                      <span className="text-[10px] text-emerald-500 ml-auto">
                        já configurado{current.redactedValue ? ` (${current.redactedValue})` : ''}
                      </span>
                    )}
                  </label>
                  <input
                    type={current?.isPassword || isRequired ? 'password' : 'text'}
                    value={values[key] ?? ''}
                    onChange={(e) => setValue(key, e.target.value)}
                    placeholder={current?.isSet ? '•••• (preencha para sobrescrever)' : 'Cole o valor'}
                    className="w-full text-sm px-2 py-1.5 rounded-md bg-muted/40 border border-border/60 focus:outline-none focus:border-primary/60"
                  />
                </div>
              )
            })}
          </div>

          {entry.allowlistEnv && allowlist && (
            <AllowlistEditor
              envKey={entry.allowlistEnv}
              label={entry.allowlistLabel ?? entry.allowlistEnv}
              current={allowlist}
              onChange={onChange}
            />
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-border/60">
          <Button size="sm" variant="ghost" onClick={onClose} disabled={saving}>
            Fechar
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
            Salvar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function AllowlistEditor({
  envKey,
  label,
  current,
  onChange,
}: {
  envKey: string
  label: string
  current: string[]
  onChange: () => Promise<void>
}) {
  const [list, setList] = useState<string[]>(current)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => { setList(current) }, [current])

  const persist = async (next: string[]) => {
    setBusy(true)
    try {
      const res = await window.electronAPI.setHermesEnv({
        key: envKey,
        value: next.join(','),
      })
      if (!res.success) {
        toast.error(`Falha ao atualizar ${envKey}`, { description: res.error })
        return
      }
      setList(next)
      await onChange()
    } finally {
      setBusy(false)
    }
  }

  const add = async () => {
    const id = input.trim().replace(/^(telegram|tg):/i, '').trim()
    if (!id || list.includes(id)) return
    setInput('')
    await persist([...list, id])
  }

  const remove = async (id: string) => {
    await persist(list.filter(x => x !== id))
  }

  return (
    <div className="pt-3 border-t border-border/40 space-y-2">
      <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
      {list.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {list.map((id) => (
            <span
              key={id}
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-muted text-xs"
            >
              {id}
              <button
                type="button"
                disabled={busy}
                onClick={() => void remove(id)}
                className="text-muted-foreground hover:text-destructive"
                aria-label={`Remover ${id}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && input.trim()) void add() }}
          placeholder="Cole o user ID e pressione Enter"
          disabled={busy}
          className="flex-1 text-sm px-2 py-1.5 rounded-md bg-muted/40 border border-border/60 focus:outline-none focus:border-primary/60"
        />
        <Button size="sm" variant="outline" onClick={() => void add()} disabled={busy || !input.trim()}>
          Adicionar
        </Button>
      </div>
    </div>
  )
}
