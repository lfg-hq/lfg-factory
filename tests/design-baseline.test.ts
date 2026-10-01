import {test,expect} from 'bun:test';
import {composeCapturedDesign,designPreviewPath,sealDesignBaseline,openDesignBaseline,type DesignBaseline} from '../src/services/design-baseline.ts';
const b:DesignBaseline={version:1,projectId:'p',branch:'main',path:'/dashboard',capturedAt:'now',width:1440,height:900,region:{x:300,y:100,width:900,height:500},screenshot:'aGVsbG8='};
test('preserves the capture and confines proposed code to an opaque sandbox',()=>{
 const html=composeCapturedDesign(b,'<script>parent.document.body.remove()</script>');
 expect(html).toContain('src="data:image/png;base64,aGVsbG8="');
 expect(html).toContain('sandbox="allow-scripts"');
 expect(html).not.toContain('allow-same-origin');
 expect(html).toContain('&lt;script&gt;');
 expect(html).toContain('left:300px;top:100px;width:900px;height:500px');
});
test('rejects invalid capture boundaries and injected image values',()=>{
 expect(()=>composeCapturedDesign({...b,region:{...b.region,width:2000}},'')).toThrow();
 expect(()=>composeCapturedDesign({...b,screenshot:'" onerror="alert(1)'},'')).toThrow();
});
test('only permits paths within the configured project preview',()=>{
 expect(designPreviewPath('https://preview.test','/dashboard')).toBe('https://preview.test/dashboard');
 for(const path of ['https://evil.test','//evil.test','/\\evil.test','/dashboard#x']) expect(()=>designPreviewPath('https://preview.test',path)).toThrow();
});

test('layout captures cannot be fabricated or edited through document content',()=>{
 const sealed=sealDesignBaseline(b,'test-key');
 expect(openDesignBaseline(sealed,'test-key')).toEqual(b);
 expect(()=>openDesignBaseline(sealed.replace('main','fake'),'test-key')).toThrow();
 expect(()=>openDesignBaseline(sealed,'wrong-key')).toThrow();
});
