import {
  Signer,
  ethers,
  getAddress,
  hexlify,
  ZeroAddress,
  Contract,
  parseUnits
} from 'ethers'
import { Readable } from 'stream'
import { createHash } from 'crypto'
import { EncryptMethod } from '../../@types/fileObject.js'
import ERC721Factory from '@oceanprotocol/contracts/artifacts/contracts/ERC721Factory.sol/ERC721Factory.json' assert { type: 'json' }
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import {
  DEVELOPMENT_CHAIN_ID,
  getOceanArtifactsAdresses,
  getOceanArtifactsAdressesByChainId
} from '../../utils/address.js'
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' assert { type: 'json' }
import { getEventFromTx, streamToObject } from '../../utils/util.js'

import { encrypt } from '../../utils/crypt.js'
import { AssetUtils } from '../../utils/asset.js'

import {
  DDO_IDENTIFIER_PREFIX,
  PROTOCOL_COMMANDS,
  getConfiguration
} from '../../utils/index.js'
import { FeesHandler } from '../../components/core/handler/feesHandler.js'
import { OceanNode } from '../../OceanNode.js'
import { ProviderFees } from '../../@types/Fees.js'

export async function publishAsset(asset: any, publisherAccount: Signer) {
  const genericAsset = JSON.parse(JSON.stringify(asset))
  try {
    let network = getOceanArtifactsAdressesByChainId(DEVELOPMENT_CHAIN_ID)
    if (!network) {
      network = getOceanArtifactsAdresses().development
    }
    const net = await publisherAccount.provider.getNetwork()
    const chainId = net && net.chainId ? net.chainId : DEVELOPMENT_CHAIN_ID
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
    genericAsset.services[0].datatokenAddress = datatokenAddress
    genericAsset.nftAddress = nftAddress
    // let's call node to encrypt

    const data = Uint8Array.from(
      Buffer.from(JSON.stringify(genericAsset.services[0].files))
    )
    const encryptedData = await encrypt(data, EncryptMethod.ECIES)
    const encryptedDataString = encryptedData.toString('hex')

    const nftContract = new ethers.Contract(
      nftAddress,
      ERC721Template.abi,
      publisherAccount
    )
    genericAsset.id =
      DDO_IDENTIFIER_PREFIX +
      createHash('sha256')
        .update(getAddress(nftAddress) + chainId.toString(10))
        .digest('hex')
    genericAsset.nftAddress = nftAddress
    genericAsset.chainId = parseInt(chainId.toString(10))

    genericAsset.services[0].files = encryptedDataString
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
      datatokenAddress,
      trxReceipt
    }
  } catch (ex) {
    console.log('publish asset error: ', ex)
    return null
  }
}

export async function orderAsset(
  genericAsset: any,
  serviceIndex: number,
  consumerAccount: Signer,
  consumerAddress: string,
  publisherAccount: Signer,
  oceanNode?: OceanNode,
  providerFees?: ProviderFees
) {
  const consumeMarketFeeAddress = ZeroAddress
  const consumeMarketFeeAmount = 0
  const consumeMarketFeeToken = ZeroAddress
  const service = AssetUtils.getServiceByIndex(genericAsset, serviceIndex)

  let orderTxReceipt = null
  const dataTokenContract = new Contract(
    service.datatokenAddress,
    ERC20Template.abi,
    publisherAccount
  )

  if (!providerFees) {
    const oceanNodeConfig = await getConfiguration(true)
    const statusCommand = {
      command: PROTOCOL_COMMANDS.GET_FEES,
      ddoId: genericAsset.id,
      serviceId: service.id,
      consumerAddress,
      node: oceanNodeConfig.keys.peerId.toString()
    }
    const response = await new FeesHandler(oceanNode).handle(statusCommand)
    const fees = await streamToObject(response.stream as Readable)
    providerFees = fees.providerFee
  }
  // call the mint function on the dataTokenContract
  const mintTx = await dataTokenContract.mint(
    await consumerAccount.getAddress(),
    parseUnits('1000', 18)
  )
  await mintTx.wait()
  if (providerFees.providerFeeToken !== ZeroAddress) {
    // get provider fees in our account as well
    const providerFeeTokenContract = new Contract(
      providerFees.providerFeeToken,
      ERC20Template.abi,
      publisherAccount
    )
    const mintTx = await providerFeeTokenContract.mint(
      await consumerAccount.getAddress(),
      providerFees.providerFeeAmount
    )
    await mintTx.wait()

    const approveTx = await (
      providerFeeTokenContract.connect(consumerAccount) as any
    ).approve(await dataTokenContract.getAddress(), providerFees.providerFeeAmount)
    await approveTx.wait()
  }
  const dataTokenContractWithNewSigner = dataTokenContract.connect(consumerAccount) as any
  try {
    const orderTx = await dataTokenContractWithNewSigner.startOrder(
      consumerAddress,
      serviceIndex,
      {
        providerFeeAddress: providerFees.providerFeeAddress,
        providerFeeToken: providerFees.providerFeeToken,
        providerFeeAmount: providerFees.providerFeeAmount,
        v: providerFees.v,
        r: providerFees.r,
        s: providerFees.s,
        providerData: providerFees.providerData,
        validUntil: providerFees.validUntil
      },
      {
        consumeMarketFeeAddress,
        consumeMarketFeeToken,
        consumeMarketFeeAmount
      }
    )
    orderTxReceipt = await orderTx.wait()
  } catch (e) {
    console.log(e)
  }
  return orderTxReceipt
}

