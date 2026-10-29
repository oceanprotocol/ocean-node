import { expect } from 'chai'
import {
  RESERVED_CONTAINER_ENV_KEYS,
  buildAlgoContainerEnv,
  mergeOwnerEnvs,
  parsePassContainerEnvs
} from '../../../components/c2d/containerEnvs.js'
import { getConfiguration } from '../../../utils/config.js'
import { ENVIRONMENT_VARIABLES } from '../../../utils/constants.js'
import {
  TEST_ENV_CONFIG_PATH,
  buildEnvOverrideConfig,
  setupEnvironment,
  tearDownEnvironment
} from '../../utils/utils.js'

describe('containerEnvs: parsePassContainerEnvs', () => {
  it('returns {} for unset/empty values', () => {
    expect(parsePassContainerEnvs(undefined)).to.deep.equal({})
    expect(parsePassContainerEnvs(null)).to.deep.equal({})
    expect(parsePassContainerEnvs('')).to.deep.equal({})
    expect(parsePassContainerEnvs('   ')).to.deep.equal({})
    expect(parsePassContainerEnvs('undefined')).to.deep.equal({})
  })

  it('parses a JSON object string', () => {
    expect(parsePassContainerEnvs('{"FOO":"bar","LOG_LEVEL":"debug"}')).to.deep.equal({
      FOO: 'bar',
      LOG_LEVEL: 'debug'
    })
  })

  it('parses a JSON array of KEY=value strings', () => {
    expect(
      parsePassContainerEnvs('["FOO=bar","API_URL=https://example.com"]')
    ).to.deep.equal({ FOO: 'bar', API_URL: 'https://example.com' })
  })

  it('splits array entries on the first = so values may contain =', () => {
    expect(parsePassContainerEnvs('["TOKEN=a=b=c"]')).to.deep.equal({ TOKEN: 'a=b=c' })
  })

  it('accepts an already-parsed object or array (config.json path)', () => {
    expect(parsePassContainerEnvs({ FOO: 'bar' })).to.deep.equal({ FOO: 'bar' })
    expect(parsePassContainerEnvs(['FOO=bar'])).to.deep.equal({ FOO: 'bar' })
  })

  it('coerces scalar object values to strings', () => {
    expect(parsePassContainerEnvs({ N: 1, B: true })).to.deep.equal({ N: '1', B: 'true' })
  })

  it('skips malformed array entries but keeps the good ones', () => {
    expect(parsePassContainerEnvs('["FOO=bar","noequals","=emptykey"]')).to.deep.equal({
      FOO: 'bar'
    })
  })

  it('fails soft to {} on invalid JSON', () => {
    expect(parsePassContainerEnvs('{not json}')).to.deep.equal({})
  })

  it('fails soft to {} on non-object/array JSON', () => {
    expect(parsePassContainerEnvs('"a string"')).to.deep.equal({})
    expect(parsePassContainerEnvs('42')).to.deep.equal({})
  })

  it('skips non-scalar object values', () => {
    expect(parsePassContainerEnvs({ OK: 'v', BAD: { nested: 1 } })).to.deep.equal({
      OK: 'v'
    })
  })

  it('rejects invalid env-var names in the object form', () => {
    expect(
      parsePassContainerEnvs({
        '': 'x',
        'A=B': 'y',
        'has space': 'z',
        '1LEADING': 'n',
        OK: 'v'
      })
    ).to.deep.equal({ OK: 'v' })
  })

  it('ignores prototype-pollution-shaped keys', () => {
    const out = parsePassContainerEnvs({
      __proto__: 'x',
      constructor: 'y',
      prototype: 'z',
      SAFE: 'v'
    })
    expect(out).to.deep.equal({ SAFE: 'v' })
    expect(Object.getPrototypeOf(out)).to.equal(Object.prototype)
  })

  it('drops reserved keys at parse time (both forms)', () => {
    expect(
      parsePassContainerEnvs({ DIDS: 'x', TRANSFORMATION_DID: 'y', FOO: 'bar' })
    ).to.deep.equal({ FOO: 'bar' })
    expect(parsePassContainerEnvs('["DIDS=x","FOO=bar"]')).to.deep.equal({ FOO: 'bar' })
  })
})

