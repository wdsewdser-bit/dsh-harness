#!/usr/bin/env node
'use strict'

/**
 * Probe whether the local wb-proxy actually forwards image input on every
 * account it rotates through.
 *
 * Usage:
 *   node probe-vision.cjs <imagePath> <bearerKey> [rounds] [baseURL]
 *
 * Each round sends the same image with the same question. A route that cannot
 * process the image answers without any visual detail (the DSH adapter always
 * emits the text handle next to the image, so such a reply reads like metadata
 * only). Prints one line per round plus the raw reply.
 */

const fs = require('node:fs')

const [imagePath, bearer, roundsArg, baseArg] = process.argv.slice(2)
if (!imagePath || !bearer) {
  console.error('usage: node probe-vision.cjs <imagePath> <bearerKey> [rounds] [baseURL]')
  process.exit(2)
}
const rounds = Number(roundsArg || 6)
const base = (baseArg || 'http://127.0.0.1:8788/v1').replace(/\/+$/, '')

const bytes = fs.readFileSync(imagePath)
const dataURL = `data:image/png;base64,${bytes.toString('base64')}`
const question = '只依据你实际看到的画面内容回答：这张图里是什么界面？用一句中文描述最显著的 3 个视觉要素。如果你看不到图像像素、只拿到路径/尺寸等元数据，请只回答“NO_VISION”。'

async function once(index) {
  const started = Date.now()
  const body = {
    model: 'deepseek-v4.1-flash',
    stream: false,
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: question },
        { type: 'image_url', image_url: { url: dataURL } },
      ],
    }],
  }
  try {
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
      /* keep raw text */
    }
    const flat = String(reply).replace(/\s+/g, ' ').trim()
    const verdict = /NO_VISION/.test(flat) ? 'NO_VISION' : 'VISION_OK'
    console.log(`[round ${index}] http=${response.status} ${verdict} ${Date.now() - started}ms :: ${flat.slice(0, 240)}`)
    return verdict
  } catch (error) {
    console.log(`[round ${index}] ERROR ${String(error?.message || error)}`)
    return 'ERROR'
  }
}

;(async () => {
  const tally = {}
  for (let index = 1; index <= rounds; index += 1) {
    const verdict = await once(index)
    tally[verdict] = (tally[verdict] || 0) + 1
  }
  console.log(`\nsummary ${JSON.stringify(tally)}`)
})()
