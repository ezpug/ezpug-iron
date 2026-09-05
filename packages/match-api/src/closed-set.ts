import type { z } from 'zod'

/**
 * **Every enum this package publishes is a closed set, checked at load time.**
 * The platform's gameserver union pins the pattern (its self-check block at the
 * bottom of `vocabulary/gameserver.ts`): a discriminated union's option literals
 * and the published list of names must be the same set, in the same order, so a
 * consumer that switches over the list is exhaustive over the union and a C#
 * generator that reads the list reads the whole union. A disagreement throws
 * the moment the module is imported — in every test run, never in production.
 */
export function assertClosedSet(
  name: string,
  union: { options: readonly z.ZodObject[] },
  discriminator: string,
  published: readonly string[],
): void {
  const optionValues = union.options.map(option => {
    const field = option.shape[discriminator]
    const value = (field as { value?: unknown } | undefined)?.value
    if (typeof value !== 'string')
      throw new Error(`${name}: every option needs a literal \`${discriminator}\``)
    return value
  })
  const publishedSet = new Set(published)
  if (publishedSet.size !== published.length)
    throw new Error(`${name}: the published list repeats a name`)
  if (
    optionValues.length !== published.length ||
    !optionValues.every((value, index) => published[index] === value)
  ) {
    throw new Error(
      `${name}: the published list and the union options disagree — ` +
        'the set is closed, update both together, in the same order',
    )
  }
}
