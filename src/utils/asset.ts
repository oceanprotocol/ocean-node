import axios from 'axios'
import { Service, DDOManager, DDO } from '@oceanprotocol/ddo-js'
import { DDO_IDENTIFIER_PREFIX } from './constants.js'
import { CORE_LOGGER } from './logging/common.js'
import { createHash } from 'crypto'
import { ethers, getAddress, Signer } from 'ethers'
import { KNOWN_CONFIDENTIAL_EVMS } from './address.js'
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/interfaces/IERC20Template.sol/IERC20Template.json' assert { type: 'json' }
import ERC20Template4 from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20Template4.sol/ERC20Template4.json' assert { type: 'json' }
import { getContractAddress, getNFTFactory } from '../components/Indexer/utils.js'

// Notes:
// Asset as per asset.py on provider, is a class there, while on ocean.Js we only have a type
// this is an utility to extract information from the Asset services
export const AssetUtils = {
  getServiceIndexById(asset: DDO, id: string): number | null {
    const ddoInstance = DDOManager.getDDOClass(asset)
    const { services } = ddoInstance.getDDOFields()

    for (let c = 0; c < services.length; c++) if (services[c].id === id) return c
    return null
  },
  getServiceByIndex(asset: DDO, index: number) {
    const ddoInstance = DDOManager.getDDOClass(asset)
    const { services } = ddoInstance.getDDOFields()

    if (index >= 0 && index < services.length) {
      return services[index]
    }
    return null
  },

  getServiceById(asset: DDO, id: string) {
    const ddoInstance = DDOManager.getDDOClass(asset)
    const { services } = ddoInstance.getDDOFields() as any

    const filteredServices = services.filter((service: any) => service.id === id)

    return filteredServices.length ? filteredServices[0] : null
  }
}

export async function fetchFileMetadata(
  url: string,
  method: string,
  forceChecksum: boolean
): Promise<{ contentLength: string; contentType: string; contentChecksum: string }> {
  let contentType: string = ''
  let contentLength: number = 0
  const contentChecksum = createHash('sha256')
  const maxLengthInt = parseInt(process.env.MAX_CHECKSUM_LENGTH, 10)
  const maxLength = isNaN(maxLengthInt) ? 10 * 1024 * 1024 : maxLengthInt

  try {
    const response = await axios({
      url,
      method: method || 'get',
      responseType: 'stream'
    })
    contentType = response.headers['content-type']
    let totalSize = 0
    for await (const chunk of response.data) {
      totalSize += chunk.length
      contentChecksum.update(chunk)
      if (totalSize > maxLength && !forceChecksum) {
        contentLength = 0
        break
      }
    }
    contentLength = totalSize
  } catch (error) {
    CORE_LOGGER.error(error)
  }

  return {
    contentLength: contentLength.toString(),
    contentType,
    contentChecksum: contentChecksum.digest('hex')
  }
}

/**
 * Validates if a given DDO identifier matches the NFT address and the chain ID provided
 * @param ddoID the ID of the DDO
 * @param nftAddress the nft address
 * @param chainId the chain id
 * @returns validation result
 */
export function validateDDOHash(
  ddoID: string,
  nftAddress: string,
  chainId: number
): boolean {
  if (!ddoID || !nftAddress || !chainId) {
    CORE_LOGGER.error('Invalid or missing data for proper DDO id validation')
    return false
  }
  const hashAddressAndChain: string = generateDDOHash(nftAddress, chainId)
  return ddoID === hashAddressAndChain
}

export function deleteIndexedMetadataIfExists(
  ddo: Record<string, any>
): Record<string, any> {
  const ddoCopy: Record<string, any> = structuredClone(ddo)
  if ('indexedMetadata' in ddoCopy) {
    delete ddoCopy.indexedMetadata
    return ddoCopy
  }
  return ddo
}

/**
 * Generates DDO Id given the chain and nft address provided
 * @param nftAddress the nft address
 * @param chainId the chain id
 * @returns did
 */
