export class InFlightCoalescer<T> {
  private readonly entries = new Map<
    string,
    {
      promise: Promise<T>;
      controller: AbortController;
      consumers: number;
      settled: boolean;
    }
  >();

  run(key: string, start: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(toAbortError(signal.reason));
    }

    let entry = this.entries.get(key);
    if (!entry) {
      const controller = new AbortController();
      const created = {
        controller,
        consumers: 0,
        settled: false,
        promise: Promise.resolve()
          .then(() => start(controller.signal))
          .finally(() => {
            created.settled = true;
            if (this.entries.get(key) === created) {
              this.entries.delete(key);
            }
          }),
      };
      this.entries.set(key, created);
      entry = created;
    }

    entry.consumers += 1;
    const active = entry;

    return new Promise<T>((resolve, reject) => {
      let done = false;

      const onAbort = () => {
        if (done) return;
        done = true;
        signal?.removeEventListener('abort', onAbort);
        active.consumers -= 1;
        if (active.consumers <= 0 && !active.settled && !active.controller.signal.aborted) {
          if (this.entries.get(key) === active) {
            this.entries.delete(key);
          }
          active.controller.abort(signal?.reason);
        }
        reject(toAbortError(signal?.reason));
      };

      signal?.addEventListener('abort', onAbort, { once: true });

      active.promise.then(
        (value) => {
          if (done) return;
          done = true;
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (err: unknown) => {
          if (done) return;
          done = true;
          signal?.removeEventListener('abort', onAbort);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  get size(): number {
    return this.entries.size;
  }
}

function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === 'string' && reason.length > 0 ? reason : 'Aborted');
  err.name = 'AbortError';
  return err;
}
