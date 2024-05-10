export const ddo = {
  hashType: 'sha256',
  '@context': ['https://w3id.org/did/v1'],
  id: 'did:op:fa0e8fa9550e8eb13392d6eeb9ba9f8111801b332c8d2345b350b3bc66b379d7',
  nftAddress: '0xBB1081DbF3227bbB233Db68f7117114baBb43656',
  version: '4.1.0',
  chainId: 137,
  metadata: {
    created: '2022-12-30T08:40:06Z',
    updated: '2022-12-30T08:40:06Z',
    type: 'dataset',
    name: 'DEX volume in details',
    description:
      'Volume traded and locked of Decentralized Exchanges (Uniswap, Sushiswap, Curve, Balancer, ...), daily in details',
    tags: ['index', 'defi', 'tvl'],
    author: 'DEX',
    license: 'https://market.oceanprotocol.com/terms',
    additionalInformation: {
      termsAndConditions: true
    }
  }
}
export const genericAlgorithm = {
  '@context': ['https://w3id.org/did/v1'],
  id: '',
  version: '4.1.0',
  chainId: 8996,
  nftAddress: '0x0',
  metadata: {
    created: '2021-12-20T14:35:20Z',
    updated: '2021-12-20T14:35:20Z',
    type: 'algorithm',
    name: 'dataset-name',
    description: 'Ocean protocol test dataset description',
    author: 'oceanprotocol-team',
    license: 'MIT',
    tags: ['white-papers'],
    additionalInformation: { 'test-key': 'test-value' },
    links: ['http://data.ceda.ac.uk/badc/ukcp09/']
  },
  services: [
    {
      id: '0',
      type: 'access',
      description: 'Download service',
      files: [
        {
          url: 'https://raw.githubusercontent.com/oceanprotocol/test-algorithm/master/javascript/algo.js',
          contentType: 'text/js',
          encoding: 'UTF-8'
        }
      ],
      datatokenAddress: '0x0',
      serviceEndpoint: 'http://172.15.0.4:8030',
      timeout: 0
    }
  ],
  nft: { state: 0 },
  event: {},
  credentials: {
    allow: [
      {
        type: 'address',
        values: ['0xBE5449a6A97aD46c8558A3356267Ee5D2731ab5e']
      }
    ],
    deny: [
      {
        type: 'address',
        values: ['0x123']
      }
    ]
  }
}

export const genericDDO = {
  '@context': ['https://w3id.org/did/v1'],
  id: '',
  version: '4.1.0',
  chainId: 8996,
  nftAddress: '0x0',
  metadata: {
    created: '2021-12-20T14:35:20Z',
    updated: '2021-12-20T14:35:20Z',
    type: 'dataset',
    name: 'dataset-name',
    description: 'Ocean protocol test dataset description',
    author: 'oceanprotocol-team',
    license: 'MIT',
    tags: ['white-papers'],
    additionalInformation: { 'test-key': 'test-value' },
    links: ['http://data.ceda.ac.uk/badc/ukcp09/']
  },
  services: [
    {
      id: '0',
      type: 'access',
      description: 'Download service',
      files: [
        {
          url: 'https://raw.githubusercontent.com/oceanprotocol/test-algorithm/master/javascript/algo.js',
          contentType: 'text/js',
          encoding: 'UTF-8'
        }
      ],
      datatokenAddress: '0x0',
      serviceEndpoint: 'http://172.15.0.4:8030',
      timeout: 0
    }
  ],
  nft: { state: 0 },
  event: {},
  credentials: {
    allow: [
      {
        type: 'address',
        values: ['0xBE5449a6A97aD46c8558A3356267Ee5D2731ab5e']
      }
    ],
    deny: [
      {
        type: 'address',
        values: ['0x123']
      }
    ]
  }
}

