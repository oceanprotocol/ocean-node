import { expect } from 'chai'
import type {
  ServiceTemplate,
  TemplateIncludedItem
} from '../../../@types/C2D/ServiceOnDemand.js'
import {
  applyCurated,
  deriveTemplateSpecs,
  mergeSelection,
  parseHfResolveUrl,
  scanHfUrls,
  sortTemplatesForCache
} from '../../../components/modelCache/derive.js'
import { matchesAllowPatterns } from '../../../components/modelCache/fnmatch.js'
import type {
  FileSelection,
  ModelSpec,
  ServiceModelCacheCuratedEntry
} from '../../../components/modelCache/types.js'

// Fixtures are shaped like the ocean-node-templates catalogue: ComfyUI bundles whose weights
// come from properties.models[].url of loader nodes (usually inside a subgraph) and from
// MarkdownNote text, and vLLM bundles that only name their repo in includes[].

const HF = 'https://huggingface.co'
const QWEN_IMAGE = 'Comfy-Org/Qwen-Image_ComfyUI'
const QWEN_EDIT = 'Comfy-Org/Qwen-Image-Edit_ComfyUI'
const LIGHTNING = 'lightx2v/Qwen-Image-Lightning'
const H3 = 'Comfy-Org/MiniMax-H3'
const QWEN3_VL = 'Comfy-Org/Qwen3-VL'
const MUSIC3 = 'Comfy-Org/MiniMax-Music-3'
const GEMMA = 'google/gemma-4-31B-it'
const GLM = 'zai-org/GLM-5.3-Flash'
const QWEN38 = 'Qwen/Qwen3.8-27B-FP8'
const SHA_1 = 'a1b2c3d4e5'.repeat(4)
const SHA_2 = '0f9e8d7c6b'.repeat(4)

const VAE = 'split_files/vae/qwen_image_vae.safetensors'
const TEXT_ENC = 'split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors'
const EDIT_UNET =
  'split_files/diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors'
const RELIGHT = 'split_files/loras/Qwen-Image-Edit-2509-Relight.safetensors'
const LIGHT_MIGRATION =
  'split_files/loras/Qwen-Image-Edit-2509-Light-Migration.safetensors'
const LIGHTNING_LORA =
  'Qwen-Image-Edit-2509/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors'

function resolveUrl(repo: string, revision: string, file: string): string {
  return `${HF}/${repo}/resolve/${revision}/${file}`
}

let nodeId = 100

function loaderNode(
  type: string,
  url: string,
  directory: string
): Record<string, unknown> {
  const name = url.split('?')[0].split('#')[0].split('/').pop()
  const id = nodeId++
  return {
    id,
    type,
    pos: [-730, 600],
    size: [330, 110],
    flags: {},
    order: 6,
    mode: 0,
    inputs: [
      {
        localized_name: 'name',
        name: 'name',
        type: 'COMBO',
        widget: { name: 'name' },
        link: id
      }
    ],
    outputs: [{ localized_name: 'OUT', name: 'OUT', type: 'MODEL', links: [id, id + 1] }],
    properties: {
      'Node name for S&R': type,
      cnr_id: 'comfy-core',
      ver: '0.3.48',
      enableTabs: false,
      tabWidth: 65,
      models: [{ name, url, directory }],
      widget_ue_connectable: {}
    },
    widgets_values: [name, 'default', 1.0, true, null]
  }
}

function markdownNote(text: string): Record<string, unknown> {
  return {
    id: nodeId++,
    type: 'MarkdownNote',
    pos: [-1200, 800],
    size: [860, 520],
    flags: {},
    order: 1,
    mode: 0,
    inputs: [],
    outputs: [],
    properties: { 'Node name for S&R': 'MarkdownNote' },
    widgets_values: [text],
    color: '#222',
    bgcolor: '#000'
  }
}

// A ComfyUI frontend export: top-level nodes plus one subgraph holding the loaders.
function comfyGraph(nodes: unknown[], subgraphNodes: unknown[] = []): unknown {
  return {
    id: 'f3b6c1e2-0000-4000-8000-000000000001',
    revision: 0,
    last_node_id: 500,
    last_link_id: 900,
    nodes,
    links: [[1, 111, 0, 112, 0, 'VAE']],
    groups: [],
    definitions: {
      subgraphs: subgraphNodes.length
        ? [
            {
              id: '0b5e7a10-0000-4000-8000-000000000002',
              version: 1,
              state: { lastGroupId: 0, lastNodeId: 300 },
              revision: 0,
              config: {},
              name: 'New Subgraph',
              inputNode: { id: -10, bounding: [0, 0, 120, 60] },
              outputNode: { id: -20, bounding: [900, 0, 120, 60] },
              inputs: [],
              outputs: [],
              widgets: [],
              nodes: subgraphNodes,
              groups: [],
              links: [],
              extra: {}
            }
          ]
        : []
    },
    config: {},
    extra: { ds: { scale: 0.5, offset: [0, 0] }, frontendVersion: '1.26.6' },
    version: 0.4
  }
}

function workflow(id: string, graph: unknown) {
  return { id, name: id, description: `${id} workflow`, graph }
}

function model(name: string, repoId?: string, sizeGb = 1): TemplateIncludedItem {
  return { name, kind: 'model', sizeGb, ...(repoId ? { repoId } : {}) }
}

function comfyTemplate(
  id: string,
  extra: Partial<ServiceTemplate> = {}
): ServiceTemplate {
  return {
    id,
    name: id,
    description: 'ComfyUI bundle',
    kind: 'bundle',
    service: 'comfyui',
    category: 'image',
    image: 'yanwk/comfyui-boot',
    tag: 'cu130-megapak-pt211-20260814',
    exposedPorts: [8188],
    entrypoint: ['/bin/bash', '-c'],
    command: ['#!/bin/bash\nset -euo pipefail\n# bootstrap inlined from bootstrap.sh\n'],
    userConfigurableEnvVars: [
      { key: 'COMFY_WORKFLOW_ID', validation: '^[A-Za-z0-9_-]+$' },
      { key: 'COMFY_WORKFLOW' }
    ],
    ...extra
  }
}

function vllmTemplate(id: string, extra: Partial<ServiceTemplate> = {}): ServiceTemplate {
  return {
    id,
    name: id,
    description: 'vLLM bundle',
    kind: 'bundle',
    category: 'llm',
    image: 'vllm/vllm-openai',
    tag: 'v0.14.0',
    exposedPorts: [8000],
    entrypoint: ['/bin/bash', '-c'],
    command: ['#!/bin/bash\nexec vllm serve "$MODEL"\n'],
    ...extra
  }
}

