/**
 * Test-only ESM resolver for the local Team plugins.
 *
 * DSH resolves profile peer dependencies through its own runtime resolution
 * map. Plain `node --test` does not have that map, so this hook maps only the
 * @deepseek-ai packages used by the profile plugins to the copies already
 * installed for the current DSH application. It does not modify runtime
 * configuration or profile state.
 */

import { createRequire, registerHooks } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const APP_NODE_MODULES = 'D:/dsh-test/app/node_modules'
const PROFILE_NODE_MODULES = 'D:/dsh-test/home/profiles/web/node_modules'
const PNPM_ROOT = join(APP_NODE_MODULES, '.pnpm')

const packageDirs = new Map()

function packageName(specifier) {
  if (!specifier.startsWith('@deepseek-ai/')) return undefined
  const parts = specifier.split('/')
  return parts.length >= 2 ? parts[0] + '/' + parts[1] : undefined
}

function findPackageDir(name) {
  if (packageDirs.has(name)) return packageDirs.get(name)
  const [scope, pkg] = name.split('/')
  const candidates = [
    join(PROFILE_NODE_MODULES, scope, pkg),
    join(APP_NODE_MODULES, scope, pkg),
  ]
  if (existsSync(PNPM_ROOT)) {
    for (const entry of readdirSync(PNPM_ROOT, { withFileTypes: true })) {
      candidates.push(join(PNPM_ROOT, entry.name, 'node_modules', scope, pkg))
    }
  }
  const found = candidates.find((candidate) => existsSync(join(candidate, 'package.json')))
  packageDirs.set(name, found)
  return found
}

function resolvePackage(specifier, parentURL) {
  const absolute = specifier.startsWith('file:')
    ? fileURLToPath(specifier)
    : specifier.startsWith('.') && parentURL !== undefined
      ? fileURLToPath(new URL(specifier, parentURL))
      : specifier
  const absoluteMarker = APP_NODE_MODULES.replaceAll('\\', '/') + '/@deepseek-ai/'
  if (absolute.replaceAll('\\', '/').startsWith(absoluteMarker)) {
    const relative = absolute.replaceAll('\\', '/').slice(absoluteMarker.length)
    const parts = relative.split('/')
    const name = '@deepseek-ai/' + parts[0]
    const dir = findPackageDir(name)
    if (process.env.DSH_TEST_RESOLVER_DEBUG === '1') {
      console.error('[test-resolver] absolute', specifier, '=>', name, dir)
    }
    if (dir !== undefined) {
      const candidate = join(dir, ...parts.slice(1))
      if (existsSync(candidate)) return candidate
    }
  }
  const name = packageName(specifier)
  if (name === undefined) return undefined
  const dir = findPackageDir(name)
  if (dir === undefined) return undefined
  const manifestPath = join(dir, 'package.json')
  try {
    return createRequire(manifestPath).resolve(specifier)
  } catch {
    // Fall through to the package export for ESM-only packages and subpaths.
  }
  const subpath = specifier.slice(name.length)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (subpath.length === 0) {
    const entry = manifest.exports?.['.']?.default ?? manifest.module ?? manifest.main
    if (typeof entry === 'string') {
      const candidate = join(dir, entry)
      if (existsSync(candidate)) return candidate
    }
  } else {
    const relative = subpath.replace(/^\/+/, '')
    for (const candidate of [
      join(dir, relative),
      join(dir, 'lib', relative),
      join(dir, 'lib', relative + '.js'),
    ]) {
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = resolvePackage(specifier, context.parentURL)
    if (resolved !== undefined) {
      return { url: pathToFileURL(resolved).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
