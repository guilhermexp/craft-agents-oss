import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DataTable } from '../data-table'

describe('DataTable row identity', () => {
  test('uses caller stable ids after canonical rows reorder', () => {
    const columns = [{ id: 'identity', cell: ({ row }: { row: { id: string } }) => row.id }]
    const html = renderToStaticMarkup(
      <DataTable<{ id: string }, unknown>
        columns={columns}
        data={[{ id: 'entry_b' }, { id: 'entry_a' }]}
        getRowId={entry => entry.id}
      />,
    )

    expect(html).toContain('entry_b')
    expect(html).toContain('entry_a')
    expect(html).not.toContain('>0<')
  })
})