// product-studio-qwen-image, cut down to two of its five workflows.
function productStudio(extra: Partial<ServiceTemplate> = {}): ServiceTemplate {
  const background = comfyGraph(
    [
      markdownNote(
        '## Background swap\n\n**1.** Upload a packshot of your product in *Load Product Image*.\n\n' +
          '**3.** Queue the prompt. The result saves as `ecom_background_00001_.png`.\n'
      )
    ],
    [
      loaderNode('VAELoader', resolveUrl(QWEN_IMAGE, 'main', VAE), 'vae'),
      loaderNode('CLIPLoader', resolveUrl(QWEN_IMAGE, 'main', TEXT_ENC), 'text_encoders'),
      loaderNode(
        'UNETLoader',
        resolveUrl(QWEN_EDIT, 'main', EDIT_UNET),
        'diffusion_models'
      ),
      loaderNode(
        'LoraLoaderModelOnly',
        resolveUrl(LIGHTNING, 'main', LIGHTNING_LORA),
        'loras'
      )
    ]
  )
  const relight = comfyGraph(
    [
      markdownNote(
        '### Prompt-driven relight instead of a reference photo\n\nTo relight from a text ' +
          'description, open the subgraph and change the *lora_name* widget from ' +
          '`Qwen-Image-Edit-2509-Light-Migration.safetensors` to ' +
          `[\`Qwen-Image-Edit-2509-Relight.safetensors\`](${resolveUrl(QWEN_EDIT, 'main', RELIGHT)})` +
          ', then describe the lighting you want in the prompt — for example, "warm ' +
          'golden-hour light from the left."\n'
      )
    ],
    [
      // the same base weights as the background workflow: one file each in the cache
      loaderNode('VAELoader', resolveUrl(QWEN_IMAGE, 'main', VAE), 'vae'),
      loaderNode('CLIPLoader', resolveUrl(QWEN_IMAGE, 'main', TEXT_ENC), 'text_encoders'),
      loaderNode(
        'UNETLoader',
        resolveUrl(QWEN_EDIT, 'main', EDIT_UNET),
        'diffusion_models'
      ),
      loaderNode(
        'LoraLoaderModelOnly',
        resolveUrl(QWEN_EDIT, 'main', LIGHT_MIGRATION),
        'loras'
      )
    ]
  )
  return comfyTemplate('product-studio-qwen-image', {
    order: 1,
    includes: [
      model('Qwen2.5-VL 7B text encoder (fp8 scaled)', QWEN_IMAGE, 9.38),
      model('Qwen-Image VAE', QWEN_IMAGE, 0.25),
      model('Qwen-Image-Edit 2509 (fp8 e4m3fn)', QWEN_EDIT, 20.43),
      model('Qwen-Image-Edit 2509 Relight LoRA', QWEN_EDIT, 0.24),
      model('Qwen-Image-Edit 2509 Lightning 4-step LoRA (bf16)', LIGHTNING, 0.85)
    ],
    workflows: [
      workflow('ocean_ecom_background', background),
      workflow('ocean_ecom_relight', relight)
    ],
    ...extra
  })
}

// ugc-reel-minimax-h3: the prompt writer's weights are only named in a "## Model links" note.
function ugcReelH3(extra: Partial<ServiceTemplate> = {}): ServiceTemplate {
  const prompts = comfyGraph([
    {
      id: nodeId++,
      type: 'PrimitiveStringMultiline',
      widgets_values: ['a woman holds up a jar']
    },
    markdownNote(
      `## Model links\n\n[${QWEN3_VL}](${HF}/${QWEN3_VL})\n\n**text_encoders**\n\n` +
        `- [qwen3vl_8b_bf16.safetensors](${resolveUrl(QWEN3_VL, 'main', 'text_encoders/qwen3vl_8b_bf16.safetensors')}) — 17.5 GB, the prompt writer\n`
    )
  ])
  const multishot = comfyGraph(
    [
      markdownNote(
        `## Model links\n\n[${H3}](${HF}/${H3})\n\n**diffusion_models**\n\n` +
          `- [minimax_h3_fl2va_pruned_int8_convrot.safetensors](${resolveUrl(H3, 'main', 'diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors')})\n`
      )
    ],
    [
      loaderNode(
        'UNETLoader',
        resolveUrl(
          H3,
          'main',
          'diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors'
        ),
        'diffusion_models'
      ),
      loaderNode(
        'VAELoader',
        resolveUrl(H3, 'main', 'vae/minimax_h3_video_vae_fp16.safetensors'),
        'vae'
      )
    ]
  )
  return comfyTemplate('ugc-reel-minimax-h3', {
    order: 2,
    category: 'video',
    includes: [
      model('MiniMax H3 FL2VA (int8)', H3, 21),
      model('MiniMax H3 video VAE', H3, 0.5),
      model('Qwen3-VL 8B (bf16)', QWEN3_VL, 17.5),
      {
        name: 'ComfyUI-VideoHelperSuite',
        kind: 'customnode',
        url: 'https://github.com/x/y'
      }
    ],
    workflows: [
      workflow('ocean_h3_ugc_multishot', multishot),
      workflow('ocean_h3_ugc_prompts', prompts)
    ],
    ...extra
  })
}

// music-generator-minimax-music3: the resident gemma writer is pulled by the bootstrap, not by
// a workflow URL, so includes[] is the only place it appears.
function musicGenerator(extra: Partial<ServiceTemplate> = {}): ServiceTemplate {
  const song = comfyGraph(
    [],
    [
      loaderNode(
        'UNETLoader',
        resolveUrl(
          MUSIC3,
          'main',
          'diffusion_models/minimax_music3_dit_fp16.safetensors'
        ),
        'diffusion_models'
      ),
      loaderNode(
        'VAELoader',
        resolveUrl(MUSIC3, 'main', 'vae/minimax_music3_dav.safetensors'),
        'vae'
      )
    ]
  )
  return comfyTemplate('music-generator-minimax-music3', {
    order: 5,
    category: 'app',
    includes: [
      model('MiniMax Music 3 DiT (fp16)', MUSIC3, 6),
      model('MiniMax Music 3 DAV', MUSIC3, 0.3),
      model('Gemma 4 31B it (lyrics writer)', GEMMA, 62)
    ],
    workflows: [workflow('ocean_music3_song', song)],
    ...extra
  })
}

// coding-agent-glm53-flash: no workflow graph at all, the repo comes from includes[].
function codingAgentGlm(extra: Partial<ServiceTemplate> = {}): ServiceTemplate {
  return vllmTemplate('coding-agent-glm53-flash', {
    includes: [
      model('GLM-5.3-Flash', GLM, 210),
      { name: 'opencode CLI', kind: 'other', url: 'https://opencode.ai/install' }
    ],
    ...extra
  })
}

