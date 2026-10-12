import { createHash, createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire('D:/dsh-test/app/node_modules/@deepseek-ai/dsh/package.json')
const yaml = require('yaml')

export function authorizationCookie(authority, home = 'D:/dsh-test/home') {
  const credentials = yaml.parse(readFileSync(home + '/.credentials.yaml', 'utf8'))
  const grant = (credentials.records ?? credentials)['client-connection/browser-session']
  if (grant?.kind !== 'grant' || typeof grant.payload?.secret !== 'string') {
    throw new Error('Browser-session grant unavailable')
  }
  const issuedAt = Date.now()
  const body = Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt: issuedAt + 3600000 })).toString('base64url')
  const signature = createHmac('sha256', Buffer.from(grant.payload.secret, 'base64url')).update(body).digest('base64url')
  const name = 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url')
  return name + '=v1.' + body + '.' + signature
}

export async function rpc(method, args = {}, { authority = '127.0.0.1:40123', timeoutMs = 30000 } = {}) {
  const rpcId = randomUUID()
  const response = await fetch('http://' + authority + '/api/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: authorizationCookie(authority) },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error('RPC HTTP ' + response.status)
  const envelope = await response.json()
  if (envelope.rpcId !== rpcId || envelope.result?.ok !== true) {
    throw new Error('RPC refused: ' + String(envelope.result?.error?.code ?? 'invalid-envelope'))
  }
  return envelope.result.value
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [method, args = '{}'] = process.argv.slice(2)
  try {
    if (!method) throw new Error('Usage: usage-runtime-rpc.mjs METHOD JSON_ARGS')
    const result = await rpc(method, JSON.parse(args))
    if (method === 'settings/describe') {
      const namespaces = result?.namespaces ?? (Array.isArray(result) ? result : [])
      console.log(JSON.stringify({ namespaces: namespaces.map(row => ({ ns: row.ns, revision: row.revision })) }))
    } else {
      console.log(JSON.stringify(result))
    }
  } catch (error) {
    console.error(error.name + ': ' + error.message)
    process.exitCode = 1
  }
}
