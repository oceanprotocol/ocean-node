import { VersionedDDO, DeprecatedDDO } from '@oceanprotocol/ddo-js'
import axios from 'axios'
import {
  ZeroAddress,
  Signer,
  ethers,
  JsonRpcApiProvider,
  Interface,
  toUtf8Bytes,
  hexlify,
  getBytes,
  toUtf8String
} from 'ethers'
import { Readable } from 'winston-transport'
import { DecryptDDOCommand } from '../../../@types/commands.js'
import { OceanNode } from '../../../OceanNode.js'
import { EVENT_HASHES, PROTOCOL_COMMANDS } from '../../../utils/constants.js'
import { timestampToDateTime } from '../../../utils/conversions.js'
import { getConfiguration } from '../../../utils/config.js'
import { create256Hash } from '../../../utils/crypt.js'
import { getDatabase } from '../../../utils/database.js'
import { INDEXER_LOGGER } from '../../../utils/logging/common.js'
import { LOG_LEVELS_STR } from '../../../utils/logging/Logger.js'
import { URLUtils } from '../../../utils/url.js'
import { streamToString } from '../../../utils/util.js'
import ERC721Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC721Template.sol/ERC721Template.json' assert { type: 'json' }
import { toString as uint8ArrayToString } from 'uint8arrays/to-string'
import ERC20Template from '@oceanprotocol/contracts/artifacts/contracts/templates/ERC20TemplateEnterprise.sol/ERC20TemplateEnterprise.json' assert { type: 'json' }
import { fetchTransactionReceipt } from '../../core/utils/validateOrders.js'
import { withRetrial } from '../utils.js'

export abstract class BaseEventProcessor {
  protected networkId: number

  constructor(chainId: number) {
    this.networkId = chainId
  }

  protected isValidDtAddressFromServices(services: any[]): boolean {
    for (const service of services) {
      if (
        service.datatokenAddress === '0x0' ||
        service.datatokenAddress === ZeroAddress
      ) {
        return false
      }
    }
    return true
  }

  protected async getTokenInfo(services: any[], signer: Signer): Promise<any[]> {
    const datatokens: any[] = []

    for (const service of services) {
      const datatoken = new ethers.Contract(
        service.datatokenAddress,
        ERC20Template.abi,
        signer
      )
      let name: string
      let symbol: string
      if (
        service.datatokenAddress === '0x0' ||
        service.datatokenAddress === ZeroAddress
      ) {
        name = `Datatoken${services.indexOf(service)}`
        symbol = `DT${services.indexOf(service)}`
      } else {
        name = await datatoken.name()
        INDEXER_LOGGER.logMessage(`name.datatoken: ${name}`)
        symbol = await datatoken.symbol()
        INDEXER_LOGGER.logMessage(`symbol.datatoken: ${symbol}`)
      }

      datatokens.push({
        address: service.datatokenAddress,
        name,
        symbol,
        serviceId: service.id
      })
    }

    return datatokens
  }

  protected async getEventData(
    provider: JsonRpcApiProvider,
    transactionHash: string,
    abi: any,
    eventType: string
  ): Promise<ethers.LogDescription> {
    const iface = new Interface(abi)
    let receipt: ethers.TransactionReceipt
    try {
      receipt = await fetchTransactionReceipt(transactionHash, provider)
    } catch (e) {
      INDEXER_LOGGER.error(`Error retrieving receipt: ${e.message}`)
    }
    if (receipt) {
      let eventHash: string
      for (const [key, value] of Object.entries(EVENT_HASHES)) {
        if (value.type === eventType) {
          eventHash = key
          break
        }
      }
      if (eventHash === '') {
        INDEXER_LOGGER.error(`Event hash couldn't be found!`)
        return null
      }

      let eventObj: any
      for (const log of receipt.logs) {
        if (log.topics[0] === eventHash) {
          eventObj = {
            topics: log.topics,
            data: log.data
          }
          break
        }
      }

      if (!eventObj) {
        INDEXER_LOGGER.error(
          `Event object couldn't be retrieved! Event hash not present in logs topics`
        )
        return null
      }

      return iface.parseLog(eventObj)
    } else {
      INDEXER_LOGGER.error('Receipt could not be fetched')
    }
  }

  protected async getNFTInfo(
    nftAddress: string,
    signer: Signer,
    owner: string,
    timestamp: number
  ): Promise<any> {
    const nftContract = new ethers.Contract(nftAddress, ERC721Template.abi, signer)
    const state = parseInt((await nftContract.getMetaData())[2])
    const id = parseInt(await nftContract.getId())
    const tokenURI = await nftContract.tokenURI(id)
    return {
      state,
      address: nftAddress,
      name: await nftContract.name(),
      symbol: await nftContract.symbol(),
      owner,
      created: timestampToDateTime(timestamp),
      tokenURI
    }
  }

