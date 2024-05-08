import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import * as multiFormatRaw from 'multiformats/codecs/raw'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import { INDEXER_LOGGER } from './logging/common.js'

export function hexStringToByteArray(hexString: any) {
  if (hexString.length % 2 !== 0) {
    throw new Error('Must have an even number of hex digits to convert to bytes')
  } /* w w w.  jav  a2 s .  c o  m */
  const numBytes = hexString.length / 2
  const byteArray = new Uint8Array(numBytes)
  for (let i = 0; i < numBytes; i++) {
    byteArray[i] = parseInt(hexString.substr(i * 2, 2), 16)
  }
  return byteArray
}

export function stringToByteArray(data: string) {
  const numBytes = data.length / 2
  const byteArray = new Uint8Array(numBytes)
  for (let i = 0; i < numBytes; i++) {
    byteArray[i] = data.charCodeAt(i)
  }
  return byteArray
}

export async function cidFromRawString(data: string) {
  const hash = await sha256.digest(uint8ArrayFromString(data))
  const cid = CID.create(1, multiFormatRaw.code, hash)
  return cid
}

export function getRandomInt(min: number, max: number) {
  min = Math.ceil(min)
  max = Math.floor(max)
  return Math.floor(Math.random() * (max - min) + min) // The maximum is exclusive and the minimum is inclusive
}

export function timestampToDateTime(timestamp: number) {
  const date = new Date(timestamp * 1000)
  INDEXER_LOGGER.logMessage(`date: ${date}`)
  const year = date.getFullYear()
  INDEXER_LOGGER.logMessage(`year: ${year}`)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  INDEXER_LOGGER.logMessage(`month: ${month}`)
  const day = String(date.getDate()).padStart(2, '0')
  INDEXER_LOGGER.logMessage(`day: ${day}`)
  const hours = String(date.getHours()).padStart(2, '0')
  INDEXER_LOGGER.logMessage(`hours: ${hours}`)
  const minutes = String(date.getMinutes()).padStart(2, '0')
  INDEXER_LOGGER.logMessage(`minutes: ${minutes}`)
  const seconds = String(date.getSeconds()).padStart(2, '0')
  INDEXER_LOGGER.logMessage(`seconds: ${seconds}`)
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}Z`
}
