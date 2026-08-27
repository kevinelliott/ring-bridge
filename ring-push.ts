/**
 * Control over Ring's push notification registration.
 *
 * `ring-client-api` registers a Firebase push receiver as a side effect of
 * `getLocations()`, using the Ring *Android app's* Firebase credentials, and
 * then PATCHes the account's device record with the new token. That is how the
 * library delivers live doorbell and motion events.
 *
 * The cost is not obvious: Ring limits how many devices may be registered for
 * push on an account, and registering another one can push an existing
 * registration out. In practice that can mean the phone app and the chime stop
 * announcing events while the bridge runs -- a much worse trade than the
 * feature is worth, since a doorbell you cannot hear is the whole point of
 * owning one.
 *
 * Streaming does not need any of this. Video, audio, and reconnects all work
 * with push registration suppressed; only live event delivery is affected, and
 * that falls back to polling Ring's event history.
 */
import type { RingApi } from 'ring-client-api'

type PushCapable = {
  registerPushReceiver: (...args: unknown[]) => Promise<void>
}

/**
 * Prevent this process from registering for push notifications.
 *
 * Must be called before the first `getLocations()`, which is what triggers
 * registration. Returns a function that restores the original behaviour, for
 * tests.
 */
export function suppressPushRegistration(api: RingApi): () => void {
  const proto = Object.getPrototypeOf(api) as PushCapable
  const original = proto.registerPushReceiver

  // Patching the prototype rather than the instance because the library calls
  // it internally through `this`, and an own-property override on one instance
  // would be missed by any other RingApi this process creates.
  proto.registerPushReceiver = async function noop(): Promise<void> {
    return undefined
  }

  return () => {
    proto.registerPushReceiver = original
  }
}
