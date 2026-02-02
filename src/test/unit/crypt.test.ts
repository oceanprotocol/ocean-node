import { expect } from 'chai'
import { EncryptMethod } from '../../@types/fileObject.js'
import {
  buildEnvOverrideConfig,
  OverrideEnvConfig,
  setupEnvironment,
  tearDownEnvironment,
  TEST_ENV_CONFIG_FILE
} from '../utils/utils.js'
import { getConfiguration } from '../../utils/index.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'
import { homedir } from 'os'
import { KeyManager } from '../../components/KeyManager/index.js'

describe('crypt', () => {
  let envOverrides: OverrideEnvConfig[]
  let keyManager: KeyManager
  before(async () => {
    envOverrides = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.RPCS, ENVIRONMENT_VARIABLES.ADDRESS_FILE],
      [
        '{ "8996":{ "rpc":"http://127.0.0.1:8545", "chainId": 8996, "network": "development", "chunkSize": 100 }}',
        `${homedir}/.ocean/ocean-contracts/artifacts/address.json`
      ]
    )
    envOverrides = await setupEnvironment(TEST_ENV_CONFIG_FILE, envOverrides)
    const config = await getConfiguration()
    keyManager = new KeyManager(config)
  })
  it('should encrypt/decrypt AES', async () => {
    const data = Uint8Array.from(Buffer.from('ocean'))
    const encryptedData = await keyManager.encrypt(data, EncryptMethod.AES)
    const decryptedData = await keyManager.decrypt(encryptedData, EncryptMethod.AES)
    expect(Uint8Array.from(decryptedData)).to.deep.equal(data)
  })
  it('should encrypt/decrypt ECIES', async () => {
    const data = Uint8Array.from(Buffer.from('ocean'))
    const encryptedData = await keyManager.encrypt(data, EncryptMethod.ECIES)
    const decryptedData = await keyManager.decrypt(encryptedData, EncryptMethod.ECIES)
    expect(Uint8Array.from(decryptedData)).to.deep.equal(data)
  })
  after(async () => {
    await tearDownEnvironment(envOverrides)
  })
})
