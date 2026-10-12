#!/usr/bin/env node
'use strict'

/**
 * Measure how the upstream behaves as one request accumulates images.
 *
 * Usage:
 *   node probe-vision3.cjs <targetImage> <fillerImage> <fillerCount> <bearerKey> [baseURL]
 *
 * Builds a history of `fillerCount` earlier image turns, then asks about the
 * target image last. If the answer stops describing the target content while a
 * clean request succeeds, the route is dropping images once a request carries
 * many of them, independent of the target's own size.
 */

const fs = require('node:fs')

const [targetPath, fillerPath, countArg, bearer, baseArg] = process.argv.slice(2)
if (!targetPath || !fillerPath || !bearer) {
  console.error('usage: node probe-vision3.cjs <targetImage> <fillerImage> <fillerCount> <bearerKey> [baseURL]')
  process.exit(2)
}
const fillerCount = Number(countArg || 0)
const base = (baseArg || 'http://127.0.0.1:8788/v1').replace(/\/+$/, '')
const PREFIX = 'data:' + 'image/' + 'png;base64,'

const targetURL = PREFIX + fs.readFileSync(targetPath).toString('base64')
const fillerURL = PREFIX + fs.readFileSync(fillerPath).toString('base64')

const messages = []
for (let index = 0; index < fillerCount; index += 1) {
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: `参考图 ${index + 1}` },
      { type: 'image_url', image_url: { url: fillerURL } },
    ],
  })
  messages.push({ role: 'assistant', content: `已记录参考图 ${index + 1}` })
}
messages.push({
  role: 'user',
  content: [
    { type: 'text', text: '只描述最后这张图：它展示了什么内容？如果你看不到像素、只有路径或尺寸等元数据，只回答 NO_VISION。' },
    { type: 'image_url', image_url: { url: targetURL } },
  ],
})

const body = {
  model: 'deepseek-v4.1-flash',
  stream: false,
  max_tokens: 200,
  messages,
}

;(async () => {
  const started = Date.now()
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${bearer}`,
      'x-opencode-session': 'dsh-vision-probe',
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let reply = text
  try {
    const parsed = JSON.parse(text)
    reply = parsed?.choices?.[0]?.message?.content ?? text
  } catch {
    /* keep raw */
  }
  const flat = String(reply).replace(/\s+/g, ' ').trim()
  const verdict = /NO_VISION/.test(flat) ? 'NO_VISION' : (flat.length === 0 ? 'EMPTY' : 'VISION_OK')
  console.log(`filler=${fillerCount} http=${response.status} ${verdict} ${Date.now() - started}ms :: ${flat.slice(0, 260)}`)
})()
