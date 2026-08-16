#!/usr/bin/env node
/**
 * Materializa uma cópia do TypeScript com API JS (5.9.x) só para a árvore do
 * ESLint, mantendo `typescript` na raiz apontando para o port nativo (TS 7).
 *
 * POR QUE ISTO EXISTE
 * -------------------
 * `typescript@7` (port nativo em Go) não expõe API JS: `require('typescript')`
 * devolve apenas `{ version, versionMajorMinor }`. Todo o ecossistema
 * `@typescript-eslint` consome essa API — `typescript-estree` lê
 * `ts.Extension.Cjs` no topo do módulo e `ts-api-utils` lê `ts.Intrinsic` —
 * então o ESLint morre no load, antes de abrir um único arquivo:
 *
 *     TypeError: Cannot read properties of undefined (reading 'Cjs')
 *
 * Não é defasagem de plugin: a última `@typescript-eslint/*` publicada declara
 * `peerDependencies.typescript: ">=4.8.4 <6.1.0"`. Não existe release que
 * suporte TS 7.
 *
 * POR QUE NÃO `overrides`/`resolutions`
 * -------------------------------------
 * `typescript` é *peerDependency* desses pacotes, satisfeita pela raiz. Não há
 * dependência declarada para o gerenciador sobrescrever, então nem
 * `overrides` aninhado nem `resolutions` estilo yarn materializam uma cópia.
 *
 * O QUE ESTE SCRIPT FAZ
 * ---------------------
 * Caminha o fecho de dependências dos pacotes de lint (`eslint`,
 * `eslint-plugin-*`, `eslint-config-*`, `@typescript-eslint/*`), acha todo
 * pacote que declara `typescript` em deps/peerDeps/optionalDeps e cria
 * `<pacote>/node_modules/typescript` apontando para o alias
 * `typescript-for-eslint` (npm:typescript@5.9.x). A resolução do Node encontra
 * o link antes de subir até a raiz, então o linter enxerga 5.9.x e `tsc`
 * continua sendo TS 7 em todo o resto do repo.
 *
 * Roda no `postinstall` da raiz: clone limpo + `bun install` já sai lintável,
 * sem passo manual. Se um plugin novo de lint trouxer outro consumidor de
 * `typescript`, ele é descoberto automaticamente na próxima instalação.
 *
 * Ver também: docs/eslint-typescript7.md
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ALIAS_PACKAGE = 'typescript-for-eslint'
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

/** Nomes de pacote que iniciam o fecho: só a toolchain de lint. */
export function isLintRootName(name) {
  // `typescript-eslint` é o meta-pacote flat-config; `@typescript-eslint/*` são
  // os pacotes internos. Plugins/configs com escopo (`@stylistic/eslint-plugin`,
  // `@scope/eslint-config-y`) seguem a convenção do ESLint no nome *sem* escopo,
  // então descamamos o escopo antes de casar — senão o fecho ignora a subárvore
  // deles e o linter volta a crashar no próximo clone limpo.
  if (name === 'eslint' || name === 'typescript-eslint') return true
  if (name.startsWith('@typescript-eslint/')) return true
  const unscoped = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name
  return (
    unscoped === 'eslint-plugin' ||
    unscoped === 'eslint-config' ||
    unscoped.startsWith('eslint-plugin-') ||
    unscoped.startsWith('eslint-config-')
  )
}

