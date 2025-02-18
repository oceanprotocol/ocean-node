import { Credentials } from '../../@types/DDO/Credentials'

export const downloadAsset = {
  '@context': ['https://w3id.org/did/v1'],
  id: '',
  nftAddress: '',
  version: '4.1.0',
  chainId: 80001,
  metadata: {
    created: '2021-12-20T14:35:20Z',
    updated: '2021-12-20T14:35:20Z',
    type: 'dataset',
    name: 'cli fixed asset',
    description: 'asset published using ocean.js cli tool',
    tags: ['test'],
    author: 'oceanprotocol',
    license: 'https://market.oceanprotocol.com/terms',
    additionalInformation: {
      termsAndConditions: true
    }
  },
  services: [
    {
      id: 'ccb398c50d6abd5b456e8d7242bd856a1767a890b537c2f8c10ba8b8a10e6025',
      type: 'download',
      files: {
        files: [
          {
            type: 'url',
            url: 'https://raw.githubusercontent.com/oceanprotocol/testdatasets/main/shs_dataset_test.txt',
            method: 'GET'
          }
        ]
      },
      datatokenAddress: '',
      serviceEndpoint: 'https://v4.provider.oceanprotocol.com',
      timeout: 86400
    }
  ],
  event: {},
  nft: {
    address: '',
    name: 'Ocean Data NFT',
    symbol: 'OCEAN-NFT',
    state: 5,
    tokenURI: '',
    owner: '',
    created: ''
  },
  stats: {
    orders: 0,
    price: {
      value: '0'
    }
  },
  purgatory: {
    state: false
  },
  datatokens: [] as any
}

const nftLevelCredentials: Credentials = {
  allow: [
    {
      type: 'address',
      values: ['0xBE5449a6A97aD46c8558A3356267Ee5D2731ab5e']
    },
    {
      type: 'address',
      values: ['0xA78deb2Fa79463945C247991075E2a0e98Ba7A09']
    }
  ],
  deny: [
    {
      type: 'address',
      values: ['0x02354A1F160A3fd7ac8b02ee91F04104440B28E7']
    }
  ]
}

const serviceLevelCredentials: Credentials = {
  deny: [
    {
      type: 'address',
      values: ['0xA78deb2Fa79463945C247991075E2a0e98Ba7A09']
    }
  ]
}

export const downloadAssetWithCredentials = {
  '@context': ['https://w3id.org/did/v1'],
  id: '',
  nftAddress: '',
  version: '4.1.0',
  chainId: 80001,
  metadata: {
    created: '2021-12-20T14:35:20Z',
    updated: '2021-12-20T14:35:20Z',
    type: 'dataset',
    name: 'cli fixed asset',
    description: 'asset published using ocean.js cli tool',
    tags: ['test'],
    author: 'oceanprotocol',
    license: 'https://market.oceanprotocol.com/terms',
    additionalInformation: {
      termsAndConditions: true
    }
  },
  credentials: nftLevelCredentials,
  services: [
    {
      id: 'ccb398c50d6abd5b456e8d7242bd856a1767a890b537c2f8c10ba8b8a10e6025',
      type: 'download',
      files: {
        files: [
          {
            type: 'url',
            url: 'https://raw.githubusercontent.com/oceanprotocol/testdatasets/main/shs_dataset_test.txt',
            method: 'GET'
          }
        ]
      },
      credentials: serviceLevelCredentials,
      datatokenAddress: '',
      serviceEndpoint: 'https://v4.provider.oceanprotocol.com',
      timeout: 86400
    }
  ],
  event: {},
  nft: {
    address: '',
    name: 'Ocean Data NFT',
    symbol: 'OCEAN-NFT',
    state: 5,
    tokenURI: '',
    owner: '',
    created: ''
  },
  purgatory: {
    state: false
  },
  datatokens: [] as any,
  stats: {
    allocated: 0,
    orders: 0,
    price: {
      value: '0'
    }
  }
}

export const computeAsset = {
  '@context': ['https://w3id.org/did/v1'],
  id: '',
  nftAddress: '',
  version: '4.1.0',
  chainId: 80001,
  metadata: {
    created: '2021-12-20T14:35:20Z',
    updated: '2021-12-20T14:35:20Z',
    type: 'dataset',
    name: 'cli fixed asset',
    description: 'asset published using ocean.js cli tool',
    tags: ['test'],
    author: 'oceanprotocol',
    license: 'https://market.oceanprotocol.com/terms',
    additionalInformation: {
      termsAndConditions: true
    }
  },
  services: [
    {
      id: '1155995dda741e93afe4b1c6ced2d01734a6ec69865cc0997daf1f4db7259a36',
      type: 'compute',
      files: {
        files: [
          {
            type: 'url',
            url: 'https://raw.githubusercontent.com/oceanprotocol/testdatasets/main/shs_dataset_test.txt',
            method: 'GET'
          }
        ]
      },
      datatokenAddress: '',
      serviceEndpoint: 'https://v4.provider.oceanprotocol.com',
      timeout: 86400,
      compute: {
        allowRawAlgorithm: false,
        allowNetworkAccess: true,
        publisherTrustedAlgorithmPublishers: [] as any,
        publisherTrustedAlgorithms: [] as any
      }
    }
  ],
  event: {},
  nft: {
    address: '',
    name: 'Ocean Data NFT',
    symbol: 'OCEAN-NFT',
    state: 5,
    tokenURI: '',
    owner: '',
    created: ''
  },
  purgatory: {
    state: false
  },
  datatokens: [] as any,
  stats: {
    allocated: 0,
    orders: 0,
    price: {
      value: '0'
    }
  }
}

export const algoAsset = {
  '@context': ['https://w3id.org/did/v1'],
  id: '',
  nftAddress: '',
  version: '4.1.0',
  chainId: 137,
  metadata: {
    created: '2023-08-01T17:09:39Z',
    updated: '2023-08-01T17:09:39Z',
    type: 'algorithm',
    name: 'CLi Algo',
    description: 'Cli algo',
    author: 'OPF',
    license: 'https://market.oceanprotocol.com/terms',
    additionalInformation: {
      termsAndConditions: true
    },
    algorithm: {
      language: '',
      version: '0.1',
      container: {
        entrypoint: 'node $ALGO',
        image: 'node',
        tag: 'latest',
        checksum:
          'sha256:1155995dda741e93afe4b1c6ced2d01734a6ec69865cc0997daf1f4db7259a36'
      }
    }
  },
  services: [
    {
      id: 'db164c1b981e4d2974e90e61bda121512e6909c1035c908d68933ae4cfaba6b0',
      type: 'compute',
      files: {
        files: [
          {
            url: 'https://raw.githubusercontent.com/oceanprotocol/test-algorithm/master/javascript/algo.js',
            contentType: 'text/js',
            encoding: 'UTF-8'
          }
        ]
      },
      timeout: 86400,
      serviceEndpoint: 'https://v4.provider.oceanprotocol.com',
      compute: {
        allowRawAlgorithm: false,
        allowNetworkAccess: true,
        publisherTrustedAlgorithmPublishers: [] as any,
        publisherTrustedAlgorithms: [] as any
      }
    }
  ],
  stats: {
    allocated: 0,
    orders: 0,
    price: {
      value: '0'
    }
  },
  nft: {
    address: '',
    name: 'Ocean Data NFT',
    symbol: 'OCEAN-NFT',
    state: 5,
    tokenURI: '',
    owner: '',
    created: ''
  }
}
