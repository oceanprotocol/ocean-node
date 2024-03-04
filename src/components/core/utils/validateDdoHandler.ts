// eslint-disable-next-line import/no-duplicates
import rdfDataModel from '@rdfjs/data-model'
import rdfDataset from '@rdfjs/dataset'
import toNT from '@rdfjs/to-ntriples'
import { Parser, Quad } from 'n3'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
// @ts-ignore
import * as shaclEngine from 'shacl-engine'
// import { createHash } from 'crypto'
import { ethers } from 'ethers' // getAddress
import { readFile } from 'node:fs/promises'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { create256Hash } from '../../../utils/crypt.js'
import { getProviderWallet } from './feesHandler.js'
// eslint-disable-next-line import/no-duplicates
import factory from '@rdfjs/data-model'

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
  CORE_LOGGER.logMessage(`results for errors: ${JSON.stringify(results)}`)
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

// function isIsoFormat(dateString: string): boolean {
//   const isoDateRegex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z)?$/
//   return isoDateRegex.test(dateString)
// }

// function makeDid(nftAddress: string, chainId: string): string {
//   return (
//     'did:op:' +
//     createHash('sha256')
//       .update(getAddress(nftAddress) + chainId)
//       .digest('hex')
//   )
// }

// export async function validateShortVersion(obj: Record<string, any>) {
//   const ddoCopy = JSON.parse(JSON.stringify(obj))
// }

export async function validateObject(
  obj: Record<string, any>,
  chainId: number,
  nftAddress: string
): Promise<[boolean, Record<string, string>]> {
  CORE_LOGGER.logMessage(`Validating object: ` + JSON.stringify(obj), true)
  const ddoCopy = JSON.parse(JSON.stringify(obj))
  ddoCopy['@type'] = 'DDO'
  // const extraErrors: Record<string, string> = {}
  // const timestamps = ['created', 'updated']
  // timestamps.forEach((attr) => {
  //   if ('metadata' in obj && attr in obj.metadata && !isIsoFormat(obj.metadata[attr])) {
  //     extraErrors.metadata = `${attr} is not in ISO format.`
  //   }
  // })

  // if (!chainId && chainId !== ddoCopy.chainId) {
  //   extraErrors.chainId = 'chainId is missing or invalid.'
  // }

  // try {
  //   getAddress(nftAddress)
  // } catch (err) {
  //   extraErrors.nftAddress = 'nftAddress is missing or invalid.'
  //   CORE_LOGGER.logMessage(`Error when retrieving address ${nftAddress}: ${err}`, true)
  // }

  // if (!(makeDid(nftAddress, chainId.toString(10)) === obj.id)) {
  //   extraErrors.id = 'did is not valid for chain Id and nft address'
  // }

  const version = obj.version || CURRENT_VERSION
  const schemaFilePath = getSchema(version)
  const filename = new URL(schemaFilePath, import.meta.url)
  const schemaDataset = rdfDataset.dataset()
  const dataset = rdfDataset.dataset()
  try {
    const contents = await readFile(filename, { encoding: 'utf8' })
    const parser = new Parser()
    const quads = parser.parse(contents)
    quads.forEach((quad: Quad) => {
      schemaDataset.add(quad)
    })
  } catch (err) {
    CORE_LOGGER.logMessage(`Error detecting schema file: ${err}`, true)
  }
  Object.entries(ddoCopy).forEach(([key, value]) => {
    CORE_LOGGER.logMessage(`key value: ${key} ${JSON.stringify(value)}`)
    const subject = factory.namedNode(`http://example.org/ddo/${key}`)
    CORE_LOGGER.logMessage(
      `subject: ${JSON.stringify(subject)}, url http://example.org/ddo/${key}`
    )
    const predicate = factory.namedNode('http://example.org/ddo/property')
    CORE_LOGGER.logMessage(`predicate: ${JSON.stringify(predicate)}`)
    let stringValue = ''
    if (typeof value === 'object') {
      stringValue = JSON.stringify(value)
    } else {
      stringValue = value.toString()
    }
    const object = factory.literal(stringValue)
    CORE_LOGGER.logMessage(`object: ${JSON.stringify(object)}`)
    dataset.add(factory.quad(subject, predicate, object))
  })
  CORE_LOGGER.logMessage(`dataset after the update: ${JSON.stringify(dataset)}`)
  // create a validator instance for the shapes in the given dataset
  const validator = new shaclEngine.Validator(schemaDataset, {
    factory: rdfDataModel
  })

  CORE_LOGGER.logMessage(`validator: ${JSON.stringify(validator)}`)

  // run the validation process
  const report = await validator.validate({ dataset })
  CORE_LOGGER.logMessage(`report: ${JSON.stringify(report)}`)
  if (!report) {
    const errorMsg = 'Validation report does not exist'
    CORE_LOGGER.logMessage(errorMsg, true)
    return [false, { error: errorMsg }]
  }
  const errors = parseReportToErrors(report.results)
  // if (extraErrors) {
  //   // Merge errors and extraErrors without overwriting existing keys
  //   const mergedErrors = { ...errors, ...extraErrors }
  //   // Check if there are any new errors introduced
  //   const newErrorsIntroduced = Object.keys(mergedErrors).some(
  //     (key) => !Object.prototype.hasOwnProperty.call(errors, key)
  //   )
  //   if (newErrorsIntroduced) {
  //     CORE_LOGGER.logMessage(
  //       `validateObject found new errors introduced: ${JSON.stringify(mergedErrors)}`,
  //       true
  //     )
  //     CORE_LOGGER.logMessage(`mergedErrors: ${mergedErrors}`)

  //     return [false, mergedErrors]
  //   }
  // }
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