function readPackageJson(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

/** Resolução de pacote estilo Node: sobe os `node_modules` a partir de `fromDir`. */
function resolvePackageDir(name, fromDir) {
  let dir = fromDir
  for (;;) {
    const base = path.basename(dir) === 'node_modules' ? dir : path.join(dir, 'node_modules')
    const candidate = path.join(base, name)
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function declaredDependencies(pkg) {
  return {
    ...(pkg.dependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
  }
}

/** Todo pacote no fecho da toolchain de lint que declara `typescript`. */
function findTypescriptConsumers() {
  const rootPkg = readPackageJson(REPO_ROOT)
  if (!rootPkg) throw new Error(`package.json não encontrado em ${REPO_ROOT}`)

  const rootNames = Object.keys({
    ...(rootPkg.devDependencies ?? {}),
    ...(rootPkg.dependencies ?? {}),
  }).filter(isLintRootName)

  const queue = []
  for (const name of rootNames) {
    const dir = resolvePackageDir(name, REPO_ROOT)
    if (dir) queue.push(dir)
  }

  const visited = new Set()
  const consumers = []
  while (queue.length > 0) {
    const dir = queue.shift()
    if (visited.has(dir)) continue
    visited.add(dir)

    const pkg = readPackageJson(dir)
    if (!pkg) continue

    const deps = declaredDependencies(pkg)
    if (deps.typescript) consumers.push({ name: pkg.name, dir })

    for (const dep of Object.keys(deps)) {
      if (dep === 'typescript') continue
      const depDir = resolvePackageDir(dep, dir)
      if (depDir && !visited.has(depDir)) queue.push(depDir)
    }
  }
  return consumers
}

/**
 * Cria (ou revalida) `<consumer>/node_modules/typescript` -> alias 5.9.x.
 * Devolve 'linked' | 'kept' | 'preexisting'.
 */
function linkTypescript(consumerDir, aliasDir) {
  const nestedModules = path.join(consumerDir, 'node_modules')
  const linkPath = path.join(nestedModules, 'typescript')
  const relativeTarget = path.relative(nestedModules, aliasDir)

  let existing = null
  try {
    existing = fs.lstatSync(linkPath)
  } catch {
    /* não existe */
  }

  if (existing?.isSymbolicLink()) {
    const current = fs.readlinkSync(linkPath)
    if (path.resolve(nestedModules, current) === aliasDir) return 'kept'
    fs.unlinkSync(linkPath)
  } else if (existing) {
    // Diretório real instalado pelo gerenciador: respeita e não sobrescreve.
    return 'preexisting'
  }

  fs.mkdirSync(nestedModules, { recursive: true })
  fs.symlinkSync(relativeTarget, linkPath, LINK_TYPE)
  return 'linked'
}

/**
 * Garante que `node_modules/.bin/tsc` resolve para o `typescript` da raiz (TS 7).
 *
 * POR QUE ISTO EXISTE
 * -------------------
 * O alias `typescript-for-eslint` (`npm:typescript@5.9.3`) também declara
 * `bin: { tsc }`, então disputa `node_modules/.bin/tsc` com o `typescript@7`
 * da raiz. O bun resolve o `.bin` por ordem de nome de pacote e `typescript`
 * ordena antes de `typescript-for-eslint` — mas isso é acidente, não invariante.
 * O `typecheck` de `apps/electron` é um `tsc --noEmit` pelado; se o alias 5.9.x
 * vencesse o link, o typecheck faria downgrade silencioso para TS 5 sem nenhum
 * sinal. Este assert transforma esse downgrade invisível em falha de install
 * alta e acionável. O resolvedor de realpath é injetável para testar os dois
 * caminhos sem mexer no `node_modules` real.
 */
export function assertTscBinIsTypescript(realpath = fs.realpathSync) {
  const binPath = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsc')
  const typescriptDir = path.join(REPO_ROOT, 'node_modules', 'typescript')
  let resolved
  try {
    resolved = realpath(binPath)
  } catch {
    throw new Error(
      `[link-eslint-typescript] node_modules/.bin/tsc não existe.\n` +
        '  O `typescript` da raiz (TS 7) deveria ter linkado esse bin no install.\n' +
        '  Rode `bun install` de novo; sem ele todo `typecheck:*` falha.',
    )
  }
  const withinTypescript =
    resolved === typescriptDir || resolved.startsWith(typescriptDir + path.sep)
  if (!withinTypescript) {
    throw new Error(
      `[link-eslint-typescript] node_modules/.bin/tsc resolve para\n` +
        `    ${resolved}\n` +
        `  fora de ${typescriptDir}.\n` +
        '  O alias `typescript-for-eslint` (TS 5.9.x) venceu a disputa pelo `.bin/tsc`\n' +
        '  e todo `typecheck:*` faria downgrade silencioso para TS 5. O invariante\n' +
        '  do AGENTS.md ("tsc = TS 7 em todo typecheck:*") está quebrado.\n' +
        '  Rode `rm -rf node_modules && bun install`; se persistir, o alias precisa\n' +
        '  parar de expor `bin.tsc` (import via ./node_modules/typescript-for-eslint).',
    )
  }
}

function main() {
  try {
    assertTscBinIsTypescript()
  } catch (err) {
    console.error(err.message)
    process.exitCode = 1
    return
  }

  const aliasDir = path.join(REPO_ROOT, 'node_modules', ALIAS_PACKAGE)
  const aliasPkg = readPackageJson(aliasDir)
  if (!aliasPkg) {
    console.error(
      `[link-eslint-typescript] ${ALIAS_PACKAGE} não está instalado em node_modules/.\n` +
        '  Ele é a cópia do TypeScript com API JS usada pelo ESLint (ver devDependencies da raiz).\n' +
        '  Rode `bun install` de novo; sem ele o ESLint crasha no load com "reading \'Cjs\'".',
    )
    process.exitCode = 1
    return
  }
  if (!aliasPkg.version?.startsWith('5.')) {
    console.error(
      `[link-eslint-typescript] ${ALIAS_PACKAGE} resolveu para ${aliasPkg.version}; ` +
        '@typescript-eslint exige typescript >=4.8.4 <6.1.0.',
    )
    process.exitCode = 1
    return
  }

  const consumers = findTypescriptConsumers()
  if (consumers.length === 0) {
    console.error(
      '[link-eslint-typescript] nenhum consumidor de `typescript` encontrado na árvore do ESLint. ' +
        'A toolchain de lint provavelmente não está instalada.',
    )
    process.exitCode = 1
    return
  }

  let linked = 0
  let kept = 0
  const preexisting = []
  for (const consumer of consumers) {
    const result = linkTypescript(consumer.dir, aliasDir)
    if (result === 'linked') linked += 1
    else if (result === 'kept') kept += 1
    else preexisting.push(consumer.name)
  }

  console.log(
    `[link-eslint-typescript] typescript@${aliasPkg.version} para o ESLint: ` +
      `${linked} link(s) criado(s), ${kept} já corretos, ${consumers.length} consumidor(es).`,
  )
  if (preexisting.length > 0) {
    console.log(
      `[link-eslint-typescript] cópia própria mantida em: ${preexisting.join(', ')}`,
    )
  }
}

// Só executa quando invocado direto (postinstall/CLI); import de teste não roda.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
