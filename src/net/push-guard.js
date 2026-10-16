import { isIPv4, isIPv6 } from 'node:net';
import { NetGuard, NetGuardError } from '@atc-web/atc-service-core/http';

/**
 * SSRF guard for push targets: service-core's {@link NetGuard} (scheme, credentials, host allowlist,
 * public-only addresses unless private ones are allowed, pinned address), plus two checks on the
 * resolved address. Link-local addresses (169.254.0.0/16, fe80::/10) and cloud metadata endpoints
 * are refused always, even with `PUSH_ALLOW_PRIVATE`. A private address is accepted only for a host
 * on `PUSH_ALLOWED_HOSTS` (config already refuses `PUSH_ALLOW_PRIVATE` without that list); the check
 * runs again after DNS, on the address that will actually be dialled.
 */
export class PushGuard {
  static METADATA = new Set(['169.254.169.254', '169.254.170.2', '100.100.100.200', 'fd00:ec2::254']);

  /** @param {{ allowHttp: boolean, allowPrivate: boolean, allowedHosts: string[], lookup?: any }} o */
  constructor({ allowHttp, allowPrivate, allowedHosts, lookup }) {
    this.allowedHosts = allowedHosts;
    this.inner = new NetGuard({ allowHttp, allowPrivate, allowedHosts, ...(lookup ? { lookup } : {}) });
  }

  /** Static URL checks (at save time). @param {string} rawUrl */
  check(rawUrl) {
    return this.inner.check(rawUrl);
  }

  /** @param {string} ip */
  static isLinkLocalOrMetadata(ip) {
    const a = ip.toLowerCase().replace(/^::ffff:/, '');
    if (PushGuard.METADATA.has(a)) return true;
    if (isIPv4(a)) return a.startsWith('169.254.');
    if (isIPv6(a)) { const g = NetGuard.parseIPv6(a); return g !== null && (g[0] & 0xffc0) === 0xfe80; }
    return false;
  }

  /** @param {string} host */
  #allowed(host) {
    return this.allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
  }

  /**
   * Resolve and vet a push URL for one delivery.
   * @param {string} rawUrl
   * @returns {Promise<import('@atc-web/atc-service-core/http').VettedTarget>}
   */
  async resolve(rawUrl) {
    const target = await this.inner.resolve(rawUrl);
    const host = target.url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (PushGuard.isLinkLocalOrMetadata(target.address) || PushGuard.isLinkLocalOrMetadata(host)) {
      throw new NetGuardError('PRIVATE_ADDRESS', `push target "${host}" resolves to a link-local or metadata address (${target.address})`);
    }
    if (!NetGuard.isPublicAddress(target.address) && !this.#allowed(host)) {
      throw new NetGuardError('PRIVATE_ADDRESS', `push target "${host}" resolves to private address ${target.address} and is not on PUSH_ALLOWED_HOSTS`);
    }
    return target;
  }
}
