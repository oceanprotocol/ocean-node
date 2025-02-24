import { DDOExample, ddov5, ddov7, ddoValidationSignature } from '../../data/ddo.js'
import {
  getValidationSignature,
  validateObject
} from '../../../components/core/utils/validateDdoHandler.js'
import { TEST_ENV_CONFIG_FILE, setupEnvironment } from '../../utils/utils.js'
import { expect } from 'chai'

describe('Schema validation tests', () => {
  before(() => {
    setupEnvironment(TEST_ENV_CONFIG_FILE)
  })
  it('should pass the validation on version 4.1.0', async () => {
    const validationResult = await validateObject(DDOExample, 137, DDOExample.nftAddress)
    expect(validationResult[0]).to.eql(true)
    expect(validationResult[1]).to.eql({})
  })
  it('should not pass due to invalid metadata.created on version 4.1.0', async () => {
    const copy = JSON.parse(JSON.stringify(DDOExample))
    copy['@context'] = ['https://w3id.org/did/v1']
    delete copy.metadata.created
    const validationResult = await validateObject(copy, 137, copy.nftAddress)
    expect(validationResult[0]).to.eql(false)
  })
  // TO DO after fixing regex for created & updated: it('should not pass due to invalid ISO timestamp on version 4.1.0', async () => {
  it('4.5.0 should pass the validation without service', async () => {
    const validationResult = await validateObject(ddov5, 137, ddov5.nftAddress)
    expect(validationResult[0]).to.eql(true)
    expect(validationResult[1]).to.eql({})
  })
  it('should pass the validation and return signature', async () => {
    const validationResult = await validateObject(
      ddoValidationSignature,
      137,
      ddov5.nftAddress
    )
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
    const validationResult = await validateObject(ddov7, 137, ddov7.nftAddress)
    console.log('Validation 4.7.0 result: ', validationResult)
    expect(validationResult[0]).to.eql(true)
    expect(validationResult[1]).to.eql({})
  })

  it('should pass the validation on version 4.7.0 without credentials', async () => {
    const newDDO = structuredClone(ddov7)
    delete newDDO.services[0].credentials
    const validationResult = await validateObject(newDDO, 137, newDDO.nftAddress)
    expect(validationResult[0]).to.eql(true)
    expect(validationResult[1]).to.eql({})
  })
})
