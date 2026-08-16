import { describe, expect, it } from 'bun:test'
import path from 'node:path'

import { assertTscBinIsTypescript, isLintRootName } from '../link-eslint-typescript.mjs'

// REPO_ROOT do script é resolve(dirname(script), '..'); replicamos para montar
// caminhos de realpath que caem sob node_modules/typescript vs. o alias.
const REPO_ROOT = path.resolve(import.meta.dir, '..', '..')
const typescriptBin = path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
const aliasBin = path.join(
  REPO_ROOT,
  'node_modules',
  'typescript-for-eslint',
  'bin',
  'tsc',
)

describe('isLintRootName', () => {
  it('reconhece plugins/configs com escopo e o meta-pacote', () => {
    expect(isLintRootName('@stylistic/eslint-plugin')).toBe(true)
    expect(isLintRootName('typescript-eslint')).toBe(true)
    expect(isLintRootName('eslint-plugin-x')).toBe(true)
    expect(isLintRootName('@scope/eslint-config-y')).toBe(true)
  })

  it('mantém os roots já cobertos', () => {
    expect(isLintRootName('eslint')).toBe(true)
    expect(isLintRootName('@typescript-eslint/parser')).toBe(true)
  })

  it('ignora pacotes fora da toolchain de lint', () => {
    expect(isLintRootName('react')).toBe(false)
    expect(isLintRootName('typescript')).toBe(false)
  })
})

describe('assertTscBinIsTypescript', () => {
  it('passa quando o bin resolve sob node_modules/typescript', () => {
    expect(() => assertTscBinIsTypescript(() => typescriptBin)).not.toThrow()
  })

  it('falha alto quando o bin resolve para o alias typescript-for-eslint', () => {
    expect(() => assertTscBinIsTypescript(() => aliasBin)).toThrow(
      /typescript-for-eslint/,
    )
  })

  it('falha quando o bin não existe', () => {
    expect(() =>
      assertTscBinIsTypescript(() => {
        throw new Error('ENOENT')
      }),
    ).toThrow(/não existe/)
  })
})
