import { expect } from 'chai'
import {
  areKnownCredentialTypes,
  checkCredentials,
  hasAddressMatchAllRule
} from '../../utils/credentials.js'
import { Credentials } from '@oceanprotocol/ddo-js'
import {
  buildEnvOverrideConfig,
  OverrideEnvConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'
import { homedir } from 'os'

let envOverrides: OverrideEnvConfig[]

describe('credentials', () => {
  before(async () => {
    envOverrides = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.RPCS, ENVIRONMENT_VARIABLES.ADDRESS_FILE],
      [
        '{ "8996":{ "rpc":"http://172.0.0.1:8545", "chainId": 8996, "network": "development", "chunkSize": 100 }}',
        `${homedir}/.ocean/ocean-contracts/artifacts/address.json`
      ]
    )
    envOverrides = await setupEnvironment(null, envOverrides)
  })

  it('should allow access with undefined or empty credentials', () => {
    const credentialsUndefined: Credentials = undefined
    const consumerAddress = '0x123'
    const accessGranted1 = checkCredentials(credentialsUndefined, consumerAddress)
    expect(accessGranted1).to.equal(true)
    const credentialsEmapty = {} as Credentials
    const accessGranted2 = checkCredentials(credentialsEmapty, consumerAddress)
    expect(accessGranted2).to.equal(true)
  })
  it('should allow access with empty allow and deny lists', () => {
    const credentials: Credentials = {
      allow: [],
      deny: []
    }
    const consumerAddress = '0x123'
    const accessGranted = checkCredentials(credentials, consumerAddress)
    expect(accessGranted).to.equal(true)
  })
  it('should allow access with empty values in deny lists', () => {
    const credentials: Credentials = {
      allow: [],
      deny: [
        {
          type: 'address',
          values: []
        }
      ]
    }
    const consumerAddress = '0x123'
    const accessGranted = checkCredentials(credentials, consumerAddress)
    expect(accessGranted).to.equal(true)
  })

  it('should allow access with "accessList" credentials type', () => {
    const consumerAddress = '0x123'
    const credentials: Credentials = {
      allow: [],
      deny: [
        {
          type: 'accessList',
          values: [consumerAddress]
        }
      ]
    }

    const accessGranted = checkCredentials(credentials, consumerAddress)
    expect(accessGranted).to.equal(true)
  })

  it('should deny access with empty values in allow lists', () => {
    const credentials: Credentials = {
      allow: [],
      deny: [
        {
          type: 'address',
          values: []
        }
      ]
    }
    const consumerAddress = '0x123'
    const accessGranted = checkCredentials(credentials, consumerAddress)
    expect(accessGranted).to.equal(false)
  })
  it('should allow access with address in allow list', () => {
    const credentials: Credentials = {
      allow: [],
      deny: [
        {
          type: 'address',
          values: ['0x123']
        }
      ]
    }
    const consumerAddress = '0x123'
    const accessGranted = checkCredentials(credentials, consumerAddress)
    expect(accessGranted).to.equal(true)
  })
  it('should allow access with address not in deny list', () => {
    const credentials: Credentials = {
      allow: [],
      deny: [
        {
          type: 'address',
          values: ['0x456']
        }
      ]
    }
    const consumerAddress = '0x123'
    const accessGranted = checkCredentials(credentials, consumerAddress)
    expect(accessGranted).to.equal(true)
  })
  it('should deny access with address in deny list', () => {
    const credentials: Credentials = {
      allow: [
        {
          type: 'address',
          values: []
        }
      ],
      deny: [
        {
          type: 'address',
          values: ['0x123']
        }
      ]
    }
    const consumerAddress = '0x123'
    const accessGranted = checkCredentials(credentials, consumerAddress)
    expect(accessGranted).to.equal(false)
  })
  it('should deny access with address not in allow list', () => {
    const credentials: Credentials = {
      allow: [
        {
          type: 'address',
          values: ['0x456']
        }
      ],
      deny: [
        {
          type: 'address',
          values: []
        }
      ]
    }
    const consumerAddress = '0x123'
    const accessGranted = checkCredentials(credentials, consumerAddress)
    expect(accessGranted).to.equal(false)
  })

  it('should check correctly known credentials types', () => {
    const credentials: Credentials = {
      allow: [],
      deny: [
        {
          type: 'unknow_type',
          values: ['0x456']
        }
      ]
    }
    const isKnownType1 = areKnownCredentialTypes(credentials)
    expect(isKnownType1).to.equal(false)

    const credentialsOk: Credentials = {
      deny: [
        {
          type: 'address',
          values: ['0x456']
        }
      ],
      allow: [
        {
          type: 'accessList',
          values: ['0x456']
        },
        {
          type: 'address',
          values: ['0x678']
        }
      ]
    }
    const isKnownType2 = areKnownCredentialTypes(credentialsOk)
    expect(isKnownType2).to.equal(true)

    const credentialsNOk: Credentials = {
      deny: [
        {
          type: 'address',
          values: ['0x456']
        }
      ],
      allow: [
        {
          type: 'not_valid_type',
          values: ['0x456']
        }
      ]
    }
    const isKnownType3 = areKnownCredentialTypes(credentialsNOk)
    expect(isKnownType3).to.equal(false)
  })

  it('should check match all (*) rules', () => {
    const creds = {
      credentials: {
        allow: [
          {
            type: 'address',
            values: ['*']
          }
        ],
        deny: [
          {
            type: 'address',
            values: ['0x2222', '0x333']
          }
        ]
      }
    }
    expect(hasAddressMatchAllRule(creds.credentials.allow)).to.be.equal(true)
    const creds2 = structuredClone(creds)
    creds2.credentials.allow[0].values = ['0x2222', '0x333']
    expect(hasAddressMatchAllRule(creds2.credentials.allow)).to.be.equal(false)
  })

  after(async () => {
    await tearDownEnvironment(envOverrides)
  })
})
