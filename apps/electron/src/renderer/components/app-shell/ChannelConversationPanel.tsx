import * as React from 'react'
import { Hash, Send } from 'lucide-react'
import type { ChannelConfig, ChannelMessage } from '@craft-agent/shared/channels'
import { cn } from '@/lib/utils'

interface ChannelConversationPanelProps {
  workspaceId: string
  channel: ChannelConfig
}

function formatAuthor(message: ChannelMessage): string {
  if (message.authorType === 'agent') return `@${message.authorId}`
  if (message.authorType === 'system') return 'sistema'
  return message.authorId
}

function participantSummary(channel: ChannelConfig): string {
  const participants = channel.participants ?? []
  if (participants.length === 0) return 'Sem agentes configurados'
  return participants.map(participant => `@${participant.id}`).join(' ')
}

export function ChannelConversationPanel({ workspaceId, channel }: ChannelConversationPanelProps) {
  const [messages, setMessages] = React.useState<ChannelMessage[]>([])
  const [draft, setDraft] = React.useState('')
  const [isLoading, setIsLoading] = React.useState(true)
  const [isSending, setIsSending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null)

  const loadMessages = React.useCallback(async () => {
    setIsLoading(true)
    try {
      const next = await window.electronAPI.listChannelMessages(workspaceId, channel.id)
      setMessages(next)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load channel messages')
    } finally {
      setIsLoading(false)
    }
  }, [channel.id, workspaceId])

  React.useEffect(() => {
    void loadMessages()
  }, [loadMessages])

  React.useEffect(() => {
    return window.electronAPI.onChannelMessagesChanged((changedWorkspaceId, channelId) => {
      if (changedWorkspaceId === workspaceId && channelId === channel.id) {
        void loadMessages()
      }
    })
  }, [channel.id, loadMessages, workspaceId])

  const sendMessage = React.useCallback(async () => {
    const text = draft.trim()
    if (!text || isSending) return
    setIsSending(true)
    try {
      await window.electronAPI.sendChannelMessage(workspaceId, {
        channelId: channel.id,
        text,
        authorId: 'human',
      })
      setDraft('')
      setError(null)
      await loadMessages()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send channel message')
    } finally {
      setIsSending(false)
      textareaRef.current?.focus()
    }
  }, [channel.id, draft, isSending, loadMessages, workspaceId])

  const canSend = draft.trim().length > 0 && !isSending
  const participants = channel.participants ?? []

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border/60 px-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-muted/40">
          <Hash className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-foreground">{channel.name}</h1>
          <p className="truncate text-xs text-muted-foreground">{participantSummary(channel)}</p>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Carregando canal...</div>
        ) : messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-center">
            <div className="max-w-sm">
              <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-md border border-border/70 bg-muted/30">
                <Hash className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-foreground">Nenhuma mensagem no canal</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Mencione agentes configurados, por exemplo {participants[0] ? `@${participants[0].id}` : '@default'}, para criar turnos separados no mesmo contexto.
              </p>
            </div>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
            {messages.map(message => (
              <article
                key={message.id}
                className={cn(
                  'rounded-md border px-3 py-2 text-sm',
                  message.authorType === 'user'
                    ? 'border-border/70 bg-muted/25'
                    : 'border-primary/20 bg-primary/5',
                )}
              >
                <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{formatAuthor(message)}</span>
                  {message.tagged.length > 0 ? <span>chamou {message.tagged.map(id => `@${id}`).join(' ')}</span> : null}
                </div>
                <p className="whitespace-pre-wrap leading-6 text-foreground">{message.text}</p>
              </article>
            ))}
          </div>
        )}
      </div>

      <footer className="shrink-0 border-t border-border/60 p-4">
        <div className="mx-auto max-w-3xl">
          {error ? <div className="mb-2 text-xs text-destructive">{error}</div> : null}
          <div className="rounded-md border border-border bg-background">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void sendMessage()
                }
              }}
              placeholder={participants.length > 0 ? `Chame ${participants.map(p => `@${p.id}`).join(' ')}...` : 'Configure participantes no canal para chamar agentes...'}
              className="min-h-24 w-full resize-none bg-transparent px-3 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
            <div className="flex items-center justify-between border-t border-border/60 px-2 py-2">
              <span className="truncate px-1 text-xs text-muted-foreground">{channel.description ?? 'Conversa compartilhada do canal'}</span>
              <button
                type="button"
                disabled={!canSend}
                onClick={() => { void sendMessage() }}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Enviar mensagem para o canal"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}
