// import toNT from '@rdfjs/to-ntriples'
import { Parser } from 'n3'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { readFile } from 'node:fs/promises'
import { createHash } from 'crypto'
import { ethers, getAddress } from 'ethers'
// import pkg from 'rdf-dataset-ext'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { create256Hash } from '../../../utils/crypt.js'
import { getProviderWallet } from './feesHandler.js'
// import SHACLValidator from 'rdf-validate-shacl'
// import { readFileSync } from 'fs'
// import { DatasetCore } from '@rdfjs/types'
// import { graph, jsonParser } from 'rdflib'
// eslint-disable-next-line import/no-duplicates
// import factory from '@rdfjs/data-model'
// import fromFile from 'rdf-utils-fs/fromFile.js'
// const { fromStream } = pkg
import pkg from 'jsonld'
const { expand, flatten, toRDF, fromRDF } = pkg

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

function validate(constraints: any, data: any) {
  const errors: Array<Record<string, string>> = []

  constraints.forEach((constraint: any) => {
    const path = constraint['http://www.w3.org/ns/shacl#path'][0]['@id']
    const minCount = constraint['http://www.w3.org/ns/shacl#minCount']
      ? parseInt(constraint['http://www.w3.org/ns/shacl#minCount'][0]['@value'], 10)
      : 0
    const maxCount = constraint['http://www.w3.org/ns/shacl#maxCount']
      ? parseInt(constraint['http://www.w3.org/ns/shacl#maxCount'][0]['@value'], 10)
      : Infinity
    const datatype = constraint['http://www.w3.org/ns/shacl#datatype'][0]['@id']
    const pattern = constraint['http://www.w3.org/ns/shacl#pattern']
      ? new RegExp(constraint['http://www.w3.org/ns/shacl#pattern'][0]['@value'])
      : null

    const values = data[0][path]
    if (!values || values.length < minCount || values.length > maxCount) {
      errors.push({
        path: `Property ${path} does not meet minCount or maxCount constraints`
      })
    }

    values.forEach((value: any) => {
      if (
        datatype === 'http://www.w3.org/2001/XMLSchema#string' &&
        typeof value['@value'] !== 'string'
      ) {
        errors.push({ path: `Property ${path} does not meet datatype constraint` })
      }

      if (pattern && !pattern.test(value['@value'])) {
        errors.push({ path: `Property ${path} does not match the required pattern` })
      }
    })
  })

  return errors
}

export async function validateObject(
  obj: Record<string, any>,
  chainId: number,
  nftAddress: string
): Promise<[boolean, any]> {
  CORE_LOGGER.logMessage(`Validating object: ` + JSON.stringify(obj), true)
  const ddoCopy = JSON.parse(JSON.stringify(obj))
  ddoCopy['@type'] = 'DDO'
  const extraErrors: Record<string, string> = {}
  ddoCopy['@context'] = { '@vocab': 'http://schema.org/' }
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

  const version = obj.version || CURRENT_VERSION
  const schemaFilePath = getSchema(version)
  try {
    const contents = await readFile(schemaFilePath, { encoding: 'utf8' })
    const parser = new Parser()
    const quads = parser.parse(contents)
    const formatQuads = await fromRDF(quads)
    const flattenQuads = await flatten(formatQuads)
    CORE_LOGGER.logMessage(`Schema flattenQuads: ${JSON.stringify(flattenQuads)}`)
    const expanded = await expand(ddoCopy)
    const flattened = await flatten(expanded)
    const nquads = await toRDF(flattened, { format: 'application/n-quads' })
    const nquadsFromRDF = await fromRDF(nquads)

    const report = validate(flattenQuads, nquadsFromRDF)
    CORE_LOGGER.logMessage(`report: ${JSON.stringify(report)}`)
    if (!report) {
      const errorMsg = 'Validation report does not exist'
      CORE_LOGGER.logMessage(errorMsg, true)
      return [false, { error: errorMsg }]
    }
    if (report.length === 0) {
      return [true, {}]
    } else {
      return [false, report]
    }
  } catch (err) {
    CORE_LOGGER.logMessage(`Error detecting schema file: ${err}`, true)
  }
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
