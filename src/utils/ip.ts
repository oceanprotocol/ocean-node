export async function getIPv4() {
  return await getIPFromAPI('https://api.ipify.org?format=json')
}

export async function getIPv6() {
  return await getIPFromAPI('https://api6.ipify.org?format=json')
}

export async function getIPFromAPI(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      method: 'GET'
    })
    const data = await res.json()
    return data.ip
  } catch (e) {
    return null
  }
}
