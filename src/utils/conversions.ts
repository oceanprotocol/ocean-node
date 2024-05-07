import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import * as multiFormatRaw from 'multiformats/codecs/raw'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'

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
