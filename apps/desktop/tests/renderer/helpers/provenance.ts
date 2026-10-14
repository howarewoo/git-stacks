import { createHash } from 'node:crypto'
import { glob, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

let pending: Promise<{ fingerprint: string; files: Record<string, string> }> | undefined

/** Hash actual renderer/main/preload/shared/UI inputs, not a fixture version label. */
export function sourceProvenance(root = process.cwd()) {
  return (pending ??= (async () => {
    const paths: string[] = []
    for await (const path of glob(
      [
        'src/**/*.{ts,tsx,css,json}',
        '../../packages/shared/src/**/*.{ts,tsx,css,json}',
        '../../packages/ui/src/**/*.{ts,tsx,css,json}',
        'tests/renderer/**/*.{ts,tsx,css}',
        'scripts/perf/**/*.{ts,mjs,cjs}',
        'electron*.config.*',
        'vite*.config.*',
        'package.json',
        '../../pnpm-lock.yaml',
      ],
      { cwd: root },
    ))
      paths.push(path)
    paths.sort()
    const files = Object.fromEntries(
      await Promise.all(
        paths.map(async (path) => [
          path,
          createHash('sha256')
            .update(await readFile(resolve(root, path)))
            .digest('hex'),
        ]),
      ),
    )
    return { fingerprint: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files }
  })())
}