// private-assistant-qwen38-27b: unlisted, includes-only.
function privateAssistant(extra: Partial<ServiceTemplate> = {}): ServiceTemplate {
  return vllmTemplate('private-assistant-qwen38-27b', {
    unlisted: true,
    includes: [
      model('Qwen3.8-27B (FP8)', QWEN38, 29),
      {
        name: 'Open WebUI',
        kind: 'other',
        url: 'https://github.com/open-webui/open-webui'
      }
    ],
    ...extra
  })
}

function byKey(specs: ModelSpec[]): Record<string, ModelSpec> {
  const out: Record<string, ModelSpec> = {}
  for (const s of specs) {
    const key = `${s.repo}@${s.revision}`
    expect(Object.keys(out), `duplicate spec ${key}`).to.not.include(key)
    out[key] = s
  }
  return out
}

function filesOf(spec: ModelSpec): string[] {
  expect(spec, 'spec').to.not.equal(undefined)
  expect(spec.selection.kind, `${spec.repo} selection`).to.equal('files')
  return [...(spec.selection as { kind: 'files'; files: string[] }).files].sort()
}

function patternsOf(selection: FileSelection): string[] {
  expect(selection.kind).to.equal('patterns')
  return (selection as { kind: 'patterns'; patterns: string[] }).patterns
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value)) deepFreeze(v)
  }
  return value
}

function spec(
  repo: string,
  revision: string,
  selection: FileSelection,
  priority: number,
  source = 'template:t'
): ModelSpec {
  return { repo, revision, selection, priority, sources: [source] }
}

