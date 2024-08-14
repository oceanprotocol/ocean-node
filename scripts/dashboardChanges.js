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

// Directories to exclude from the hash calculation
const excludeDirs = ['.next', 'node_modules']

// Function to calculate hash of a directory recursively
function calculateHash(directory) {
  const hash = createHash('sha256')
  const files = getAllFiles(directory)
  files.forEach((file) => {
    hash.update(readFileSync(file))
  })
  return hash.digest('hex')
}

// Function to get all files in a directory recursively
function getAllFiles(directory) {
  const filesInDirectory = readdirSync(directory)
  let allFiles = []
  filesInDirectory.forEach((file) => {
    const absolute = join(directory, file)
    if (excludeDirs.includes(file)) {
      return
    }
    if (statSync(absolute).isDirectory()) {
      allFiles = allFiles.concat(getAllFiles(absolute))
    } else {
      allFiles.push(absolute)
    }
  })
  return allFiles
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
  console.log(
    'Changes detected in the dashboard. Cleaning old build and running Next.js build...'
  )
  cleanDistDirectory()
  execSync('cd dashboard && npm install && npx next build', { stdio: 'inherit' })
} else {
  console.log('No changes detected in the dashboard. Skipping Next.js build.')
}
