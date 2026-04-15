import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

function setupConfigDir() {
  const configDir = mkdtempSync(join(tmpdir(), 'craft-agent-theme-'))
  const workspaceRoot = join(configDir, 'workspaces', 'theme-workspace')
  mkdirSync(workspaceRoot, { recursive: true })

  writeFileSync(
    join(workspaceRoot, 'config.json'),
    JSON.stringify(
      {
        id: 'ws-theme-1',
        name: 'Theme Workspace',
        slug: 'theme-workspace',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      null,
      2,
    ),
    'utf-8',
  )

  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify(
      {
        workspaces: [
          {
            id: 'ws-theme-1',
            name: 'Theme Workspace',
            rootPath: workspaceRoot,
            createdAt: Date.now(),
          },
        ],
        activeWorkspaceId: 'ws-theme-1',
        activeSessionId: null,
      },
      null,
      2,
    ),
    'utf-8',
  )

  return { configDir }
}

describe('app theme storage', () => {
  it('loads local scenic background images as data URLs and clears overrides', () => {
    const { configDir } = setupConfigDir()
    const imagePath = join(configDir, 'custom-bg.png')

    writeFileSync(
      imagePath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5WnXcAAAAASUVORK5CYII=',
        'base64',
      ),
    )

    const run = Bun.spawnSync(
      [
        process.execPath,
        '--eval',
        `
          import { existsSync } from 'fs';
          import { loadAppTheme, saveAppTheme, getAppThemePath } from '${STORAGE_MODULE_PATH}';

          saveAppTheme({ mode: 'scenic', backgroundImage: ${JSON.stringify(imagePath)} });
          const loaded = loadAppTheme();
          if (!loaded?.backgroundImage?.startsWith('data:image/png;base64,')) {
            throw new Error('Expected loadAppTheme to resolve local images to data URLs');
          }

          saveAppTheme(null);
          if (existsSync(getAppThemePath())) {
            throw new Error('Expected saveAppTheme(null) to remove theme.json');
          }
        `,
      ],
      {
        env: {
          ...process.env,
          CRAFT_CONFIG_DIR: configDir,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    if (run.exitCode !== 0) {
      throw new Error(
        `theme storage subprocess failed (exit ${run.exitCode})\nstdout:\n${run.stdout.toString()}\nstderr:\n${run.stderr.toString()}`,
      )
    }

    expect(readFileSync(imagePath).length).toBeGreaterThan(0)
  })
})
