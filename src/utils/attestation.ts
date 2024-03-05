import * as fs from 'fs'
import * as crypto from 'crypto'
import * as path from 'path'

// Recursively get all files in a directory and its subdirectories
function getAllFiles(directory: string): string[] {
  const files: string[] = []
  const items = fs.readdirSync(directory, { withFileTypes: true })

  for (const item of items) {
    const filePath = path.join(directory, item.name)
    if (item.isDirectory()) {
      files.push(...getAllFiles(filePath)) // Recurse into subdirectory
    } else {
      files.push(filePath) // Add file path
    }
  }

  return files
}

// Compute the SHA-256 hash for a single file
async function computeFileHash(filePath: string): Promise<string> {
  const data = fs.readFileSync(filePath)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hashHex = hashArray.map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return hashHex
}

// Compute the hash for all files in the codebase
export async function computeCodebaseHash(directory: string): Promise<string> {
  const files = getAllFiles(directory)
  const hashes = await Promise.all(files.map(computeFileHash))
  const allHashes = hashes.join('') // Combine all hashes into a single string
  const hashBuffer = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(allHashes)
  )
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hashHex = hashArray.map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return hashHex
}
