import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
// @ts-ignore
import { V4DDO, V5DDO } from '@oceanprotocol/ddo-js'
import rdf from '@zazuko/env-node'
import SHACLValidator from 'rdf-validate-shacl'
import formats from '@rdfjs/formats-common'
import { fromRdf } from 'rdf-literal'
import { ethers, getAddress } from 'ethers'
import { CORE_LOGGER, INDEXER_LOGGER } from '../../../utils/logging/common.js'
import { create256Hash } from '../../../utils/crypt.js'
import { getProviderWallet } from './feesHandler.js'
import { Readable } from 'stream'
import { deleteIndexedMetadataIfExists } from '../../../utils/asset.js'

const CURRENT_VERSION = '4.7.0'
const ALLOWED_VERSIONS = ['4.1.0', '4.3.0', '4.5.0', '4.7.0']

export function getSchema(version: string = CURRENT_VERSION): string {
  if (!ALLOWED_VERSIONS.includes(version)) {
    CORE_LOGGER.logMessage(`Can't find schema ${version}`, true)
    return
  }
  const path = `../../../../schemas/${version}.ttl`
  // Use fileURLToPath to convert the URL to a file path
  const currentModulePath = fileURLToPath(import.meta.url)

  // Use dirname to get the directory name
  const currentDirectory = dirname(currentModulePath)
  const schemaFilePath = resolve(currentDirectory, path)
  if (!schemaFilePath) {
    CORE_LOGGER.logMessage(`Can't find schema ${version}`, true)
    return
  }
  return schemaFilePath
}

/* function isIsoFormat(dateString: string): boolean {
  const isoDateRegex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z)?$/
  return isoDateRegex.test(dateString)
}
*/

export function makeDid(
  ddo: Record<string, any>,
  dataNftAddress: string, // get the data from blockchain event
  chainId: string
): string {
  if (ddo.version.startsWith('4.')) {
    return V4DDO.getDDOClass(ddo).makeDid(dataNftAddress, chainId)
  } else if (ddo.version.startsWith('5.')) {
    return V5DDO.getDDOClass(ddo).makeDid(dataNftAddress, chainId)
  } else {
    INDEXER_LOGGER.error(`Version of DDO unknown: ${ddo.version}`)
  }
}

export async function validateObject(
  obj: Record<string, any>,
  chainId: number,
  nftAddress: string
): Promise<[boolean, Record<string, string[]>]> {
  const updatedDdo = deleteIndexedMetadataIfExists(obj)
  const ddoCopy = JSON.parse(JSON.stringify(updatedDdo))
  ddoCopy['@type'] = 'DDO'

  const extraErrors: Record<string, string[]> = {}
  // overwrite context
  ddoCopy['@context'] = {
    '@vocab': 'http://schema.org/'
  }
  /* if (!('@context' in ddoCopy) || !Array.isArray(ddoCopy['@context'])) {
    ddoCopy['@context'] = {
      '@vocab': 'http://schema.org/'
    }
  }
  if (!('@vocab' in ddoCopy['@context'])) {
    ddoCopy['@context']['@vocab'] = 'http://schema.org/'
  }
  */
  /* if (!('metadata' in obj)) {
    if (!('metadata' in extraErrors)) extraErrors.metadata = []
    extraErrors.metadata.push('Metadata is missing.')
  } 
  if (obj.metadata && !('created' in obj.metadata)) {
    if (!('created' in extraErrors)) extraErrors.created = []
    extraErrors.created.push('Created is missing or invalid.')
  }
  if (obj.metadata && !('updated' in obj.metadata)) {
    if (!('updated' in extraErrors)) extraErrors.updated = []
    extraErrors.updated.push('Metadata is missing or invalid.')
  }
  ;['created', 'updated'].forEach((attr) => {
    if ('metadata' in obj && attr in obj.metadata && !isIsoFormat(obj.metadata[attr])) {
      if (!('metadata' in extraErrors)) extraErrors.metadata = []
      extraErrors.metadata.push(`${attr} is not in ISO format.`)
    }
  })
  */
  if (!chainId) {
    if (!('chainId' in extraErrors)) extraErrors.chainId = []
    extraErrors.chainId.push('chainId is missing or invalid.')
  }

  try {
    getAddress(nftAddress)
  } catch (err) {
    if (!('nftAddress' in extraErrors)) extraErrors.nftAddress = []
    extraErrors.nftAddress.push('nftAddress is missing or invalid.')
    CORE_LOGGER.logMessage(`Error when retrieving address ${nftAddress}: ${err}`, true)
  }

  if (!(makeDid(ddoCopy, nftAddress, chainId.toString(10)) === obj.id)) {
    if (!('id' in extraErrors)) extraErrors.id = []
    extraErrors.id.push('did is not valid for chain Id and nft address')
  }
  const version = ddoCopy.version || CURRENT_VERSION
  const schemaFilePath = getSchema(version)
  CORE_LOGGER.logMessage(`Using ` + schemaFilePath, true)

  const shapes = await rdf.dataset().import(rdf.fromFile(schemaFilePath))
  const dataStream = Readable.from(JSON.stringify(ddoCopy))
  const output = formats.parsers.import('application/ld+json', dataStream)
  const data = await rdf.dataset().import(output)
  const validator = new SHACLValidator(shapes, { factory: rdf })
  const report = await validator.validate(data)
  if (report.conforms) {
    CORE_LOGGER.logMessage(`Valid object: ` + JSON.stringify(obj), true)
    return [true, {}]
  }
  for (const result of report.results) {
    // See https://www.w3.org/TR/shacl/#results-validation-result for details
    // about each property
    const key = result.path.value.replace('http://schema.org/', '')
    if (!(key in extraErrors)) extraErrors[key] = []
    extraErrors[key].push(fromRdf(result.message[0]))
  }
  extraErrors.fullReport = await report.dataset.serialize({
    format: 'application/ld+json'
  })
  CORE_LOGGER.logMessage(`Failed to validate DDO: ` + JSON.stringify(obj), true)
  CORE_LOGGER.logMessage(JSON.stringify(extraErrors), true)
  return [false, extraErrors]
}

export async function getValidationSignature(ddo: string): Promise<any> {
  try {
    const hashedDDO = create256Hash(ddo)
    const providerWallet = await getProviderWallet()
    const messageHash = ethers.solidityPackedKeccak256(
      ['bytes'],
      [ethers.hexlify(ethers.toUtf8Bytes(hashedDDO))]
    )
    const signed32Bytes = await providerWallet.signMessage(
      new Uint8Array(ethers.toBeArray(messageHash))
    )
    const signatureSplitted = ethers.Signature.from(signed32Bytes)
    const v = signatureSplitted.v <= 1 ? signatureSplitted.v + 27 : signatureSplitted.v
    const r = ethers.hexlify(signatureSplitted.r) // 32 bytes
    const s = ethers.hexlify(signatureSplitted.s)
    return { hash: hashedDDO, publicKey: providerWallet.address, r, s, v }
  } catch (error) {
    CORE_LOGGER.logMessage(`Validation signature error: ${error}`, true)
    return { hash: '', publicKey: '', r: '', s: '', v: '' }
  }
}
