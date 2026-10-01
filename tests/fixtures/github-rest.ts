/**
 * The result and failure shapes the GitHub fixture server speaks.
 *
 * They live in their own module because the server is now composed of more than one
 * file: the original transport double and the surface the live end-to-end suite needs
 * on top of it. Both raise the same error, so a route either answers a result or
 * fails the way the outer handler already knows how to turn into an HTTP answer.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export type RestResult = { status: number; body: unknown; headers?: Record<string, string> }
