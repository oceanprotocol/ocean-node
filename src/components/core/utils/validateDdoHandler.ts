import rdfDataModel from '@rdfjs/data-model'
import rdfDataset from '@rdfjs/dataset'
import toNT from '@rdfjs/to-ntriples'
import { Parser, Quad } from 'n3'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
// @ts-ignore
import * as shaclEngine from 'shacl-engine'
import { createHash } from 'crypto'
import { ethers, getAddress } from 'ethers'
import { readFile } from 'node:fs/promises'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { create256Hash } from '../../../utils/crypt.js'

const CURRENT_VERSION = '4.5.0'
const ALLOWED_VERSIONS = ['4.1.0', '4.3.0', '4.5.0']

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

function parseReportToErrors(results: any): Record<string, string> {
  const paths = results
    .filter((result: any) => result.path)
    .map((result: any) => toNT(result.path))
    .map((path: any) => path.replace('http://schema.org/', ''))

  const messages = results
    .filter((result: any) => result.message)
    .map((result: any) => toNT(result.message))
    .map(beautifyMessage)

  return Object.fromEntries(
    paths.map((path: string, index: number) => [path, messages[index]])
  )
}

function beautifyMessage(message: string): string {
  if (message.startsWith('Less than 1 values on')) {
    const index = message.indexOf('->') + 2
    message = 'Less than 1 value on ' + message.slice(index)
  }
  return message
}

function isIsoFormat(dateString: string): boolean {
  const isoDateRegex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z)?$/
  return isoDateRegex.test(dateString)
}

function makeDid(nftAddress: string, chainId: string): string {
  return (
    'did:op:' +
    createHash('sha256')
      .update(getAddress(nftAddress) + chainId)
      .digest('hex')
  )
}
export async function validateObject(
  obj: Record<string, any>,
  chainId: number,
  nftAddress: string
): Promise<[boolean, Record<string, string>]> {
  const ddoCopy = JSON.parse(JSON.stringify(obj))
  ddoCopy['@type'] = 'DDO'
  const extraErrors: Record<string, string> = {}
  if (!('@context' in obj)) {
    extraErrors['@context'] = 'Context is missing.'
  }
  if ('@context' in obj && !Array.isArray(obj['@context'])) {
    extraErrors['@context'] = 'Context is not an array.'
  }
  if (!('metadata' in obj)) {
    extraErrors.metadata = 'Metadata is missing or invalid.'
  }

  ;['created', 'updated'].forEach((attr) => {
    if ('metadata' in obj && attr in obj.metadata && !isIsoFormat(obj.metadata[attr])) {
      extraErrors.metadata = `${attr} is not in ISO format.`
    }
  })

  if (!chainId) {
    extraErrors.chainId = 'chainId is missing or invalid.'
  }

  try {
    getAddress(nftAddress)
  } catch (err) {
    extraErrors.nftAddress = 'nftAddress is missing or invalid.'
    CORE_LOGGER.logMessage(`Error when retrieving address ${nftAddress}: ${err}`, true)
  }

  if (!(makeDid(nftAddress, chainId.toString(10)) === obj.id)) {
    extraErrors.id = 'did is not valid for chain Id and nft address'
  }

  // @context key is reserved in JSON-LD format
  ddoCopy['@context'] = { '@vocab': 'http://schema.org/' }

  const version = obj.version || CURRENT_VERSION
  const schemaFilePath = getSchema(version)
  const filename = new URL(schemaFilePath, import.meta.url)
  const dataset = rdfDataset.dataset()
  try {
    const contents = await readFile(filename, { encoding: 'utf8' })
    const parser = new Parser()
    const quads = parser.parse(contents)
    quads.forEach((quad: Quad) => {
      dataset.add(quad)
    })
  } catch (err) {
    CORE_LOGGER.logMessage(`Error detecting schema file: ${err}`, true)
  }
  // create a validator instance for the shapes in the given dataset
  const validator = new shaclEngine.Validator(dataset, {
    factory: rdfDataModel
  })

  // run the validation process
  const report = await validator.validate({ dataset })
  if (!report) {
    const errorMsg = 'Validation report does not exist'
    CORE_LOGGER.logMessage(errorMsg, true)
    return [false, { error: errorMsg }]
  }
  const errors = parseReportToErrors(report.results)

  if (extraErrors) {
    // Merge errors and extraErrors without overwriting existing keys
    const mergedErrors = { ...errors, ...extraErrors }

    // Check if there are any new errors introduced
    const newErrorsIntroduced = Object.keys(mergedErrors).some(
      (key) => !Object.prototype.hasOwnProperty.call(errors, key)
    )

    if (newErrorsIntroduced) {
      return [false, mergedErrors]
    }
  }

  return [report.conforms, errors]
}

/**
 * TODO double check this, not sure if is correct
 * TODO create a ValidationSignature type for the response
 * @param raw DDO
 * @returns hash
 */
export async function getValidationSignature(rawDDO: string): Promise<any> {
  let values = {}
  try {
    const hashedRaw = create256Hash(rawDDO)
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY)

    const message = ethers.solidityPackedKeccak256(
      ['bytes'],
      [ethers.hexlify(ethers.toUtf8Bytes(hashedRaw))]
    )
    const signed = await wallet.signMessage(message)
    const signatureSplitted = ethers.Signature.from(signed)
    const v = signatureSplitted.v <= 1 ? signatureSplitted.v + 27 : signatureSplitted.v
    const r = ethers.hexlify(signatureSplitted.r) // 32 bytes
    const s = ethers.hexlify(signatureSplitted.s)

    values = { hash: hashedRaw, publicKey: wallet.address, r, s, v }
  } catch (error) {
    console.error(error)
    values = { hash: '', publicKey: '', r: '', s: '', v: '' }
  }
  return values
}
