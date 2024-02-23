import { expect } from 'chai'
import { decrypt, encrypt } from '../../utils/crypt.js'
import { EncryptMethod } from '../../@types/fileObject.js'

describe('crypt', () => {
  it('should encrypt/decrypt AES', async () => {
    const data = Uint8Array.from(Buffer.from('ocean'))
    const encryptedData = await encrypt(data, EncryptMethod.AES)
    const decryptedData = await decrypt(encryptedData, EncryptMethod.AES)
    expect(Uint8Array.from(decryptedData)).to.deep.equal(data)
  })
  it('should encrypt/decrypt ECIES', async () => {
    const data = Uint8Array.from(Buffer.from('ocean'))
    const encryptedData = await encrypt(data, EncryptMethod.ECIES)
    const decryptedData = await decrypt(encryptedData, EncryptMethod.ECIES)
    expect(Uint8Array.from(decryptedData)).to.deep.equal(data)
  })
})
