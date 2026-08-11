import { describe, expect, it } from 'bun:test'
import {
  createEmbeddedBoundsReporter,
  dockEmbeddedBrowser,
  isConcealedByOverlays,
  releaseEmbeddedBrowser,
  type EmbeddedBrowserPaneApi,
  type EmbeddedBrowserRect,
} from '@/hooks/embedded-browser-view'
import { resolveBrowserDockRoute } from '@/components/app-shell/browser-dock-routing'
import { buildMeetingAskContext } from '@/components/app-shell/meeting-ask-context'

type PaneCall =
  | { call: 'displayMode'; instanceId: string; mode: 'floating' | 'integrated' }
  | { call: 'bounds'; instanceId: string; rect: EmbeddedBrowserRect }
  | { call: 'visible'; instanceId: string; visible: boolean }

interface FakePane {
  api: EmbeddedBrowserPaneApi
  calls: PaneCall[]
}

/** `accept` decide o retorno de cada RPC — é assim que o main rejeita bounds. */
function fakePane(accept: { displayMode?: boolean; bounds?: boolean } = {}): FakePane {
  const calls: PaneCall[] = []
  return {
    calls,
    api: {
      setDisplayMode: async (instanceId, mode) => {
        calls.push({ call: 'displayMode', instanceId, mode })
        return accept.displayMode ?? true
      },
      setEmbeddedBounds: async (instanceId, rect) => {
        calls.push({ call: 'bounds', instanceId, rect })
        return accept.bounds ?? true
      },
      setViewsVisible: async (instanceId, visible) => {
        calls.push({ call: 'visible', instanceId, visible })
        return true
      },
    },
  }
}

/** Deixa as promises encadeadas dentro dos helpers assentarem. */
const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

const rect = (overrides: Partial<EmbeddedBrowserRect> = {}): EmbeddedBrowserRect => ({
  x: 10,
  y: 20,
  width: 800,
  height: 600,
  ...overrides,
})

describe('roteamento do pedido de dock', () => {
  it('encaixa na página de Reuniões sem nenhuma sessão de chat selecionada', () => {
    expect(resolveBrowserDockRoute(
      { instanceId: 'browser-1', mode: 'integrated' },
      { workspaceId: 'ws-1', previewSessionId: null, meetingsActive: true },
    )).toEqual({ kind: 'meetings-host' })
  })

  it('a página de Reuniões vence o preview do chat enquanto está aberta', () => {
    // O preview é session-scoped e fica atrás da página: encaixar lá seria um
    // browser que o usuário não vê.
    expect(resolveBrowserDockRoute(
      { instanceId: 'browser-1', mode: 'integrated' },
      { workspaceId: 'ws-1', previewSessionId: 'session-1', meetingsActive: true },
    )).toEqual({ kind: 'meetings-host' })
  })

  it('sem a página de Reuniões o dock continua indo para o preview da sessão', () => {
    expect(resolveBrowserDockRoute(
      { instanceId: 'browser-1', mode: 'integrated' },
      { workspaceId: 'ws-1', previewSessionId: 'session-1', meetingsActive: false },
    )).toEqual({ kind: 'preview-tab' })
  })

  it('sem sessão e fora da página de Reuniões o browser continua janela', () => {
    expect(resolveBrowserDockRoute(
      { instanceId: 'browser-1', mode: 'integrated' },
      { workspaceId: 'ws-1', previewSessionId: null, meetingsActive: false },
    )).toEqual({ kind: 'ignore' })
  })

  it('sem workspace não há onde hospedar', () => {
    expect(resolveBrowserDockRoute(
      { instanceId: 'browser-1', mode: 'integrated' },
      { workspaceId: null, previewSessionId: null, meetingsActive: true },
    )).toEqual({ kind: 'ignore' })
  })

  it('pedido de desencaixe libera os dois hosts', () => {
    expect(resolveBrowserDockRoute(
      { instanceId: 'browser-1', mode: 'floating' },
      { workspaceId: 'ws-1', previewSessionId: null, meetingsActive: true },
    )).toEqual({ kind: 'release' })
  })
})

