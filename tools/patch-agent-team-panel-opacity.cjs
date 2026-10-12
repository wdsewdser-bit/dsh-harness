#!/usr/bin/env node
'use strict'

/**
 * Keep the Team panel's translucent tint while blocking conversation text from
 * showing through it. The opaque base is painted underneath the menu tint.
 */

const fs = require('node:fs')

const file = process.argv[2]
if (!file) {
  process.stderr.write('usage: patch-agent-team-panel-opacity.cjs <client.js>\n')
  process.exit(1)
}

let source = fs.readFileSync(file, 'utf8')
const panelOld = 'background:var(--dsw-specific-menu);--dsw-elevation-stroke-color'
const panelNew = 'background:var(--dsw-specific-menu);background-color:var(--dsw-alias-bg-base);background-image:linear-gradient(var(--dsw-specific-menu),var(--dsw-specific-menu));backdrop-filter:none;--dsw-elevation-stroke-color'
const stickyOld = 'background:var(--dsw-specific-menu)}.VoX2oq_roomDetailTitle'
const stickyNew = 'background-color:var(--dsw-alias-bg-base);background-image:linear-gradient(var(--dsw-specific-menu),var(--dsw-specific-menu));backdrop-filter:none}.VoX2oq_roomDetailTitle'

if (!source.includes(panelOld) || !source.includes(stickyOld)) {
  throw new Error('expected Team panel CSS markers were not found')
}
source = source.replace(panelOld, panelNew).replace(stickyOld, stickyNew)
fs.writeFileSync(file, source)
process.stdout.write('[patch-agent-team-panel-opacity] panel opacity backing applied\n')
