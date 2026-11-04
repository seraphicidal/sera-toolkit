import type { FastifyReply, FastifyRequest } from 'fastify';

export function onClientGone(
  request: FastifyRequest,
  reply: FastifyReply,
  onGone: () => void,
): void {
  const raw = reply.raw;
  let fired = false;
  const handler = (): void => {
    if (fired) return;
    fired = true;
    if (!raw.writableFinished) onGone();
  };
  raw.once('close', handler);
  request.raw.socket?.once('close', handler);
}

export function clientAbortSignal(request: FastifyRequest, reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  onClientGone(request, reply, () => controller.abort());
  return controller.signal;
}
