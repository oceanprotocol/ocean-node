import { incorrectDDO, DDOExample, ddov5 } from '../../data/ddo.js'
import { validateObject } from '../../../components/core/utils/validateDdoHandler.js'
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
      '{ "1": "https://rpc.eth.gateway.fm", "137": "https://polygon.meowrpc.com", "80001": "https://rpc-mumbai.maticvigil.com" }'
    ]
  )
  envOverrides = await setupEnvironment(null, envOverrides)

  after(() => {
    // Restore original local setup / env variables after test
    tearDownEnvironment(envOverrides)
  })

  it('should pass the validation on version 4.1.0', async () => {
    const validationResult = await validateObject(DDOExample, 137, DDOExample.nftAddress)
    expect(validationResult[0]).to.eql(true)
    expect(validationResult[1]).to.eql({})
  })
  it('should not pass the validation on version 4.1.0', async () => {
    const validationResult = await validateObject(
      incorrectDDO,
      8996,
      DDOExample.nftAddress
    )
    expect(validationResult[0]).to.eql(false)
    expect(validationResult[1]).to.eql({
      metadata: 'Metadata is missing or invalid.',
      id: 'did is not valid for chain Id and nft address'
    })
  })
  it('should not pass due to missing context on version 4.1.0', async () => {
    const copy = DDOExample
    delete copy['@context']
    const validationResult = await validateObject(copy, 8996, copy.nftAddress)
    expect(validationResult[0]).to.eql(false)
    expect(validationResult[1]).to.eql({
      '@context': 'Context is missing or invalid.'
    })
  })
  it('4.5.0 should pass the validation without service', async () => {
    const validationResult = await validateObject(ddov5, 137, ddov5.nftAddress)
    expect(validationResult[0]).to.eql(true)
    expect(validationResult[1]).to.eql({})
  })
})