export async function reOrderAsset(
  previousOrderTxId: string,
  genericAsset: any,
  serviceIndex: number,
  consumerAccount: Signer,
  consumerAddress: string,
  publisherAccount: Signer,
  oceanNode?: OceanNode,
  providerFees?: ProviderFees
) {
  let orderTxReceipt
  const consumeMarketFeeAddress = ZeroAddress
  const consumeMarketFeeAmount = 0
  const consumeMarketFeeToken = ZeroAddress
  const service = AssetUtils.getServiceByIndex(genericAsset, serviceIndex)
  const dataTokenContract = new Contract(
    service.datatokenAddress,
    ERC20Template.abi,
    publisherAccount
  )

  if (!providerFees) {
    const oceanNodeConfig = await getConfiguration(true)
    const statusCommand = {
      command: PROTOCOL_COMMANDS.GET_FEES,
      ddoId: genericAsset.id,
      serviceId: service.id,
      consumerAddress,
      node: oceanNodeConfig.keys.peerId.toString()
    }
    const response = await new FeesHandler(oceanNode).handle(statusCommand)
    const fees = await streamToObject(response.stream as Readable)
    providerFees = fees.providerFee
  }
  // call the mint function on the dataTokenContract
  const mintTx = await dataTokenContract.mint(
    await consumerAccount.getAddress(),
    parseUnits('1000', 18)
  )
  await mintTx.wait()
  if (providerFees.providerFeeToken !== ZeroAddress) {
    // get provider fees in our account as well
    const providerFeeTokenContract = new Contract(
      providerFees.providerFeeToken,
      ERC20Template.abi,
      publisherAccount
    )
    const mintTx = await providerFeeTokenContract.mint(
      await consumerAccount.getAddress(),
      providerFees.providerFeeAmount
    )
    await mintTx.wait()

    const approveTx = await (
      providerFeeTokenContract.connect(consumerAccount) as any
    ).approve(await dataTokenContract.getAddress(), providerFees.providerFeeAmount)
    await approveTx.wait()
  }
  const dataTokenContractWithNewSigner = dataTokenContract.connect(consumerAccount) as any
  try {
    const orderTx = await dataTokenContractWithNewSigner.reuseOrder(
      previousOrderTxId,
      {
        providerFeeAddress: providerFees.providerFeeAddress,
        providerFeeToken: providerFees.providerFeeToken,
        providerFeeAmount: providerFees.providerFeeAmount,
        v: providerFees.v,
        r: providerFees.r,
        s: providerFees.s,
        providerData: providerFees.providerData,
        validUntil: providerFees.validUntil
      },
      {
        consumeMarketFeeAddress,
        consumeMarketFeeToken,
        consumeMarketFeeAmount
      }
    )
    orderTxReceipt = await orderTx.wait()
  } catch (e) {
    console.log(e)
  }
  return orderTxReceipt
}
