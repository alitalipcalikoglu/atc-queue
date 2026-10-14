/** JSON Schemas for the HTTP surface. */
export class Schemas {
  static name = { type: 'string', pattern: '^[a-z][a-z0-9._-]{0,63}$' };
  static id = { type: 'string', pattern: '^msg_[0-9a-z]{6,12}[0-9a-f]{16}$' };
  static token = { type: 'string', pattern: '^[0-9a-f-]{36}$' };
  static sec = (/** @type {number} */ max) => ({ type: 'integer', minimum: 0, maximum: max });

  static putQueue = {
    type: 'object', additionalProperties: false,
    properties: {
      description: { type: 'string', maxLength: 500 },
      visibilitySec: { type: 'integer', minimum: 1, maximum: 43_200 },
      maxAttempts: { type: 'integer', minimum: 1, maximum: 100 },
      backoffBaseSec: { type: 'integer', minimum: 0, maximum: 86_400 },
      backoffMaxSec: { type: 'integer', minimum: 0, maximum: 604_800 },
      paused: { type: 'boolean' },
    },
  };
  static message = {
    type: 'object', additionalProperties: false, required: ['body'],
    properties: { body: {}, delaySec: Schemas.sec(1_209_600), priority: { type: 'integer', minimum: -100, maximum: 100 }, dedupeKey: { type: 'string', minLength: 1, maxLength: 200 } },
  };
  static batch = { type: 'object', additionalProperties: false, required: ['messages'], properties: { messages: { type: 'array', minItems: 1, maxItems: 1_000, items: Schemas.message } } };
  static pull = { type: 'object', additionalProperties: false, properties: { max: { type: 'integer', minimum: 1, maximum: 1_000 }, visibilitySec: { type: 'integer', minimum: 1, maximum: 43_200 }, waitSec: Schemas.sec(25) } };
  static ack = { type: 'object', additionalProperties: false, required: ['leaseToken'], properties: { leaseToken: Schemas.token } };
  static nack = { type: 'object', additionalProperties: false, required: ['leaseToken'], properties: { leaseToken: Schemas.token, delaySec: Schemas.sec(1_209_600), error: { type: 'string', maxLength: 1_000 }, dead: { type: 'boolean' } } };
  static extend = { type: 'object', additionalProperties: false, required: ['leaseToken', 'visibilitySec'], properties: { leaseToken: Schemas.token, visibilitySec: { type: 'integer', minimum: 1, maximum: 43_200 } } };
  static redrive = { type: 'object', additionalProperties: false, properties: { ids: { type: 'array', minItems: 1, maxItems: 1_000, items: Schemas.id }, all: { const: true } } };
  static purge = { type: 'object', additionalProperties: false, required: ['state'], properties: { state: { type: 'string', enum: ['ready', 'dead', 'all'] } } };

  static queueParams = { type: 'object', properties: { name: Schemas.name }, required: ['name'] };
  static messageParams = { type: 'object', properties: { name: Schemas.name, id: Schemas.id }, required: ['name', 'id'] };
  static listQuery = { type: 'object', additionalProperties: false, properties: { state: { type: 'string', enum: ['ready', 'delayed', 'leased', 'dead'] }, limit: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|1[0-9][0-9]|200)$' }, cursor: { type: 'string', pattern: '^[0-9]{1,15}$' } } };
  static deleteQuery = { type: 'object', additionalProperties: false, properties: { force: { type: 'string', enum: ['true', 'false'] } } };
}
