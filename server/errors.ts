import { z } from 'zod';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: [
    'password',
    'token',
    'authorization',
    'cookie',
    'req.headers.authorization',
    'req.headers.cookie',
  ],
});
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
  }
}
export const requestLog: RequestHandler = (req, res, next) => {
  req.requestId = randomUUID();
  res.setHeader('X-Request-ID', req.requestId);
  const start = Date.now();
  const requestPath = req.path.replace(/\/files\/[^/]+/, '/files/[redacted]');
  res.on('finish', () =>
    logger.info(
      {
        requestId: req.requestId,
        method: req.method,
        path: requestPath,
        status: res.statusCode,
        ms: Date.now() - start,
      },
      'request',
    ),
  );
  next();
};
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (res.headersSent) return;
  let result =
    error instanceof AppError
      ? error
      : new AppError(500, 'INTERNAL_ERROR', 'The request could not be completed. Try again.');
  if (error instanceof z.ZodError)
    result = new AppError(
      422,
      'VALIDATION_ERROR',
      'Check the highlighted fields.',
      error.flatten().fieldErrors as Record<string, string[]>,
    );
  const databaseNumber = error.number || error.originalError?.info?.number;
  if (error.code === '23505' || [2601, 2627].includes(databaseNumber)) {
    const constraint = error.constraint || error.message || '';
    const field = /barcode/.test(constraint)
      ? 'barcode'
      : /sku/.test(constraint)
        ? 'sku'
        : 'identity';
    result = new AppError(409, 'DUPLICATE', `This ${field} already exists.`, {
      [field]: [`This ${field} already exists.`],
    });
  }
  if (error.code === 'LIMIT_FILE_SIZE' || error.type === 'entity.too.large')
    result = new AppError(413, 'FILE_TOO_LARGE', 'The upload is too large. Check the size limit.');
  if (error.type === 'entity.parse.failed')
    result = new AppError(400, 'INVALID_JSON', 'Send a valid JSON request.');
  if (error.code === '22P02' || [245, 8169].includes(databaseNumber))
    result = new AppError(400, 'INVALID_VALUE', 'A supplied identifier or value is invalid.');
  if (error.code === '23514' || databaseNumber === 547)
    result = new AppError(422, 'CONSTRAINT', 'The change violates an inventory constraint.');
  if ([1205, 1222, 51001].includes(databaseNumber))
    result = new AppError(
      409,
      'DATABASE_CONFLICT',
      'Another operation changed or locked this record. Reload and try again.',
    );
  if (result.status >= 500)
    logger.error(
      { requestId: req.requestId, errorType: error?.name, code: error?.code },
      'request failed',
    );
  res.status(result.status).json({
    error: {
      code: result.code,
      message: result.message,
      ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
      requestId: req.requestId,
    },
  });
};
