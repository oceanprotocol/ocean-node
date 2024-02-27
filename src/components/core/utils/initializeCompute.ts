import { P2PCommandResponse } from '../../../@types'
import { ComputeAlgorithm, ComputeAsset } from '../../../@types/C2D.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { DDO } from '../../../@types/DDO/DDO.js'
import { getJsonRpcProvider } from '../../../utils/blockchain.js'
import { validateComputeProviderFee } from './feesHandler.js'
import { Readable } from 'stream'

export async function validateProviderFeesForDatasets(
  datasets: [ComputeAsset],
  algorithm: ComputeAlgorithm,
  chainId: number,
  env: string,
  validUntil: number,
  consumerAddress: string
): Promise<P2PCommandResponse> {
  const listOfAssest = [...datasets, ...[algorithm]]
  const node = this.getOceanNode()
  const approvedParams: any = {
    algorithm: {},
    datasets: []
  }
  const provider = await getJsonRpcProvider(chainId)

  for (const asset of listOfAssest) {
    try {
      const ddo = (await node.getDatabase().ddo.retrieve(asset.documentId)) as DDO
      if (ddo.id === algorithm.documentId) {
        if (ddo.metadata.type !== 'algorithm') {
          const errorMsg = `DID is not a valid algorithm`
          CORE_LOGGER.error(errorMsg)
          return {
            stream: null,
            status: {
              httpStatus: 400,
              error: errorMsg
            }
          }
        }
      }
      const service = this.getServiceById(ddo, asset.serviceId)

      const resultValidation = await validateComputeProviderFee(
        provider,
        asset.transferTxId,
        env,
        ddo,
        service,
        validUntil,
        consumerAddress
      )
      if (ddo.metadata.type === 'algorithm') {
        approvedParams.algorithm = resultValidation[1]
      } else {
        approvedParams.datasets.push(resultValidation[1])
      }
    } catch (error) {
      CORE_LOGGER.error(`Unable to get compute provider fees: ${error}`)
    }
  }

  const result = JSON.stringify(approvedParams, (key, value) => {
    if (typeof value === 'bigint') {
      return value.toString()
    }
    return value
  })
  return {
    stream: Readable.from(result),
    status: {
      httpStatus: 200
    }
  }
}
