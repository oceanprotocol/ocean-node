import path from 'path'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
// __dirname and __filename are not defined in ES module scope
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// set env vars first
// envFilePath should be relative to current directory
export async function setupEnvironment(envFilePath: string) {
  // configure some env variables
  const pathEnv = path.resolve(__dirname, envFilePath)
  console.log('Setting up environment with variables from:', pathEnv)
  dotenv.config({ path: pathEnv, encoding: 'utf8', debug: true })
}
