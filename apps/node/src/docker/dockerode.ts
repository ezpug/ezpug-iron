import Docker from 'dockerode'
import type { ContainerInfo, ContainerStatus, DockerPort } from './port'
import { DockerError } from './port'

/**
 * **The docker daemon, through dockerode** — the one adapter of
 * {@link DockerPort} that touches a real socket. Thin on purpose: every
 * rule (idempotent stop and remove, digest fallback for a local build) is
 * stated here once and proven against the real daemon by
 * `dockerode.test.ts` when this box has one, so the fake and the daemon
 * cannot drift apart unnoticed.
 */

export interface DockerodeOptions {
  /** The daemon's unix socket (`EZPUG_NODE_DOCKER_SOCKET`). */
  socketPath: string
}

/** The json log cap of every container this node creates. */
export const CONTAINER_LOG = {
  Type: 'json-file',
  Config: { 'max-size': '10m', 'max-file': '3' },
} as const

interface DockerodeFailure {
  statusCode?: number
  message?: string
  reason?: string
}

function toDockerError(error: unknown, what: string): DockerError {
  const failure = error as DockerodeFailure
  const detail = failure.reason ?? failure.message ?? String(error)
  return new DockerError(`${what}: ${detail}`, failure.statusCode)
}

function statusOf(state: string | undefined): ContainerStatus {
  switch (state) {
    case 'created':
    case 'running':
    case 'paused':
    case 'restarting':
    case 'removing':
    case 'exited':
    case 'dead':
      return state
    default:
      return 'dead'
  }
}

/**
 * The first regular file in a tar archive, as text — what docker's archive
 * endpoint answers for one file. Plain ustar: a 512-byte header (the size in
 * octal at 124), the content padded to 512; pax and GNU long-name headers
 * (`x`, `g`, `L`) are skipped like any entry that is not a file.
 */
export function firstFileInTar(archive: Buffer): string | null {
  let offset = 0
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) return null
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').trim() || '0', 8)
    const type = String.fromCharCode(header[156] ?? 0)
    const start = offset + 512
    if (type === '0' || type === '\0') return archive.subarray(start, start + size).toString('utf8')
    offset = start + Math.ceil(size / 512) * 512
  }
  return null
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks)
}

