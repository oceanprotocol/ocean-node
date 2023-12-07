import { expect } from 'chai'
import { decrypt, encrypt } from '../../src/utils/crypt.js'

describe('crypt', () => {
  it('should encrypt/decrypt AES', async () => {
    const data = Uint8Array.from(Buffer.from('ocean'))
    const encryptedData = await encrypt(data, 'AES')
    const decryptedData = await decrypt(encryptedData, 'AES')
    expect(Uint8Array.from(decryptedData)).to.deep.equal(data)
  })
  it('should encrypt/decrypt ECIES', async () => {
    const data = Uint8Array.from(Buffer.from('ocean'))
    const encryptedData = await encrypt(data, 'ECIES')
    const decryptedData = await decrypt(encryptedData, 'ECIES')
    expect(Uint8Array.from(decryptedData)).to.deep.equal(data)
  })
})
