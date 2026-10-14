/** Domain error with a stable code and the HTTP status the API maps it to. */
export class QueueError extends Error {
  /** @type {Record<string, number>} */
  static STATUS = {
    QUEUE_NOT_FOUND: 404,
    MESSAGE_NOT_FOUND: 404,
    QUEUE_EXISTS: 409,
    QUEUE_NOT_EMPTY: 409,
    QUEUE_FULL: 409,
    LIMIT_EXCEEDED: 409,
    LEASE_LOST: 409,
    INVALID_STATE: 409,
    MESSAGE_TOO_LARGE: 413,
    INVALID_ARGUMENT: 400,
    FORBIDDEN: 403,
  };

  /**
   * @param {keyof typeof QueueError.STATUS} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'QueueError';
    this.code = code;
    this.statusCode = QueueError.STATUS[code];
    this.details = details;
  }
}