export const DDOExample2 = {
  '@context': ['https://w3id.org/did/v1'],
  id: 'did:op:0c184915b07b44c888d468be85a9b28253e80070e5294b1aaed81c2f0264e430',
  version: '4.1.0',
  chainId: 8996,
  nftAddress: '0x0000000000000000000000000000000000000000',
  metadata: {
    created: '2022-12-30T08:40:06Z',
    updated: '2022-12-30T08:40:06Z',
    name: 'Ocean protocol white paper',
    type: 'dataset',
    description: 'Ocean protocol white paper -- description',
    author: 'Ocean Protocol Foundation Ltd.',
    license: 'CC-BY',
    contentLanguage: 'en-US',
    tags: ['white-papers'],
    additionalInformation: { 'test-key': 'test-value' },
    links: [
      'http://data.ceda.ac.uk/badc/ukcp09/data/gridded-land-obs/gridded-land-obs-daily/',
      'http://data.ceda.ac.uk/badc/ukcp09/data/gridded-land-obs/gridded-land-obs-averages-25km/',
      'http://data.ceda.ac.uk/badc/ukcp09/'
    ]
  },
  services: [
    {
      id: 'test',
      type: 'access',
      datatokenAddress: '0xC7EC1970B09224B317c52d92f37F5e1E4fF6B687',
      name: 'Download service',
      description: 'Download service',
      serviceEndpoint: 'http://localhost:8030/',
      timeout: 0,
      files:
        '0x04f0dddf93c186c38bfea243e06889b490a491141585669cfbe7521a5c7acb3bfea5a5527f17eb75ae1f66501e1f70f73df757490c8df479a618b0dd23b2bf3c62d07c372f64c6ad94209947471a898c71f1b2f0ab2a965024fa8e454644661d538b6aa025e517197ac87a3767820f018358999afda760225053df20ff14f499fcf4e7e036beb843ad95587c138e1f972e370d4c68c99ab2602b988c837f6f76658a23e99da369f6898ce1426d49c199cf8ffa33b79002765325c12781a2202239381866c6a06b07754024ee9a6e4aabc8'
    }
  ]
}
export const genericComputeDDO = {
  '@context': ['https://w3id.org/did/v1'],
  id: '',
  version: '4.1.0',
  chainId: 8996,
  nftAddress: '0x0',
  metadata: {
    created: '2021-12-20T14:35:20Z',
    updated: '2021-12-20T14:35:20Z',
    type: 'dataset',
    name: 'dataset-name',
    description: 'Ocean protocol test dataset description',
    author: 'oceanprotocol-team',
    license: 'MIT',
    tags: ['white-papers'],
    additionalInformation: { 'test-key': 'test-value' },
    links: ['http://data.ceda.ac.uk/badc/ukcp09/']
  },
  services: [
    {
      id: '0',
      type: 'compute',
      description: 'Compute service',
      files: [
        {
          url: 'https://raw.githubusercontent.com/oceanprotocol/test-algorithm/master/javascript/algo.js',
          contentType: 'text/js',
          encoding: 'UTF-8'
        }
      ],
      datatokenAddress: '0x0',
      serviceEndpoint: 'http://172.15.0.4:8030',
      timeout: 0,
      compute: {
        namespace: 'test',
        publisherTrustedAlgorithms: [
          {
            did: 'did:op:706d7452b1a25b183051fe02f2ad902d54fc45a43fdcee26b20f21684b5dee72',
            filesChecksum:
              'b4908c868c78086097a10f986718a8f3fae1455f0d443c3dc59330207d47cc6d',
            containerSectionChecksum:
              '20d3f5667b2068e84db5465fb51aa405b06a0ff791635048d7976ec7f5abdc73'
          }
        ]
      }
    }
  ],
  nft: { state: 0 },
  event: {},
  credentials: {
    allow: [
      {
        type: 'address',
        values: ['0xBE5449a6A97aD46c8558A3356267Ee5D2731ab5e']
      }
    ],
    deny: [
      {
        type: 'address',
        values: ['0x123']
      }
    ]
  }
}

