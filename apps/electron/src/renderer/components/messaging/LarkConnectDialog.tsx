/**
 * LarkConnectDialog — credential-input pairing flow in a modal.
 *
 * Sibling to TelegramConnectDialog. Lark/Feishu bots authenticate with an
 * app id + app secret against one of two separate ecosystems (Lark =
 * open.larksuite.com, Feishu = open.feishu.cn), so the user picks the domain
 * too. There is no separate "test" round-trip: Save validates the payload,
 * persists it, and connects via a long-connection WS client — connection
 * errors surface in the platform row's runtime status.
 *
 * Used by MessagingSettingsPage. The `reconfigure` prop is set when the user
 * picks "Reconfigure" from the three-dot menu.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@craft-agent/ui'
import { SettingsSecretInput } from '@/components/settings'
import { cn } from '@/lib/utils'

type LarkDomain = 'lark' | 'feishu'

interface LarkConnectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When true, treat the flow as "replace existing credentials". */
  reconfigure?: boolean
  onSaved?: () => void
}

export function LarkConnectDialog({
  open,
  onOpenChange,
  reconfigure = false,
  onSaved,
}: LarkConnectDialogProps) {
  const { t } = useTranslation()
  const [appId, setAppId] = React.useState('')
  const [appSecret, setAppSecret] = React.useState('')
  const [domain, setDomain] = React.useState<LarkDomain>('lark')
  const [saving, setSaving] = React.useState(false)

  const ready = appId.trim().length > 0 && appSecret.trim().length > 0

  const handleSave = async () => {
    if (!ready) return
    setSaving(true)
    try {
      await window.electronAPI.saveLarkCredentials(
        JSON.stringify({ appId: appId.trim(), appSecret: appSecret.trim(), domain }),
      )
      toast.success(t('settings.messaging.lark.saved'))
      onSaved?.()
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.messaging.lark.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent key={open ? 'open' : 'closed'} className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {reconfigure
              ? t('settings.messaging.lark.reconfigureTitle', { defaultValue: 'Replace Lark credentials' })
              : t('settings.messaging.lark.connectTitle', { defaultValue: 'Connect Lark' })}
          </DialogTitle>
          <DialogDescription className="whitespace-pre-line">
            {t('settings.messaging.lark.instructions')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {/* Domain selector — Lark and Feishu are separate ecosystems. */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t('settings.messaging.lark.domainLabel')}</span>
            {(['lark', 'feishu'] as const).map((d) => (
              <Button
                key={d}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDomain(d)}
                disabled={saving}
                className={cn(domain === d && 'ring-1 ring-foreground/30')}
              >
                {t(d === 'feishu' ? 'settings.messaging.lark.domainFeishu' : 'settings.messaging.lark.domainLark')}
              </Button>
            ))}
          </div>

          <input
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            placeholder={t('settings.messaging.lark.appIdPlaceholder')}
            disabled={saving}
            className="w-full h-9 px-3 text-sm rounded-lg bg-foreground-2 outline-none focus:ring-1 focus:ring-foreground/30"
          />

          <SettingsSecretInput
            value={appSecret}
            onChange={setAppSecret}
            placeholder={t('settings.messaging.lark.appSecretPlaceholder')}
            disabled={saving}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button variant="outline" size="sm" onClick={handleSave} disabled={!ready || saving}>
            {saving && <Spinner className="mr-1 text-[14px]" />}
            {t('settings.messaging.lark.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
