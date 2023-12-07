import fs from 'fs'
import { homedir } from 'os'
/**
 * Get the artifacts address from the address.json file
 * either from the env or from the ocean-contracts dir
 * @returns data or null
 */
export function getOceanArtifactsAdresses(): any {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const data = fs.readFileSync(
      process.env.ADDRESS_FILE ||
        `${homedir}/.ocean/ocean-contracts/artifacts/address.json`,
      'utf8'
    )
    return JSON.parse(data)
  } catch (error) {
    return null
  }
}
// default Ocean token (only) addresses per chain
export const OCEAN_TOKEN_ADDRESS_PER_CHAIN = {
  mumbai: {
    chainId: 80001,
    Ocean: '0xd8992Ed72C445c35Cb4A2be468568Ed1079357c8'
  },

  polygon: {
    chainId: 137,
    Ocean: '0x282d8efCe846A88B159800bd4130ad77443Fa1A1'
  },
  bsc: {
    chainId: 56,
    Ocean: '0xDCe07662CA8EbC241316a15B611c89711414Dd1a'
  },
  energyweb: {
    chainId: 246,
    Ocean: '0x593122AAE80A6Fc3183b2AC0c4ab3336dEbeE528'
  },
  moonriver: {
    chainId: 1285,
    Ocean: '0x99C409E5f62E4bd2AC142f17caFb6810B8F0BAAE'
  },
  mainnet: {
    chainId: 1,
    Ocean: '0x967da4048cD07aB37855c090aAF366e4ce1b9F48'
  },
  goerli: {
    chainId: 5,
    Ocean: '0xCfDdA22C9837aE76E0faA845354f33C62E03653a'
  },
  polygonedge: {
    chainId: 81001,
    Ocean: '0x8c98ea273bA22327F896Aa1a1a46E1BFf56e9b1D'
  },
  gaiaxtestnet: {
    chainId: 2021000,
    Ocean: '0x80E63f73cAc60c1662f27D2DFd2EA834acddBaa8'
  },
  alfajores: {
    chainId: 44787,
    Ocean: '0xd8992Ed72C445c35Cb4A2be468568Ed1079357c8'
  },
  'gen-x-testnet': {
    chainId: 100,
    // OceanToken: '0x0995527d3473b3a98c471f1ed8787acd77fbf009', ?
    Ocean: '0x0995527d3473b3a98c471f1ed8787acd77fbf009'
  },
  filecointestnet: {
    chainId: 3141,
    Ocean: '0xf26c6C93f9f1d725e149d95f8E7B2334a406aD10'
  },
  oasis_saphire_testnet: {
    chainId: 23295,
    Ocean: '0x973e69303259B0c2543a38665122b773D28405fB'
  },
  sepolia: {
    chainId: 11155111,
    Ocean: '0x1B083D8584dd3e6Ff37d04a6e7e82b5F622f3985'
  },
  oasis_saphire: {
    chainId: 23294,
    Ocean: '0x39d22B78A7651A76Ffbde2aaAB5FD92666Aca520'
  },
  optimism_sepolia: {
    chainId: 11155420,
    Ocean: '0xf26c6C93f9f1d725e149d95f8E7B2334a406aD10'
  },
  optimism: {
    chainId: 10,
    Ocean: '0x2561aa2bB1d2Eb6629EDd7b0938d7679B8b49f9E'
  },
  development: {
    chainId: 8996,
    Ocean: '0x2473f4F7bf40ed9310838edFCA6262C17A59DF64'
  }
}
