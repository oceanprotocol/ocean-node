import { expect } from 'chai'
import { ethers } from 'ethers'
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' with { type: 'json' }
import { findMetadataEventInLogs } from '../../components/core/handler/ddoHandler.js'
import { EVENTS } from '../../utils/constants.js'

describe('findMetadataEventInLogs', () => {
  const nftAddress = '0x0d4Aa8DfDdBE0c4B4d5DF981f5416fd6001CE1e8'
  const otherNftAddress = '0x2473f4F7bf40ed0310eEf9f3b52A9c15dbC1DCbc'
  const publisherAddress = '0xe2DD09d719Da89e5a3D0F2549c7E24566e947260'
  const abiInterface = new ethers.Interface(ERC721Template.abi)

  const flags = '0x02'
  const encryptedData = '0x1234567890abcdef'
  const metaDataHash = ethers.id('some metadata')

  function buildMetadataLog(eventName: string, emitter: string) {
    const { topics, data } = abiInterface.encodeEventLog(eventName, [
      publisherAddress,
      0,
      'http://localhost:8000',
      flags,
      encryptedData,
      metaDataHash,
      1735689600,
      100
    ])
    return { address: emitter, topics, data }
  }

  // an unrelated event emitted before the metadata one (e.g. by an ERC-4337
  // entry point, a multisig wallet or an ERC20 token)
  function buildForeignLog(emitter: string) {
    return {
      address: emitter,
      topics: [
        ethers.id('Transfer(address,address,uint256)'),
        ethers.zeroPadValue(publisherAddress, 32),
        ethers.zeroPadValue(otherNftAddress, 32)
      ],
      data: ethers.zeroPadValue('0x01', 32)
    }
  }

  it('should find MetadataCreated when it is not the first log in the receipt', () => {
    const logs = [
      buildForeignLog('0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789'),
      buildForeignLog(otherNftAddress),
      buildMetadataLog(EVENTS.METADATA_CREATED, nftAddress)
    ]
    const eventData = findMetadataEventInLogs(logs, nftAddress)
    expect(eventData).to.not.equal(null)
    expect(eventData.name).to.equal(EVENTS.METADATA_CREATED)
    expect(parseInt(eventData.args[3], 16)).to.equal(2)
    expect(eventData.args[4]).to.equal(encryptedData)
    expect(eventData.args[5]).to.equal(metaDataHash)
  })

  it('should find MetadataUpdated as well', () => {
    const logs = [
      buildForeignLog(otherNftAddress),
      buildMetadataLog(EVENTS.METADATA_UPDATED, nftAddress)
    ]
    const eventData = findMetadataEventInLogs(logs, nftAddress)
    expect(eventData).to.not.equal(null)
    expect(eventData.name).to.equal(EVENTS.METADATA_UPDATED)
  })

  it('should match the data NFT address case-insensitively', () => {
    const logs = [buildMetadataLog(EVENTS.METADATA_CREATED, nftAddress.toLowerCase())]
    const eventData = findMetadataEventInLogs(logs, nftAddress)
    expect(eventData).to.not.equal(null)
    expect(eventData.name).to.equal(EVENTS.METADATA_CREATED)
  })

  it('should ignore metadata events emitted by other contracts', () => {
    const logs = [
      buildMetadataLog(EVENTS.METADATA_CREATED, otherNftAddress),
      buildMetadataLog(EVENTS.METADATA_UPDATED, nftAddress)
    ]
    const eventData = findMetadataEventInLogs(logs, nftAddress)
    expect(eventData).to.not.equal(null)
    expect(eventData.name).to.equal(EVENTS.METADATA_UPDATED)
  })

  it('should return null when the transaction has no metadata event', () => {
    const logs = [buildForeignLog(nftAddress), buildForeignLog(otherNftAddress)]
    expect(findMetadataEventInLogs(logs, nftAddress)).to.equal(null)
  })

  it('should return null for an empty logs array', () => {
    expect(findMetadataEventInLogs([], nftAddress)).to.equal(null)
  })
})
