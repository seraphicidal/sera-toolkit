export interface TimeoutSignalHandle {
  readonly signal: AbortSignal;
  readonly cleanup: () => void;
}

function timeoutReason(): Error {
  if (typeof DOMException === 'function') {
    return new DOMException('The operation timed out.', 'TimeoutError');
  }
  const error = new Error('The operation timed out.');
  error.name = 'TimeoutError';
  return error;
}

export function createTimeoutSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): TimeoutSignalHandle {
  const controller = new AbortController();

  if (parentSignal?.aborted) {
    controller.abort(parentSignal.reason);
    return { signal: controller.signal, cleanup: () => undefined };
  }

  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timer = undefined;
    controller.abort(timeoutReason());
  }, timeoutMs);

  const onParentAbort = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    controller.abort(parentSignal?.reason);
  };

  parentSignal?.addEventListener('abort', onParentAbort, { once: true });

  const cleanup = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    parentSignal?.removeEventListener('abort', onParentAbort);
  };

  return { signal: controller.signal, cleanup };
}
