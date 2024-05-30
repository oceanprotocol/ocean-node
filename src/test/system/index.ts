import { execFile } from 'child_process'
import { promisify } from 'util'

const execFilePromise = promisify(execFile)

const runOceanCliCommand = async (command: string, args: string[]): Promise<string> => {
  try {
    const { stdout, stderr } = await execFilePromise(command, args, { cwd: 'ocean-cli' })
    if (stderr) {
      throw new Error(stderr)
    }
    return stdout
  } catch (error) {
    throw new Error(`error: ${error.message}`)
  }
}

const testOceanNode = async () => {
  try {
    console.log('Running Ocean CLI command...')
    const result = await runOceanCliCommand('npm', ['run', 'cli', 'h'])
    console.log(result)
  } catch (error) {
    console.error(error)
  }
}

testOceanNode()
