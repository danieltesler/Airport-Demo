/**
 * A sign-in step failed. `reason` is a short code that is safe to log (never a token, a secret
 * or a user's details) and is the only thing the callback writes to the server log.
 */
export class AuthError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "AuthError";
  }
}
