import { expect } from 'chai'
import { decrypt, encrypt } from '../../utils/crypt.js'
import { EncryptMethod } from '../../@types/fileObject.js'
import {
  buildEnvOverrideConfig,
  OverrideEnvConfig,
  setupEnvironment,
  TEST_ENV_CONFIG_FILE
} from '../utils/utils.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'
import { homedir } from 'os'

describe('crypt', () => {
  let envOverrides: OverrideEnvConfig[]
  before(async () => {
    envOverrides = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.RPCS, ENVIRONMENT_VARIABLES.ADDRESS_FILE],
      [
        '{ "8996":{ "rpc":"http://172.0.0.1:8545", "chainId": 8996, "network": "development", "chunkSize": 100 }}',
        `${homedir}/.ocean/ocean-contracts/artifacts/address.json`
      ]
    )
    envOverrides = await setupEnvironment(TEST_ENV_CONFIG_FILE, envOverrides)
  })
  it('should encrypt/decrypt AES', async () => {
    const data = Uint8Array.from(Buffer.from('ocean'))
    const encryptedData = await encrypt(data, EncryptMethod.AES)
    const decryptedData = await decrypt(encryptedData, EncryptMethod.AES)
    expect(Uint8Array.from(decryptedData)).to.deep.equal(data)
  })
  it('should encrypt/decrypt ECIES', async () => {
    const data = Uint8Array.from(Buffer.from('ocean'))
    const encryptedData = await encrypt(data, EncryptMethod.ECIES)
    const decryptedData = await decrypt(encryptedData, EncryptMethod.ECIES)
    expect(Uint8Array.from(decryptedData)).to.deep.equal(data)
  })
  after(async () => {
    await tearDownEnvironment(envOverrides)
  })
})
