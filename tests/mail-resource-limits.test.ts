import {describe,it,expect,vi} from 'vitest';
import {ImapService} from '../src/services/imap-service.js';
import {MAX_MESSAGE_BYTES,materializeBoundedAttachments,assertMessageSize} from '../src/utils/mail-resource-limits.js';
import {extractPdfPreview} from '../src/utils/pdf-preview.js';
describe('bounded message processing',()=>{
  it('rejects server-reported oversize before parsing and requests partial source',async()=>{
    const fetchOne=vi.fn(async()=>({source:Buffer.from('synthetic'),size:MAX_MESSAGE_BYTES+1}));
    const service=new ImapService();vi.spyOn(service as any,'ensureConnected').mockResolvedValue({getMailboxLock:async()=>({release(){}}),fetchOne});
    await expect(service.getEmailContent('synthetic','INBOX',7)).rejects.toThrow(/processing limit/);
    expect(fetchOne.mock.calls[0]?.[1]).toMatchObject({source:{start:0,maxLength:MAX_MESSAGE_BYTES+1},size:true});
  });
  it('rejects actual oversize even if a server omits or lies about size',()=>{
    expect(()=>assertMessageSize(Buffer.alloc(MAX_MESSAGE_BYTES+1))).toThrow(/processing limit/);
  });
  it('bounds aggregate attachment count and bytes before decoding',async()=>{
    await expect(materializeBoundedAttachments(Array.from({length:21},()=>({content:'YQ=='})))).rejects.toThrow(/Too many/);
    await expect(materializeBoundedAttachments([{content:Buffer.alloc(MAX_MESSAGE_BYTES)},{content:Buffer.from('x')}])).rejects.toThrow(/aggregate/);
    const result=await materializeBoundedAttachments([{content:'YQ=='}]);expect(result[0].content.toString()).toBe('a');
  });
  it('rejects large PDFs before starting a parser worker',async()=>{
    await expect(extractPdfPreview(Buffer.alloc(256*1024+1),100)).rejects.toThrow(/resource limit/);
  });
  it('extracts small PDFs in an isolated bounded worker',async()=>{
    const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
    const stream='BT /F1 12 Tf 30 200 Td (Hello fixture) Tj ET';objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    let pdf='%PDF-1.4\n';const offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
    const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const result=await extractPdfPreview(Buffer.from(pdf),5);expect(result.text).toContain('Hello');expect(result.text.length).toBeLessThanOrEqual(5);expect(result.truncated).toBe(true);
  });
});
