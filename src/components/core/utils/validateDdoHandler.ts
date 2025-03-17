// @ts-ignore
import { V4DDO, V5DDO, validateDDO } from '@oceanprotocol/ddo-js'
import { ethers } from 'ethers'
import { CORE_LOGGER, INDEXER_LOGGER } from '../../../utils/logging/common.js'
import { create256Hash } from '../../../utils/crypt.js'
import { getProviderWallet } from './feesHandler.js'
import { deleteIndexedMetadataIfExists } from '../../../utils/asset.js'

export function makeDid(
  ddo: Record<string, any>,
  dataNftAddress: string, // get the data from blockchain event
  chainId: string
): string {
  if (ddo.version.startsWith('4.')) {
    return V4DDO.getDDOClass(ddo).makeDid(dataNftAddress, chainId)
  } else if (ddo.version.startsWith('5.')) {
    return V5DDO.getDDOClass(ddo).makeDid(dataNftAddress, chainId)
  } else {
    INDEXER_LOGGER.error(`Version of DDO unknown: ${ddo.version}`)
  }
}

export async function validateDdo(
  obj: Record<string, any>
): Promise<[boolean, Record<string, string[]>]> {
  const updatedDdo = deleteIndexedMetadataIfExists(obj)
  return await validateDDO(updatedDdo)
}

export async function getValidationSignature(ddo: string): Promise<any> {
  try {
    const hashedDDO = create256Hash(ddo)
    const providerWallet = await getProviderWallet()
    const messageHash = ethers.solidityPackedKeccak256(
      ['bytes'],
      [ethers.hexlify(ethers.toUtf8Bytes(hashedDDO))]
    )
    const signed32Bytes = await providerWallet.signMessage(
      new Uint8Array(ethers.toBeArray(messageHash))
    )
    const signatureSplitted = ethers.Signature.from(signed32Bytes)
    const v = signatureSplitted.v <= 1 ? signatureSplitted.v + 27 : signatureSplitted.v
    const r = ethers.hexlify(signatureSplitted.r) // 32 bytes
    const s = ethers.hexlify(signatureSplitted.s)
    return { hash: hashedDDO, publicKey: providerWallet.address, r, s, v }
  } catch (error) {
    CORE_LOGGER.logMessage(`Validation signature error: ${error}`, true)
    return { hash: '', publicKey: '', r: '', s: '', v: '' }
  }
}
