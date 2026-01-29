import { EncryptMethod } from '../@types/fileObject.js'
import crypto from 'crypto'

// this can be handy as we do this kind of hash in multiple places
export function create256Hash(input: string): string {
  const result = crypto.createHash('sha256').update(input).digest('hex')
  return '0x' + result
}

// convert from string format to EncryptMethod (case insensitive)
export function getEncryptMethodFromString(str: string): EncryptMethod {
  if (!str || str.length === 0) return EncryptMethod.AES // default

  return str.toUpperCase() === 'ECIES' ? EncryptMethod.ECIES : EncryptMethod.AES
}
