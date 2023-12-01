import { expect, assert } from 'chai'
import { JsonRpcProvider, Signer, Contract, ethers, getAddress, hexlify } from 'ethers'
import { createHash } from 'crypto'
import fs from 'fs'
import { homedir } from 'os'
import { validateOrderTransaction } from '../../src/components/core/validateTransaction'
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' assert { type: 'json' }
import { getEventFromTx, sleep } from '../../src/utils/util.js'
import { genericAsset } from '../constants.js'

describe('validateOrderTransaction Function with Real Transactions', () => {
  let provider: JsonRpcProvider
  let factoryContract: Contract
  let nftContract: Contract
  let nftAddress: string
  const chainId = 8996
  let assetDID: string
  let publisherAccount: Signer
  let consumerAccount: Signer
  let userAddress: string
  let dataNftAddress: string
  let feeAddress: string
  let datatokenAddress: string
  let fixedDDO
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
  const providerFeeAmount = 0
  const feeToken = '0x312213d6f6b5FCF9F56B7B8946A6C727Bf4Bc21f'

  before(async () => {
    provider = new JsonRpcProvider('http://127.0.0.1:8545')
    publisherAccount = (await provider.getSigner(0)) as Signer
    consumerAccount = (await provider.getSigner(1)) as Signer
    feeAddress = await publisherAccount.getAddress()
    userAddress = await publisherAccount.getAddress()
    console.log('userAddress', userAddress)

    const data = JSON.parse(
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      fs.readFileSync(
        process.env.ADDRESS_FILE ||
          `${homedir}/.ocean/ocean-contracts/artifacts/address.json`,
        'utf8'
      )
    )

    // Initialize the factory contract
    factoryContract = new ethers.Contract(
      data.development.ERC721Factory,
      ERC721Factory.abi,
      publisherAccount
    )
  })

  it('should publish a dataset', async () => {
    const tx = await factoryContract.createNftWithErc20(
      {
        name: '72120Bundle',
        symbol: '72Bundle',
        templateIndex: 1,
        tokenURI: 'https://oceanprotocol.com/nft/',
        transferable: true,
        owner: await publisherAccount.getAddress()
      },
      {
        strings: ['ERC20B1', 'ERC20DT1Symbol'],
        templateIndex: 1,
        addresses: [
          await publisherAccount.getAddress(),
          ZERO_ADDRESS,
          ZERO_ADDRESS,
          '0x0000000000000000000000000000000000000000'
        ],
        uints: [1000, 0],
        bytess: []
      }
    )
    const txReceipt = await tx.wait()
    assert(txReceipt, 'transaction failed')
    const nftEvent = getEventFromTx(txReceipt, 'NFTCreated')
    const erc20Event = getEventFromTx(txReceipt, 'TokenCreated')
    console.log('erc20Event', erc20Event)
    dataNftAddress = nftEvent.args[0]
    datatokenAddress = erc20Event.args[0]
    console.log('nftAddress ', dataNftAddress)
    console.log('datatokenAddress ', datatokenAddress)
    assert(dataNftAddress, 'find nft created failed')
    assert(datatokenAddress, 'find datatoken created failed')
  })

  it('should set metadata and save ', async () => {
    console.log('1. should set metadata and save')
    nftContract = new Contract(dataNftAddress, ERC721Template.abi, publisherAccount)
    console.log('2. should set metadata and save')
    genericAsset.id =
      'did:op:' +
      createHash('sha256')
        .update(getAddress(dataNftAddress) + chainId.toString(10))
        .digest('hex')
    genericAsset.nftAddress = dataNftAddress
    console.log('3. should set metadata and save')

    assetDID = genericAsset.id
    console.log('assetDID', assetDID)
    const stringDDO = JSON.stringify(genericAsset)
    const bytes = Buffer.from(stringDDO)
    const metadata = hexlify(bytes)
    console.log('metadata ', metadata)
    const hash = createHash('sha256').update(metadata).digest('hex')
    console.log('hash ', hash)

    const setMetaDataTx = await nftContract.setMetaData(
      0,
      'http://v4.provider.oceanprotocol.com',
      '0x123',
      '0x02',
      metadata,
      '0x' + hash,
      []
    )
    const trxReceipt = await setMetaDataTx.wait()
    console.log('trxReceipt ==', trxReceipt)
    assert(trxReceipt, 'set metadata failed')
  })

  it('should simulate a transaction and validate it', async () => {
    // // Simulate a transaction
    // // expect(txReceipt).to.exist
    // // Use the transaction receipt in validateOrderTransaction
    // const txId = txReceipt.transactionHash
    // console.log('txId', txId)
    // const result = await validateOrderTransaction(
    //   txId,
    //   userAddress,
    //   provider,
    //   dataNftAddress,
    //   datatokenAddress
    // )
    // expect(result.isValid).to.be.true
    // expect(result.message).to.equal('Transaction is valid.')
  })

  // Additional tests and logic as needed
})
