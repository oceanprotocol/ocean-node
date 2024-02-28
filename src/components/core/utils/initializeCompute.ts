import { P2PCommandResponse } from '../../../@types'
import { ComputeAlgorithm, ComputeAsset } from '../../../@types/C2D.js'
import { CORE_LOGGER } from '../../../utils/logging/common.js'
import { DDO } from '../../../@types/DDO/DDO.js'
import { getJsonRpcProvider } from '../../../utils/blockchain.js'
import { validateComputeProviderFee } from './feesHandler.js'
import { Readable } from 'stream'
import { OceanNode } from '../../../OceanNode'
import { Service } from '../../../@types/DDO/Service.js'

export function getServiceById(ddo: DDO, serviceId: string): Service {
  try {
    return ddo.services.filter((service) => service.id === serviceId)[0]
  } catch (err) {
    CORE_LOGGER.error(`Service was not found: ${err}`)
  }
}

export async function validateProviderFeesForDatasets(
  node: OceanNode,
  datasets: [ComputeAsset],
  algorithm: ComputeAlgorithm,
  chainId: number,
  env: string,
  validUntil: number,
  consumerAddress: string
): Promise<P2PCommandResponse> {
  const listOfAssest = [...datasets, ...[algorithm]]
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
      const service = getServiceById(ddo, asset.serviceId)

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
        approvedParams.algorithm = {
          datatoken: service.datatokenAddress,
          providerFees: resultValidation[1],
          validOrder: resultValidation[0]
        }
      } else {
        approvedParams.datasets.push({
          datatoken: service.datatokenAddress,
          providerFees: resultValidation[1],
          validOrder: resultValidation[0]
        })
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