export function generateDDOHash(nftAddress: string, chainId: number): string | null {
  if (!nftAddress || !chainId) {
    CORE_LOGGER.error('Invalid or missing data for proper DDO id hash generation')
    return null
  }
  const hashAddressAndChain: string = createHash('sha256')
    .update(getAddress(nftAddress) + chainId.toString(10))
    .digest('hex')

  return DDO_IDENTIFIER_PREFIX + hashAddressAndChain
}

/**
 * Checks if the given network is a confidential evm (oasis mainnet and testnet for now)
 * @param network name or chain id
 * @returns true if confidential evm
 */
export function isConfidentialEVM(network: bigint): boolean {
  return KNOWN_CONFIDENTIAL_EVMS.includes(network)
}

export async function isERC20Template4Active(
  network: number,
  owner: Signer
): Promise<boolean> {
  try {
    const nftFactoryAddress = getContractAddress(network, 'ERC721Factory')
    const factoryERC721 = await getNFTFactory(owner, nftFactoryAddress)
    const currentTokenCount = await factoryERC721.getCurrentTemplateCount()

    for (let i = 1; i <= currentTokenCount; i++) {
      const tokenTemplate = await factoryERC721.getTokenTemplate(i)

      const erc20Template: any = new ethers.Contract(
        tokenTemplate.templateAddress,
        ERC20Template.abi,
        owner
      )

      // check for ID
      const id = await erc20Template.connect(owner).getId()
      if (tokenTemplate.isActive && id.toString() === '4') {
        return true
      }
    }
  } catch (err) {
    CORE_LOGGER.error(
      'Error checking if ERCTemplate4 is active on confidential EVM: ' + err.message
    )
  }

  return false
}

export async function isDataTokenTemplate4(
  templateAddress: string, // template address
  owner: Signer
): Promise<boolean> {
  try {
    const erc20Template: any = new ethers.Contract(
      templateAddress,
      ERC20Template.abi,
      owner
    )
    const id = await erc20Template.connect(owner).getId()
    return id.toString() === '4'
  } catch (err) {
    CORE_LOGGER.error(
      'Error checking if datatoken at address ' + templateAddress + ' has id 4'
    )
    return false
  }
}

export function isConfidentialChainDDO(ddoChain: bigint, ddoService: Service): boolean {
  const isConfidential = isConfidentialEVM(ddoChain)
  return isConfidential && (!ddoService.files || ddoService.files.length === 0)
}

/**
 * get files object from SC
 * @param serviceIndex service id
 * @param datatokenAddress data token address
 * @param signer provider wallet
 * @param consumerAddress consumer wallet address
 * @param consumerSignature signature
 * @param consumerData consumer data
 * @returns files object or null
 */
export async function getFilesObjectFromConfidentialEVM(
  serviceIndex: number,
  datatokenAddress: string,
  signer: Signer,
  consumerAddress: string,
  consumerSignature: string,
  consumerData: string
  // NOTE about signatures consume data:
  // ddo id + nonce (for downloading)
  // consumerAddress + datasets[0].documentId + nonce (for start/init compute)
): Promise<string> {
  try {
    const currentProviderAddress = await signer.getAddress()
    // now try to get the url
    const consumerMessage = ethers.hexlify(ethers.toUtf8Bytes(consumerData))

    const providerMessage = ethers.solidityPackedKeccak256(
      ['uint256', 'bytes'],
      [serviceIndex, consumerSignature]
    )

    const providerMessageHashBytes = ethers.toBeArray(providerMessage)
    const providerSignature = await signer.signMessage(providerMessageHashBytes)

    CORE_LOGGER.info('Try getFilesObject from Confidential EVM (SC call)')
    const contract = new ethers.Contract(datatokenAddress, ERC20Template4.abi, signer)

    // call smart contract to decrypt
    const bytesData = await contract.getFilesObject(
      serviceIndex,
      currentProviderAddress,
      providerSignature,
      consumerMessage,
      consumerSignature,
      consumerAddress
    )
    const filesObject: string = ethers.toUtf8String(bytesData)
    return filesObject
  } catch (err) {
    CORE_LOGGER.error(
      'Unable to decrypt files object from Template4 on confidential EVM: ' + err.message
    )
    return null
  }
}