export function createDockerodeDocker(options: DockerodeOptions): DockerPort {
  const docker = new Docker({ socketPath: options.socketPath })

  const inspect = async (id: string): Promise<ContainerInfo | null> => {
    try {
      const info = await docker.getContainer(id).inspect()
      return {
        id: info.Id,
        name: info.Name.replace(/^\//, ''),
        image: info.Config.Image,
        labels: info.Config.Labels ?? {},
        status: statusOf(info.State.Status),
        ...(info.State.Status === 'exited' || info.State.Status === 'dead'
          ? { exitCode: info.State.ExitCode }
          : {}),
        ...(info.State.Error ? { error: info.State.Error } : {}),
      }
    } catch (error) {
      if ((error as DockerodeFailure).statusCode === 404) return null
      throw toDockerError(error, `inspect ${id}`)
    }
  }

  return {
    async ping() {
      try {
        await docker.ping()
      } catch (error) {
        throw toDockerError(error, `docker is not reachable at ${options.socketPath}`)
      }
    },

    async imageDigest(reference) {
      try {
        const info = await docker.getImage(reference).inspect()
        // A pulled image knows the registry's digest; a local build never
        // pushed knows only its own id, which is a sha256 too and just as
        // good an answer to "which build is this".
        return info.RepoDigests?.[0]?.split('@')[1] ?? info.Id
      } catch (error) {
        if ((error as DockerodeFailure).statusCode === 404) return null
        throw toDockerError(error, `inspect image ${reference}`)
      }
    },

    async pullImage(reference) {
      let stream: NodeJS.ReadableStream
      try {
        stream = await docker.pull(reference)
      } catch (error) {
        throw toDockerError(error, `pull ${reference}`)
      }
      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(stream, (error: Error | null) => {
          if (error) reject(toDockerError(error, `pull ${reference}`))
          else resolve()
        })
      })
    },

    async listContainers(labels) {
      try {
        const list = await docker.listContainers({
          all: true,
          filters: { label: Object.entries(labels).map(([key, value]) => `${key}=${value}`) },
        })
        return list.map(entry => ({
          id: entry.Id,
          name: entry.Names[0]?.replace(/^\//, '') ?? entry.Id,
          image: entry.Image,
          labels: entry.Labels ?? {},
          status: statusOf(entry.State),
          // The list endpoint carries the exit code only as prose
          // ("Exited (137) 3 seconds ago"); the number is read out of it.
          ...(entry.State === 'exited' || entry.State === 'dead'
            ? { exitCode: Number(entry.Status.match(/\((-?\d+)\)/)?.[1] ?? Number.NaN) }
            : {}),
        }))
      } catch (error) {
        throw toDockerError(error, 'list containers')
      }
    },

    async createContainer(spec) {
      try {
        const container = await docker.createContainer({
          name: spec.name,
          Image: spec.image,
          Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
          Labels: { ...spec.labels },
          Tty: spec.tty,
          OpenStdin: spec.tty,
          StopTimeout: spec.stopTimeoutSeconds,
          HostConfig: {
            NetworkMode: 'host',
            Binds: [...spec.binds],
            // The node is the supervisor: a server that exits is reported,
            // never silently restarted with a token the orchestrator has
            // already given up on.
            RestartPolicy: { Name: 'no' },
            // A game server's console is chatty and the daemon's default log
            // is uncapped: the same 3 × 10 MB every compose service in this
            // repo is held to (PRD-03 T15a), said per container because the
            // daemon's config is every project's on a shared box.
            LogConfig: CONTAINER_LOG,
          },
        })
        return container.id
      } catch (error) {
        throw toDockerError(error, `create ${spec.name}`)
      }
    },

    async startContainer(id) {
      try {
        await docker.getContainer(id).start()
      } catch (error) {
        // 304: already running. Starting what runs is nothing.
        if ((error as DockerodeFailure).statusCode === 304) return
        throw toDockerError(error, `start ${id}`)
      }
    },

    async stopContainer(id, timeoutSeconds) {
      try {
        await docker.getContainer(id).stop({ t: timeoutSeconds })
      } catch (error) {
        const code = (error as DockerodeFailure).statusCode
        // 304: already stopped; 404: already gone. Both are the outcome asked for.
        if (code === 304 || code === 404) return
        throw toDockerError(error, `stop ${id}`)
      }
    },

    async removeContainer(id) {
      try {
        await docker.getContainer(id).remove({ force: true, v: true })
      } catch (error) {
        if ((error as DockerodeFailure).statusCode === 404) return
        throw toDockerError(error, `remove ${id}`)
      }
    },

    inspectContainer: inspect,

    async readFiles(image, binds, paths) {
      let container: Docker.Container
      try {
        // Never started: docker mounts the volumes for an archive read of a
        // created container, so nothing boots and nothing listens.
        container = await docker.createContainer({
          Image: image,
          Entrypoint: ['true'],
          Cmd: [],
          HostConfig: { NetworkMode: 'none', Binds: [...binds], AutoRemove: false },
        })
      } catch (error) {
        throw toDockerError(error, `create a container to read ${image}`)
      }
      try {
        const read: Record<string, string | null> = {}
        for (const path of paths) {
          try {
            read[path] = firstFileInTar(await collect(await container.getArchive({ path })))
          } catch (error) {
            if ((error as DockerodeFailure).statusCode === 404) read[path] = null
            else throw toDockerError(error, `read ${path} out of ${image}`)
          }
        }
        return read
      } finally {
        await container.remove({ force: true, v: false }).catch(() => undefined)
      }
    },
  }
}
