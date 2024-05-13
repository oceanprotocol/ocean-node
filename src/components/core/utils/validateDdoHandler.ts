// eslint-disable-next-line import/no-duplicates
import rdfDataModel from '@rdfjs/data-model'
// eslint-disable-next-line import/no-duplicates
import factory from '@rdfjs/data-model'
import rdfDataset from '@rdfjs/dataset'
import toNT from '@rdfjs/to-ntriples'
// import { Parser, Quad } from 'n3'
import { fromFile } from 'rdf-utils-fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
// @ts-ignore
import * as shaclEngine from 'shacl-engine'
import { createHash } from 'crypto'
import { ethers, getAddress } from 'ethers'
import pkg from 'rdf-dataset-ext'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { create256Hash } from '../../../utils/crypt.js'
import { getProviderWallet } from './feesHandler.js'
// import * as SHACL from 'shacl-js'
// import pkg2 from 'shacl-js'
// import { jsonParser } from 'rdflib'
// const { SHACLValidator } = pkg2
const { fromStream } = pkg
// import { readFile } from 'node:fs/promises'
// import { fromFile } from 'rdf-utils-fs'
// // eslint-disable-next-line import/no-duplicates
// import factory from '@rdfjs/data-model'
// // import { fromStream } from 'rdf-dataset-ext'
// import pkg from 'rdf-dataset-ext'
// const { fromStream } = pkg

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

export function makeDid(nftAddress: string, chainId: string): string {
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
  CORE_LOGGER.logMessage(`Validating object: ` + JSON.stringify(obj), true)
  const ddoCopy = JSON.parse(JSON.stringify(obj))
  ddoCopy['@type'] = 'DDO'
  ddoCopy['@context'] = { '@vocab': 'http://schema.org/' }
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

  const version = obj.version || CURRENT_VERSION
  const schemaFilePath = getSchema(version)
  // const filename = new URL(schemaFilePath, import.meta.url)
  let schemaDataset = rdfDataset.dataset()
  const dataset = rdfDataset.dataset()
  try {
    schemaDataset = await fromStream(schemaDataset, fromFile(schemaFilePath))
    CORE_LOGGER.logMessage(`Schema quads: ${JSON.stringify(schemaDataset)}`)
    // // When the stream ends, log the dataset
    // quadsStream.on('end', () => {
    // })
  } catch (err) {
    CORE_LOGGER.logMessage(`Error detecting schema file: ${err}`, true)
  }
  const shapes: any[] = []
  Object.entries(ddoCopy).forEach(([key, value]) => {
    const subject = factory.namedNode(`http://example.org/ddo/${key}`)
    const predicate = factory.namedNode('http://example.org/ddo/property')
    const shape = factory.namedNode('http://example.org/ddo/shape')
    let stringValue = ''
    if (typeof value === 'object') {
      stringValue = JSON.stringify(value)
    } else {
      stringValue = value.toString()
    }
    const object = factory.literal(stringValue)
    // const valid = new SHACLValidator()
    // CORE_LOGGER.logMessage(`node validaor with new lib: ${valid}`)
    // CORE_LOGGER.logMessage(
    //   `node validation with new lib: ${valid.prototype.validate(
    //     JSON.stringify(ddoCopy),
    //     'text/turtle',
    //     shape,
    //     'text/turtle'
    //   )}`
    // )
    shapes.push(shape)
    dataset.add(factory.quad(subject, predicate, object))
  })
  CORE_LOGGER.logMessage(`shapes: ${shapes}`)
  // const graph = new jsonParser()
  // graph.parseJSON(ddoCopy, 'json-ld')
  // CORE_LOGGER.logMessage(`dataset after the update: ${JSON.stringify(graph)}`)
  // create a validator instance for the shapes in the given dataset
  const validator = new shaclEngine.Validator(schemaDataset, {
    factory: rdfDataModel
  })
  // run the validation process
  const report = await validator.validate(JSON.stringify(ddoCopy), shapes)
  CORE_LOGGER.logMessage(`report: ${JSON.stringify(report)}`)
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
      CORE_LOGGER.logMessage(
        `validateObject found new errors introduced: ${JSON.stringify(mergedErrors)}`,
        true
      )

      return [false, mergedErrors]
    }
  }
  return [report.conforms, errors]
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
