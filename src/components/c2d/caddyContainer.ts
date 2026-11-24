import type Dockerode from 'dockerode'
import { PassThrough } from 'stream'

export const CADDY_IMAGE = 'caddy:2.11.9-alpine'
export const CADDY_CONTAINER = 'ocean-node-caddy'
export const CADDY_LE_STORE = '/letsencrypt/acme.json'
export const CADDY_CERT_DIR = '/data/ocean'
const CADDY_DATA_VOLUME = 'ocean-node-caddy-data'
// Docker may rewrite bind paths in inspect output, so the wanted file is kept in a label
const CADDY_ACME_LABEL = 'ocean-node.letsencrypt-store'
const CADDY_EXEC_TIMEOUT_MS = 10_000
// Admin API on the host's loopback (Caddy's default): service containers cannot reach it
export const CADDY_LOAD_CMD = [
  'wget',
  '-qO-',
  '--header',
  'Content-Type: application/json',
  '--post-file=/dev/stdin',
  'http://127.0.0.1:2019/load'
]

async function pullIfMissing(docker: Dockerode, image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect()
    return
  } catch (e) {
    if (e?.statusCode !== 404) throw e
  }
  const stream = await docker.pull(image)
  await new Promise((resolve, reject) =>
    docker.modem.followProgress(stream, (err: Error) =>
      err ? reject(err) : resolve(null)
    )
  )
}

// Host network: Caddy listens on the services' random host ports
export async function ensureCaddy(
  docker: Dockerode,
  letsEncryptAcmePath?: string
): Promise<Dockerode.Container> {
  const binds = [`${CADDY_DATA_VOLUME}:/data`]
  if (letsEncryptAcmePath) binds.push(`${letsEncryptAcmePath}:${CADDY_LE_STORE}:ro`)
  const container = docker.getContainer(CADDY_CONTAINER)
  let info: Dockerode.ContainerInspectInfo | null = null
  try {
    info = await container.inspect()
  } catch (e) {
    if (e?.statusCode !== 404) throw e
  }
  if (
    info?.Config?.Image === CADDY_IMAGE &&
    info.Config.Labels?.[CADDY_ACME_LABEL] === (letsEncryptAcmePath ?? '')
  ) {
    if (!info.State?.Running) await container.start()
    return container
  }
  if (info) await container.remove({ force: true })
  await pullIfMissing(docker, CADDY_IMAGE)
  const created = await docker.createContainer({
    name: CADDY_CONTAINER,
    Image: CADDY_IMAGE,
    Cmd: ['caddy', 'run'],
    Labels: { [CADDY_ACME_LABEL]: letsEncryptAcmePath ?? '' },
    HostConfig: { NetworkMode: 'host', RestartPolicy: { Name: 'always' }, Binds: binds }
  })
  await created.start()
  return created
}

// `input` goes on stdin and is never put in an error (it can hold a private key)
export async function caddyExec(
  container: Dockerode.Container,
  Cmd: string[],
  input = ''
): Promise<string> {
  const exec = await container.exec({
    Cmd,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true
  })
  const stream = await exec.start({ hijack: true, stdin: true })
  const out = new PassThrough()
  const chunks: Buffer[] = []
  out.on('data', (c: Buffer) => chunks.push(c))
  container.modem.demuxStream(stream, out, out)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      stream.destroy()
      reject(new Error(`caddy exec ${Cmd[0]}: timed out`))
    }, CADDY_EXEC_TIMEOUT_MS)
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    stream.on('end', done)
    stream.on('close', done)
    stream.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    stream.end(input)
  })
  const output = Buffer.concat(chunks).toString()
  const { ExitCode } = await exec.inspect()
  if (ExitCode !== 0)
    throw new Error(
      `caddy exec ${Cmd[0]} exited ${ExitCode}: ${output.trim().slice(0, 200)}`
    )
  return output
}
