import { execFile, type ExecFileException } from 'node:child_process'
import { closeSync, openSync, readSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { promisify } from 'node:util'
import { mainLog } from '../logger'

const execFileAsync = promisify(execFile)

export type RemuxOutcome = 'remuxed' | 'skipped'

export interface RemuxResult {
  outcome: RemuxOutcome
  /** Tamanho do arquivo final, em bytes (remux adiciona cues e muda o tamanho). */
  size: number
}

type ExecFileLike = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>

const REMUX_TIMEOUT_MS = 10 * 60_000
const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])

/**
 * Regrava o `.webm` do MediaRecorder com `-c copy` para escrever o elemento
 * Duration e os Cues que ele nunca escreve. Sem isso, players (Chromium
 * incluso) mostram duração infinita e não deixam seekar — exatamente o caso da
 * prévia da gravação. O arquivo original só é substituído quando a saída do
 * remux existe, é EBML válida e não vazia; qualquer falha deixa o original
 * intocado e devolve `skipped`.
 *
 * `execFileFn` é injetável para teste (o binário `ffmpeg` pode não existir).
 */
export async function remuxWebmForSeek(
  filePath: string,
  execFileFn: ExecFileLike = execFileAsync as unknown as ExecFileLike,
): Promise<RemuxResult> {
  const originalSize = statSync(filePath).size
  const head = Buffer.alloc(4)
  const fd = openSync(filePath, 'r')
  try {
    readSync(fd, head, 0, 4, 0)
  } finally {
    closeSync(fd)
  }
  // Sem magic EBML não há o que remuxar — e spawnar o ffmpeg contra um arquivo
  // inválido é custo garantido de falha. Sealed recordings são sempre webm.
  if (!head.equals(EBML_MAGIC)) {
    mainLog.warn(`[meetings] remux skipped for ${filePath}: input is not a valid EBML/webm`)
    return { outcome: 'skipped', size: originalSize }
  }
  const tmpPath = `${filePath}.remux-tmp`
  const cleanupTmp = () => {
    try { unlinkSync(tmpPath) } catch { /* inexistente: nada a limpar */ }
  }
  try {
    // `-f webm`: o arquivo temporário não tem extensão reconhecível e o ffmpeg
    // infere o formato de saída pela extensão — sem isso o muxer falha.
    await execFileFn('ffmpeg', ['-y', '-v', 'error', '-i', filePath, '-c', 'copy', '-f', 'webm', tmpPath], {
      timeout: REMUX_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    })
    const stat = statSync(tmpPath)
    if (stat.size === 0) throw new Error('remux produced an empty file')
    const head = Buffer.alloc(4)
    const fd = openSync(tmpPath, 'r')
    try {
      readSync(fd, head, 0, 4, 0)
    } finally {
      closeSync(fd)
    }
    if (!head.equals(EBML_MAGIC)) throw new Error('remux output is not a valid EBML/webm')
    renameSync(tmpPath, filePath)
    mainLog.info(`[meetings] remuxed recording for seek: ${filePath} (${originalSize} -> ${stat.size} bytes)`)
    return { outcome: 'remuxed', size: stat.size }
  } catch (error) {
    cleanupTmp()
    const execError = error as ExecFileException & { code?: string }
    const reason = execError.code === 'ENOENT'
      ? 'ffmpeg not found on PATH'
      : error instanceof Error ? error.message : String(error)
    mainLog.warn(`[meetings] remux skipped for ${filePath}: ${reason}`)
    return { outcome: 'skipped', size: originalSize }
  }
}