  protected async createOrUpdateDDO(ddo: VersionedDDO, method: string): Promise<any> {
    try {
      const { ddo: ddoDatabase, ddoState } = await getDatabase()
      if (ddo instanceof DeprecatedDDO) {
        const { id, nftAddress } = ddo.getDDOFields()
        await Promise.all([ddoDatabase.delete(id), ddoState.delete(id)])
        const saveDDO = await ddoDatabase.create(ddo.getDDOData())
        await ddoState.create(this.networkId, saveDDO.id, nftAddress, undefined, true)

        return saveDDO
      }

      const saveDDO = await ddoDatabase.update({ ...ddo.getDDOData() })
      await ddoState.update(
        this.networkId,
        saveDDO.id,
        saveDDO.nftAddress,
        saveDDO.indexedMetadata?.event?.tx,
        true
      )
      INDEXER_LOGGER.logMessage(
        `Saved or updated DDO  : ${saveDDO.id} from network: ${this.networkId} triggered by: ${method}`
      )
      return saveDDO
    } catch (err) {
      const { ddoState } = await getDatabase()
      const { id, nftAddress } = ddo.getDDOFields()
      const tx =
        ddo instanceof DeprecatedDDO
          ? undefined
          : ddo.getAssetFields().indexedMetadata?.event?.txid

      await ddoState.update(this.networkId, id, nftAddress, tx, true, err.message)
      INDEXER_LOGGER.log(
        LOG_LEVELS_STR.LEVEL_ERROR,
        `Error found on ${this.networkId} triggered by: ${method} while creating or updating DDO: ${err}`,
        true
      )
    }
  }

  protected checkDdoHash(decryptedDocument: any, documentHashFromContract: any): boolean {
    const utf8Bytes = toUtf8Bytes(JSON.stringify(decryptedDocument))
    const expectedMetadata = hexlify(utf8Bytes)
    if (create256Hash(expectedMetadata.toString()) !== documentHashFromContract) {
      INDEXER_LOGGER.error(`DDO checksum does not match.`)
      return false
    }
    return true
  }