describe('mecânica de embed compartilhada', () => {
  it('encaixa e só então revela', async () => {
    const pane = fakePane()

    expect(await dockEmbeddedBrowser(pane.api, 'browser-1')).toBe(true)

    expect(pane.calls).toEqual([
      { call: 'displayMode', instanceId: 'browser-1', mode: 'integrated' },
      { call: 'visible', instanceId: 'browser-1', visible: true },
    ])
  })

  it('não revela quando o main recusa o encaixe', async () => {
    const pane = fakePane({ displayMode: false })

    expect(await dockEmbeddedBrowser(pane.api, 'browser-1')).toBe(false)

    expect(pane.calls.some((entry) => entry.call === 'visible')).toBe(false)
  })

  it('não revela quando o host desmontou durante o encaixe', async () => {
    const pane = fakePane()

    // O cleanup já ocultou/devolveu a instância; revelar depois deixaria a
    // janela pintando sobre uma superfície que não existe mais.
    expect(await dockEmbeddedBrowser(pane.api, 'browser-1', () => true)).toBe(false)

    expect(pane.calls.some((entry) => entry.call === 'visible')).toBe(false)
  })

  it('reporta o retângulo medido e ignora repetições', async () => {
    const pane = fakePane()
    const reporter = createEmbeddedBoundsReporter(pane.api, 'browser-1')

    reporter.report(rect())
    reporter.report(rect())
    await settle()

    expect(pane.calls).toEqual([
      { call: 'bounds', instanceId: 'browser-1', rect: rect() },
    ])
  })

  it('esquece o retângulo recusado para que a retentativa com o mesmo valor passe', async () => {
    const pane = fakePane({ bounds: false })
    const reporter = createEmbeddedBoundsReporter(pane.api, 'browser-1')

    reporter.report(rect())
    await settle()
    reporter.report(rect())
    await settle()

    expect(pane.calls.filter((entry) => entry.call === 'bounds')).toHaveLength(2)
  })

  it('ignora retângulos sub-pixel de layout intermediário', async () => {
    const pane = fakePane()
    const reporter = createEmbeddedBoundsReporter(pane.api, 'browser-1')

    reporter.report(rect({ width: 0.4 }))
    reporter.report(rect({ height: 0 }))
    reporter.report(null)
    await settle()

    expect(pane.calls).toEqual([])
  })

  it('envia propriedades próprias: um DOMRect não atravessa o contextBridge', async () => {
    const pane = fakePane()
    const reporter = createEmbeddedBoundsReporter(pane.api, 'browser-1')

    // `getBoundingClientRect()` devolve um DOMRect, cujos campos são todos
    // acessores do protótipo. O contextBridge copia só propriedades próprias,
    // então repassar o DOMRect entrega `{}` no main e cada eixo vira NaN.
    const domRectLike = Object.create({
      get x() { return 10 },
      get y() { return 20 },
      get width() { return 800 },
      get height() { return 600 },
    }) as EmbeddedBrowserRect

    reporter.report(domRectLike)
    await settle()

    const sent = pane.calls.find((entry) => entry.call === 'bounds')
    expect(sent?.call === 'bounds' && Object.keys(sent.rect).sort()).toEqual(['height', 'width', 'x', 'y'])
    expect(sent?.call === 'bounds' && sent.rect).toEqual(rect())
  })

  it('esconder a pane não desencaixa: trocar de aba não devolve a janela', () => {
    const pane = fakePane()

    releaseEmbeddedBrowser(pane.api, 'browser-1', 'conceal')

    expect(pane.calls).toEqual([
      { call: 'visible', instanceId: 'browser-1', visible: false },
    ])
  })

  it('desmontar o host da página devolve a instância ao modo flutuante', () => {
    const pane = fakePane()

    releaseEmbeddedBrowser(pane.api, 'browser-1', 'floating')

    // Uma instância deixada integrada sem host é uma janela órfã.
    expect(pane.calls).toEqual([
      { call: 'displayMode', instanceId: 'browser-1', mode: 'floating' },
    ])
  })

  it('esconde as views só quando um overlay cobre o buraco', () => {
    const hole = rect({ x: 100, y: 100, width: 400, height: 300 })

    expect(isConcealedByOverlays(hole, [rect({ x: 300, y: 200, width: 200, height: 200 })])).toBe(true)
    // Menu na sidebar distante não pode apagar o browser.
    expect(isConcealedByOverlays(hole, [rect({ x: 0, y: 0, width: 80, height: 900 })])).toBe(false)
    // Overlay montado mas ainda sem geometria.
    expect(isConcealedByOverlays(hole, [rect({ x: 100, y: 100, width: 0, height: 0 })])).toBe(false)
    expect(isConcealedByOverlays(hole, [])).toBe(false)
  })
})

describe('sessão de agente sobre a reunião hospedada', () => {
  it('recebe a identidade da reunião e a transcrição disponível', () => {
    const context = buildMeetingAskContext({
      title: 'Weekly sync',
      url: 'https://meet.google.com/abc-defg-hij',
      transcriptText: 'Ana: começamos',
      loading: false,
      live: true,
    })

    expect(context.context).toContain('Meeting: Weekly sync')
    expect(context.context).toContain('URL: https://meet.google.com/abc-defg-hij')
    expect(context.context).toContain('Ana: começamos')
  })

  it('avisa que a call está em curso e a transcrição é parcial', () => {
    const live = buildMeetingAskContext({
      title: 'Weekly sync',
      transcriptText: 'Ana: começamos',
      loading: false,
      live: true,
    })
    const ended = buildMeetingAskContext({
      title: 'Weekly sync',
      transcriptText: 'Ana: começamos',
      loading: false,
      live: false,
    })

    expect(live.context).toContain('happening right now')
    expect(ended.context).not.toContain('happening right now')
  })

  it('reunião ao vivo ainda sem falas não é transcrição indisponível', () => {
    const live = buildMeetingAskContext({ title: 'Weekly sync', transcriptText: '', loading: false, live: true })
    const ended = buildMeetingAskContext({ title: 'Weekly sync', transcriptText: '', loading: false, live: false })

    expect(live.context).toContain('(nothing transcribed yet)')
    expect(ended.context).toContain('(transcript unavailable)')
  })

  it('mantém a transcrição já carregada visível enquanto a próxima busca corre', () => {
    const context = buildMeetingAskContext({
      title: 'Weekly sync',
      transcriptText: 'Ana: começamos',
      loading: true,
      live: true,
    })

    expect(context.context).toContain('Ana: começamos')
    expect(context.context).not.toContain('loading transcript')
  })
})