export const DDOExample = {
  '@context': ['https://w3id.org/did/v1'],
  id: 'did:op:fa0e8fa9550e8eb13392d6eeb9ba9f8111801b332c8d2345b350b3bc66b379d5',
  nftAddress: '0xBB1081DbF3227bbB233Db68f7117114baBb43656',
  version: '4.1.0',
  chainId: 137,
  metadata: {
    created: '2022-12-30T08:40:06Z',
    updated: '2022-12-30T08:40:06Z',
    type: 'dataset',
    name: 'DEX volume in details',
    description:
      'Volume traded and locked of Decentralized Exchanges (Uniswap, Sushiswap, Curve, Balancer, ...), daily in details',
    tags: ['index', 'defi', 'tvl'],
    author: 'DEX',
    license: 'https://market.oceanprotocol.com/terms',
    additionalInformation: {
      termsAndConditions: true
    }
  },
  services: [
    {
      id: '24654b91482a3351050510ff72694d88edae803cf31a5da993da963ba0087648',
      type: 'access',
      files:
        '0x04beba2f90639ff7559618160df5a81729904022578e6bd5f60c3bebfe5cb2aca59d7e062228a98ed88c4582c290045f47cdf3824d1c8bb25b46b8e10eb9dc0763ce82af826fd347517011855ce1396ac94af8cc6f29b78012b679cb78a594d9064b6f6f4a8229889f0bb53262b6ab62b56fa5c608ea126ba228dd0f87290c0628fe07023416280c067beb01a42d0a4df95fdb5a857f1f59b3e6a13b0ae4619080369ba5bede6c7beff6afc7fc31c71ed8100e7817d965d1f8f1abfaace3c01f0bd5d0127df308175941088a1f120a4d9a0290be590d65a7b4de01ae1efe24286d7a06fadeeafba83b5eab25b90961abf1f24796991f06de6c8e1c2357fbfb31f484a94e87e7dba80a489e12fffa1adde89f113b4c8c4c8877914911a008dbed0a86bdd9d14598c35894395fb4a8ea764ed2f9459f6acadac66e695b3715536338f6cdee616b721b0130f726c78ca60ec02fc86c',
      datatokenAddress: '0xfF4AE9869Cafb5Ff725f962F3Bbc22Fb303A8aD8',
      serviceEndpoint: 'https://v4.provider.polygon.oceanprotocol.com',
      timeout: 604800
    }
  ],
  event: {
    tx: '0xceb617f13a8db82ba9ef24efcee72e90d162915fd702f07ac6012427c31ac952',
    block: 39326976,
    from: '0x0DB823218e337a6817e6D7740eb17635DEAdafAF',
    contract: '0xBB1081DbF3227bbB233Db68f7117114baBb43656',
    datetime: '2023-02-15T16:42:22'
  },
  nft: {
    address: '0xBB1081DbF3227bbB233Db68f7117114baBb43656',
    name: 'Ocean Data NFT',
    symbol: 'OCEAN-NFT',
    state: 0,
    tokenURI:
      'data:application/json;base64,eyJuYW1lIjoiT2NlYW4gRGF0YSBORlQiLCJzeW1ib2wiOiJPQ0VBTi1ORlQiLCJkZXNjcmlwdGlvbiI6IlRoaXMgTkZUIHJlcHJlc2VudHMgYW4gYXNzZXQgaW4gdGhlIE9jZWFuIFByb3RvY29sIHY0IGVjb3N5c3RlbS5cblxuVmlldyBvbiBPY2VhbiBNYXJrZXQ6IGh0dHBzOi8vbWFya2V0Lm9jZWFucHJvdG9jb2wuY29tL2Fzc2V0L2RpZDpvcDpmYTBlOGZhOTU1MGU4ZWIxMzM5MmQ2ZWViOWJhOWY4MTExODAxYjMzMmM4ZDIzNDViMzUwYjNiYzY2YjM3OWQ1IiwiZXh0ZXJuYWxfdXJsIjoiaHR0cHM6Ly9tYXJrZXQub2NlYW5wcm90b2NvbC5jb20vYXNzZXQvZGlkOm9wOmZhMGU4ZmE5NTUwZThlYjEzMzkyZDZlZWI5YmE5ZjgxMTE4MDFiMzMyYzhkMjM0NWIzNTBiM2JjNjZiMzc5ZDUiLCJiYWNrZ3JvdW5kX2NvbG9yIjoiMTQxNDE0IiwiaW1hZ2VfZGF0YSI6ImRhdGE6aW1hZ2Uvc3ZnK3htbCwlM0Nzdmcgdmlld0JveD0nMCAwIDk5IDk5JyBmaWxsPSd1bmRlZmluZWQnIHhtbG5zPSdodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyclM0UlM0NwYXRoIGZpbGw9JyUyM2ZmNDA5Mjc3JyBkPSdNMCw5OUwwLDIzQzEzLDIwIDI3LDE4IDM3LDE4QzQ2LDE3IDUyLDE4IDYyLDIwQzcxLDIxIDg1LDI0IDk5LDI3TDk5LDk5WicvJTNFJTNDcGF0aCBmaWxsPSclMjNmZjQwOTJiYicgZD0nTTAsOTlMMCw1MkMxMSw0OCAyMyw0NCAzMyw0NEM0Miw0MyA1MCw0NSA2MSw0OEM3MSw1MCA4NSw1MiA5OSw1NUw5OSw5OVonJTNFJTNDL3BhdGglM0UlM0NwYXRoIGZpbGw9JyUyM2ZmNDA5MmZmJyBkPSdNMCw5OUwwLDcyQzgsNzMgMTcsNzUgMjksNzZDNDAsNzYgNTMsNzYgNjYsNzdDNzgsNzcgODgsNzcgOTksNzhMOTksOTlaJyUzRSUzQy9wYXRoJTNFJTNDL3N2ZyUzRSJ9',
    owner: '0x0DB823218e337a6817e6D7740eb17635DEAdafAF',
    created: '2022-12-30T08:40:43'
  },
  purgatory: {
    state: false
  },
  datatokens: [
    {
      address: '0xfF4AE9869Cafb5Ff725f962F3Bbc22Fb303A8aD8',
      name: 'Boorish Fish Token',
      symbol: 'BOOFIS-23',
      serviceId: '24654b91482a3351050510ff72694d88edae803cf31a5da993da963ba0087648'
    }
  ],
  stats: {
    allocated: 5211144,
    orders: 36,
    price: {
      value: 1000,
      tokenAddress: '0x282d8efCe846A88B159800bd4130ad77443Fa1A1',
      tokenSymbol: 'mOCEAN'
    }
  },
  accessDetails: {
    templateId: 2,
    publisherMarketOrderFee: '0',
    type: 'fixed',
    addressOrId: '0xd829c22afa50a25ad965e2c2f3d89940a6a27dbfabc2631964ea882883bc7d11',
    price: '1000',
    isPurchasable: true,
    baseToken: {
      address: '0x282d8efce846a88b159800bd4130ad77443fa1a1',
      name: 'Ocean Token (PoS)',
      symbol: 'mOCEAN',
      decimals: 18
    },
    datatoken: {
      address: '0xff4ae9869cafb5ff725f962f3bbc22fb303a8ad8',
      name: 'Boorish Fish Token',
      symbol: 'BOOFIS-23'
    }
  }
}
export const incorrectDDO = {
  '@context': ['https://w3id.org/did/v1'],
  id: 'did:op:fa0e8fa9550e8eb13392d6eeb9ba9f8111801b332c8d2345b350b3bc66b379d5',
  version: '4.1.0',
  chainId: 8996,
  nftAddress: '0xBB1081DbF3227bbB233Db68f7117114baBb43656'
}

