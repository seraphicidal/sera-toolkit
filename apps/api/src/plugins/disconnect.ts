import type { FastifyReply, FastifyRequest } from 'fastify';

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

export function clientAbortSignal(request: FastifyRequest, reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  onClientGone(request, reply, () => controller.abort());
  return controller.signal;
}
