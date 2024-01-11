import rdfDataModel from '@rdfjs/data-model'
import rdfDataset from '@rdfjs/dataset'
import toNT from '@rdfjs/to-ntriples'
import fs from 'fs'
// @ts-ignore
import * as shaclEngine from 'shacl-engine'
import { createHash } from 'crypto'
import { getAddress, isAddress } from 'ethers'
import { INDEXER_LOGGER } from '../../Indexer/index.js'
import { resolve } from 'path'
import Quad from 'rdf-ext/lib/Quad.js'

const CURRENT_VERSION = '4.5.0'
const ALLOWED_VERSIONS = ['4.3.0', '4.5.0']

function getSchema(version: string = CURRENT_VERSION): string {
  if (!ALLOWED_VERSIONS.includes(version)) {
    INDEXER_LOGGER.logMessage(`Can't find schema ${version}`, true)
    return
  }
  const path = `../../../../schemas/v4/${version}.ttl`
  const schemaFilePath = resolve(__dirname, path)
  if (!schemaFilePath) {
    INDEXER_LOGGER.logMessage(`Can't find schema ${version}`, true)
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
async function validateObject(
  obj: Record<string, any>,
  chainId: number,
  nftAddress: string
): Promise<[boolean, Record<string, string>]> {
  const ddoCopy = obj
  ddoCopy['@type'] = 'DDO'
  const extraErrors: Record<string, string> = {}

  if (
    !('context' in obj) ||
    !(Array.isArray(obj.context) || typeof obj.context === 'object')
  ) {
    extraErrors['@context'] = 'Context is missing or invalid.'
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

  if (!nftAddress || nftAddress === '' || !isAddress(nftAddress.toLowerCase())) {
    extraErrors.nftAddress = 'nftAddress is missing or invalid.'
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

  const fileStream = fs.createReadStream(filename.pathname)
  fileStream.on('data', (quad: Quad) => {
    dataset.add(quad)
  })

  fileStream.on('error', (error: Error) => {
    INDEXER_LOGGER.logMessage(`Error reading RDF file: ${error}`, true)
  })

  // create a validator instance for the shapes in the given dataset
  const validator = new shaclEngine.Validator(dataset, {
    coverage: true,
    factory: rdfDataModel
  })

  // run the validation process
  const report = await validator.validate({ dataset })
  if (!report) {
    INDEXER_LOGGER.logMessage(`Validation report does not exist`, true)
    return [false, { error: 'Validation report does not exist' }]
  }
  const errors = parseReportToErrors(report.results)

  if (extraErrors) {
    return [false, { ...errors, ...extraErrors }]
  }

  return [report.conforms, errors]
}
