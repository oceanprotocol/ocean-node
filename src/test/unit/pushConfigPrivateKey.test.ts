import { expect } from 'chai'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import { fileURLToPath } from 'url'
import { OceanNode } from '../../OceanNode.js'
import { OceanNodeConfig } from '../../@types/OceanNode.js'
import { PushConfigHandler } from '../../components/core/admin/pushConfigHandler.js'
import { FetchConfigHandler } from '../../components/core/admin/fetchConfigHandler.js'
import { getConfiguration } from '../../utils/config/builder.js'
import { ENVIRONMENT_VARIABLES, PROTOCOL_COMMANDS } from '../../utils/constants.js'
import { streamToString } from '../../utils/util.js'
import {
  OverrideEnvConfig,
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// dist/test/unit -> src/test/config.json, the config the other suites run on
const TEST_CONFIG_FILE = path.resolve(__dirname, '../../../src/test/config.json')

const ADMIN_ADDRESS = '0x00000000000000000000000000000000000000ad'
const HIDDEN = '[*** HIDDEN CONTENT ***]'

function privateKey(): string {
  return process.env.PRIVATE_KEY
}

// Only what the admin handlers touch: signature checks always pass for ADMIN_ADDRESS, and
// nothing is started when a pushed config is applied.
function fakeOceanNode(config: OceanNodeConfig): OceanNode {
  let current = config
  return {
    getConfig: () => current,
    setConfig: (next: OceanNodeConfig) => {
      current = next
    },
    addC2DEngines: () => Promise.resolve(),
    getAuth: () => ({
      validateAuthenticationOrToken: () => Promise.resolve({ valid: true, error: '' })
    }),
    getAdminAddresses: () => ({
      addresses: [ADMIN_ADDRESS],
      accessLists: undefined as undefined
    })
  } as unknown as OceanNode
}

function signedCommand(command: string) {
  return {
    command,
    address: ADMIN_ADDRESS,
    nonce: String(Date.now()),
    signature: '0xsignature'
  }
}

function expectNoPrivateKey(body: string) {
  expect(body).to.not.include(privateKey())
  expect(body).to.not.include(privateKey().slice(2))
}

describe('pushConfig / fetchConfig never return the private key', () => {
  let tempDir: string
  let configPath: string
  let baseConfig: Record<string, any>
  let envOverrides: OverrideEnvConfig[]
  let node: OceanNode

  // a config file that still holds the `over` copy of the private key, as saved by a client
  // that echoed an older pushConfig response back
  function writeConfigFileWithOver(): void {
    const file = { ...baseConfig, over: { privateKey: privateKey() } }
    fs.writeFileSync(configPath, JSON.stringify(file, null, 4))
  }

  before(async () => {
    expect(privateKey()).to.match(/^0x[0-9a-fA-F]{64}$/)
    baseConfig = JSON.parse(fs.readFileSync(TEST_CONFIG_FILE, 'utf-8'))
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-push-config-'))
    configPath = path.join(tempDir, 'config.json')
    writeConfigFileWithOver()

    envOverrides = await setupEnvironment(
      undefined,
      buildEnvOverrideConfig([ENVIRONMENT_VARIABLES.CONFIG_PATH], [configPath])
    )
    const config = await getConfiguration(true)
    expect(config.keys.privateKey).to.equal(privateKey())
    node = fakeOceanNode(config)
  })

  beforeEach(() => {
    writeConfigFileWithOver()
  })

  after(async () => {
    await tearDownEnvironment(envOverrides)
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('the resolved configuration carries no `over` copy of the key', async () => {
    const config = await getConfiguration(true)
    expect(config).to.not.have.property('over')
  })

  it('pushConfig answers without the private key and drops `over` from the file', async () => {
    const response = await new PushConfigHandler(node).handle({
      ...signedCommand(PROTOCOL_COMMANDS.PUSH_CONFIG),
      config: { rateLimit: 31 }
    })
    expect(response.status.httpStatus).to.equal(200)
    const body = await streamToString(response.stream as Readable)

    expectNoPrivateKey(body)
    const answer = JSON.parse(body)
    expect(answer).to.not.have.property('over')
    expect(answer.keys.privateKey).to.equal(HIDDEN)
    expect(answer.rateLimit).to.equal(31)

    const saved = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    expect(saved).to.not.have.property('over')
    expect(saved.rateLimit).to.equal(31)
    // the node still runs with its real key
    expect(node.getConfig().keys.privateKey).to.equal(privateKey())
  })

  it('fetchConfig answers without the private key', async () => {
    const response = await new FetchConfigHandler(node).handle(
      signedCommand(PROTOCOL_COMMANDS.FETCH_CONFIG)
    )
    expect(response.status.httpStatus).to.equal(200)
    const body = await streamToString(response.stream as Readable)

    expectNoPrivateKey(body)
    const answer = JSON.parse(body)
    expect(answer).to.not.have.property('over')
    expect(answer.keys.privateKey).to.equal(HIDDEN)
  })
})
