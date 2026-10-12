#!/usr/bin/env node
'use strict'

/**
 * Isolate why a vision request goes empty once the conversation grows.
 *
 * Usage:
 *   node probe-vision4.cjs <targetImage> <fillerImage> <count> <images|text> <bearerKey> [baseURL]
 *
 * `images` fills earlier turns with the filler image, `text` fills them with an
 * equivalent amount of text only. Prints the raw provider body whenever the
 * reply carries no text, so an upstream refusal is distinguishable from a
 * plain NO_VISION answer.
 */

const fs = require('node:fs')

const [targetPath, fillerPath, countArg, mode, bearer, baseArg] = process.argv.slice(2)
if (!targetPath || !fillerPath || !bearer || (mode !== 'images' && mode !== 'text')) {
  console.error('usage: node probe-vision4.cjs <targetImage> <fillerImage> <count> <images|text> <bearerKey> [baseURL]')
  process.exit(2)
}
const count = Number(countArg || 0)
const base = (baseArg || 'http://127.0.0.1:8788/v1').replace(/\/+$/, '')
const PREFIX = 'data:' + 'image/' + 'png;base64,'

const targetURL = PREFIX + fs.readFileSync(targetPath).toString('base64')
const fillerURL = PREFIX + fs.readFileSync(fillerPath).toString('base64')
const fillerText = '这是第 N 张参考图，仅作为历史记录占位。'.repeat(20)

const messages = []
for (let index = 0; index < count; index += 1) {
  const content = [{ type: 'text', text: `参考图 ${index + 1} ${fillerText}` }]
  if (mode === 'images') content.push({ type: 'image_url', image_url: { url: fillerURL } })
  messages.push({ role: 'user', content })
  messages.push({ role: 'assistant', content: `已记录参考图 ${index + 1}` })
}
messages.push({
  role: 'user',
  content: [
    { type: 'text', text: '只描述最后这张图：它展示了什么内容？如果你看不到像素、只有路径或尺寸等元数据，只回答 NO_VISION。' },
    { type: 'image_url', image_url: { url: targetURL } },
  ],
})

const body = { model: 'deepseek-v4.1-flash', stream: false, max_tokens: 200, messages }

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
  let reply = ''
  let finish = ''
  let usage = ''
  try {
    const parsed = JSON.parse(text)
    const choice = parsed?.choices?.[0]
    reply = choice?.message?.content ?? ''
    finish = choice?.finish_reason ?? ''
    usage = JSON.stringify(parsed?.usage ?? {})
  } catch {
    /* keep raw */
  }
  const flat = String(reply).replace(/\s+/g, ' ').trim()
  const verdict = /NO_VISION/.test(flat) ? 'NO_VISION' : (flat.length === 0 ? 'EMPTY' : 'VISION_OK')
  console.log(`mode=${mode} count=${count} http=${response.status} ${verdict} finish=${finish} ${Date.now() - started}ms`)
  console.log(`  usage=${usage}`)
  console.log(`  reply=${flat.slice(0, 240) || '(none)'}`)
  if (verdict === 'EMPTY') console.log(`  raw=${text.slice(0, 500)}`)
})()
