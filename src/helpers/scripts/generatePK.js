//simple script to generate a new private key
import * as ethCrypto from 'eth-crypto'
import fs from 'node:fs'

const argv = process.argv.slice(2)
const saveToFile = argv.length === 1 && argv[0] === '--save'
const pair = ethCrypto.createIdentity()
if (saveToFile) {
  console.log('Saving private key to file ".pk.out"')
  const pkFile = fs.createWriteStream('.pk.out', { flags: 'w' })
  pkFile.write(pair.privateKey)
  pkFile.end()
} else {
  console.log('\n#########################################\n')
  console.log('\tWARNING: SENSITIVE DATA!\n')
  console.log('#########################################\n')
  console.log('\nYour Node Private Key: \n', pair.privateKey)
  console.log('\nYour Node Public Key:\n', pair.publicKey)
  console.log('\nYour Node Eth/Wallet Address:\n', pair.address)
  console.log('\n-------------------------------------------\n')
}
