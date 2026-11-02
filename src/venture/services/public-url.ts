import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as http } from "node:http";
import { request as https } from "node:https";

// Conservative public-unicast allowlist. IPv4-mapped IPv6 and special-use IPv6
// are rejected, including translation/tunnel ranges that could hide IPv4 targets.
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) ||
      (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
  }
  return isIP(address) === 6 && /^[23]/.test(address) && !/^200[12]:/i.test(address);
}
export async function publicUrl(raw: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port))) throw new Error('UNSAFE_URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await new Promise<{address: string; family: number}[]>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(signal?.reason || new Error('SOURCE_TIMEOUT')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('SOURCE_TIMEOUT')); }, 10000);
    signal?.addEventListener('abort', abort, { once: true });
    lookup(host, { all: true }).then(result => { cleanup(); resolve(result); }, error => { cleanup(); reject(error); });
  });
  signal?.throwIfAborted();
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('UNSAFE_URL');
  url.hash = '';
  return { url, address: addresses[0]! };
}

export async function readPublicUrl(raw: string, limit: number, signal?: AbortSignal): Promise<{url: string; title: string; text: string}> {
  for (let redirects = 0; redirects <= 4; redirects++) {
    signal?.throwIfAborted();
    const { url, address } = await publicUrl(raw, signal);
    // Pin the validated DNS answer at connection time: no DNS-rebinding gap.
    const response = await new Promise<{location?: string; body: string}>((resolve, reject) => {
      const req = (url.protocol === 'https:' ? https : http)(url, {
        signal, headers: { 'User-Agent': 'VentureAnalyst/1.0', Accept: 'text/html,text/plain', 'Accept-Encoding': 'identity' },
        lookup: ((_host: string, _opts: unknown, cb: Function) => cb(null, address.address, address.family)) as any,
      }, res => {
        if (res.statusCode && [301,302,303,307,308].includes(res.statusCode)) {
          res.destroy(); resolve({ location: res.headers.location, body: '' }); return;
        }
        if (res.statusCode !== 200 || !/^(text\/plain|text\/html)/i.test(res.headers['content-type'] || '') || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
          res.destroy(); reject(new Error('SOURCE_INACCESSIBLE')); return;
        }
        let size = 0; const chunks: Buffer[] = [];
        res.on('data', chunk => { size += chunk.length; if (size > 512_000) { res.destroy(new Error('SOURCE_TOO_LARGE')); } else chunks.push(chunk); });
        res.on('error', reject);
        res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject); req.setTimeout(15_000, () => req.destroy(new Error('SOURCE_TIMEOUT'))); req.end();
    });
    if (response.location) { raw = new URL(response.location, url).href; continue; }
    const title = response.body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || url.hostname;
    const text = response.body.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
    if (!text) throw new Error('SOURCE_INACCESSIBLE');
    return { url: url.href, title: title.slice(0, 200), text };
  }
  throw new Error('SOURCE_REDIRECT_LIMIT');
}
