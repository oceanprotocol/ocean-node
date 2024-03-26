// Url utility functions
export const URLUtils = {
  // basic url check using URL constructor
  isValidUrl(urlString: string, hyperTextProtocolOnly: boolean = true): boolean {
    let url
    try {
      url = new URL(urlString)
    } catch (e) {
      return false
    }
    // by default only care about http:// and https://
    return hyperTextProtocolOnly
      ? url.protocol === 'http:' || url.protocol === 'https:'
      : true
  },

  // adds the forward slash if missing
  sanitizeURLPath(url: string): string {
    if (!url.endsWith('/')) {
      url = url + '/'
    }
    return url
  }
}
