import { execSync } from 'child_process'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  rmSync
} from 'fs'
import { createHash } from 'crypto'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Directory to check for changes
const dashboardDir = join(__dirname, '../dashboard')
const distDir = join(__dirname, '../dist')
const hashFile = join(__dirname, 'dashboard.hash')

// Function to calculate hash of a directory
function calculateHash(directory) {
  const files = execSync(`find ${directory} -type f | sort`).toString().trim().split('\n')
  const hash = createHash('sha256')
  files.forEach((file) => {
    hash.update(readFileSync(file))
  })
  return hash.digest('hex')
}

// Function to check if there are changes in the directory
function hasChanges() {
  const currentHash = calculateHash(dashboardDir)
  if (existsSync(hashFile)) {
    const previousHash = readFileSync(hashFile, 'utf-8')
    if (previousHash === currentHash) {
      return false
    }
  }
  writeFileSync(hashFile, currentHash)
  return true
}

// Function to clean the dist directory except the dashboard folder
function cleanDistDirectory() {
  if (!existsSync(distDir)) {
    return
  }

  const files = readdirSync(distDir)
  files.forEach((file) => {
    const filePath = join(distDir, file)
    if (filePath !== join(distDir, 'dashboard')) {
      if (statSync(filePath).isDirectory()) {
        rmSync(filePath, { recursive: true, force: true })
      } else {
        rmSync(filePath)
      }
    }
  })
}

if (hasChanges()) {
  console.log('Changes detected. Cleaning old build and running Next.js build...')
  cleanDistDirectory()
  execSync('cd dashboard && npm install && npx next build', { stdio: 'inherit' })
} else {
  console.log('No changes detected. Skipping Next.js build.')
}