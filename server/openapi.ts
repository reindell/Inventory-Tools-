const response = { description: 'Successful response' };
const error = {
  description: 'Validation, permission, conflict, or server error',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
};
const json = (schema: unknown) => ({ required: true, content: { 'application/json': { schema } } });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const secured = { security: [{ bearerAuth: [] }] };
const mutations = {
  parameters: [
    { name: 'X-CSRF-Token', in: 'header', required: true, schema: { type: 'string' } },
    { name: 'Origin', in: 'header', required: true, schema: { type: 'string', format: 'uri' } },
  ],
};
export const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'SDP Inventory API',
    version: '1.1.0',
    description:
      'Single-production-location inventory and tool/jig borrowing. Staff can only browse the catalog and manage their own unissued requests; Admins approve, issue and record returns. Mutations require an exact allowed Origin and a CSRF token from GET /auth/csrf with its signed cookie. All protected operations require a Bearer access token. Production refresh cookies require HTTPS.',
  },
  servers: [{ url: '/api/v1' }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              fieldErrors: { type: 'object' },
              requestId: { type: 'string' },
            },
          },
        },
      },
      Login: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', format: 'password' },
        },
      },
      ItemInput: {
        type: 'object',
        required: ['name', 'sku', 'category', 'reorderLevel'],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 150 },
          sku: { type: 'string', maxLength: 64 },
          barcode: { type: 'string', maxLength: 100 },
          category: { type: 'string' },
          supplier: { type: 'string' },
          description: { type: 'string' },
          reorderLevel: { type: 'integer', minimum: 0 },
          serialized: { type: 'boolean' },
          version: { type: 'integer', description: 'Required for edit; latest item version' },
        },
      },
      StockInput: {
        type: 'object',
        required: ['itemId', 'type', 'quantity', 'reason', 'expectedVersion'],
        properties: {
          itemId: { type: 'string', format: 'uuid' },
          type: { type: 'string', enum: ['in', 'out', 'adjustment'] },
          quantity: { type: 'integer', minimum: 1 },
          direction: { type: 'string', enum: ['add', 'remove'] },
          reason: { type: 'string', minLength: 3 },
          note: { type: 'string' },
          expectedVersion: { type: 'integer' },
          serials: { type: 'array', items: { type: 'string' } },
          outStatus: { type: 'string', enum: ['sold', 'damaged'] },
        },
      },
    },
  },
  paths: {} as Record<string, any>,
};
function operation(
  method: string,
  path: string,
  summary: string,
  body?: unknown,
  publicAccess = false,
  extra: Record<string, unknown> = {},
) {
  const parameters = [
    ...(method !== 'get' ? mutations.parameters : []),
    ...[...path.matchAll(/\{(\w+)\}/g)].map((match) => ({
      name: match[1],
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' },
    })),
  ];
  openapi.paths[path] ||= {};
  openapi.paths[path][method] = {
    summary,
    ...(publicAccess ? {} : secured),
    parameters,
    ...(body ? { requestBody: json(body) } : {}),
    responses: {
      '200': response,
      '201': response,
      '204': response,
      '400': error,
      '401': error,
      '403': error,
      '409': error,
      '413': error,
      '422': error,
      '429': error,
    },
    ...extra,
  };
}
operation('get', '/auth/csrf', 'Get CSRF token and signed cookie', undefined, true);
operation('post', '/auth/login', 'Sign in', ref('Login'), true);
for (const action of ['refresh', 'logout'])
  operation('post', `/auth/${action}`, action, undefined, true);
operation('get', '/auth/me', 'Current account');
operation(
  'post',
  '/auth/forgot-password',
  'Request password reset',
  {
    type: 'object',
    required: ['email'],
    properties: { email: { type: 'string', format: 'email' } },
  },
  true,
);
operation(
  'post',
  '/auth/reset-password',
  'Consume password reset token',
  {
    type: 'object',
    required: ['token', 'password'],
    properties: {
      token: { type: 'string' },
      password: { type: 'string', minLength: 12, maxLength: 128 },
    },
  },
  true,
);
operation(
  'post',
  '/auth/accept-invitation',
  'Activate invited account',
  {
    type: 'object',
    required: ['token', 'name', 'password'],
    properties: {
      token: { type: 'string' },
      name: { type: 'string' },
      password: { type: 'string', minLength: 12 },
    },
  },
  true,
);
for (const path of [
  '/dashboard',
  '/items',
  '/items/check-identity',
  '/movements',
  '/alerts/low-stock',
  '/categories',
  '/suppliers',
  '/users',
  '/settings',
  '/audit-events',
  '/exports/items.csv',
  '/stock/reconcile',
])
  operation('get', path, `Read ${path.slice(1)} (role restrictions apply)`);
operation('get', '/settings/branding', 'Public company brand configuration', undefined, true);
operation('get', '/items/{id}', 'Item detail, image gallery, stock history');
operation('post', '/items', 'Create item (Admin/Manager)', ref('ItemInput'));
operation('patch', '/items/{id}', 'Update item (Admin/Manager)', ref('ItemInput'));
for (const action of ['archive', 'restore'])
  operation('post', `/items/{id}/${action}`, `${action} item (Admin/Manager)`);
