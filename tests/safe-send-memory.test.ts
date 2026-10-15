import {describe,it,expect,vi,afterEach} from 'vitest';
import {SafeSendService} from '../src/services/safe-send-service.js';
const input=()=>({accountId:'synthetic',composer:{from:'a@example.test',to:'b@example.test',subject:'fixture',attachments:[{filename:'fixture.bin',content:Buffer.alloc(64)}]}});
afterEach(()=>vi.useRealTimers());
describe('send preview resource lifecycle',()=>{
  it('automatically zeroes expired attachment copies without confirmation',()=>{
    vi.useFakeTimers();
    const service=new SafeSendService({executor(){},ttlMs:10});
    const p=service.preview(input());
    const owned=(service as any).drafts.get(p.draftId).payload.composer.attachments[0].content;
    vi.advanceTimersByTime(11);
    expect(owned.every((byte:number)=>byte===0)).toBe(true);
    expect((service as any).drafts.get(p.draftId)?.payload).toBeUndefined();
  });
  it('rejects aggregate attachment and pending-count excess without evicting valid drafts',()=>{
    const service=new SafeSendService({executor(){},maxPendingDrafts:1,maxRetainedAttachmentBytes:100});
    const first=service.preview(input());
    expect(()=>service.preview(input())).toThrow(/limit|capacity/i);
    expect(service.getState(first.draftId)).toBe('pending');
    const bytes=new SafeSendService({executor(){},maxPendingDrafts:3,maxRetainedAttachmentBytes:100});
    bytes.preview(input());expect(()=>bytes.preview(input())).toThrow(/limit|capacity/i);
  });
});
