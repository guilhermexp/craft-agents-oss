import * as React from 'react'
import { Hash, Loader2, Plus, Send, Users, X } from 'lucide-react'
import type { ChannelMessage, WarRoomChannel, WarRoomDispatch, WarRoomParticipant } from '@craft-agent/shared/channels'
import { cn } from '@/lib/utils'
import { useOptionalAppShellContext } from '@/context/AppShellContext'

interface ChannelConversationPanelProps {
  workspaceId: string
  channel: WarRoomChannel
}

function formatAuthor(message: ChannelMessage): string {
  if (message.authorType === 'agent') return `@${message.authorId}`
  if (message.authorType === 'system') return 'sistema'
  return message.authorId
}

function participantSummary(channel: WarRoomChannel): string {
  const participants = channel.participants ?? []
  if (participants.length === 0) return 'Sem agentes configurados'
  return participants.map(participant => `@${participant.id}`).join(' ')
}

function slugifyParticipantId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function dispatchTone(status: WarRoomDispatch['status']): string {
  if (status === 'completed') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
  if (status === 'failed') return 'border-destructive/40 bg-destructive/10 text-destructive'
  if (status === 'running') return 'border-blue-500/30 bg-blue-500/10 text-blue-300'
  if (status === 'queued') return 'border-amber-500/30 bg-amber-500/10 text-amber-300'
  return 'border-border bg-muted/30 text-muted-foreground'
}

function getActiveMention(textarea: HTMLTextAreaElement | null, draft: string): { start: number; query: string } | null {
  if (!textarea) return null
  const cursor = textarea.selectionStart ?? draft.length
  const prefix = draft.slice(0, cursor)
  const match = /(?:^|\s)@([a-zA-Z0-9_-]*)$/.exec(prefix)
  if (!match) return null
  return {
    start: cursor - match[1].length - 1,
    query: match[1].toLowerCase(),
  }
}

