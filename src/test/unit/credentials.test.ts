import { expect } from 'chai'
import {
  areKnownCredentialTypes,
  checkCredentials,
  hasAddressMatchAllRule
} from '../../utils/credentials.js'
import {
  buildEnvOverrideConfig,
  OverrideEnvConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../utils/utils.js'
import { ENVIRONMENT_VARIABLES } from '../../utils/constants.js'
import { homedir } from 'os'
import { DEVELOPMENT_CHAIN_ID } from '../../utils/address.js'
import { Credentials, CREDENTIALS_TYPES } from '@oceanprotocol/ddo-js'

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

  it('should deny access with undefined or empty credentials', async () => {
    const credentialsUndefined: Credentials = undefined
    const consumerAddress = '0x123'
    const accessGranted1 = await checkCredentials(credentialsUndefined, consumerAddress)
    expect(accessGranted1).to.equal(false)
    const credentialsEmapty = {} as Credentials
    const accessGranted2 = await checkCredentials(credentialsEmapty, consumerAddress)
    expect(accessGranted2).to.equal(false)
  })

  it('should deny access with empty allow and deny lists', async () => {
    // if list does not exist or is empty access is denied
    const credentials: Credentials = {
      allow: [],
      deny: []
    }
    const consumerAddress = '0x123'
    const accessGranted = await checkCredentials(credentials, consumerAddress)
    expect(accessGranted).to.equal(false)
  })

  it('should deny access with empty values in deny lists', async () => {
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
    const accessGranted = await checkCredentials(credentials, consumerAddress)
    expect(accessGranted).to.equal(false)
  })

  it('should deny access with "accessList" credentials (default behaviour if cannot check)', async () => {
    const consumerAddress = '0x123'
    const credentials: Credentials = {
      allow: [],
      deny: [
        {
          type: CREDENTIALS_TYPES.ACCESS_LIST,
          values: [consumerAddress] // not a valid SC address anyway
        }
      ]
    }

    const accessGranted = await checkCredentials(credentials, consumerAddress)
    expect(accessGranted).to.equal(false)
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
    const accessGranted = await checkCredentials(credentials, consumerAddress)
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
    const accessGranted = await checkCredentials(credentials, consumerAddress)
    expect(accessGranted).to.equal(true)
  })

  it('should deny access with address not explicitly in deny list but also without any allow list', async () => {
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
    const accessGranted = await checkCredentials(credentials, consumerAddress)
    expect(accessGranted).to.equal(false) // its not denied explicitly but not allowed either
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
    const accessGranted = await checkCredentials(credentials, consumerAddress)
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
    const accessGranted = await checkCredentials(credentials, consumerAddress)
    expect(accessGranted).to.equal(false)
  })

  it('should check correctly known credentials types', () => {
    const credentials: Credentials = {
      allow: [],
      deny: [
        {
          // @ts-expect-error
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
          type: CREDENTIALS_TYPES.ADDRESS,
          values: ['0x456']
        }
      ],
      allow: [
        {
          type: CREDENTIALS_TYPES.ACCESS_LIST,
          values: ['0x456']
        },
        {
          type: CREDENTIALS_TYPES.ADDRESS,
          values: ['0x678']
        }
      ]
    }
    const isKnownType2 = areKnownCredentialTypes(credentialsOk)
    expect(isKnownType2).to.equal(true)

    const credentialsNOk: Credentials = {
      deny: [
        {
          type: CREDENTIALS_TYPES.ADDRESS,
          values: ['0x456']
        }
      ],
      allow: [
        {
          // @ts-expect-error
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
    }
    expect(hasAddressMatchAllRule(creds.credentials.allow)).to.be.equal(true)
    const creds2 = structuredClone(creds)
    creds2.credentials.allow[0].values = ['0x2222', '0x333']
    expect(hasAddressMatchAllRule(creds2.credentials.allow)).to.be.equal(false)
  })

  it('should deny access by default if no specific allow rule is a match', async () => {
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
          values: []
        }
      ]
    }
    const consumerAddress = '0x123'
    const accessGranted = await checkCredentials(
      credentials,
      consumerAddress,
      DEVELOPMENT_CHAIN_ID
    )
    expect(accessGranted).to.equal(false)
  })

  it('should allow acess with match_allow: any', async () => {
    const credentials: Credentials = {
      allow: [
        {
          type: CREDENTIALS_TYPES.ADDRESS,
          values: ['0x123']
        },
        {
          type: CREDENTIALS_TYPES.ACCESS_LIST,
          values: ['0x456']
        }
      ],
      deny: [],
      match_allow: 'any'
    }
    const consumerAddress = '0x123'
    const accessGranted = await checkCredentials(
      credentials,
      consumerAddress,
      DEVELOPMENT_CHAIN_ID
    )

    expect(accessGranted).to.equal(true)
  })

  it('should deny access with match_allow: all', async () => {
    const credentials: Credentials = {
      allow: [
        {
          type: CREDENTIALS_TYPES.ADDRESS,
          values: ['0x123']
        },
        {
          type: CREDENTIALS_TYPES.ACCESS_LIST,
          values: ['0x456']
        }
      ],
      deny: [],
      match_allow: 'all'
    }
    const consumerAddress = '0x123'
    const accessGranted = await checkCredentials(
      credentials,
      consumerAddress,
      DEVELOPMENT_CHAIN_ID
    )
    expect(accessGranted).to.equal(false)
  })

  after(async () => {
    await tearDownEnvironment(envOverrides)
  })
})
