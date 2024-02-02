import axios from 'axios'
import { DDO } from '../@types/DDO/DDO'
import { Service } from '../@types/DDO/Service'
import { createHash } from 'crypto'

// Notes:
// Asset as per asset.py on provider, is a class there, while on ocean.Js we only have a type
// this is an utility to extract information from the Asset services
export const AssetUtils = {
  getServiceIndexById(asset: DDO, id: string): number | null {
    for (let c = 0; c < asset.services.length; c++)
      if (asset.services[c].id === id) return c
    return null
  },
  getServiceByIndex(asset: DDO, index: number): Service | null {
    if (index >= 0 && index < asset.services.length) {
      return asset.services[index]
    }
    return null
  },

  getServiceById(asset: DDO, id: string): Service | null {
    const services = asset.services.filter((service: Service) => service.id === id)
    return services.length ? services[0] : null
  }
}

export async function fetchFileMetadata(
  url: string,
  method: string,
  forceChecksum: boolean
): Promise<{ contentLength: string; contentType: string; contentChecksum: string }> {
  let contentType: string = ''
  let contentLength: number = 0
  const contentChecksum = createHash('sha256')
  const maxLengthInt = parseInt(process.env.MAX_CHECKSUM_LENGTH, 10)
  const maxLength = isNaN(maxLengthInt) ? 10 * 1024 * 1024 : maxLengthInt

  try {
    const response = await axios({
      url,
      method: method || 'get',
      responseType: 'stream'
    })
    contentType = response.headers['content-type']
    let totalSize = 0
    for await (const chunk of response.data) {
      totalSize += chunk.length
      contentChecksum.update(chunk)
      if (totalSize > maxLength && !forceChecksum) {
        contentLength = 0
        break
      }
    }
    contentLength = totalSize
  } catch (error) {}

  return {
    contentLength: contentLength.toString(),
    contentType,
    contentChecksum: contentChecksum.digest('hex')
  }
}
