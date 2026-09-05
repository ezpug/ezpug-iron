// Three known sound-registry violations: a second audio element, a second
// audio context, and an mp3 pulled in at a call site. All three bypass the mute,
// the volume and the user-gesture unlock the one registry exists to hold.

import cue from './match-found.mp3'

export function announce(): void {
  const element = new Audio(cue)
  void element.play()

  const context = new AudioContext()
  void context.resume()
}