describe('modelCache derive', () => {
  describe('parseHfResolveUrl', () => {
    it('parses a resolve URL into repo, revision and repo-relative file', () => {
      expect(parseHfResolveUrl(resolveUrl(QWEN_IMAGE, 'main', VAE))).to.deep.equal({
        repo: QWEN_IMAGE,
        revision: 'main',
        file: VAE
      })
    })

    it("strips '?download=true' and '#fragment' before parsing", () => {
      const base = resolveUrl(QWEN_EDIT, 'main', RELIGHT)
      const want = { repo: QWEN_EDIT, revision: 'main', file: RELIGHT }
      expect(parseHfResolveUrl(`${base}?download=true`)).to.deep.equal(want)
      expect(parseHfResolveUrl(`${base}#model-card`)).to.deep.equal(want)
      expect(parseHfResolveUrl(`${base}?download=true#frag`)).to.deep.equal(want)
    })

    it('rejects a path that is not .safetensors once the query or fragment is gone', () => {
      for (const url of [
        `${HF}/${GLM}/resolve/main/model.bin?name=x.safetensors`,
        `${HF}/${GLM}/resolve/main/README.md#w.safetensors`,
        `${HF}/${GLM}/resolve/main/config.json`
      ]) {
        expect(parseHfResolveUrl(url), url).to.equal(null)
      }
    })

    it('rejects every non-resolve shape (blob/, raw/, datasets/, spaces/, repo root)', () => {
      for (const url of [
        `${HF}/${QWEN_EDIT}/blob/main/${RELIGHT}`,
        `${HF}/${QWEN_EDIT}/raw/main/${RELIGHT}`,
        `${HF}/datasets/${QWEN_EDIT}/resolve/main/${RELIGHT}`,
        `${HF}/spaces/${QWEN_EDIT}/resolve/main/${RELIGHT}`,
        `${HF}/${QWEN_EDIT}/resolve/main.safetensors`,
        `${HF}/${QWEN_EDIT}.safetensors`,
        `http://huggingface.co/${QWEN_EDIT}/resolve/main/${RELIGHT}`,
        `https://hf.co/${QWEN_EDIT}/resolve/main/${RELIGHT}`
      ]) {
        expect(parseHfResolveUrl(url), url).to.equal(null)
      }
    })

    it('keeps a 40-hex revision as the commit and refuses 7-39 hex as ambiguous', () => {
      expect(parseHfResolveUrl(resolveUrl(QWEN_EDIT, SHA_1, RELIGHT))).to.deep.equal({
        repo: QWEN_EDIT,
        revision: SHA_1,
        file: RELIGHT
      })
      for (const short of [
        'abc1234',
        SHA_1.slice(0, 12),
        SHA_1.slice(0, 39),
        '1234567'
      ]) {
        expect(parseHfResolveUrl(resolveUrl(QWEN_EDIT, short, RELIGHT)), short).to.equal(
          null
        )
      }
      // ref names, including short words that happen to be hex
      for (const name of ['v1.0', 'fp8-scaled', 'cafe', 'release_2026.10']) {
        expect(
          parseHfResolveUrl(resolveUrl(QWEN_EDIT, name, RELIGHT))?.revision
        ).to.equal(name)
      }
      // refs/pr/N arrives percent-encoded and is not a v1 ref name
      expect(
        parseHfResolveUrl(resolveUrl(QWEN_EDIT, 'refs%2Fpr%2F12', RELIGHT))
      ).to.equal(null)
    })

    it('refuses invalid repo ids', () => {
      for (const repo of [
        'Comfy-Org/Qwen--Image',
        '-Comfy-Org/Qwen-Image',
        'Comfy-Org/.hidden',
        'Comfy-Org/Qwen-Image.git',
        'Comfy-Org/Qwen..Image',
        'Comfy-Org/Qwen-Image.',
        `Comfy-Org/${'x'.repeat(97)}`,
        'Comfy%2DOrg/Qwen-Image'
      ]) {
        expect(parseHfResolveUrl(resolveUrl(repo, 'main', VAE)), repo).to.equal(null)
      }
    })

    it('decodes the file path and refuses traversal, empty segments and control chars', () => {
      expect(
        parseHfResolveUrl(
          resolveUrl(QWEN_IMAGE, 'main', 'split_files/my%20vae.safetensors')
        )?.file
      ).to.equal('split_files/my vae.safetensors')
      for (const file of [
        '%2E%2E/%2E%2E/etc/x.safetensors',
        'split_files/../x.safetensors',
        'split_files/./x.safetensors',
        'split_files//x.safetensors',
        'split_files/a%5Cb.safetensors',
        'split_files/a%00b.safetensors',
        'split_files/a%0Ab.safetensors',
        `${'a'.repeat(250)}.safetensors`,
        'bad%E0%A4%A.safetensors'
      ]) {
        expect(parseHfResolveUrl(resolveUrl(QWEN_IMAGE, 'main', file)), file).to.equal(
          null
        )
      }
      // a malformed escape in the revision is refused too, not thrown
      expect(parseHfResolveUrl(resolveUrl(QWEN_IMAGE, 'ma%ZZin', VAE))).to.equal(null)
    })
  })

  describe('scanHfUrls', () => {
    it('finds URLs in properties.models[].url and in MarkdownNote text, deduplicated', () => {
      const urls = scanHfUrls(ugcReelH3().workflows[0].graph).sort()
      expect(urls).to.deep.equal(
        [
          resolveUrl(
            H3,
            'main',
            'diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors'
          ),
          resolveUrl(H3, 'main', 'vae/minimax_h3_video_vae_fp16.safetensors')
        ].sort()
      )
    })

    it('stops at ) ] " and whitespace and ignores repo-root links', () => {
      const file = resolveUrl(
        QWEN3_VL,
        'main',
        'text_encoders/qwen3vl_8b_bf16.safetensors'
      )
      const text =
        `[${QWEN3_VL}](${HF}/${QWEN3_VL}) and [w](${file}) then [${file}] then "${file}" ` +
        `then <${file}> then ${file}?download=true\n${file}#sha`
      expect(scanHfUrls({ widgets_values: [text] })).to.deep.equal([file])
    })

    it('ignores non-string leaves and survives very deep graphs', () => {
      const url = resolveUrl(QWEN_IMAGE, 'main', VAE)
      let deep: unknown = { properties: { models: [{ url, directory: 'vae' }] } }
      for (let i = 0; i < 50_000; i++) deep = { child: [deep, i, true, null] }
      expect(scanHfUrls(deep)).to.deep.equal([url])
      expect(scanHfUrls(undefined)).to.deep.equal([])
      expect(scanHfUrls(42)).to.deep.equal([])
    })
  })

  describe('sortTemplatesForCache', () => {
    it('sorts by order (undefined last), then listed before unlisted, then id', () => {
      const input = [
        vllmTemplate('zz-no-order'),
        vllmTemplate('hidden-no-order', { unlisted: true }),
        vllmTemplate('c-order-3', { order: 3 }),
        vllmTemplate('aa-no-order'),
        vllmTemplate('b-order-1', { order: 1 }),
        vllmTemplate('a-order-3', { order: 3 }),
        vllmTemplate('hidden-order-2', { order: 2, unlisted: true }),
        vllmTemplate('hidden-order-3', { order: 3, unlisted: true }),
        vllmTemplate('a-hidden-no-order', { unlisted: true }),
        vllmTemplate('negative', { order: -1 })
      ]
      const before = input.map((t) => t.id)
      expect(sortTemplatesForCache(input).map((t) => t.id)).to.deep.equal([
        'negative',
        'b-order-1',
        'hidden-order-2',
        'a-order-3',
        'c-order-3',
        'hidden-order-3',
        'aa-no-order',
        'zz-no-order',
        'a-hidden-no-order',
        'hidden-no-order'
      ])
      expect(
        input.map((t) => t.id),
        'input array untouched'
      ).to.deep.equal(before)
    })
  })

  describe('deriveTemplateSpecs', () => {
    it('derives one files spec per (repo, revision) from a ComfyUI bundle', () => {
      const { specs, problems } = deriveTemplateSpecs([productStudio()], true)
      expect(problems).to.deep.equal([])
      const got = byKey(specs)
      expect(Object.keys(got).sort()).to.deep.equal(
        [`${LIGHTNING}@main`, `${QWEN_EDIT}@main`, `${QWEN_IMAGE}@main`].sort()
      )
      expect(filesOf(got[`${QWEN_IMAGE}@main`])).to.deep.equal([TEXT_ENC, VAE].sort())
      // the relight LoRA is only linked from a MarkdownNote: the bootstrap downloads it too
      expect(filesOf(got[`${QWEN_EDIT}@main`])).to.deep.equal(
        [EDIT_UNET, LIGHT_MIGRATION, RELIGHT].sort()
      )
      expect(filesOf(got[`${LIGHTNING}@main`])).to.deep.equal([LIGHTNING_LORA])
      for (const s of specs) {
        expect(s.priority).to.equal(0)
        expect(s.sources).to.deep.equal(['template:product-studio-qwen-image'])
        expect(s).to.not.have.property('commit')
      }
    })

    it("merges '?download=true' / '#frag' duplicates of one file into one entry", () => {
      const vae = resolveUrl(QWEN_IMAGE, 'main', VAE)
      const t = comfyTemplate('dupes', {
        workflows: [
          workflow(
            'a',
            comfyGraph(
              [markdownNote(`Weights: [vae](${vae}#L1) and ${vae}?download=true.`)],
              [loaderNode('VAELoader', `${vae}?download=true`, 'vae')]
            )
          ),
          workflow('b', comfyGraph([], [loaderNode('VAELoader', vae, 'vae')]))
        ]
      })
      const { specs, problems } = deriveTemplateSpecs([t], true)
      expect(problems).to.deep.equal([])
      expect(specs).to.have.length(1)
      expect(filesOf(specs[0])).to.deep.equal([VAE])
    })

    it('skips unsupported URL shapes with a problem naming the template', () => {
      const t = comfyTemplate('bad-urls', {
        workflows: [
          workflow(
            'wf',
            comfyGraph(
              [
                markdownNote(
                  `See [card](${HF}/${QWEN_EDIT}/blob/main/${RELIGHT}) or ` +
                    `[raw](${HF}/${QWEN_EDIT}/raw/main/${LIGHT_MIGRATION}) or ` +
                    `[ckpt](${HF}/${GLM}/resolve/main/model.bin?name=x.safetensors) or ` +
                    `[readme](${HF}/${GLM}/resolve/main/README.md#x.safetensors)`
                )
              ],
              [loaderNode('VAELoader', resolveUrl(QWEN_IMAGE, 'main', VAE), 'vae')]
            )
          )
        ]
      })
      const { specs, problems } = deriveTemplateSpecs([t], true)
      expect(specs.map((s) => `${s.repo}@${s.revision}`)).to.deep.equal([
        `${QWEN_IMAGE}@main`
      ])
      expect(problems).to.have.length(4)
      for (const p of problems) {
        expect(p).to.match(/^template:bad-urls: /)
        expect(p).to.include('skipped unsupported model URL')
      }
      expect(problems.join('\n')).to.include(`${HF}/${QWEN_EDIT}/blob/main/${RELIGHT}`)
      expect(problems.join('\n')).to.include(
        `${HF}/${QWEN_EDIT}/raw/main/${LIGHT_MIGRATION}`
      )
      // the query string is never echoed into the log
      expect(problems.join('\n')).to.not.include('name=x')
    })

    it('keeps a 40-hex URL revision as a commit spec next to the main spec', () => {
      const t = comfyTemplate('pinned', {
        workflows: [
          workflow(
            'wf',
            comfyGraph(
              [],
              [
                loaderNode(
                  'LoraLoaderModelOnly',
                  resolveUrl(QWEN_EDIT, SHA_1, RELIGHT),
                  'loras'
                ),
                loaderNode(
                  'UNETLoader',
                  resolveUrl(QWEN_EDIT, 'main', EDIT_UNET),
                  'diffusion_models'
                )
              ]
            )
          )
        ]
      })
      const { specs, problems } = deriveTemplateSpecs([t], true)
      expect(problems).to.deep.equal([])
      const got = byKey(specs)
      expect(Object.keys(got).sort()).to.deep.equal(
        [`${QWEN_EDIT}@${SHA_1}`, `${QWEN_EDIT}@main`].sort()
      )
      expect(filesOf(got[`${QWEN_EDIT}@${SHA_1}`])).to.deep.equal([RELIGHT])
      expect(filesOf(got[`${QWEN_EDIT}@main`])).to.deep.equal([EDIT_UNET])
      // a URL revision is never turned into a curated-style pin
      expect(got[`${QWEN_EDIT}@${SHA_1}`]).to.not.have.property('commit')
    })

    it('skips a 7-39 hex revision and an invalid repo id with a problem each', () => {
      const t = comfyTemplate('odd-urls', {
        workflows: [
          workflow(
            'wf',
            comfyGraph(
              [],
              [
                loaderNode(
                  'LoraLoaderModelOnly',
                  resolveUrl(QWEN_EDIT, 'abc1234', RELIGHT),
                  'loras'
                ),
                loaderNode(
                  'VAELoader',
                  resolveUrl('Comfy-Org/Qwen--Image', 'main', VAE),
                  'vae'
                ),
                loaderNode(
                  'VAELoader',
                  resolveUrl('Comfy-Org/vae.git', 'main', VAE),
                  'vae'
                ),
                loaderNode(
                  'CLIPLoader',
                  resolveUrl(QWEN_IMAGE, 'main', TEXT_ENC),
                  'text_encoders'
                )
              ]
            )
          )
        ]
      })
      const { specs, problems } = deriveTemplateSpecs([t], true)
      expect(specs.map((s) => `${s.repo}@${s.revision}`)).to.deep.equal([
        `${QWEN_IMAGE}@main`
      ])
      expect(problems).to.have.length(3)
      expect(problems.join('\n')).to.include('/resolve/abc1234/')
      expect(problems.join('\n')).to.include('Comfy-Org/Qwen--Image')
      expect(problems.join('\n')).to.include('Comfy-Org/vae.git')
    })

    it('only scans workflow graphs, not descriptions, commands or includes[].url', () => {
      const url = resolveUrl(QWEN_IMAGE, 'main', VAE)
      const t = comfyTemplate('elsewhere', {
        description: `Downloads ${url}`,
        command: [`#!/bin/bash\ncurl -L ${url}\n`],
        includes: [{ name: 'VAE', kind: 'other', url }],
        workflows: [workflow('no-graph', undefined), workflow('empty', comfyGraph([]))]
      })
      expect(deriveTemplateSpecs([t], true)).to.deep.equal({ specs: [], problems: [] })
    })

    it('turns an includes[] model whose repo no URL of the template names into a full snapshot', () => {
      const { specs, problems } = deriveTemplateSpecs(
        [codingAgentGlm(), musicGenerator()],
        true
      )
      expect(problems).to.deep.equal([])
      const got = byKey(specs)
      expect(got[`${GLM}@main`]).to.deep.include({
        repo: GLM,
        revision: 'main',
        selection: { kind: 'all' },
        sources: ['template:coding-agent-glm53-flash']
      })
      expect(got[`${GEMMA}@main`]).to.deep.include({
        selection: { kind: 'all' },
        sources: ['template:music-generator-minimax-music3']
      })
      // MiniMax-Music-3 is URL-referenced: its files only, never the whole repo
      expect(filesOf(got[`${MUSIC3}@main`])).to.deep.equal(
        [
          'diffusion_models/minimax_music3_dit_fp16.safetensors',
          'vae/minimax_music3_dav.safetensors'
        ].sort()
      )
      expect(Object.keys(got)).to.have.length(3)
    })

    it('never adds a full snapshot for an includes[] repo that a URL of the template names', () => {
      const { specs } = deriveTemplateSpecs([productStudio(), ugcReelH3()], true)
      for (const s of specs) expect(s.selection.kind, s.repo).to.equal('files')
      // a URL at a pinned commit names the repo as well
      const pinnedOnly = comfyTemplate('pinned-only', {
        includes: [model('Relight LoRA', QWEN_EDIT)],
        workflows: [
          workflow(
            'wf',
            comfyGraph(
              [],
              [
                loaderNode(
                  'LoraLoaderModelOnly',
                  resolveUrl(QWEN_EDIT, SHA_1, RELIGHT),
                  'loras'
                )
              ]
            )
          )
        ]
      })
      expect(
        deriveTemplateSpecs([pinnedOnly], true).specs.map(
          (s) => `${s.repo}@${s.revision}`
        )
      ).to.deep.equal([`${QWEN_EDIT}@${SHA_1}`])
    })

    it('does not fall back to a full snapshot when the only URL naming the repo is unsupported', () => {
      // The template downloads ONE file of the repo (at a short commit the cache refuses as
      // ambiguous). The repo is still referenced by a URL of this template, so the design's
      // includes[] rule must not turn it into a whole-repo snapshot of main.
      const t = comfyTemplate('short-pin', {
        includes: [model('Qwen-Image-Edit 2509 Relight LoRA', QWEN_EDIT, 0.24)],
        workflows: [
          workflow(
            'wf',
            comfyGraph(
              [],
              [
                loaderNode(
                  'LoraLoaderModelOnly',
                  resolveUrl(QWEN_EDIT, '5d3b0a1', RELIGHT),
                  'loras'
                )
              ]
            )
          )
        ]
      })
      const { specs, problems } = deriveTemplateSpecs([t], true)
      expect(problems).to.have.length(1)
      expect(
        specs,
        'no spec for a repo the template only names by an unsupported URL'
      ).to.deep.equal([])
    })

    it('ignores includes[] items that are not models, and models without a repoId', () => {
      const t = comfyTemplate('extras', {
        includes: [
          {
            name: 'Workflow pack',
            kind: 'workflow',
            repoId: 'Comfy-Org/workflow_templates'
          },
          { name: 'KJNodes', kind: 'customnode', repoId: 'kijai/ComfyUI-KJNodes' },
          { name: 'Sample inputs', kind: 'other', repoId: 'Comfy-Org/sample-inputs' },
          {
            name: 'Upscaler from GitHub',
            kind: 'model',
            url: 'https://github.com/x/y/z.pth'
          },
          { name: 'Mystery model', kind: 'model' }
        ]
      })
      expect(deriveTemplateSpecs([t], true)).to.deep.equal({ specs: [], problems: [] })
    })

    it('skips an includes[] model with an invalid repo id with a problem', () => {
      const t = vllmTemplate('bad-include', {
        includes: [
          model('bad', 'not-a-repo-id'),
          model('worse', 'org/na--me'),
          model('ok', GLM)
        ]
      })
      const { specs, problems } = deriveTemplateSpecs([t], true)
      expect(specs.map((s) => `${s.repo}@${s.revision}`)).to.deep.equal([`${GLM}@main`])
      expect(problems).to.have.length(2)
      expect(problems[0]).to.match(
        /^template:bad-include: skipped invalid repo id "not-a-repo-id"/
      )
      expect(problems[1]).to.include('"org/na--me"')
    })

    it('merges repeated includes[] items and the same repo across templates', () => {
      // includes lists the same repo once per file, as the catalogue does
      const a = vllmTemplate('landing-studio', {
        order: 4,
        includes: [model('Qwen3.8 27B', QWEN38), model('Qwen3.8 27B tokenizer', QWEN38)]
      })
      const b = privateAssistant({ unlisted: false, order: 9 })
      const { specs } = deriveTemplateSpecs([b, a], true)
      expect(specs).to.have.length(1)
      expect(specs[0]).to.deep.equal({
        repo: QWEN38,
        revision: 'main',
        selection: { kind: 'all' },
        priority: 0,
        sources: ['template:landing-studio', 'template:private-assistant-qwen38-27b']
      })
    })

    it("lets a full snapshot from one template dominate another template's files", () => {
      // product studio (order 1) names files of Qwen-Image-Edit; another bundle (order 3)
      // only lists the repo in includes[]
      const whole = vllmTemplate('edit-everything', {
        order: 3,
        includes: [model('Qwen-Image-Edit (all of it)', QWEN_EDIT)]
      })
      const got = byKey(deriveTemplateSpecs([whole, productStudio()], true).specs)
      expect(got[`${QWEN_EDIT}@main`]).to.deep.equal({
        repo: QWEN_EDIT,
        revision: 'main',
        selection: { kind: 'all' },
        priority: 0,
        sources: ['template:product-studio-qwen-image', 'template:edit-everything']
      })
      expect(filesOf(got[`${QWEN_IMAGE}@main`])).to.deep.equal([TEXT_ENC, VAE].sort())
    })

    it('unions files of one repo across templates with the best priority', () => {
      const other = comfyTemplate('lora-lab', {
        order: 8,
        workflows: [
          workflow(
            'wf',
            comfyGraph(
              [],
              [
                loaderNode(
                  'LoraLoaderModelOnly',
                  resolveUrl(QWEN_EDIT, 'main', 'split_files/loras/extra.safetensors'),
                  'loras'
                ),
                loaderNode(
                  'UNETLoader',
                  resolveUrl(QWEN_EDIT, 'main', EDIT_UNET),
                  'diffusion_models'
                )
              ]
            )
          )
        ]
      })
      const got = byKey(deriveTemplateSpecs([other, productStudio()], true).specs)
      const edit = got[`${QWEN_EDIT}@main`]
      expect(filesOf(edit)).to.deep.equal(
        [
          EDIT_UNET,
          LIGHT_MIGRATION,
          RELIGHT,
          'split_files/loras/extra.safetensors'
        ].sort()
      )
      expect(edit.priority).to.equal(0)
      expect(edit.sources).to.deep.equal([
        'template:product-studio-qwen-image',
        'template:lora-lab'
      ])
    })

    it('ranks templates by catalogue order: order, listed before unlisted, then id', () => {
      const templates = [
        privateAssistant(), // unlisted, no order
        codingAgentGlm(), // listed, no order
        musicGenerator(), // order 5
        ugcReelH3(), // order 2
        productStudio() // order 1
      ]
      const got = byKey(deriveTemplateSpecs(templates, true).specs)
      expect(got[`${QWEN_IMAGE}@main`].priority).to.equal(0)
      expect(got[`${H3}@main`].priority).to.equal(1)
      expect(got[`${QWEN3_VL}@main`].priority).to.equal(1)
      expect(got[`${MUSIC3}@main`].priority).to.equal(2)
      expect(got[`${GEMMA}@main`].priority).to.equal(2)
      expect(got[`${GLM}@main`].priority).to.equal(3)
      expect(got[`${QWEN38}@main`].priority).to.equal(4)
    })

    it('returns specs in non-decreasing priority order regardless of input order', () => {
      const templates = [
        privateAssistant(),
        musicGenerator(),
        codingAgentGlm(),
        productStudio(),
        ugcReelH3()
      ]
      const { specs } = deriveTemplateSpecs(templates, true)
      const priorities = specs.map((s) => s.priority)
      expect(priorities).to.deep.equal([...priorities].sort((a, b) => a - b))
    })

    it('drops unlisted templates when includeUnlisted is false', () => {
      const templates = [privateAssistant(), codingAgentGlm(), productStudio()]
      const all = byKey(deriveTemplateSpecs(templates, true).specs)
      expect(all).to.have.property(`${QWEN38}@main`)
      expect(all[`${QWEN38}@main`].priority).to.be.greaterThan(
        all[`${GLM}@main`].priority
      )

      const listed = byKey(deriveTemplateSpecs(templates, false).specs)
      expect(listed).to.not.have.property(`${QWEN38}@main`)
      expect(listed).to.have.property(`${GLM}@main`)
      expect(listed).to.have.property(`${QWEN_IMAGE}@main`)
      // a repo that a listed template also needs stays, credited to the listed one only
      const shared = vllmTemplate('team-assistant', {
        includes: [model('Qwen3.8', QWEN38)]
      })
      const both = byKey(deriveTemplateSpecs([privateAssistant(), shared], false).specs)
      expect(both[`${QWEN38}@main`].sources).to.deep.equal(['template:team-assistant'])
    })

    it('does not mutate the templates it derives from', () => {
      const templates = deepFreeze([productStudio(), ugcReelH3(), codingAgentGlm()])
      expect(() => deriveTemplateSpecs(templates, true)).to.not.throw()
      expect(templates.map((t) => t.id)).to.deep.equal([
        'product-studio-qwen-image',
        'ugc-reel-minimax-h3',
        'coding-agent-glm53-flash'
      ])
    })
  })

  describe('mergeSelection', () => {
    const files = (...f: string[]): FileSelection => ({ kind: 'files', files: f })
    const patterns = (...p: string[]): FileSelection => ({
      kind: 'patterns',
      patterns: p
    })
    const all: FileSelection = { kind: 'all' }

    it("'all' dominates everything", () => {
      for (const other of [all, files('a.safetensors'), patterns('*.json')]) {
        expect(mergeSelection(all, other)).to.deep.equal({ kind: 'all' })
        expect(mergeSelection(other, all)).to.deep.equal({ kind: 'all' })
      }
    })

    it('unions files, keeping first-seen order without duplicates', () => {
      expect(
        mergeSelection(
          files('b.safetensors', 'a.safetensors'),
          files('a.safetensors', 'c.safetensors')
        )
      ).to.deep.equal(files('b.safetensors', 'a.safetensors', 'c.safetensors'))
    })

    it('unions patterns without duplicates', () => {
      expect(
        mergeSelection(
          patterns('*.json', 'tokenizer*'),
          patterns('*.json', '*.safetensors')
        )
      ).to.deep.equal(patterns('*.json', 'tokenizer*', '*.safetensors'))
    })

    it('turns files into escaped patterns when mixed with patterns, either way round', () => {
      expect(
        mergeSelection(files('vae/x.safetensors'), patterns('*.json'))
      ).to.deep.equal(patterns('vae/x.safetensors', '*.json'))
      expect(
        mergeSelection(patterns('*.json'), files('vae/x.safetensors'))
      ).to.deep.equal(patterns('*.json', 'vae/x.safetensors'))
    })

    it('escapes [ * ? in file names so they still select exactly that file', () => {
      const weird = [
        'loras/style[v2].safetensors',
        'loras/a*b.safetensors',
        'loras/q?.safetensors',
        'loras/x]y.safetensors'
      ]
      const merged = patternsOf(mergeSelection(files(...weird), patterns('*.json')))
      expect(merged).to.deep.equal([
        'loras/style[[]v2].safetensors',
        'loras/a[*]b.safetensors',
        'loras/q[?].safetensors',
        'loras/x]y.safetensors',
        '*.json'
      ])
      // each escaped name selects its literal file and nothing its glob reading would
      const repo = [
        ...weird,
        'loras/stylev.safetensors',
        'loras/style2.safetensors',
        'loras/aXYZb.safetensors',
        'loras/ab.safetensors',
        'loras/qx.safetensors',
        'loras/q.safetensors',
        'config.json',
        'other.safetensors'
      ]
      const selected = repo.filter((f) => matchesAllowPatterns(f, merged))
      expect(selected.sort()).to.deep.equal([...weird, 'config.json'].sort())
    })

    it('dedupes an escaped file against an identical existing pattern', () => {
      expect(
        mergeSelection(patterns('m[[]1].safetensors'), files('m[1].safetensors'))
      ).to.deep.equal(patterns('m[[]1].safetensors'))
    })

    it('does not mutate its inputs', () => {
      const a = deepFreeze(files('a.safetensors'))
      const b = deepFreeze(patterns('*.json'))
      const c = deepFreeze(files('c.safetensors'))
      expect(() => mergeSelection(a, b)).to.not.throw()
      expect(() => mergeSelection(a, c)).to.not.throw()
      expect(() => mergeSelection(b, b)).to.not.throw()
    })
  })

  describe('applyCurated', () => {
    const templateSpecs = (): ModelSpec[] => [
      spec(QWEN_EDIT, 'main', { kind: 'files', files: [EDIT_UNET] }, 0, 'template:a'),
      spec(QWEN_EDIT, SHA_1, { kind: 'files', files: [RELIGHT] }, 0, 'template:a'),
      spec(
        LIGHTNING,
        'main',
        { kind: 'files', files: [LIGHTNING_LORA] },
        0,
        'template:a'
      ),
      spec(GEMMA, 'main', { kind: 'all' }, 1, 'template:b'),
      spec(GLM, 'main', { kind: 'all' }, 2, 'template:c')
    ]

    it('returns the template specs untouched when nothing is curated', () => {
      const input = templateSpecs()
      const { specs, problems } = applyCurated(input, [])
      expect(problems).to.deep.equal([])
      expect(specs).to.deep.equal(templateSpecs())
    })

    it('replaces every derived spec of a curated repo, all revisions included', () => {
      const { specs, problems } = applyCurated(templateSpecs(), [
        { repo: QWEN_EDIT, revision: 'v2', allowPatterns: ['split_files/loras/*'] }
      ])
      expect(problems).to.deep.equal([])
      expect(specs.map((s) => `${s.repo}@${s.revision}`)).to.deep.equal([
        `${LIGHTNING}@main`,
        `${GEMMA}@main`,
        `${GLM}@main`,
        `${QWEN_EDIT}@v2`
      ])
      expect(specs[3]).to.deep.include({
        selection: { kind: 'patterns', patterns: ['split_files/loras/*'] },
        sources: ['curated']
      })
    })

    it("narrows a template's full snapshot (gemma's allowPatterns) with revision 'main' by default", () => {
      const { specs } = applyCurated(templateSpecs(), [
        { repo: GEMMA, allowPatterns: ['*.json', '*.safetensors', 'tokenizer*'] }
      ])
      const gemma = specs.filter((s) => s.repo === GEMMA)
      expect(gemma).to.have.length(1)
      expect(gemma[0].revision).to.equal('main')
      expect(gemma[0].selection).to.deep.equal({
        kind: 'patterns',
        patterns: ['*.json', '*.safetensors', 'tokenizer*']
      })
      expect(gemma[0].sources).to.deep.equal(['curated'])
      expect(gemma[0]).to.not.have.property('commit')
    })

    it("adds a whole-repo spec for a repo no template uses, 'all' when no selection is given", () => {
      const { specs } = applyCurated(templateSpecs(), [{ repo: QWEN38 }])
      const added = specs.find((s) => s.repo === QWEN38)
      expect(added).to.deep.include({
        repo: QWEN38,
        revision: 'main',
        selection: { kind: 'all' },
        sources: ['curated']
      })
      expect(specs).to.have.length(6)
    })

    it('dedupes files and patterns inside one entry', () => {
      const { specs } = applyCurated(
        [],
        [
          { repo: QWEN_EDIT, files: [RELIGHT, RELIGHT, EDIT_UNET] },
          { repo: GEMMA, allowPatterns: ['*.json', '*.json'] }
        ]
      )
      expect(specs[0].selection).to.deep.equal({
        kind: 'files',
        files: [RELIGHT, EDIT_UNET]
      })
      expect(specs[1].selection).to.deep.equal({ kind: 'patterns', patterns: ['*.json'] })
    })

    it('publishes a commit pin under its ref name', () => {
      const { specs, problems } = applyCurated(
        [],
        [
          { repo: GLM, commit: SHA_1 },
          { repo: QWEN38, revision: 'fp8-v2', commit: SHA_2, files: ['config.json'] }
        ]
      )
      expect(problems).to.deep.equal([])
      expect(specs[0]).to.deep.include({ repo: GLM, revision: 'main', commit: SHA_1 })
      expect(specs[1]).to.deep.include({
        repo: QWEN38,
        revision: 'fp8-v2',
        commit: SHA_2,
        selection: { kind: 'files', files: ['config.json'] }
      })
    })

    it('keeps the first of two different pins for one repo@revision and reports the second', () => {
      const { specs, problems } = applyCurated(
        [],
        [
          { repo: GLM, commit: SHA_1, files: ['a.safetensors'] },
          { repo: GLM, commit: SHA_2, files: ['b.safetensors'], priority: -10 }
        ]
      )
      expect(specs).to.have.length(1)
      expect(specs[0]).to.deep.include({
        repo: GLM,
        revision: 'main',
        commit: SHA_1,
        selection: { kind: 'files', files: ['a.safetensors'] }
      })
      expect(
        specs[0].priority,
        'the dropped entry does not lend its priority'
      ).to.not.equal(-10)
      expect(problems).to.have.length(1)
      expect(problems[0]).to.match(/^curated\[1\]: /)
      expect(problems[0]).to.include(`${GLM}@main`)
    })

    it('treats a pinned and an unpinned entry for one repo@revision as a conflict too', () => {
      const { specs, problems } = applyCurated(
        [],
        [
          { repo: GLM, files: ['a.safetensors'] },
          { repo: GLM, commit: SHA_1, files: ['b.safetensors'] }
        ]
      )
      expect(specs).to.have.length(1)
      expect(specs[0]).to.not.have.property('commit')
      expect(specs[0].selection).to.deep.equal({
        kind: 'files',
        files: ['a.safetensors']
      })
      expect(problems).to.have.length(1)
      expect(problems[0]).to.match(/^curated\[1\]: /)
    })

    it('merges entries for one repo@revision with the same pin, and keeps revisions apart', () => {
      const { specs, problems } = applyCurated(
        [],
        [
          { repo: GLM, commit: SHA_1, files: ['a.safetensors'] },
          { repo: GLM, revision: 'v1', commit: SHA_2 },
          { repo: GLM, commit: SHA_1, allowPatterns: ['*.json'], priority: 7 },
          { repo: QWEN_EDIT, files: ['loras/style[v2].safetensors'] },
          { repo: QWEN_EDIT, allowPatterns: ['*.json'] }
        ]
      )
      expect(problems).to.deep.equal([])
      const got = byKey(specs)
      expect(Object.keys(got).sort()).to.deep.equal(
        [`${GLM}@main`, `${GLM}@v1`, `${QWEN_EDIT}@main`].sort()
      )
      expect(got[`${GLM}@main`]).to.deep.include({
        commit: SHA_1,
        selection: { kind: 'patterns', patterns: ['a.safetensors', '*.json'] },
        priority: 7,
        sources: ['curated']
      })
      expect(got[`${GLM}@v1`]).to.deep.include({
        commit: SHA_2,
        selection: { kind: 'all' }
      })
      expect(got[`${QWEN_EDIT}@main`].selection).to.deep.equal({
        kind: 'patterns',
        patterns: ['loras/style[[]v2].safetensors', '*.json']
      })
    })

    it('uses an explicit priority as is and puts entries without one after every template, in list order', () => {
      const { specs } = applyCurated(templateSpecs(), [
        { repo: 'org/curated-late-a' },
        { repo: 'org/curated-early', priority: 1 },
        { repo: 'org/curated-late-b' },
        { repo: 'org/curated-first', priority: -5 }
      ])
      const p = (repo: string) => specs.find((s) => s.repo === repo).priority
      expect(p('org/curated-early')).to.equal(1)
      expect(p('org/curated-first')).to.equal(-5)
      const maxTemplate = Math.max(...templateSpecs().map((s) => s.priority))
      expect(p('org/curated-late-a')).to.be.greaterThan(maxTemplate)
      expect(p('org/curated-late-b')).to.be.greaterThan(p('org/curated-late-a'))
      expect(specs.map((s) => `${s.repo}@${s.revision}`)).to.deep.equal([
        'org/curated-first@main',
        `${QWEN_EDIT}@main`,
        `${QWEN_EDIT}@${SHA_1}`,
        `${LIGHTNING}@main`,
        // ties keep the template spec first: the sort is stable
        `${GEMMA}@main`,
        'org/curated-early@main',
        `${GLM}@main`,
        'org/curated-late-a@main',
        'org/curated-late-b@main'
      ])
    })

    it('sorts the final list by priority, stable for ties', () => {
      const unsorted = [
        spec('org/t2', 'main', { kind: 'all' }, 2),
        spec('org/t0a', 'main', { kind: 'all' }, 0),
        spec('org/t1', 'main', { kind: 'all' }, 1),
        spec('org/t0b', 'main', { kind: 'all' }, 0)
      ]
      const { specs } = applyCurated(unsorted, [
        { repo: 'org/c1', priority: 1 },
        { repo: 'org/c0', priority: 0 },
        { repo: 'org/c1b', priority: 1 }
      ])
      expect(specs.map((s) => s.repo)).to.deep.equal([
        'org/t0a',
        'org/t0b',
        'org/c0',
        'org/t1',
        'org/c1',
        'org/c1b',
        'org/t2'
      ])
    })

    it('skips invalid entries with a problem each and leaves the template specs of their repo alone', () => {
      const curated: ServiceModelCacheCuratedEntry[] = [
        { repo: 'not-a-repo-id' },
        { repo: 'Comfy-Org/Qwen--Image' },
        { repo: QWEN_EDIT, revision: 'refs/pr/1' },
        { repo: QWEN_EDIT, revision: 'abc1234' },
        { repo: QWEN_EDIT, revision: SHA_1 },
        { repo: QWEN_EDIT, commit: SHA_1.toUpperCase() },
        { repo: QWEN_EDIT, commit: 'abc1234' },
        { repo: QWEN_EDIT, files: ['../escape.safetensors'] },
        { repo: QWEN_EDIT, files: [RELIGHT, '/abs.safetensors'] },
        { repo: QWEN_EDIT, files: ['split_files//x.safetensors'] },
        { repo: QWEN_EDIT, files: ['split_files\\x.safetensors'] },
        { repo: QWEN_EDIT, revision: '' }
      ]
      const { specs, problems } = applyCurated(templateSpecs(), curated)
      expect(specs).to.deep.equal(templateSpecs())
      expect(problems).to.have.length(curated.length)
      problems.forEach((p, i) =>
        expect(p).to.match(new RegExp(`^curated\\[${i}\\]: .*skipped`))
      )
    })

    it('does not mutate the template specs or the curated config', () => {
      const tmpl = deepFreeze(templateSpecs())
      const curated = deepFreeze<ServiceModelCacheCuratedEntry[]>([
        { repo: GEMMA, allowPatterns: ['*.json'] },
        { repo: GEMMA, files: ['model-00001-of-00002.safetensors'] },
        { repo: GLM, commit: SHA_1, files: ['a.safetensors'] },
        { repo: GLM, commit: SHA_1, files: ['b.safetensors'] }
      ])
      let result = { specs: [] as ModelSpec[], problems: [] as string[] }
      expect(() => {
        result = applyCurated(tmpl, curated)
      }).to.not.throw()
      expect(result.problems).to.deep.equal([])
      expect(byKey(result.specs)[`${GLM}@main`].selection).to.deep.equal({
        kind: 'files',
        files: ['a.safetensors', 'b.safetensors']
      })
      expect(curated[0].allowPatterns).to.deep.equal(['*.json'])
    })
  })
})
