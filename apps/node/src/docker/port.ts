/**
 * **The corner of docker the node needs**, as a port (PRD-02 T11): pull an
 * image and read its digest, create/start/stop/remove a container, list and
 * inspect the ones that carry our labels. `dockerode.ts` is the adapter over
 * the daemon's socket; `fake.ts` is the one every instance-manager test
 * runs on, scriptable down to "the container exited 137" and "the container
 * is simply gone".
 *
 * Everything here is idempotent where docker is not: stopping a stopped
 * container and removing a removed one are both nothing, because the
 * orchestrator's `stop` is idempotent by contract and the node reconciles
 * against a daemon somebody may have poked by hand.
 */

/** Docker's own container states (`State.Status`). */
export type ContainerStatus =
  | 'created'
  | 'running'
  | 'paused'
  | 'restarting'
  | 'removing'
  | 'exited'
  | 'dead'

export interface ContainerInfo {
  readonly id: string
  readonly name: string
  readonly image: string
  readonly labels: Readonly<Record<string, string>>
  readonly status: ContainerStatus
  /** For `exited` and `dead`. */
  readonly exitCode?: number
  /** What docker recorded when the container failed to start or died. */
  readonly error?: string
}

/** What the node asks docker to run. Host networking always (`compose.cs2.yaml` says why). */
export interface ContainerSpec {
  readonly name: string
  readonly image: string
  readonly env: Readonly<Record<string, string>>
  readonly labels: Readonly<Record<string, string>>
  /** `volume-or-path:/container/path[:ro]`, docker's own syntax. */
  readonly binds: readonly string[]
  /** A tty, so `docker attach` is a real server console. */
  readonly tty: boolean
  /** Seconds between SIGTERM and SIGKILL on `stop`. */
  readonly stopTimeoutSeconds: number
}

export class DockerError extends Error {
  override readonly name = 'DockerError'
  constructor(
    message: string,
    /** Docker's HTTP status where there was one (404 for "no such container"). */
    readonly statusCode?: number,
  ) {
    super(message)
  }
}

export interface DockerPort {
  /** Is the daemon there. Throws with the socket path in the message when not. */
  ping: () => Promise<void>
  /**
   * The digest of an image on this host — the registry's `RepoDigest` for a
   * pulled image, the image id (also `sha256:…`) for a local build that was
   * never pushed — or null when the image is not here.
   */
  imageDigest: (reference: string) => Promise<string | null>
  pullImage: (reference: string) => Promise<void>
  /** Every container (running or not) carrying all of `labels`. */
  listContainers: (labels: Readonly<Record<string, string>>) => Promise<ContainerInfo[]>
  /** Create without starting; resolves with docker's id. */
  createContainer: (spec: ContainerSpec) => Promise<string>
  startContainer: (id: string) => Promise<void>
  /** Idempotent: a container that is already stopped or gone is nothing. */
  stopContainer: (id: string, timeoutSeconds: number) => Promise<void>
  /** Forced and idempotent. */
  removeContainer: (id: string) => Promise<void>
  /** Null when docker no longer knows the id. */
  inspectContainer: (id: string) => Promise<ContainerInfo | null>
}
