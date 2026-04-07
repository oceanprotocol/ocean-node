import { createRequire } from 'module'

const require = createRequire(import.meta.url)

export function getPackageVersion(): string {
  return process.env.npm_package_version ?? require('../../package.json').version
}
