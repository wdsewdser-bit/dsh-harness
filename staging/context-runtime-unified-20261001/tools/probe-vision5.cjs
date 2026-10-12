#!/usr/bin/env node
'use strict'

/**
 * Reproduce the exact DSH pi-ai image block shape: a metadata handle text block
 * followed by the image part, inside a conversation that already has history.
 *
 * Usage:
 *   node probe-vision5.cjs <targetImage> <fillerImage> <fillerCount> <handle|plain> <bearerKey> [baseURL]
 *
 * `handle` prefixes the target image with the same `<path>/<type>/<content>`
 * text DSH emits; `plain` sends the image alone. Answers are compared to see
 * whether the handle text is what makes the model claim it only has metadata.
 */

const fs = require('node:fs')

const [targetPath, fillerPath, countArg, mode, bearer, baseArg] = process.argv.slice(2)
if (!targetPath || !fillerPath || !bearer || (mode !== 'handle' && mode !== 'plain')) {
  console.error('usage: node probe-vision5.cjs <targetImage> <fillerImage> <fillerCount> <handle|plain> <bearerKey> [baseURL]')
  process.exit(2)
}
const count = Number(countArg || 0)
const base = (baseArg || 'http://127.0.0.1:8788/v1').replace(/\/+$/, '')
const PREFIX = 'data:' + 'image/' + 'png;base64,'

const targetBytes = fs.readFileSync(targetPath)
const targetURL = PREFIX + targetBytes.toString('base64')
const fillerURL = PREFIX + fs.readFileSync(fillerPath).toString('base64')

const messages = []
for (let index = 0; index < count; index += 1) {
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: `这是历史里的第 ${index + 1} 张截图。` },
      { type: 'image_url', image_url: { url: fillerURL } },
    ],
  })
  messages.push({ role: 'assistant', content: `已看到第 ${index + 1} 张截图。` })
}

const question = '只依据你实际看到的画面回答：最后这张图展示了什么？如果你看不到像素、只拿到路径或尺寸等元数据，只回答 NO_VISION。'
const targetContent = [{ type: 'text', text: question }]
if (mode === 'handle') {
  targetContent.push({
    type: 'text',
    text: `<path>${targetPath.replace(/\\/g, '\\\\')}</path>\n<type>image</type>\n<content>\nimage/png image, 924x1264 px, ${targetBytes.length} bytes\n</content>`,
  })
}
targetContent.push({ type: 'image_url', image_url: { url: targetURL } })
messages.push({ role: 'user', content: targetContent })

const body = { model: 'deepseek-v4.1-flash', stream: false, max_tokens: 1200, messages }

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
  try {
    const parsed = JSON.parse(text)
    const choice = parsed?.choices?.[0]
    reply = choice?.message?.content ?? ''
    finish = choice?.finish_reason ?? ''
  } catch {
    reply = text
  }
  const flat = String(reply).replace(/\s+/g, ' ').trim()
  const verdict = /NO_VISION/.test(flat) ? 'NO_VISION' : (flat.length === 0 ? 'EMPTY' : 'VISION_OK')
  console.log(`mode=${mode} count=${count} http=${response.status} ${verdict} finish=${finish} ${Date.now() - started}ms`)
  console.log(`  reply=${flat.slice(0, 300) || '(none)'}`)
})()
