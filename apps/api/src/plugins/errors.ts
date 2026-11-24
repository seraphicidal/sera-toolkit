import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { SeraError } from '@sera/engine';
import type { ApiErrorBody, ErrorCode } from '@sera/contracts/types';
import { ZodError } from 'zod';

export const errorHandlerPlugin = fp(function errorHandlerPlugin(
  app: FastifyInstance,
  _options: unknown,
  done: (error?: Error) => void,
) {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof SeraError) {
      request.log.info(
        { errorCode: error.code, detail: error.detail, route: request.routeOptions.url },
        'request failed',
      );
      const body: ApiErrorBody = { error: error.toJobError() };
      void reply.status(error.httpStatus).send(body);
      return;
    }

    if (error instanceof Error && error.name === 'AbortError') {
      const body: ApiErrorBody = {
        error: {
          code: 'CANCELLED',
          message: 'That request was cancelled.',
          retryable: false,
        },
      };
      void reply.status(499).send(body);
      return;
    }

    if (error instanceof ZodError) {
      const first = error.issues[0];
      const body: ApiErrorBody = {
        error: {
          code: 'VALIDATION_ERROR',
          message: first?.message ?? 'That request was not valid.',
          retryable: false,
        },
      };
      void reply.status(400).send(body);
      return;
    }

    const status =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;
    if (status < 500) {
      const code: ErrorCode =
        status === 429
          ? 'RATE_LIMITED'
          : status === 413
            ? 'TOO_LARGE'
            : status === 404
              ? 'NOT_FOUND'
              : status === 403
                ? 'FORBIDDEN'
                : 'VALIDATION_ERROR';
      const body: ApiErrorBody = {
        error: {
          code,
          message:
            status === 429
              ? 'Too many requests. Try again in a moment.'
              : status === 413
                ? 'That request is too large.'
                : status === 404
                  ? "We couldn't find that."
                  : status === 403
                    ? 'That request is not permitted.'
                    : 'That request was not valid.',
          retryable: status === 429,
        },
      };
      void reply.status(status).send(body);
      return;
    }

    request.log.error({ err: error, route: request.routeOptions.url }, 'unhandled error');
    const body: ApiErrorBody = {
      error: {
        code: 'INTERNAL',
        message: 'Something went wrong on our side.',
        retryable: true,
      },
    };
    void reply.status(500).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const body: ApiErrorBody = {
      error: { code: 'NOT_FOUND', message: "We couldn't find that.", retryable: false },
    };
    void reply.status(404).send(body);
  });

  done();
});
