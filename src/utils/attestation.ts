import * as fs from 'fs'
import * as crypto from 'crypto'
import * as path from 'path'
import exec from 'child_process'

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

// execute some command from terminal (could depend on OS)
// for now only used for git commands
function executeCommand(command: string): Promise<string> {
  return new Promise((resolve) => {
    try {
      // eslint-disable-next-line security/detect-child-process
      exec.exec(command, (_error: any, stdout: any) => {
        resolve(stdout)
      })
    } catch (err) {
      resolve(null)
    }
  })
}
// Compute the SHA-256 hash for a single file
async function computeFileHash(filePath: string): Promise<string> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const data = fs.readFileSync(filePath)
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const hashHex = hashArray.map((byte) => byte.toString(16).padStart(2, '0')).join('')
    return hashHex
  } catch (err) {
    // sometimes the file doesn't exist anymore (specially in dashboard stuff, silently ignore it)
    return ''
  }
}

// Compute the hash for all files in the codebase
export async function computeCodebaseHash(directory: string): Promise<string> {
  const files = getAllFiles(directory)
  // get git root folder
  let gitRootDir = await executeCommand('git rev-parse --show-toplevel')
  if (gitRootDir) {
    // clear line breaks
    gitRootDir = gitRootDir.trim().replace(/[\r\n]+/g, '')
  }
  // try get all git tracked files
  const gitFiles = await executeCommand('git ls-files')

  let hashes = ['']
  // use git files when possible
  if (gitFiles && gitRootDir) {
    const toBeHashed = gitFiles
      .trim()
      .replace(/[\r\n]+/g, '|') // clear line breaks
      .split('|')
    hashes = await Promise.all(
      toBeHashed.map((fileName) => {
        return computeFileHash(gitRootDir + '/' + fileName)
      })
    )
  } else {
    // otherwise use old way (prone to different hashes if we have local different files, even if not tracked on repo)
    hashes = await Promise.all(files.map(computeFileHash))
  }

  const allHashes = hashes.join('') // Combine all hashes into a single string
  const hashBuffer = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(allHashes)
  )
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hashHex = hashArray.map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return hashHex
}
