import { DDOExample, ddov5, ddov7, ddoValidationSignature } from '../../data/ddo.js'
import {
  getValidationSignature,
  validateDdo
} from '../../../components/core/utils/validateDdoHandler.js'
import { ENVIRONMENT_VARIABLES } from '../../../utils/index.js'

import { expect } from 'chai'
import {
  setupEnvironment,
  tearDownEnvironment,
  buildEnvOverrideConfig,
  OverrideEnvConfig
} from '../../utils/utils.js'

describe('Schema validation tests', async () => {
  let envOverrides: OverrideEnvConfig[]
  envOverrides = buildEnvOverrideConfig(
    [
      ENVIRONMENT_VARIABLES.PRIVATE_KEY,
      ENVIRONMENT_VARIABLES.IPFS_GATEWAY,
      ENVIRONMENT_VARIABLES.ARWEAVE_GATEWAY,
      ENVIRONMENT_VARIABLES.RPCS
    ],
    [
      '0xc594c6e5def4bab63ac29eed19a134c130388f74f019bc74b8f4389df2837a58',
      'https://ipfs.io/',
      'https://arweave.net/',
      '{ "1": "https://rpc.eth.gateway.fm", "137": "https://polygon.meowrpc.com" }'
    ]
  )
  envOverrides = await setupEnvironment(null, envOverrides)

  after(() => {
    // Restore original local setup / env variables after test
    tearDownEnvironment(envOverrides)
  })

  it('should pass the validation on version 4.1.0', async () => {
    const validationResult = await validateDdo(DDOExample)
    expect(validationResult[0]).to.eql(true)
    expect(validationResult[1]).to.eql({})
  })
  it('should not pass due to invalid metadata.created on version 4.1.0', async () => {
    const copy = JSON.parse(JSON.stringify(DDOExample))
    copy['@context'] = ['https://w3id.org/did/v1']
    delete copy.metadata.created
    const validationResult = await validateDdo(copy)
    expect(validationResult[0]).to.eql(false)
  })
  // TO DO after fixing regex for created & updated: it('should not pass due to invalid ISO timestamp on version 4.1.0', async () => {
  it('4.5.0 should pass the validation without service', async () => {
    const validationResult = await validateDdo(ddov5)
    expect(validationResult[0]).to.eql(true)
    expect(validationResult[1]).to.eql({})
  })
  it('should pass the validation and return signature', async () => {
    const validationResult = await validateDdo(ddoValidationSignature)
    expect(validationResult[0]).to.eql(true)
    expect(validationResult[1]).to.eql({})
    const signatureResult = await getValidationSignature(
      JSON.stringify(ddoValidationSignature)
    )
    expect(signatureResult).to.eql({
      hash: '0xa291d25eb3dd0c8487dc2d55baa629184e7b668ed1c579198a434eca9c663ac4',
      publicKey: '0xe2DD09d719Da89e5a3D0F2549c7E24566e947260',
      r: '0xc61361803ca3402afa2406dfc3e2729dd8f0c21d06c1456cc1668510b23951c0',
      s: '0x008b965fa2df393765d32942a7d8114d529a602cd7aa672d23d21f90dbeae2fd',
      v: 28
    })
  })

  it('should pass the validation on version 4.7.0', async () => {
    const validationResult = await validateDdo(ddov7)
    expect(validationResult[0]).to.eql(true)
    expect(validationResult[1]).to.eql({})
  })

  it('should pass the validation on version 4.7.0 without credentials', async () => {
    const newDDO = structuredClone(ddov7)
    delete newDDO.services[0].credentials
    const validationResult = await validateDdo(newDDO)
    expect(validationResult[0]).to.eql(true)
    expect(validationResult[1]).to.eql({})
  })
})
