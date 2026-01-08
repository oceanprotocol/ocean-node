import { expect } from 'chai'
import { checkCredentials } from '../../utils/credentials.js'
import {
  buildEnvOverrideConfig,
  OverrideEnvConfig,
  setupEnvironment,
  tearDownEnvironment,
  TEST_ENV_CONFIG_FILE
} from '../utils/utils.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'
import { homedir } from 'os'
import { Credentials } from '@oceanprotocol/ddo-js'
import { CREDENTIALS_TYPES } from '../../@types/DDO/Credentials.js'
import { Blockchain } from '../../utils/blockchain.js'
import { Signer } from 'ethers'

let envOverrides: OverrideEnvConfig[]
let blockchain: Blockchain
let signer: Signer

describe('credentials', () => {
  before(async () => {
    envOverrides = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.RPCS, ENVIRONMENT_VARIABLES.ADDRESS_FILE],
      [
        '{ "8996":{ "rpc":"http://172.0.0.1:8545", "chainId": 8996, "network": "development", "chunkSize": 100 }}',
        `${homedir}/.ocean/ocean-contracts/artifacts/address.json`
      ]
    )
    envOverrides = await setupEnvironment(TEST_ENV_CONFIG_FILE, envOverrides)
    // Initialize blockchain for tests
    blockchain = new Blockchain('http://172.0.0.1:8545', 'development', 8996, [])
    signer = blockchain.getSigner()
  })

  it('should allow access with undefined or empty credentials', async () => {
    const credentialsUndefined: Credentials = undefined
    const consumerAddress = '0x123'
    const accessGranted1 = await checkCredentials(
      consumerAddress,
      credentialsUndefined,
      signer
    )
    expect(accessGranted1).to.equal(true)
    const credentialsEmapty = {} as Credentials
    const accessGranted2 = await checkCredentials(
      consumerAddress,
      credentialsEmapty,
      signer
    )
    expect(accessGranted2).to.equal(true)
  })
  it('should allow access with empty allow and deny lists', async () => {
    const credentials: Credentials = {
      allow: [],
      deny: []
    }
    const consumerAddress = '0x123'
    const accessGranted = await checkCredentials(consumerAddress, credentials, signer)
    expect(accessGranted).to.equal(true)
  })
  it('should allow access with empty values in deny lists', async () => {
    const credentials: Credentials = {
      allow: [],
      deny: [
        {
          type: CREDENTIALS_TYPES.ADDRESS,
          values: []
        }
      ]
    }
    const consumerAddress = '0x123'
    const accessGranted = await checkCredentials(consumerAddress, credentials, signer)
    expect(accessGranted).to.equal(true)
  })

  it('should allow access with "accessList" credentials type', async () => {
    const consumerAddress = '0x123'
    const credentials: Credentials = {
      allow: [],
      deny: [
        {
          type: CREDENTIALS_TYPES.ACCESS_LIST,
          chainId: 8996,
          accessList: '0x0000000000000000000000000000000000000000'
        }
      ]
    }

    const accessGranted = await checkCredentials(consumerAddress, credentials, signer)
    expect(accessGranted).to.equal(true)
  })

  it('should deny access with empty values in allow lists', async () => {
    const credentials: Credentials = {
      deny: [],
      allow: [
        {
          type: CREDENTIALS_TYPES.ADDRESS,
          values: []
        }
      ]
    }
    const consumerAddress = '0x123'
    const accessGranted = await checkCredentials(consumerAddress, credentials, signer)
    expect(accessGranted).to.equal(false)
  })
  it('should allow access with address in allow list', async () => {
    const credentials: Credentials = {
      deny: [],
      allow: [
        {
          type: CREDENTIALS_TYPES.ADDRESS,
          values: ['0x123']
        }
      ]
    }
    const consumerAddress = '0x123'
    const accessGranted = await checkCredentials(consumerAddress, credentials, signer)
    expect(accessGranted).to.equal(true)
  })
  it('should allow access with address not in deny list', async () => {
    const credentials: Credentials = {
      allow: [],
      deny: [
        {
          type: CREDENTIALS_TYPES.ADDRESS,
          values: ['0x456']
        }
      ]
    }
    const consumerAddress = '0x123'
    const accessGranted = await checkCredentials(consumerAddress, credentials, signer)
    expect(accessGranted).to.equal(true)
  })
  it('should deny access with address in deny list', async () => {
    const credentials: Credentials = {
      allow: [
        {
          type: CREDENTIALS_TYPES.ADDRESS,
          values: []
        }
      ],
      deny: [
        {
          type: CREDENTIALS_TYPES.ADDRESS,
          values: ['0x123']
        }
      ]
    }
    const consumerAddress = '0x123'
    const accessGranted = await checkCredentials(consumerAddress, credentials, signer)
    expect(accessGranted).to.equal(false)
  })
  it('should deny access with address not in allow list', async () => {
    const credentials: Credentials = {
      allow: [
        {
          type: CREDENTIALS_TYPES.ADDRESS,
          values: ['0x456']
        }
      ],
      deny: [
        {
          type: CREDENTIALS_TYPES.ADDRESS,
          values: []
        }
      ]
    }
    const consumerAddress = '0x123'
    const accessGranted = await checkCredentials(consumerAddress, credentials, signer)
    expect(accessGranted).to.equal(false)
  })

  it('should check match all (*) rules', async () => {
    const credentials: Credentials = {
      allow: [
        {
          type: CREDENTIALS_TYPES.ADDRESS,
          values: ['*']
        }
      ],
      deny: [
        {
          type: CREDENTIALS_TYPES.ADDRESS,
          values: ['0x2222', '0x333']
        }
      ]
    }

    const accessGranted = await checkCredentials('0x123', credentials, signer)
    expect(accessGranted).to.equal(true)
  })

  after(async () => {
    await tearDownEnvironment(envOverrides)
  })
})
