import type { FastifyReply, FastifyRequest } from 'fastify';

export function onClientGone(
  request: FastifyRequest,
  reply: FastifyReply,
  onGone: () => void,
): void {
  const raw = reply.raw;
  const socket = request.raw.socket;
  let fired = false;
  const cleanup = (): void => {
    raw.off('close', onClose);
    raw.off('finish', onFinish);
    socket?.off('close', onClose);
  };
  const onClose = (): void => {
    if (fired) return;
    fired = true;
    cleanup();
    if (!raw.writableFinished) onGone();
  };
  const onFinish = (): void => {
    cleanup();
  };
  raw.once('close', onClose);
  raw.once('finish', onFinish);
  socket?.once('close', onClose);
}

export function clientAbortSignal(request: FastifyRequest, reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  onClientGone(request, reply, () => controller.abort());
  return controller.signal;
}
