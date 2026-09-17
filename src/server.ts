import { createServer, type Server } from 'node:http';
import type pg from 'pg';
import { Router } from './router.js';
import { readJsonBody, sendError } from './http-utils.js';
import { ApiError } from './errors.js';
import { buildHandlers } from './handlers.js';

export function buildServer(pool: pg.Pool): Server {
  const handlers = buildHandlers(pool);
  const router = new Router();

  router.add('GET', '/health', handlers.health);
  router.add('GET', '/', handlers.root);

  router.add('POST', '/api/recalls', handlers.publishRecall);
  router.add('GET', '/api/recalls/:taskId', handlers.getTask);
  router.add('POST', '/api/recalls/:taskId/close', handlers.closeTask);
  router.add('POST', '/api/recalls/:taskId/receipts', handlers.submitReceipts);
  router.add('POST', '/api/recalls/:taskId/exemptions', handlers.requestExemption);
  router.add('POST', '/api/exemptions/:exemptionId/review', handlers.reviewExemption);

  router.add('GET', '/api/brands/:brandId/recalls', handlers.brandProgress);
  router.add('GET', '/api/stores/:storeId/receipts', handlers.storeReceipts);
  router.add('GET', '/api/todos', handlers.todos);
  router.add('GET', '/api/templates', handlers.templates);

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const matched = router.match(req.method ?? 'GET', url.pathname);
      if (matched === null) {
        throw new ApiError(404, 'NOT_FOUND', `${req.method} ${url.pathname} not found`);
      }
      const body = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH'
        ? await readJsonBody(req)
        : undefined;
      await matched.handler({ req, res, params: matched.params, query: url.searchParams, body });
    } catch (err) {
      if (err instanceof ApiError) {
        sendError(res, err);
      } else {
        console.error('unhandled error:', err);
        sendError(res, new ApiError(500, 'INTERNAL_ERROR', 'internal server error'));
      }
    }
  });
}
