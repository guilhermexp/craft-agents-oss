import { describe, expect, it } from 'bun:test'

import { HermesEventAdapter } from './event-adapter.ts'

describe('HermesEventAdapter', () => {
  it('normalizes Hermes file and shell tools into Craft-native timeline events', () => {
    const adapter = new HermesEventAdapter()
    adapter.startTurn()

    const readStart = adapter.adaptToolCall({
      toolCallId: 'tool-read-1',
      toolName: 'read_file',
      args: { path: '/repo/src/App.tsx', offset: 10, limit: 5 },
    })
    expect(readStart).toEqual([
      expect.objectContaining({
        type: 'tool_start',
        toolUseId: 'tool-read-1',
        toolName: 'Read',
        input: {
          file_path: '/repo/src/App.tsx',
          offset: 10,
          limit: 5,
        },
        displayName: 'Read File',
      }),
    ])

    const readResult = adapter.adaptToolResult({
      toolCallId: 'tool-read-1',
      toolName: 'read_file',
      args: { path: '/repo/src/App.tsx', offset: 10, limit: 5 },
      output: { content: '10|export function App() {}', total_lines: 20 },
    })
    expect(readResult).toEqual([
      expect.objectContaining({
        type: 'tool_result',
        toolUseId: 'tool-read-1',
        toolName: 'Read',
        result: '10|export function App() {}',
        isError: false,
      }),
    ])

    const shellReadStart = adapter.adaptToolCall({
      toolCallId: 'tool-shell-read-1',
      toolName: 'terminal',
      args: { command: "sed -n '1,20p' packages/shared/src/agent/hermes-agent.ts" },
    })
    expect(shellReadStart).toEqual([
      expect.objectContaining({
        type: 'tool_start',
        toolUseId: 'tool-shell-read-1',
        toolName: 'Read',
        input: expect.objectContaining({
          file_path: 'packages/shared/src/agent/hermes-agent.ts',
          offset: 1,
          limit: 20,
          _command: "sed -n '1,20p' packages/shared/src/agent/hermes-agent.ts",
        }),
        displayName: 'Read File',
      }),
    ])
  })

  it('emits intermediate text before a tool and a final text block after tools', () => {
    const adapter = new HermesEventAdapter()
    adapter.startTurn()

    expect(adapter.adaptTextDelta('Vou ler o arquivo.')).toEqual([
      expect.objectContaining({ type: 'text_delta', text: 'Vou ler o arquivo.' }),
    ])

    const beforeTool = adapter.adaptToolCall({
      toolCallId: 'tool-read-2',
      toolName: 'read_file',
      args: { path: '/repo/package.json' },
    })
    expect(beforeTool[0]).toEqual(expect.objectContaining({
      type: 'text_complete',
      text: 'Vou ler o arquivo.',
      isIntermediate: true,
    }))
    expect(beforeTool[1]).toEqual(expect.objectContaining({
      type: 'tool_start',
      toolName: 'Read',
    }))

    expect(adapter.adaptTextDelta('Pronto.')).toEqual([
      expect.objectContaining({ type: 'text_delta', text: 'Pronto.' }),
    ])
    expect(adapter.flushFinalText()).toEqual(expect.objectContaining({
      type: 'text_complete',
      text: 'Pronto.',
      isIntermediate: false,
    }))
  })

  it('normalizes write, edit, python, search, and skill tools for native display', () => {
    const adapter = new HermesEventAdapter()
    adapter.startTurn()

    expect(adapter.adaptToolCall({
      toolCallId: 'write-1',
      toolName: 'write_file',
      args: { path: '/repo/src/new.ts', content: 'hello' },
    })[0]).toEqual(expect.objectContaining({
      type: 'tool_start',
      toolName: 'Write',
      input: { file_path: '/repo/src/new.ts', content: 'hello' },
      displayName: 'Write File',
    }))

    expect(adapter.adaptToolCall({
      toolCallId: 'edit-1',
      toolName: 'patch',
      args: { path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' },
    })[0]).toEqual(expect.objectContaining({
      type: 'tool_start',
      toolName: 'Edit',
      input: { file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' },
      displayName: 'Edit File',
    }))

    expect(adapter.adaptToolCall({
      toolCallId: 'edit-patch-1',
      toolName: 'patch',
      args: {
        mode: 'patch',
        patch: `*** Begin Patch
*** Update File: packages/shared/src/agent/hermes-agent.ts
@@
-old line
+new line
*** End Patch`,
      },
    })[0]).toEqual(expect.objectContaining({
      type: 'tool_start',
      toolName: 'Edit',
      input: expect.objectContaining({
        changes: [{
          path: 'packages/shared/src/agent/hermes-agent.ts',
          diff: `--- a/packages/shared/src/agent/hermes-agent.ts
+++ b/packages/shared/src/agent/hermes-agent.ts
@@
-old line
+new line`,
        }],
      }),
      displayName: 'Edit File',
    }))

    expect(adapter.adaptToolCall({
      toolCallId: 'py-1',
      toolName: 'execute_code',
      args: { code: 'from hermes_tools import terminal' },
    })[0]).toEqual(expect.objectContaining({
      type: 'tool_start',
      toolName: 'Python',
      input: { code: 'from hermes_tools import terminal' },
      displayName: 'Python',
    }))

    expect(adapter.adaptToolCall({
      toolCallId: 'search-1',
      toolName: 'search_files',
      args: { pattern: 'HermesAgent', path: '/repo' },
    })[0]).toEqual(expect.objectContaining({
      type: 'tool_start',
      toolName: 'Search',
      input: { pattern: 'HermesAgent', path: '/repo' },
      displayName: 'Search Files',
    }))

    expect(adapter.adaptToolCall({
      toolCallId: 'skill-1',
      toolName: 'skill_view',
      args: { name: 'hermes-agent' },
    })[0]).toEqual(expect.objectContaining({
      type: 'tool_start',
      toolName: 'Skill',
      input: { name: 'hermes-agent' },
      displayName: 'Skill View',
    }))
  })

  it('drains pending tool_starts as error results when the turn aborts mid-flight', () => {
    const adapter = new HermesEventAdapter()
    adapter.startTurn()

    adapter.adaptToolCall({
      toolCallId: 'tool-pending-1',
      toolName: 'read_file',
      args: { path: '/repo/src/App.tsx' },
    })
    adapter.adaptToolCall({
      toolCallId: 'tool-pending-2',
      toolName: 'terminal',
      args: { command: 'ls' },
    })

    const drained = adapter.drainPendingTools('turn aborted')
    expect(drained).toHaveLength(2)
    expect(drained[0]).toEqual(expect.objectContaining({
      type: 'tool_result',
      toolUseId: 'tool-pending-1',
      isError: true,
      result: '[aborted: turn aborted]',
    }))
    expect(drained[1]).toEqual(expect.objectContaining({
      type: 'tool_result',
      toolUseId: 'tool-pending-2',
      isError: true,
    }))

    // Second drain returns nothing — adapter clears state.
    expect(adapter.drainPendingTools('turn aborted')).toEqual([])
  })

  it('emits every drained tool_result before the error event (chatImpl catch order)', () => {
    const adapter = new HermesEventAdapter()
    adapter.startTurn()

    adapter.adaptToolCall({
      toolCallId: 'tool-pending-1',
      toolName: 'read_file',
      args: { path: '/repo/src/App.tsx' },
    })
    adapter.adaptToolCall({
      toolCallId: 'tool-pending-2',
      toolName: 'terminal',
      args: { command: 'ls' },
    })

    // Reproduce the exact emission order of hermes-agent chatImpl's catch path:
    // drained tool_result events first, then the terminal error event. If the
    // error were yielded first the renderer would clear before seeing the
    // results and the fix would be inert.
    const emitted = [
      ...adapter.drainPendingTools('turn aborted'),
      { type: 'error', message: 'boom' } as const,
    ]

    const errorIndex = emitted.findIndex(event => event.type === 'error')
    const lastToolResultIndex = emitted.reduce(
      (last, event, index) => (event.type === 'tool_result' ? index : last),
      -1,
    )

    expect(errorIndex).toBe(emitted.length - 1)
    expect(lastToolResultIndex).toBeLessThan(errorIndex)
    expect(emitted.filter(event => event.type === 'tool_result')).toHaveLength(2)
  })
})
