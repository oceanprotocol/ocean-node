import { Asset } from '../@types/Asset'
import { Service } from '../@types/DDO/Service'

// Notes:
// Asset as per asset.py on provider, is a class there, while on ocean.Js we only have a type
// this is an utility to extract information from the Asset services
export const AssetUtils = {
  getServiceByIndex(asset: Asset, index: number): Service | null {
    if (index >= 0 && index < asset.services.length) {
      return asset.services[index]
    }
    return null
  },

  getServiceById(asset: Asset, id: string): Service | null {
    const services = asset.services.filter((service: Service) => {
      return service.id === id
    })
    return services.length ? services[0] : null
  }
}
