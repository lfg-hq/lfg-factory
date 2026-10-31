/**
 * Signing in to LFG Desktop through the person's own browser (OAuth for native apps,
 * RFC 8252): the app opens /desktop/authorize in the browser, where the person is
 * signed in however their company signs in (Google, SSO, password). They confirm,
 * and the browser hands a one-time code to the app on a 127.0.0.1 callback. The app
 * proves it started the flow (PKCE) and gets back:
 *   - a runner token for this computer, and
 *   - a one-time token that opens a fresh session of its own in the app window.
 * Nothing is signed in to inside an embedded window, and no token is copied by hand.
 */

import { createHash, randomBytes } from "node:crypto";
import { auth } from "../../auth/index.ts";
import { createRunnerDevice, revokeRunnerDevice } from "./hub.ts";

const CODE_TTL_MS = 5 * 60_000;
const APP_SESSION_TTL_MS = 3 * 60_000; // matches oneTimeToken({ expiresIn: 3 })
const PREFIX = "lfg-desktop-code:";

export class DesktopAuthError extends Error {}

const sha256b64url = (value: string) => createHash("sha256").update(value).digest("base64url");

export const isValidState = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(s);
export const isValidChallenge = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{43}$/.test(s);
/** Only a loopback callback on this machine: the code never goes to another host. */
export const isValidRedirect = (s: unknown): s is string =>
  typeof s === "string" && /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/callback$/.test(s) && Number(s.split(":")[2]!.split("/")[0]) <= 65535;
export const cleanDeviceName = (s: unknown) => (typeof s === "string" ? s.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 80) : "") || "My computer";

/** Called from the confirm page, for the signed-in person. */
export async function createDesktopCode(userId: string, input: { challenge: string; deviceName: string }): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  const ctx = await auth.$context;
  await ctx.internalAdapter.createVerificationValue({
    identifier: PREFIX + sha256b64url(code),
    value: JSON.stringify({ userId, challenge: input.challenge, deviceName: input.deviceName }),
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  return code;
}

/**
 * Called by the app with the code and its PKCE verifier. One use only. Returns the
 * runner token and a one-time token for /desktop/session.
 */
export async function exchangeDesktopCode(input: { code: unknown; verifier: unknown; replaceDeviceId?: unknown }) {
  if (typeof input.code !== "string" || typeof input.verifier !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(input.verifier)) {
    throw new DesktopAuthError("Invalid request");
  }
  const ctx = await auth.$context;
  const row = await ctx.internalAdapter.findVerificationValue(PREFIX + sha256b64url(input.code));
  if (!row) throw new DesktopAuthError("This sign-in link was already used or is unknown. Sign in again.");
  await ctx.internalAdapter.deleteVerificationValue(row.id);
  if (row.expiresAt < new Date()) throw new DesktopAuthError("This sign-in took too long. Sign in again.");
  const grant = JSON.parse(row.value) as { userId: string; challenge: string; deviceName: string };
  if (sha256b64url(input.verifier) !== grant.challenge) throw new DesktopAuthError("This sign-in didn't come from this app. Sign in again.");

  // Signing in again on the same computer replaces its previous pairing.
  if (typeof input.replaceDeviceId === "string") await revokeRunnerDevice(grant.userId, input.replaceDeviceId);
  const device = await createRunnerDevice(grant.userId, grant.deviceName);

  // A session of the app's own, so signing out in the browser doesn't sign out the app.
  const session = await ctx.internalAdapter.createSession(grant.userId, false, { userAgent: `LFG Desktop (${grant.deviceName})` });
  const sessionToken = randomBytes(32).toString("base64url");
  await ctx.internalAdapter.createVerificationValue({
    identifier: `one-time-token:${sha256b64url(sessionToken)}`,
    value: session.token,
    expiresAt: new Date(Date.now() + APP_SESSION_TTL_MS),
  });
  const user = await ctx.internalAdapter.findUserById(grant.userId);
  return {
    runnerToken: device.token,
    deviceId: device.id,
    sessionToken,
    user: { name: user?.name ?? "", email: user?.email ?? "" },
  };
}