export const ddov5 = {
  '@context': ['https://w3id.org/did/v1'],
  id: 'did:op:fa0e8fa9550e8eb13392d6eeb9ba9f8111801b332c8d2345b350b3bc66b379d5',
  version: '4.5.0',
  chainId: 137,
  nftAddress: '0xBB1081DbF3227bbB233Db68f7117114baBb43656',
  metadata: {
    created: '2021-12-20T14:35:20Z',
    updated: '2021-12-20T14:35:20Z',
    type: 'dataset',
    name: 'dataset-name',
    description: 'Ocean protocol test dataset description',
    author: 'oceanprotocol-team',
    license: 'MIT',
    tags: ['white-papers'],
    additionalInformation: { 'test-key': 'test-value' },
    links: ['http://data.ceda.ac.uk/badc/ukcp09/']
  }
}

export const publishAlgoDDO = {
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
      id: '0',
      type: 'access',
      files: {
        datatokenAddress: '0x0',
        nftAddress: '0x0',
        files: [
          {
            type: 'url',
            url: 'https://raw.githubusercontent.com/oceanprotocol/test-algorithm/master/javascript/algo.js',
            method: 'GET'
          }
        ]
      },
      timeout: 0
    }
  ]
}

export const publishDatasetDDO = {
  '@context': ['https://w3id.org/did/v1'],
  id: '',
  version: '4.1.0',
  chainId: 8996,
  nftAddress: '0x0',
  metadata: {
    created: '2021-12-20T14:35:20Z',
    updated: '2021-12-20T14:35:20Z',
    type: 'dataset',
    name: 'dataset-name',
    description: 'Ocean protocol test dataset description',
    author: 'oceanprotocol-team',
    license: 'MIT',
    tags: ['white-papers'],
    additionalInformation: { 'test-key': 'test-value' },
    links: ['http://data.ceda.ac.uk/badc/ukcp09/']
  },
  services: [
    {
      id: '0',
      type: 'compute',
      description: 'Compute service',
      files: [
        {
          datatokenAddress: '0x0',
          nftAddress: '0x0',
          files: [
            {
              type: 'url',
              url: 'https://github.com/datablist/sample-csv-files/raw/main/files/organizations/organizations-100.csv',
              method: 'GET'
            }
          ]
        }
      ],
      datatokenAddress: '0x0',
      serviceEndpoint: 'http://172.15.0.4:8030',
      timeout: 0,
      compute: {
        allowRawAlgorithm: false,
        allowNetworkAccess: true,
        publisherTrustedAlgorithmPublishers: ['0x234', '0x235'],
        publisherTrustedAlgorithms: [
          {
            did: 'did:op:123',
            filesChecksum: '100',
            containerSectionChecksum: '200'
          },
          {
            did: 'did:op:124',
            filesChecksum: '110',
            containerSectionChecksum: '210'
          }
        ]
      }
    }
  ]
}

export const ddoValidationSignature = {
  '@context': ['https://w3id.org/did/v1'],
  id: 'did:op:fa0e8fa9550e8eb13392d6eeb9ba9f8111801b332c8d2345b350b3bc66b379d5',
  version: '4.5.0',
  chainId: 137,
  nftAddress: '0xBB1081DbF3227bbB233Db68f7117114baBb43656',
  metadata: {
    created: '2021-12-20T14:35:20Z',
    updated: '2021-12-20T14:35:20Z',
    type: 'dataset',
    name: 'dataset-name',
    description: 'Ocean protocol test dataset description',
    author: 'oceanprotocol-team',
    license: 'MIT',
    tags: ['white-papers'],
    additionalInformation: { 'test-key': 'test-value' },
    links: ['http://data.ceda.ac.uk/badc/ukcp09/']
  }
}
