import { EventEmitter } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { onClientGone } from './disconnect.js';

function mockPair(writableFinished = false) {
  const socket = new EventEmitter();
  const reqRaw = Object.assign(new EventEmitter(), { socket });
  const raw = Object.assign(new EventEmitter(), { writableFinished });
  return {
    socket,
    request: { raw: reqRaw } as unknown as FastifyRequest,
    reply: { raw } as unknown as FastifyReply,
    raw,
  };
}

describe('onClientGone', () => {
  it('removes the socket listener after response finish so keep-alive connections do not leak', () => {
    const { socket, request, reply, raw } = mockPair(true);
    const onGone = vi.fn();

    for (let i = 0; i < 15; i += 1) {
      onClientGone(request, reply, onGone);
      raw.emit('finish');
    }

    expect(socket.listenerCount('close')).toBe(0);
    expect(raw.listenerCount('close')).toBe(0);
    expect(raw.listenerCount('finish')).toBe(0);
    expect(onGone).not.toHaveBeenCalled();
  });

  it('invokes onGone once on premature close and detaches remaining listeners', () => {
    const { socket, request, reply, raw } = mockPair(false);
    const onGone = vi.fn();

    onClientGone(request, reply, onGone);
    socket.emit('close');
    raw.emit('close');

    expect(onGone).toHaveBeenCalledTimes(1);
    expect(socket.listenerCount('close')).toBe(0);
    expect(raw.listenerCount('close')).toBe(0);
    expect(raw.listenerCount('finish')).toBe(0);
  });
});
