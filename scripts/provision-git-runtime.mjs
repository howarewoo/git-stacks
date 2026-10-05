#!/usr/bin/env node
// Build-time only: pin the upstream release archive before extracting any executable.
import { execFileSync } from 'node:child_process'
import {
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { get } from 'node:https'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { digest, inventory } from './git-runtime-inventory.cjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const runtimeRoot = join(root, 'resources', 'git')
const platform = `${process.platform}-${process.arch}`
const appVersion = JSON.parse(readFileSync(join(root, 'package.json'))).version
const releases = {
  'darwin-arm64': [
    'macOS-arm64',
    'f9dc64635a5b62fbd7ad95db73268bbb8912255ac516d65d37bf7af22fcb8ffe',
  ],
  'darwin-x64': ['macOS-x64', 'ae6686718aa34f4140424db16b92a47dcffd6d1f312eb8b5f3b267f7404e2680'],
  'linux-arm': ['ubuntu-arm', '9d858586217c24abed503cd5243fd8b7e3711d9fde5c6d9717d1434022193820'],
  'linux-arm64': [
    'ubuntu-arm64',
    'a161f45af4626bb7e0c688854bd4a9aee47cc514bca404cff0a5e3536ef1c0af',
  ],
  'linux-x64': ['ubuntu-x64', 'cca76aa31ad9e835e771ee7f55b73934777fbd8d16757a10d307ba06de860901'],
  'win32-arm64': [
    'windows-arm64',
    '1abbeb3a2ce06e9b80e75bb888dce959b6c73bdb11ccc670a01a71d64f4422a5',
  ],
  'win32-x64': ['windows-x64', '7b76bc5c32c0d7c5984efdc2a8a32697cf1e8a43bc55176fbf9869c0ee995130'],
}
const release = releases[platform]
if (!release) throw new Error(`No pinned Git runtime for ${platform}`)
const [archivePlatform, expectedDigest] = release
const tag = 'v2.53.0-4'
const filename = `dugite-native-v2.53.0-4098283-${archivePlatform}.tar.gz`
const source = `https://github.com/desktop/dugite-native/releases/download/${tag}/${filename}`
const cache = join(runtimeRoot, '.provision')
const archive = join(cache, filename)

async function download(url, destination, redirects = 0) {
  if (redirects > 5 || !url.startsWith('https://')) throw new Error('Unexpected release redirect')
  await new Promise((done, fail) => {
    get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        response.resume()
        download(new URL(response.headers.location, url).href, destination, redirects + 1).then(
          done,
          fail,
        )
      } else if (response.statusCode === 200) {
        pipeline(response, createWriteStream(destination, { flags: 'wx' })).then(done, fail)
      } else {
        response.resume()
        fail(new Error(`Release download failed: HTTP ${response.statusCode}`))
      }
    }).on('error', fail)
  })
}

const executableRelativePath = process.platform === 'win32' ? 'cmd/git.exe' : 'bin/git'

const destination = join(runtimeRoot, platform)
const manifestPath = join(runtimeRoot, 'runtime-manifest.json')
if (existsSync(destination)) {
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath)) : null
  const entry = manifest?.platforms?.[platform]
  if (
    manifest?.appVersion !== appVersion ||
    entry?.source !== `${source}#sha256=${expectedDigest}` ||
    entry.gitVersion !== '2.53.0' ||
    entry.sha256 !== digest(join(destination, executableRelativePath)) ||
    JSON.stringify(entry.files) !== JSON.stringify(inventory(destination))
  )
    throw new Error(
      `Existing ${platform} runtime does not match the pinned release; preserve it for inspection`,
    )
  console.log(`Existing ${platform} pinned runtime verified`)
  process.exit(0)
}

mkdirSync(cache, { recursive: true })
if (!existsSync(archive)) {
  try {
    await download(source, archive)
  } catch (error) {
    rmSync(archive, { force: true })
    throw error
  }
}
if (digest(archive) !== expectedDigest) throw new Error(`Pinned SHA-256 mismatch for ${filename}`)
if (existsSync(destination))
  throw new Error(`${destination} already exists; preserve it for inspection`)
mkdirSync(destination)
try {
  execFileSync('tar', ['-xzf', archive, '-C', destination], { stdio: 'inherit' })
  const executable = join(destination, executableRelativePath)
  if (!statSync(executable).isFile() || lstatSync(executable).isSymbolicLink())
    throw new Error('Runtime executable is not a regular file')
  const gitVersion = /(\d+\.\d+\.\d+)/u.exec(
    execFileSync(executable, ['--version'], { encoding: 'utf8' }),
  )?.[1]
  if (gitVersion !== '2.53.0') throw new Error(`Unexpected runtime Git version: ${gitVersion}`)
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : {
        appVersion,
        platforms: {},
      }
  if (manifest.appVersion !== appVersion || manifest.platforms[platform]) {
    throw new Error('Existing manifest conflicts with this release/platform')
  }
  manifest.platforms[platform] = {
    gitVersion,
    sha256: digest(executable),
    source: `${source}#sha256=${expectedDigest}`,
    files: inventory(destination),
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  rmSync(cache, { recursive: true, force: true })
  console.log(
    `Provisioned ${platform} Git ${gitVersion} from pinned ${tag}; ${Object.keys(manifest.platforms[platform].files).length} files recorded`,
  )
} catch (error) {
  rmSync(destination, { recursive: true, force: true })
  throw error
}
