import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Detects that the client has gone away, so work can be abandoned.
 *
 * The obvious implementation — listening for `close` on the request — is wrong, and
 * quietly so. For a request whose body has been read in full, Node emits `close` on the
 * `IncomingMessage` as soon as that stream ends, which is long before the client has
 * gone anywhere. Wiring an abort to it cancels every POST the moment it starts.
 *
 * The response is the correct thing to watch: it emits `close` either when it has been
 * fully sent, or when the connection dropped first. `writableFinished` tells those two
 * apart.
 */
export function onClientGone(
  _request: FastifyRequest,
  reply: FastifyReply,
  onGone: () => void,
): void {
  const raw = reply.raw;
  const handler = (): void => {
    if (!raw.writableFinished) onGone();
  };
  raw.once('close', handler);
}

/** An `AbortSignal` that fires if the client disconnects before the response completes. */
export function clientAbortSignal(request: FastifyRequest, reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  onClientGone(request, reply, () => controller.abort());
  return controller.signal;
}
