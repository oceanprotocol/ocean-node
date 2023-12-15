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
