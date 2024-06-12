//simple script to generate a new private key
import * as ethCrypto from 'eth-crypto'
import fs from 'node:fs'
const pair = ethCrypto.createIdentity()
console.log('\n#########################################\n')
console.log('WARNING: SENSITIVE DATA!\n')
console.log('-------------------------------------------\n')
console.log('\nYour Node Private Key: \n', pair.privateKey)
console.log('\nYour Node Public Key:\n', pair.publicKey)
console.log('\nYour Node Eth/Wallet Address:\n', pair.address)
console.log('\n#########################################\n')
const pkFile = fs.createWriteStream('.pk.out', { flags: 'w' })
pkFile.write(pair.privateKey)
pkFile.end()
