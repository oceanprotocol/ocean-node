#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const file = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'node_modules/@libp2p/http-utils/dist/src/index.js'
)

try {
  let content = readFileSync(file, 'utf8')

  if (content.includes("addresses.port === '' ?")) {
    console.log('✅ Already patched')
    process.exit(0)
  }

  content = content.replace(
    'port = parseInt(addresses.port, 10);',
    "port = parseInt(addresses.port === '' ? (addresses.protocol === 'https:' ? '443' : '80') : addresses.port, 10);"
  )

  writeFileSync(file, content, 'utf8')
  console.log('✅ Patched @libp2p/http-utils')
} catch (error) {
  if (error.code === 'ENOENT') {
    console.log('⚠️  Package not found, skipping')
    process.exit(0)
  }
  console.error('❌ Error:', error.message)
  process.exit(1)
}
