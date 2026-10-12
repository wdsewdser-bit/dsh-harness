const fs = require('node:fs')

const manifest = JSON.parse(
  fs.readFileSync(process.env.DSH_DESKTOP_PACKAGE, 'utf8'),
)

fs.writeFileSync(process.env.DSH_DESKTOP_VERSION_OUT, manifest.version, 'utf8')
