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
  }
}
