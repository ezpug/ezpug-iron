import type { ContainerInfo, ContainerSpec, ContainerStatus, DockerPort } from './port'
import { DockerError } from './port'

/**
 * **A docker daemon in memory** — what every instance-manager and agent
 * test runs on. It honours the port's contract (idempotent stop and remove,
 * a 404 for an unknown id, a pull that needs the image to exist somewhere)
 * and lets a test script the things a real daemon does behind the node's
 * back: a container exits, a container vanishes, the next call fails.
 */

export interface FakeContainer extends ContainerInfo {
  readonly spec: ContainerSpec
}

/** The verbs a test can make fail once, by name. */
export type DockerVerb =
  | 'ping'
  | 'imageDigest'
  | 'pullImage'
  | 'listContainers'
  | 'createContainer'
  | 'startContainer'
  | 'stopContainer'
  | 'removeContainer'
  | 'inspectContainer'

export interface FakeDocker extends DockerPort {
  /** Images on this host: reference → digest. `addImage` puts one here. */
  readonly images: Map<string, string>
  /** Images a pull can fetch (the registry): reference → digest. */
  readonly registry: Map<string, string>
  /** Every container docker knows, by id, running or not. */
  readonly containers: Map<string, FakeContainer>
  /** Every verb called, in order, with the id or reference it was given. */
  readonly calls: string[]
  addImage: (reference: string, digest?: string) => void
  /** Make the next call of `verb` throw `message`. */
  failNext: (verb: DockerVerb, message: string, statusCode?: number) => void
  /** The container's process exited with `code` — a crash, or a clean leave. */
  exit: (id: string, code: number) => void
  /** The container is gone: somebody ran `docker rm -f`, or the host lost it. */
  vanish: (id: string) => void
  /** The one container with this name, or undefined. */
  byName: (name: string) => FakeContainer | undefined
}

const DIGEST_HEX = '0123456789abcdef'.repeat(4)

export function digestFor(reference: string): string {
  // Stable per reference and obviously synthetic: the reference's bytes over
  // a fixed pattern, so a test can predict it without a hash function.
  const hex = Array.from(reference, character => (character.charCodeAt(0) % 16).toString(16))
    .join('')
    .padEnd(64, DIGEST_HEX)
    .slice(0, 64)
  return `sha256:${hex}`
}

export function createFakeDocker(): FakeDocker {
  const images = new Map<string, string>()
  const registry = new Map<string, string>()
  const containers = new Map<string, FakeContainer>()
  const calls: string[] = []
  const failures = new Map<DockerVerb, { message: string; statusCode?: number }>()
  let nextId = 1

  const check = (verb: DockerVerb, subject = ''): void => {
    calls.push(subject ? `${verb} ${subject}` : verb)
    const failure = failures.get(verb)
    if (failure) {
      failures.delete(verb)
      throw new DockerError(failure.message, failure.statusCode)
    }
  }

  const update = (id: string, patch: Partial<ContainerInfo>): void => {
    const current = containers.get(id)
    if (current) containers.set(id, { ...current, ...patch })
  }

  const fake: FakeDocker = {
    images,
    registry,
    containers,
    calls,
    addImage: (reference, digest = digestFor(reference)) => void images.set(reference, digest),
    failNext: (verb, message, statusCode) => void failures.set(verb, { message, statusCode }),
    exit: (id, code) => {
      const status: ContainerStatus = 'exited'
      update(id, { status, exitCode: code })
    },
    vanish: id => void containers.delete(id),
    byName: name => [...containers.values()].find(container => container.name === name),

    ping: () => {
      check('ping')
      return Promise.resolve()
    },
    imageDigest: reference => {
      check('imageDigest', reference)
      return Promise.resolve(images.get(reference) ?? null)
    },
    pullImage: reference => {
      check('pullImage', reference)
      const digest = registry.get(reference)
      if (digest === undefined)
        return Promise.reject(
          new DockerError(`pull access denied for ${reference}: not found`, 404),
        )
      images.set(reference, digest)
      return Promise.resolve()
    },
    listContainers: labels => {
      check('listContainers')
      const wanted = Object.entries(labels)
      return Promise.resolve(
        [...containers.values()].filter(container =>
          wanted.every(([key, value]) => container.labels[key] === value),
        ),
      )
    },
    createContainer: spec => {
      check('createContainer', spec.name)
      if (fake.byName(spec.name))
        return Promise.reject(
          new DockerError(`Conflict. The container name "/${spec.name}" is already in use`, 409),
        )
      if (!images.has(spec.image))
        return Promise.reject(new DockerError(`No such image: ${spec.image}`, 404))
      const id = `${(nextId++).toString(16).padStart(12, '0')}`
      containers.set(id, {
        id,
        name: spec.name,
        image: spec.image,
        labels: { ...spec.labels },
        status: 'created',
        spec,
      })
      return Promise.resolve(id)
    },
    startContainer: id => {
      check('startContainer', id)
      const container = containers.get(id)
      if (!container) return Promise.reject(new DockerError(`No such container: ${id}`, 404))
      update(id, { status: 'running', exitCode: undefined })
      return Promise.resolve()
    },
    stopContainer: (id, timeoutSeconds) => {
      check('stopContainer', `${id} t=${timeoutSeconds}`)
      const container = containers.get(id)
      if (container && container.status === 'running') update(id, { status: 'exited', exitCode: 0 })
      return Promise.resolve()
    },
    removeContainer: id => {
      check('removeContainer', id)
      containers.delete(id)
      return Promise.resolve()
    },
    inspectContainer: id => {
      check('inspectContainer', id)
      return Promise.resolve(containers.get(id) ?? null)
    },
  }
  return fake
}
