import {
  JsonRpcProvider,
  Signer,
  Contract,
  ethers,
  getAddress,
  hexlify,
  ZeroAddress
} from 'ethers'
import { createHash } from 'crypto'
import { EncryptMethod } from '../../@types/fileObject.js'
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import {
  DEVELOPMENT_CHAIN_ID,
  getOceanArtifactsAdresses,
  getOceanArtifactsAdressesByChainId
} from '../../utils/address.js'

import { getEventFromTx } from '../../utils/util.js'

import { encrypt } from '../../utils/crypt.js'

export async function publishAsset(genericAsset: any, publisherAccount: Signer) {
  let network = getOceanArtifactsAdressesByChainId(DEVELOPMENT_CHAIN_ID)
  if (!network) {
    network = getOceanArtifactsAdresses().development
  }
  const publisherAddress = await publisherAccount.getAddress()
  const net = await publisherAccount.provider.getNetwork()
  const { chainId } = net
  const factoryContract = new ethers.Contract(
    network.ERC721Factory,
    ERC721Factory.abi,
    publisherAccount
  )
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
        ZeroAddress,
        ZeroAddress,
        '0x0000000000000000000000000000000000000000'
      ],
      uints: [1000, 0],
      bytess: []
    }
  )
  const txReceipt = await tx.wait()
  const nftEvent = getEventFromTx(txReceipt, 'NFTCreated')
  const erc20Event = getEventFromTx(txReceipt, 'TokenCreated')

  const nftAddress = nftEvent.args[0]
  const datatokenAddress = erc20Event.args[0]

  genericAsset.services[0].files.datatokenAddress = datatokenAddress
  genericAsset.services[0].files.nftAddress = nftAddress
  // let's call node to encrypt

  const data = Uint8Array.from(
    Buffer.from(JSON.stringify(genericAsset.services[0].files))
  )
  const encryptedData = await encrypt(data, EncryptMethod.ECIES)
  // const encryptedDataString = encryptedData.toString('base64')

  const nftContract = new ethers.Contract(
    nftAddress,
    ERC721Template.abi,
    publisherAccount
  )
  genericAsset.id =
    'did:op:' +
    createHash('sha256')
      .update(getAddress(nftAddress) + chainId.toString(10))
      .digest('hex')
  genericAsset.nftAddress = nftAddress

  genericAsset.services[0].files = encryptedData
  genericAsset.services[0].datatokenAddress = datatokenAddress

  const stringDDO = JSON.stringify(genericAsset)
  const bytes = Buffer.from(stringDDO)
  const metadata = hexlify(bytes)
  const hash = createHash('sha256').update(metadata).digest('hex')

  const setMetaDataTx = await nftContract.setMetaData(
    0,
    'http://v4.provider.oceanprotocol.com',
    '0x123',
    '0x01',
    metadata,
    '0x' + hash,
    []
  )
  const trxReceipt = await setMetaDataTx.wait()
  return {
    ddo: genericAsset,
    nftAddress: genericAsset.nftAddress,
    trxReceipt
  }
}
