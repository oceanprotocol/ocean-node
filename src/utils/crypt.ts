import eciesjs from 'eciesjs'
import crypto from 'crypto'
import { getConfiguration } from './config.js'
import { EncryptMethod } from '../@types/fileObject.js'

/**
 * This method encrypts data according to a given algorithm using node keys
 * @param data data to encrypt
 * @param algorithm encryption algorithm AES or ECIES
 */
export async function encrypt(
  data: Uint8Array,
  algorithm: EncryptMethod
): Promise<Buffer> {
  let encryptedData: Buffer
  const config = await getConfiguration()
  const { privateKey, publicKey } = config.keys
  if (algorithm === EncryptMethod.AES) {
    // use first 16 bytes of public key as an initialisation vector
    const initVector = publicKey.subarray(0, 16)
    // creates cipher object, with the given algorithm, key and initialization vector
    const cipher = crypto.createCipheriv('aes-256-cbc', privateKey, initVector)
    // encoding is ignored because we are working with bytes and want to return a buffer
    encryptedData = Buffer.concat([cipher.update(data), cipher.final()])
  } else if (algorithm === EncryptMethod.ECIES) {
    const sk = new eciesjs.PrivateKey(privateKey)
    // get public key from Elliptic curve
    encryptedData = eciesjs.encrypt(sk.publicKey.toHex(), data)
  }
  return encryptedData
}

/**
 * This method decrypts data according to a given algorithm using node keys
 * @param data data to decrypt
 * @param algorithm decryption algorithm AES or ECIES
 */
export async function decrypt(
  data: Uint8Array,
  algorithm: EncryptMethod
): Promise<Buffer> {
  let decryptedData: Buffer
  const config = await getConfiguration()
  const { privateKey, publicKey } = config.keys
  if (algorithm === EncryptMethod.AES) {
    // use first 16 bytes of public key as an initialisation vector
    const initVector = publicKey.subarray(0, 16)
    // creates decipher object, with the given algorithm, key and initialization vector

    const decipher = crypto.createDecipheriv('aes-256-cbc', privateKey, initVector)

    // encoding is ignored because we are working with bytes and want to return a buffer
    decryptedData = Buffer.concat([decipher.update(data), decipher.final()])
  } else if (algorithm === EncryptMethod.ECIES) {
    const sk = new eciesjs.PrivateKey(privateKey)
    decryptedData = eciesjs.decrypt(sk.secret, data)
  }
  return decryptedData
}
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