  protected async decryptDDO(
    decryptorURL: string,
    flag: string,
    eventCreator: string,
    contractAddress: string,
    chainId: number,
    txId: string,
    metadataHash: string,
    metadata: any
  ): Promise<any> {
    let ddo
    // Log the flag value
    INDEXER_LOGGER.logMessage(`decryptDDO: flag=${flag}`)
    if ((parseInt(flag) & 2) !== 0) {
      INDEXER_LOGGER.logMessage(
        `Decrypting DDO  from network: ${this.networkId} created by: ${eventCreator} encrypted by: ${decryptorURL}`
      )
      const config = await getConfiguration()
      const { keys } = config
      let nonce: string
      try {
        if (URLUtils.isValidUrl(decryptorURL)) {
          if (
            decryptorURL === `http://localhost:${process.env.HTTP_API_PORT || '8000'}` ||
            decryptorURL === `http://127.0.0.1:${process.env.HTTP_API_PORT || '8000'}` ||
            decryptorURL.includes(`localhost:${process.env.HTTP_API_PORT || '8000'}`) ||
            decryptorURL.includes(`127.0.0.1:${process.env.HTTP_API_PORT || '8000'}`)
          ) {
            const { nonce: nonceDB } = await getDatabase()
            const existingNonce = await nonceDB.retrieve(keys.ethAddress)
            nonce =
              existingNonce && existingNonce.nonce !== null
                ? String(existingNonce.nonce + 1)
                : Date.now().toString()
          } else {
            INDEXER_LOGGER.logMessage(
              `decryptDDO: Making HTTP request to external node for nonce. DecryptorURL: ${decryptorURL}`
            )
            const nonceResponse = await axios.get(
              `${decryptorURL}/api/services/nonce?userAddress=${keys.ethAddress}`,
              { timeout: 2000 }
            )
            nonce =
              nonceResponse.status === 200 && nonceResponse.data
                ? String(parseInt(nonceResponse.data.nonce) + 1)
                : Date.now().toString()
          }
        } else {
          nonce = Date.now().toString()
        }
      } catch (err) {
        INDEXER_LOGGER.logMessage(
          `decryptDDO: Error getting nonce, using timestamp: ${err.message}`
        )
        nonce = Date.now().toString()
      }
      const nodeId = keys.peerId.toString()

      const wallet: ethers.Wallet = new ethers.Wallet(process.env.PRIVATE_KEY as string)

      const useTxIdOrContractAddress = txId || contractAddress
      const message = String(
        useTxIdOrContractAddress + keys.ethAddress + chainId.toString() + nonce
      )

      const messageHash = ethers.solidityPackedKeccak256(
        ['bytes'],
        [ethers.hexlify(ethers.toUtf8Bytes(message))]
      )

      const signature = await wallet.signMessage(
        new Uint8Array(ethers.toBeArray(messageHash))
      )

      const recoveredAddress = ethers.verifyMessage(messageHash, signature)
      INDEXER_LOGGER.logMessage(
        `decryptDDO: recovered address: ${recoveredAddress}, expected: ${keys.ethAddress}`
      )

      if (URLUtils.isValidUrl(decryptorURL)) {
        try {
          const payload = {
            transactionId: txId,
            chainId,
            decrypterAddress: keys.ethAddress,
            dataNftAddress: contractAddress,
            signature,
            nonce
          }
          const response = await withRetrial(async () => {
            try {
              const res = await axios.post(
                `${decryptorURL}/api/services/decrypt`,
                payload
              )

              if (res.status !== 200) {
                const message = `bProvider exception on decrypt DDO. Status: ${res.status}, ${res.statusText}`
                INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, message)
                throw new Error(message) // do NOT retry
              }

              return res
            } catch (err: any) {
              // Retry ONLY on ECONNREFUSED
              if (
                err.code === 'ECONNREFUSED' ||
                (err.message && err.message.includes('ECONNREFUSED'))
              ) {
                INDEXER_LOGGER.log(
                  LOG_LEVELS_STR.LEVEL_ERROR,
                  `Decrypt request failed with ECONNREFUSED, retrying...`,
                  true
                )
                throw err
              }

              throw err
            }
          })

          let responseHash
          if (response.data instanceof Object) {
            responseHash = create256Hash(JSON.stringify(response.data))
            ddo = response.data
          } else {
            ddo = JSON.parse(response.data)
            responseHash = create256Hash(ddo)
          }
          if (responseHash !== metadataHash) {
            const msg = `Hash check failed: response=${ddo}, decrypted ddo hash=${responseHash}\n metadata hash=${metadataHash}`
            INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, msg)
            throw new Error(msg)
          }
        } catch (err) {
          const message = `Provider exception on decrypt DDO. Status: ${err.message}`
          INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, message)
          throw new Error(message)
        }
      } else {
        const node = OceanNode.getInstance(config, await getDatabase())
        if (nodeId === decryptorURL) {
          const decryptDDOTask: DecryptDDOCommand = {
            command: PROTOCOL_COMMANDS.DECRYPT_DDO,
            transactionId: txId,
            decrypterAddress: keys.ethAddress,
            chainId,
            encryptedDocument: metadata,
            documentHash: metadataHash,
            dataNftAddress: contractAddress,
            signature,
            nonce
          }
          try {
            const response = await node
              .getCoreHandlers()
              .getHandler(PROTOCOL_COMMANDS.DECRYPT_DDO)
              .handle(decryptDDOTask)
            ddo = JSON.parse(await streamToString(response.stream as Readable))
          } catch (error) {
            const message = `Node exception on decrypt DDO. Status: ${error.message}`
            INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, message)
            throw new Error(message)
          }
        } else {
          try {
            const p2pNode = await node.getP2PNode()
            let isBinaryContent = false
            const sink = async function (source: any) {
              let first = true
              for await (const chunk of source) {
                if (first) {
                  first = false
                  try {
                    const str = uint8ArrayToString(chunk.subarray()) // Obs: we need to specify the length of the subarrays
                    const decoded = JSON.parse(str)
                    if ('headers' in decoded) {
                      if (str?.toLowerCase().includes('application/octet-stream')) {
                        isBinaryContent = true
                      }
                    }
                    if (decoded.httpStatus !== 200) {
                      INDEXER_LOGGER.logMessage(
                        `Error in sink method  : ${decoded.httpStatus} errro: ${decoded.error}`
                      )
                      throw new Error('Error in sink method', decoded.error)
                    }
                  } catch (e) {
                    INDEXER_LOGGER.logMessage(
                      `Error in sink method  } error: ${e.message}`
                    )
                    throw new Error(`Error in sink method ${e.message}`)
                  }
                } else {
                  if (isBinaryContent) {
                    return chunk.subarray()
                  } else {
                    const str = uint8ArrayToString(chunk.subarray())
                    return str
                  }
                }
              }
            }
            const message = {
              command: PROTOCOL_COMMANDS.DECRYPT_DDO,
              transactionId: txId,
              decrypterAddress: keys.ethAddress,
              chainId,
              encryptedDocument: metadata,
              documentHash: metadataHash,
              dataNftAddress: contractAddress,
              signature,
              nonce
            }
            const response = await p2pNode.sendTo(
              decryptorURL,
              JSON.stringify(message),
              sink
            )
            ddo = JSON.parse(await streamToString(response.stream as Readable))
          } catch (error) {
            const message = `Node exception on decrypt DDO. Status: ${error.message}`
            INDEXER_LOGGER.log(LOG_LEVELS_STR.LEVEL_ERROR, message)
            throw new Error(message)
          }
        }
      }
    } else {
      INDEXER_LOGGER.logMessage(
        `Decompressing DDO  from network: ${this.networkId} created by: ${eventCreator} ecnrypted by: ${decryptorURL}`
      )
      const byteArray = getBytes(metadata)
      const utf8String = toUtf8String(byteArray)
      ddo = JSON.parse(utf8String)
    }

    return ddo
  }

  public abstract processEvent(
    event: ethers.Log,
    chainId: number,
    signer: Signer,
    provider: JsonRpcApiProvider,
    eventName?: string
  ): Promise<any>
}
