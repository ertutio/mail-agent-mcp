import {describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
describe('setup account rendering',()=>{
  it('escapes account data and does not interpolate executable event handlers',async()=>{
    const table={innerHTML:'',querySelectorAll:()=>[],classList:{add(){},remove(){}}};
    const payload='<img src=x onerror=alert(1)>"\'';
    const context:any={document:{addEventListener:vi.fn(),getElementById:()=>table},console,fetch:async()=>({json:async()=>[{id:payload,name:payload,user:payload,host:payload}]})};
    runInNewContext(readFileSync('public/js/app.js','utf8'),context);
    await context.viewAccounts();
    expect(table.innerHTML).not.toContain('<img');
    expect(table.innerHTML).toContain('&lt;img');
    expect(table.innerHTML).not.toContain('onclick=');
  });
});
