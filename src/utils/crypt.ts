import eciesjs from 'eciesjs'
import crypto from 'crypto'
import {getConfig} from "./config.js";

export async function encrypt(data: Uint8Array, algorithm: string):Promise<Buffer> {
    let encryptedData: Buffer
    const config = await getConfig()
    const { privateKey, publicKey } = config.keys
    if (algorithm === 'AES') {
        const initVector = publicKey.subarray(0, 16)
        const cipher = crypto.createCipheriv('aes-256-cbc', privateKey, initVector)
        encryptedData = Buffer.concat([cipher.update(data), cipher.final()])
    }
    if (algorithm === 'ECIES') {
        const sk = new eciesjs.PrivateKey(privateKey)
        encryptedData = eciesjs.encrypt(sk.publicKey.toHex(), data)
    }
    return encryptedData
}

export async function decrypt(data: Uint8Array, algorithm: string):Promise<Buffer> {
    let decryptedData: Buffer
    const config = await getConfig()
    const { privateKey, publicKey } = config.keys
    if (algorithm === 'AES') {
        const initVector = publicKey.subarray(0, 16)
        const decipher = crypto.createDecipheriv('aes-256-cbc', privateKey, initVector)
        decryptedData = Buffer.concat([decipher.update(data), decipher.final()])
    }
    if (algorithm === 'ECIES') {
        const sk = new eciesjs.PrivateKey(privateKey)
        decryptedData = eciesjs.encrypt(sk.publicKey.toHex(), data)
    }
    return decryptedData
}
