/**
 * Control over Ring's push notification registration.
 *
 * `ring-client-api` registers a Firebase push receiver as a side effect of
 * `getLocations()`, using the Ring *Android app's* Firebase credentials, and
 * then PATCHes the account's device record with the new token. That is how the
 * library delivers live doorbell and motion events.
 *
 * The cost is that this occupies one of a limited number of push registrations
 * on the account. Ring caps how many devices may be registered, so taking a
 * slot on a full account evicts something else -- and that something can be the
 * phone app or the chime. A doorbell you cannot hear is a bad trade for events
 * arriving instantly rather than within a minute.
 *
 * It is one slot, not a growing list. The FCM credentials are stored in the
 * refresh token as `pnc` and the device record is keyed by the token's stable
 * hardware id, so repeated calls reuse the same registration rather than
 * creating new ones -- provided the rotated token is persisted, which
 * ring-auth does.
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