for (const path of ['/stock', '/stock/in', '/stock/out', '/stock/adjustments'])
  operation(
    'post',
    path,
    'Commit stock movement (Admin/Manager; Idempotency-Key UUID required)',
    ref('StockInput'),
    false,
    {
      parameters: [
        ...mutations.parameters,
        {
          name: 'Idempotency-Key',
          in: 'header',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
    },
  );
operation('delete', '/settings/logo', 'Revert logo (Admin)');
const fileBody = {
  required: true,
  content: {
    'multipart/form-data': {
      schema: {
        type: 'object',
        required: ['file'],
        properties: { file: { type: 'string', format: 'binary' } },
      },
    },
  },
};
for (const path of ['/settings/logo', '/items/{id}/images', '/imports/items'])
  operation('post', path, 'Validated upload (Admin/Manager; logo Admin only)', undefined, false, {
    requestBody: fileBody,
  });
operation('patch', '/items/{id}/images', 'Reorder images and select primary', {
  type: 'object',
  required: ['ids', 'primaryId'],
  properties: {
    ids: { type: 'array', maxItems: 5, items: { type: 'string', format: 'uuid' } },
    primaryId: { type: 'string', format: 'uuid' },
  },
});
operation('delete', '/items/{id}/images/{imageId}', 'Remove item image');
for (const path of [
  '/items/{id}/serials',
  '/items/{id}/movements',
  '/imports/{id}',
  '/imports/{id}/errors',
])
  operation('get', path, `Read ${path}`);
operation('post', '/imports/{id}/commit', 'Commit reviewed CSV import (repeat-safe)');
operation('post', '/users/invitations', 'Invite account (Admin)', {
  type: 'object',
  required: ['email', 'role'],
  properties: {
    email: { type: 'string', format: 'email' },
    role: { type: 'string', enum: ['Admin', 'Manager', 'Staff', 'Viewer'] },
  },
});
operation('patch', '/users/{id}', 'Change role/access (Admin)', {
  type: 'object',
  required: ['role', 'enabled'],
  properties: {
    role: { type: 'string', enum: ['Admin', 'Manager', 'Staff', 'Viewer'] },
    enabled: { type: 'boolean' },
  },
});
for (const path of ['/reports/stock', '/labels'])
  operation('post', path, 'Generate branded PDF (maximum 2000 items)', {
    type: 'object',
    properties: {
      ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
      includeLogo: { type: 'boolean' },
      filters: { type: 'object' },
    },
  });

operation('get', '/requests', 'List requests (Admin: all; others: own only)', undefined, false, {
  parameters: [
    { name: 'q', in: 'query', schema: { type: 'string', maxLength: 150 } },
    {
      name: 'status',
      in: 'query',
      schema: {
        type: 'string',
        enum: ['all', 'pending', 'approved', 'rejected', 'cancelled', 'issued', 'returned'],
      },
    },
    { name: 'requestId', in: 'query', schema: { type: 'string', format: 'uuid' } },
    { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
    { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
  ],
});
operation(
  'get',
  '/requests/summary',
  'Request and outstanding-loan totals (owner scoped; Admin all)',
);
const requestIdempotency = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};
operation(
  'post',
  '/requests',
  'Submit tool/jig request; does not reserve or deduct stock (Admin/Manager/Staff)',
  {
    type: 'object',
    additionalProperties: false,
    required: ['itemId', 'quantity', 'purpose'],
    properties: {
      itemId: { type: 'string', format: 'uuid' },
      quantity: { type: 'integer', minimum: 1, maximum: 1000000000 },
      purpose: { type: 'string', minLength: 3, maxLength: 1000 },
    },
  },
  false,
  { parameters: [...mutations.parameters, requestIdempotency] },
);
for (const action of ['approve', 'reject', 'cancel'])
  operation(
    'post',
    `/requests/{id}/${action}`,
    action === 'cancel'
      ? 'Cancel own pending/approved request; Admin may cancel any unissued request'
      : `${action} ${action === 'reject' ? 'unissued' : 'pending'} request (Admin only)`,
    {
      type: 'object',
      additionalProperties: false,
      required: ['version'],
      properties: {
        version: { type: 'integer', minimum: 1 },
        note: {
          type: 'string',
          maxLength: 1000,
          description: 'Rejection requires a reason of at least three characters.',
        },
      },
    },
  );
for (const action of ['issue', 'return'])
  operation(
    'post',
    `/requests/{id}/${action}`,
    `${action} tools and commit a stock movement atomically (Admin only; issue once, partial returns supported)`,
    {
      type: 'object',
      additionalProperties: false,
      required: ['version', 'quantity'],
      properties: {
        version: { type: 'integer', minimum: 1 },
        quantity: { type: 'integer', minimum: 1, maximum: 1000000000 },
        note: { type: 'string', maxLength: 1000 },
        serials: {
          type: 'array',
          maxItems: 1000,
          items: { type: 'string', maxLength: 100 },
          description:
            'One distinct serial per unit for serialized tools; return only serials borrowed on this request.',
        },
      },
    },
    false,
    {
      parameters: [
        ...mutations.parameters,
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        requestIdempotency,
      ],
    },
  );
operation('get', '/notifications', 'Latest 20 own notifications and total unread count');
operation('patch', '/notifications/{id}/read', 'Mark own notification as read');
operation('post', '/notifications/read-all', 'Mark all own notifications as read');
