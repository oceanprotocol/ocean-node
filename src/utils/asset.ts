import axios from 'axios'
import { promises as fs } from 'fs'
import * as path from 'path'
import { DDO } from '../@types/DDO/DDO'
import { Service } from '../@types/DDO/Service'

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
  url: string
): Promise<{ contentLength: string; contentType: string }> {
  let contentLength: string = ''
  let contentType: string = ''
  try {
    // First try with HEAD request
    const response = await axios.head(url)

    contentLength = response.headers['content-length']
    contentType = response.headers['content-type']
  } catch (error) {
    // Fallback to GET request
    try {
      const response = await axios.get(url, { method: 'GET', responseType: 'stream' })

      contentLength = response.headers['content-length']
      contentType = response.headers['content-type']
    } catch (error) {
      contentLength = 'Unknown'
    }
  }

  if (!contentLength) {
    try {
      const response = await axios.get(url, { responseType: 'stream' })
      let totalSize = 0

      for await (const chunk of response.data) {
        totalSize += chunk.length
      }
      contentLength = totalSize.toString()
    } catch (error) {
      contentLength = 'Unknown'
    }
  }
  return {
    contentLength,
    contentType
  }
}

export async function getSchemaVersions(): Promise<string[]> {
  const schemaDir = path.join(__dirname, '../../schemas/v4')
  try {
    const files = await fs.readdir(schemaDir)
    const versionPattern = /\.(\d+\.\d+\.\d+)\.ttl$/ // Regex to extract version number
    const versions = files
      .map((file) => versionPattern.exec(file)?.[1])
      .filter((version): version is string => !!version)
    return versions
  } catch (error) {
    console.error('Error reading schema versions:', error)
    return []
  }
}
