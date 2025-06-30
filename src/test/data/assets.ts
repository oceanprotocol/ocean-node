import { Credentials, CREDENTIALS_TYPES } from '@oceanprotocol/ddo-js'

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
      type: CREDENTIALS_TYPES.ADDRESS,
      values: ['0xBE5449a6A97aD46c8558A3356267Ee5D2731ab5e']
    },
    {
      type: CREDENTIALS_TYPES.ADDRESS,
      values: ['0xA78deb2Fa79463945C247991075E2a0e98Ba7A09']
    }
  ],
  deny: [
    {
      type: CREDENTIALS_TYPES.ADDRESS,
      values: ['0x02354A1F160A3fd7ac8b02ee91F04104440B28E7']
    }
  ]
}

const serviceLevelCredentials: Credentials = {
  allow: [],
  deny: [
    {
      type: CREDENTIALS_TYPES.ADDRESS,
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

export const computeAssetWithCredentials = {
  '@context': ['https://w3id.org/did/v1'],
  id: '',
  nftAddress: '',
  version: '4.1.0',
  chainId: 8996,
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
      credentials: serviceLevelCredentials,
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

export const algoAssetWithCredentials = {
  '@context': ['https://w3id.org/did/v1'],
  id: '',
  nftAddress: '',
  version: '4.1.0',
  chainId: 8996,
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
  credentials: nftLevelCredentials,
  services: [
    {
      id: 'db164c1b981e4d2974e90e61bda121512e6909c1035c908d68933ae4cfaba6b0',
      type: 'compute',
      files: {
        files: [
          {
            type: 'url',
            method: 'GET',
            url: 'https://raw.githubusercontent.com/oceanprotocol/test-algorithm/master/javascript/algo.js',
            contentType: 'text/js',
            encoding: 'UTF-8'
          }
        ]
      },
      credentials: serviceLevelCredentials,
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
            type: 'url',
            method: 'GET',
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

export const completeDBComputeJob = {
  owner: '0x6c957a45C801035d3297d43d0Ce83a237Ec5E0d1',
  did: '',
  jobId: '34aa4e7e-ce41-4547-b3e1-57aa1a7f97e6',
  dateCreated: '1732720690.68',
  dateFinished: '',
  status: 70,
  statusText: 'Job finished',
  results: '',
  inputDID: '',
  algoDID: '',
  agreementId: '0x56e2a0a9a6abcadac403dddc59858a5caf51ac286b401c811655b0235cd45da6',
  expireTimestamp: 1732721290.68,
  environment: '0x46f61c90309fcffa02e887e1a8a1ebdfeabe4f1ff279e306de2803df36bd46f7-free',
  clusterHash: '0x3e072d2ac72e9ad87fed5a913caea960c89dfad85d447cbbc92c32457f0413e1',
  configlogURL: '',
  publishlogURL: '',
  algologURL: '',
  outputsURL: '',
  stopRequested: false,
  algorithm: {
    documentId: 'did:op:39d9c2a7536865f9516b9f84432a624e25c8bb3e482de113ac9919af7d7a4866',
    serviceId: 'db164c1b981e4d2974e90e61bda121512e6909c1035c908d68933ae4cfaba6b0',
    meta: { language: '', version: '0.1', container: [Object] },
    transferTxId: '0x5c946d52cdd1623061330f455d4cb6d5898770987baa6539bda851d6c537cf6e'
  },
  assets: [
    {
      documentId:
        'did:op:ae13ce05f05457c041b013f41bf51400863eb5f387ba34e1b076f1f832a68071',
      serviceId: 'ccb398c50d6abd5b456e8d7242bd856a1767a890b537c2f8c10ba8b8a10e6025',
      transferTxId: '0xf14e89d0f0a80bf55392430e7479cac5eca6ed453e7b3ead99ab3c9820c9a411'
    }
  ],
  isRunning: false,
  isStarted: false,
  containerImage:
    'node@sha256:1155995dda741e93afe4b1c6ced2d01734a6ec69865cc0997daf1f4db7259a36'
}

export const dockerImageManifest = {
  schemaVersion: 2,
  mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
  config: {
    mediaType: 'application/vnd.docker.container.image.v1+json',
    size: 7286,
    digest: 'sha256:386e0be86bde5eff9f85ea9eda02727dd4641664d746688b4049f79ef0cdb1c9'
  },
  platform: {
    architecture: 'amd64',
    os: 'linux'
  },
  layers: [
    {
      mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
      size: 49557601,
      digest: 'sha256:167b8a53ca4504bc6aa3182e336fa96f4ef76875d158c1933d3e2fa19c57e0c3'
    },
    {
      mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
      size: 24030522,
      digest: 'sha256:b47a222d28fa95680198398973d0a29b82a968f03e7ef361cc8ded562e4d84a3'
    },
    {
      mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
      size: 64112257,
      digest: 'sha256:debce5f9f3a9709885f7f2ad3cf41f036a3b57b406b27ba3a883928315787042'
    },
    {
      mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
      size: 211039785,
      digest: 'sha256:1d7ca7cd2e066ae77ac6284a9d027f72a31a02a18bfc2a249ef2e7b01074338b'
    },
    {
      mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
      size: 3371,
      digest: 'sha256:94c7791033e87c3ab82bf56f778253138bbd5caf172ead6fc0ce39d459560607'
    },
    {
      mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
      size: 47856943,
      digest: 'sha256:72ab0dfaf5cb14ab09fd3478f8a01e3c3e21b7ad06e7b04ccac2f304d455ff45'
    },
    {
      mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
      size: 2280920,
      digest: 'sha256:3316ed2852d408595e2dfc601d96f39f4a39747bd1eb2eb1b63b1f3d49c42919'
    },
    {
      mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip',
      size: 451,
      digest: 'sha256:ef5505406bea98d0f6adb559b937c0dad0aef6d98500b1120c6e27c50fdf172b'
    }
  ]
}