describe('containerEnvs: buildAlgoContainerEnv', () => {
  it('emits DIDS and TRANSFORMATION_DID from the job', () => {
    const env = buildAlgoContainerEnv(
      { algoEnvs: { A: '1' }, inputDids: ['did:op:x'], transformationDid: 'did:op:algo' },
      {}
    )
    expect(env).to.include('A=1')
    expect(env).to.include('DIDS=["did:op:x"]')
    expect(env).to.include('TRANSFORMATION_DID=did:op:algo')
  })

  it('omits TRANSFORMATION_DID when there is no documentId', () => {
    const env = buildAlgoContainerEnv({ inputDids: [null] }, {})
    expect(env).to.deep.equal(['DIDS=[null]'])
  })

  it('lets the owner override an algorithm env', () => {
    const env = buildAlgoContainerEnv(
      { algoEnvs: { SHARED: 'algo', ALGO_ONLY: 'a' }, inputDids: [] },
      { SHARED: 'owner', OWNER_ONLY: 'o' }
    )
    expect(env).to.include('SHARED=owner')
    expect(env).to.not.include('SHARED=algo')
    expect(env).to.include('ALGO_ONLY=a')
    expect(env).to.include('OWNER_ONLY=o')
  })

  it('never lets an algorithm-supplied DIDS/TRANSFORMATION_DID shadow the contract (no duplicates)', () => {
    const env = buildAlgoContainerEnv(
      {
        algoEnvs: { DIDS: 'hijack', TRANSFORMATION_DID: 'hijack' },
        inputDids: ['did:op:real'],
        transformationDid: 'did:op:algo'
      },
      {}
    )
    expect(env.filter((e) => e.startsWith('DIDS='))).to.deep.equal([
      'DIDS=["did:op:real"]'
    ])
    expect(env.filter((e) => e.startsWith('TRANSFORMATION_DID='))).to.deep.equal([
      'TRANSFORMATION_DID=did:op:algo'
    ])
  })

  it('coerces non-string algorithm env values', () => {
    const env = buildAlgoContainerEnv(
      {
        algoEnvs: { N: 1 as unknown as string, B: true as unknown as string },
        inputDids: []
      },
      {}
    )
    expect(env).to.include('N=1')
    expect(env).to.include('B=true')
  })
})

describe('containerEnvs: mergeOwnerEnvs', () => {
  it('leaves user env untouched when there are no owner envs', () => {
    expect(mergeOwnerEnvs({ FOO: 'bar' }, {})).to.deep.equal({ FOO: 'bar' })
  })

  it('adds owner envs on top of user envs', () => {
    expect(mergeOwnerEnvs({ FOO: 'bar' }, { HF_ENDPOINT: 'http://m' })).to.deep.equal({
      FOO: 'bar',
      HF_ENDPOINT: 'http://m'
    })
  })

  it('owner wins on key collisions', () => {
    expect(mergeOwnerEnvs({ FOO: 'user' }, { FOO: 'owner' })).to.deep.equal({
      FOO: 'owner'
    })
  })

  it('never lets the owner override reserved pod-contract keys', () => {
    const merged = mergeOwnerEnvs(
      { DIDS: '["did:op:x"]', TRANSFORMATION_DID: 'did:op:a', FOO: 'bar' },
      { DIDS: 'hijack', TRANSFORMATION_DID: 'hijack', HF_ENDPOINT: 'http://m' }
    )
    expect(merged.DIDS).to.equal('["did:op:x"]')
    expect(merged.TRANSFORMATION_DID).to.equal('did:op:a')
    expect(merged.FOO).to.equal('bar')
    expect(merged.HF_ENDPOINT).to.equal('http://m')
  })

  it('handles a null/undefined owner map', () => {
    expect(mergeOwnerEnvs({ FOO: 'bar' }, undefined as any)).to.deep.equal({ FOO: 'bar' })
  })

  it('exposes the reserved keys it protects', () => {
    expect([...RESERVED_CONTAINER_ENV_KEYS]).to.deep.equal(['DIDS', 'TRANSFORMATION_DID'])
  })
})

describe('containerEnvs: PASS_CONTAINER_ENVS config mapping', () => {
  async function configWith(value: string) {
    const overrides = buildEnvOverrideConfig(
      [ENVIRONMENT_VARIABLES.PASS_CONTAINER_ENVS],
      [value]
    )
    try {
      await setupEnvironment(TEST_ENV_CONFIG_PATH, overrides)
      return await getConfiguration(true)
    } finally {
      await tearDownEnvironment(overrides)
    }
  }

  it('maps a JSON array value to config.passContainerEnvs', async () => {
    const config = await configWith('["FOO=bar","LOG_LEVEL=debug"]')
    expect(config.passContainerEnvs).to.deep.equal({ FOO: 'bar', LOG_LEVEL: 'debug' })
  })

  it('maps a JSON object value to config.passContainerEnvs', async () => {
    const config = await configWith('{"HF_ENDPOINT":"http://m"}')
    expect(config.passContainerEnvs).to.deep.equal({ HF_ENDPOINT: 'http://m' })
  })

  it('fails soft to {} on invalid input', async () => {
    const config = await configWith('{not json}')
    expect(config.passContainerEnvs).to.deep.equal({})
  })
})
