import { describe, expect, it } from 'bun:test'
import { strToU8, zipSync } from 'fflate'
import {
  buildTabularPreviewCodeFromPlainPath,
  parseDelimitedTabularData,
  parseXlsxTabularData,
} from '../tabular-preview'

function parsePreview(code: string): unknown {
  return JSON.parse(code)
}

describe('buildTabularPreviewCodeFromPlainPath', () => {
  it('builds a datatable spec for absolute CSV paths in txt blocks', () => {
    const result = buildTabularPreviewCodeFromPlainPath('/Users/tester/output/report.csv', 'txt')

    expect(result?.blockType).toBe('datatable')
    expect(parsePreview(result!.previewCode)).toEqual({
      src: '/Users/tester/output/report.csv',
      title: 'report.csv',
    })
  })

  it('builds a spreadsheet spec for absolute XLSX paths in plain blocks', () => {
    const result = buildTabularPreviewCodeFromPlainPath('"/Users/tester/output/report.xlsx"', undefined)

    expect(result?.blockType).toBe('spreadsheet')
    expect(parsePreview(result!.previewCode)).toEqual({
      src: '/Users/tester/output/report.xlsx',
      filename: 'report.xlsx',
    })
  })

  it('does not infer previews for non-plain languages or relative paths', () => {
    expect(buildTabularPreviewCodeFromPlainPath('/Users/tester/report.csv', 'bash')).toBeNull()
    expect(buildTabularPreviewCodeFromPlainPath('output/report.csv', 'txt')).toBeNull()
  })
})

describe('parseDelimitedTabularData', () => {
  it('parses quoted CSV rows and infers numeric columns', () => {
    const result = parseDelimitedTabularData('Name,Total\n"ACME, Inc.",12\nBeta,9', '/tmp/report.csv')

    expect(result.title).toBe('report.csv')
    expect(result.columns).toEqual([
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'total', label: 'Total', type: 'number' },
    ])
    expect(result.rows).toEqual([
      { name: 'ACME, Inc.', total: 12 },
      { name: 'Beta', total: 9 },
    ])
  })

  it('parses TSV files', () => {
    const result = parseDelimitedTabularData('Name\tTotal\nAlpha\t1', '/tmp/report.tsv')

    expect(result.rows).toEqual([{ name: 'Alpha', total: 1 }])
  })

  it('detects semicolon-separated CSV files', () => {
    const result = parseDelimitedTabularData(
      'Ordem;Filial;CNPJ;Parceiro;Valor unitario\n1;1101;16.404.287/0047-38;SUZANO PAPEL E CELULOSE;R$ 210',
      '/tmp/relatorio-lote-suzano-15360.csv',
    )

    expect(result.columns.map((column) => column.label)).toEqual([
      'Ordem',
      'Filial',
      'CNPJ',
      'Parceiro',
      'Valor unitario',
    ])
    expect(result.rows).toEqual([
      {
        ordem: 1,
        filial: 1101,
        cnpj: '16.404.287/0047-38',
        parceiro: 'SUZANO PAPEL E CELULOSE',
        valor_unitario: 'R$ 210',
      },
    ])
  })
})

describe('parseXlsxTabularData', () => {
  it('parses the first worksheet from a simple XLSX file', () => {
    const files = {
      'xl/workbook.xml': strToU8(
        '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      'xl/sharedStrings.xml': strToU8(
        '<sst><si><t>Name</t></si><si><t>Total</t></si><si><t>Alpha</t></si><si><t>Beta</t></si></sst>',
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        '<worksheet><sheetData>' +
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
          '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>3</v></c></row>' +
          '<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>7</v></c></row>' +
        '</sheetData></worksheet>',
      ),
    }

    const data = zipSync(files)
    const result = parseXlsxTabularData(data, '/tmp/report.xlsx')

    expect(result.filename).toBe('report.xlsx')
    expect(result.sheetName).toBe('Summary')
    expect(result.columns).toEqual([
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'total', label: 'Total', type: 'number' },
    ])
    expect(result.rows).toEqual([
      { name: 'Alpha', total: 3 },
      { name: 'Beta', total: 7 },
    ])
  })
})