export function ChannelConversationPanel({ workspaceId, channel }: ChannelConversationPanelProps) {
  const appShell = useOptionalAppShellContext()
  const [currentChannel, setCurrentChannel] = React.useState(channel)
  const [messages, setMessages] = React.useState<ChannelMessage[]>([])
  const [dispatches, setDispatches] = React.useState<WarRoomDispatch[]>([])
  const [draft, setDraft] = React.useState('')
  const [isLoading, setIsLoading] = React.useState(true)
  const [isSending, setIsSending] = React.useState(false)
  const [lastDispatchSummary, setLastDispatchSummary] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [mentionQuery, setMentionQuery] = React.useState<{ start: number; query: string } | null>(null)
  const [participantEditorOpen, setParticipantEditorOpen] = React.useState(false)
  const [isSavingParticipant, setIsSavingParticipant] = React.useState(false)
  const [participantIdDraft, setParticipantIdDraft] = React.useState('')
  const [participantNameDraft, setParticipantNameDraft] = React.useState('')
  const [participantConnectionDraft, setParticipantConnectionDraft] = React.useState('')
  const [participantModelDraft, setParticipantModelDraft] = React.useState('')
  const [participantHermesProfileDraft, setParticipantHermesProfileDraft] = React.useState('')
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null)
  const messagesEndRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    setCurrentChannel(channel)
  }, [channel])

  const participants = currentChannel.participants ?? []
  const llmConnections = appShell?.llmConnections ?? []
  const defaultConnection = appShell?.workspaceDefaultLlmConnection
    ?? llmConnections.find(connection => connection.isAuthenticated)?.slug
    ?? llmConnections[0]?.slug
    ?? 'hermes'

  React.useEffect(() => {
    if (!participantConnectionDraft) setParticipantConnectionDraft(defaultConnection)
  }, [defaultConnection, participantConnectionDraft])

  const loadChannelState = React.useCallback(async () => {
    setIsLoading(true)
    try {
      const [nextMessages, nextDispatches] = await Promise.all([
        window.electronAPI.listChannelMessages(workspaceId, currentChannel.id),
        window.electronAPI.listChannelDispatches(workspaceId, currentChannel.id).catch(() => [] as WarRoomDispatch[]),
      ])
      setMessages(nextMessages)
      setDispatches(nextDispatches)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load channel messages')
    } finally {
      setIsLoading(false)
    }
  }, [currentChannel.id, workspaceId])

  React.useEffect(() => {
    void loadChannelState()
  }, [loadChannelState])

  React.useEffect(() => {
    return window.electronAPI.onChannelMessagesChanged((changedWorkspaceId, channelId) => {
      if (changedWorkspaceId === workspaceId && channelId === currentChannel.id) {
        void loadChannelState()
      }
    })
  }, [currentChannel.id, loadChannelState, workspaceId])

  React.useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, isSending])

  const updateMentionQuery = React.useCallback((nextDraft: string) => {
    window.requestAnimationFrame(() => {
      const activeMention = getActiveMention(textareaRef.current, nextDraft)
      setMentionQuery(activeMention)
    })
  }, [])

  const insertMention = React.useCallback((participantId: string) => {
    const textarea = textareaRef.current
    const activeMention = getActiveMention(textarea, draft)
    if (!textarea || !activeMention) return
    const cursor = textarea.selectionStart ?? draft.length
    const before = draft.slice(0, activeMention.start)
    const after = draft.slice(cursor)
    const nextDraft = `${before}@${participantId} ${after}`
    const nextCursor = before.length + participantId.length + 2
    setDraft(nextDraft)
    setMentionQuery(null)
    window.requestAnimationFrame(() => {
      textarea.focus()
      textarea.setSelectionRange(nextCursor, nextCursor)
    })
  }, [draft])

  const sendMessage = React.useCallback(async () => {
    const text = draft.trim()
    if (!text || isSending) return
    setIsSending(true)
    setLastDispatchSummary('Enviando para o canal...')
    try {
      const result = await window.electronAPI.sendChannelMessage(workspaceId, {
        channelId: currentChannel.id,
        text,
        authorId: 'human',
      })
      setDraft('')
      setMentionQuery(null)
      setError(null)
      const summaryParts: string[] = []
      if (result.targetedParticipantIds.length > 0) {
        summaryParts.push(`Acionou ${result.targetedParticipantIds.map(id => `@${id}`).join(' ')}`)
      } else if (participants.length === 0) {
        summaryParts.push('Mensagem salva; configure participantes para chamar agentes com @')
      } else {
        summaryParts.push('Mensagem salva no canal; nenhum agente foi acionado')
      }
      if (result.unknownMentions.length > 0) {
        summaryParts.push(`menções não encontradas: ${result.unknownMentions.map(id => `@${id}`).join(' ')}`)
      }
      if (result.failures.length > 0) {
        summaryParts.push(`falhas: ${result.failures.map(failure => `@${failure.participantId}: ${failure.message}`).join('; ')}`)
      }
      setLastDispatchSummary(summaryParts.join(' · '))
      await loadChannelState()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send channel message')
      setLastDispatchSummary(null)
    } finally {
      setIsSending(false)
      textareaRef.current?.focus()
    }
  }, [currentChannel.id, draft, isSending, loadChannelState, participants.length, workspaceId])

  const saveParticipant = React.useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const id = slugifyParticipantId(participantIdDraft || participantNameDraft)
    const llmConnection = participantConnectionDraft.trim() || defaultConnection
    if (!id || !llmConnection || isSavingParticipant) return
    if (participants.some(participant => participant.id === id)) {
      setError(`Já existe um participante @${id} neste canal`)
      return
    }
    const participant: WarRoomParticipant = {
      id,
      displayName: participantNameDraft.trim() || id,
      llmConnection,
      ...(participantModelDraft.trim() ? { model: participantModelDraft.trim() } : {}),
      ...(participantHermesProfileDraft.trim() ? { hermesProfile: participantHermesProfileDraft.trim() } : {}),
    }
    setIsSavingParticipant(true)
    try {
      const updated = await window.electronAPI.updateChannel(workspaceId, currentChannel.id, {
        participants: [...participants, participant],
        routing: currentChannel.routing ?? { mode: 'manual-tags' },
      })
      setCurrentChannel(updated)
      setParticipantIdDraft('')
      setParticipantNameDraft('')
      setParticipantModelDraft('')
      setParticipantHermesProfileDraft('')
      setParticipantEditorOpen(false)
      setError(null)
      setLastDispatchSummary(`Participante @${participant.id} adicionado. Digite @ para mencionar.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add participant')
    } finally {
      setIsSavingParticipant(false)
    }
  }, [currentChannel.id, currentChannel.routing, defaultConnection, isSavingParticipant, participantConnectionDraft, participantHermesProfileDraft, participantIdDraft, participantModelDraft, participantNameDraft, participants, workspaceId])

  const removeParticipant = React.useCallback(async (participantId: string) => {
    try {
      const updated = await window.electronAPI.updateChannel(workspaceId, currentChannel.id, {
        participants: participants.filter(participant => participant.id !== participantId),
      })
      setCurrentChannel(updated)
      setLastDispatchSummary(`Participante @${participantId} removido do canal`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove participant')
    }
  }, [currentChannel.id, participants, workspaceId])

  const canSend = draft.trim().length > 0 && !isSending
  const mentionSuggestions = mentionQuery
    ? participants.filter(participant => (
      participant.id.toLowerCase().includes(mentionQuery.query)
      || participant.displayName.toLowerCase().includes(mentionQuery.query)
    )).slice(0, 6)
    : []
  const recentDispatches = dispatches.slice(-6).reverse()

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="flex shrink-0 items-start gap-3 border-b border-border/60 px-5 py-3">
        <div className="flex size-8 items-center justify-center rounded-md border border-border/70 bg-muted/40">
          <Hash className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold text-foreground">{currentChannel.name}</h1>
            <span className="rounded-full border border-border/70 px-2 py-0.5 text-[11px] text-muted-foreground">
              {currentChannel.routing?.mode ?? 'manual-tags'}
            </span>
          </div>
          <p className="truncate text-xs text-muted-foreground">{participantSummary(currentChannel)}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {participants.map(participant => (
              <span key={participant.id} className="group inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/30 px-2 py-1 text-xs text-foreground">
                @{participant.id}
                <span className="text-muted-foreground">· {participant.llmConnection}</span>
                <button
                  type="button"
                  onClick={() => { void removeParticipant(participant.id) }}
                  className="ml-0.5 hidden rounded-full text-muted-foreground hover:text-destructive group-hover:inline-flex"
                  aria-label={`Remover @${participant.id}`}
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={() => setParticipantEditorOpen(value => !value)}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-1 text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground"
            >
              <Plus className="size-3" />
              Adicionar agente
            </button>
          </div>
        </div>
      </header>

      {participantEditorOpen ? (
        <form onSubmit={saveParticipant} className="shrink-0 border-b border-border/60 bg-muted/10 px-5 py-3">
          <div className="mx-auto grid max-w-5xl gap-2 md:grid-cols-[1fr_1fr_1fr_auto]">
            <input
              value={participantIdDraft}
              onChange={event => setParticipantIdDraft(slugifyParticipantId(event.target.value))}
              placeholder="id da menção, ex: server-ops"
              className="rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60"
            />
            <input
              value={participantNameDraft}
              onChange={event => setParticipantNameDraft(event.target.value)}
              placeholder="nome visível"
              className="rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60"
            />
            <select
              value={participantConnectionDraft || defaultConnection}
              onChange={event => setParticipantConnectionDraft(event.target.value)}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60"
            >
              {llmConnections.length === 0 ? <option value="hermes">hermes</option> : null}
              {llmConnections.map(connection => (
                <option key={connection.slug} value={connection.slug}>{connection.name ?? connection.slug}</option>
              ))}
            </select>
            <button
              type="submit"
              disabled={isSavingParticipant || !(participantIdDraft || participantNameDraft)}
              className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isSavingParticipant ? <Loader2 className="size-4 animate-spin" /> : <Users className="size-4" />}
              Adicionar
            </button>
          </div>
          <div className="mx-auto mt-2 grid max-w-5xl gap-2 md:grid-cols-2">
            <input
              value={participantModelDraft}
              onChange={event => setParticipantModelDraft(event.target.value)}
              placeholder="modelo opcional"
              className="rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60"
            />
            <input
              value={participantHermesProfileDraft}
              onChange={event => setParticipantHermesProfileDraft(slugifyParticipantId(event.target.value))}
              placeholder="Hermes profile opcional, ex: server-ops"
              className="rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60"
            />
          </div>
        </form>
      ) : null}

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Carregando canal…</div>
        ) : messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-center">
            <div className="max-w-md">
              <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-md border border-border/70 bg-muted/30">
                <Hash className="size-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-foreground">Nenhuma mensagem no canal</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {participants.length > 0
                  ? `Digite @ para escolher ${participants.map(participant => `@${participant.id}`).join(', ')} e criar turnos separados no mesmo contexto.`
                  : 'Este canal ainda não tem agentes. Clique em “Adicionar agente” acima para habilitar menções com @.'}
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
                    : message.authorType === 'system'
                      ? 'border-amber-500/20 bg-amber-500/5'
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
            {isSending ? (
              <div className="flex items-center gap-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Processando dispatches do canal…
              </div>
            ) : null}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      <footer className="shrink-0 border-t border-border/60 p-4">
        <div className="mx-auto max-w-3xl">
          {recentDispatches.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {recentDispatches.map(dispatch => (
                <span key={dispatch.id} className={cn('rounded-full border px-2 py-1 text-[11px]', dispatchTone(dispatch.status))}>
                  @{dispatch.participantId} · {dispatch.status}
                </span>
              ))}
            </div>
          ) : null}
          {error ? <div className="mb-2 text-xs text-destructive">{error}</div> : null}
          {lastDispatchSummary && !error ? <div className="mb-2 text-xs text-muted-foreground">{lastDispatchSummary}</div> : null}
          <div className="relative rounded-md border border-border bg-background">
            {mentionSuggestions.length > 0 ? (
              <div className="absolute bottom-full left-2 z-20 mb-2 w-72 overflow-hidden rounded-md border border-border bg-popover shadow-lg">
                <div className="border-b border-border/60 px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground">Agentes do canal</div>
                {mentionSuggestions.map(participant => (
                  <button
                    key={participant.id}
                    type="button"
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => insertMention(participant.id)}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted/50"
                  >
                    <span className="font-medium text-foreground">@{participant.id}</span>
                    <span className="truncate pl-3 text-xs text-muted-foreground">{participant.displayName} · {participant.llmConnection}</span>
                  </button>
                ))}
              </div>
            ) : null}
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={event => {
                setDraft(event.target.value)
                updateMentionQuery(event.target.value)
              }}
              onClick={() => updateMentionQuery(draft)}
              onKeyUp={() => updateMentionQuery(draft)}
              onKeyDown={event => {
                if (event.key === 'Escape') setMentionQuery(null)
                if ((event.key === 'Tab' || event.key === 'Enter') && mentionSuggestions[0] && mentionQuery) {
                  event.preventDefault()
                  insertMention(mentionSuggestions[0].id)
                  return
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void sendMessage()
                }
              }}
              placeholder={participants.length > 0 ? `Digite @ para chamar ${participants.map(p => `@${p.id}`).join(' ')}...` : 'Adicione agentes ao canal para habilitar @menções...'}
              className="min-h-24 w-full resize-none bg-transparent px-3 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
            <div className="flex items-center justify-between border-t border-border/60 px-2 py-2">
              <span className="truncate px-1 text-xs text-muted-foreground">{currentChannel.description ?? 'Conversa compartilhada do canal'}</span>
              <button
                type="button"
                disabled={!canSend}
                onClick={() => { void sendMessage() }}
                className="inline-flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Enviar mensagem para o canal"
              >
                {isSending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              </button>
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}
