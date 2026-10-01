import { createHmac, timingSafeEqual } from 'node:crypto';
/** An immutable capture of the real app. Generated content can only occupy its feature region. */
export interface DesignBaseline {
  version: 1;
  projectId: string;
  branch: string | null;
  path: string;
  capturedAt: string;
  width: number;
  height: number;
  region: { x: number; y: number; width: number; height: number };
  screenshot: string;
}
export function designPreviewPath(base: string, path: string): string {
  const origin = new URL(base);
  const url = new URL(path, origin);
  if (!path.startsWith('/') || path.startsWith('//') || url.origin !== origin.origin || url.username || url.password || url.hash) {
    throw new Error('Use a path within the running project preview, without a fragment.');
  }
  return url.href;
}
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function composeCapturedDesign(b: DesignBaseline, featureHtml: string): string {
  const r = b.region;
  if (b.version !== 1 || ![b.width,b.height,r.x,r.y,r.width,r.height].every(Number.isFinite) ||
      b.width < 320 || b.width > 1920 || b.height < 200 || b.height > 1200 || r.x < 0 || r.y < 0 ||
      r.width <= 0 || r.height <= 0 || r.x+r.width > b.width+1 || r.y+r.height > b.height+1 ||
      !/^[A-Za-z0-9+/]+=*$/.test(b.screenshot) || b.screenshot.length > 8_000_000) {
    throw new Error('Invalid captured app layout. Capture it again.');
  }
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none';";
  const inner = '<!doctype html><meta http-equiv="Content-Security-Policy" content="'+policy+'">'+featureHtml;
  // Feature CSS/JS cannot modify the original shell or escape to the host page.
  return `<!doctype html><html><head><meta name="lfg-design-fidelity" content="captured-layout"><meta name="lfg-design-viewport" content="${b.width},${b.height}"><style>html,body{margin:0;width:${b.width}px;height:${b.height}px;overflow:hidden}#app-capture{position:absolute;inset:0;width:${b.width}px;height:${b.height}px}iframe{position:absolute;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;border:0;background:white}</style></head><body><img id="app-capture" alt="Captured app layout; navigation is a static reference" src="data:image/png;base64,${b.screenshot}"><iframe title="Proposed feature with sample data" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${attr(inner)}"></iframe></body></html>`;
}

export function sealDesignBaseline(baseline: DesignBaseline, key: string): string {
  const payload=JSON.stringify(baseline);
  const signature=createHmac('sha256',key).update('design-baseline:v1:'+payload).digest('hex');
  return JSON.stringify({payload,signature});
}
export function openDesignBaseline(content:string,key:string):DesignBaseline {
  const {payload,signature}=JSON.parse(content);
  if(typeof payload!=='string'||typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature)) throw new Error('Invalid layout capture signature. Capture it again.');
  const expected=createHmac('sha256',key).update('design-baseline:v1:'+payload).digest();
  if(!timingSafeEqual(expected,Buffer.from(signature,'hex'))) throw new Error('Layout capture was modified. Capture it again.');
  return JSON.parse(payload);
}
