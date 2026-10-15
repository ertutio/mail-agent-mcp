import {describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
function fixture() {
  const elements = new Map<string, any>();
  const make = () => ({textContent:'',value:'',type:'password',dataset:{},children:[] as any[],setAttribute:vi.fn(),focus:vi.fn(),addEventListener:vi.fn(),showModal:vi.fn(),close:vi.fn(),append(...items:any[]){this.children.push(...items);},replaceChildren(){this.children=[];}});
  const element = (id:string) => { if(!elements.has(id)) elements.set(id,make()); return elements.get(id); };
  const payload='<img src=x onerror=alert(1)>"\'';
  const context:any={URLSearchParams,setTimeout,sessionStorage:{getItem:()=>null,setItem:vi.fn()},window:{location:{hash:'#session=fixture-session',pathname:'/'},history:{replaceState:vi.fn()}},document:{addEventListener:vi.fn(),getElementById:element,createElement:make,querySelectorAll:()=>[]},console,fetch:vi.fn(async()=>({ok:true,json:async()=>[{id:payload,name:payload,user:payload,host:payload}]}))};
  runInNewContext(readFileSync('public/js/app.js','utf8'),context);
  return {context,element,payload};
}
describe('browser setup rendering and OAuth import',()=>{
  it('opens a text-only removal confirmation without sending a delete request until confirmed',async()=>{
    const {context,element,payload}=fixture();
    context.showRemoval({id:'fixture',name:payload,user:'fixture@example.test'});
    expect(element('remove-name').textContent).toBe(payload);
    expect(element('remove-dialog').showModal).toHaveBeenCalledOnce();
    expect(context.fetch).not.toHaveBeenCalled();
    await context.confirmRemoval();
    expect(context.fetch.mock.calls[0][0]).toBe('/api/accounts/fixture');
    expect(JSON.parse(context.fetch.mock.calls[0][1].body)).toEqual({confirmed:true,name:payload,email:'fixture@example.test'});
    expect(element('remove-dialog').close).toHaveBeenCalledOnce();
  });
  it('renders untrusted account data as DOM text without HTML or event handlers',async()=>{
    const {context,element,payload}=fixture();
    await context.viewAccounts();
    const row=element('account-list').children[0];
    expect(row.children[1].children[0].textContent).toBe(payload);
    expect(row.children[1].children[1].textContent).toBe(payload);
    expect(readFileSync('public/js/app.js','utf8')).not.toMatch(/innerHTML|onclick=/);
  });
  it('imports only installed-app OAuth fields and rejects web or malformed configurations safely',async()=>{
    const {context,element}=fixture();
    const secret=['fixture','-secret'].join('');
    await context.importOAuthFile({size:100,name:'desktop.json',text:async()=>JSON.stringify({installed:{client_id:'fixture.apps.googleusercontent.com',client_secret:secret},unrelated:'ignored'})});
    expect(element('file-label').textContent).toBe('desktop.json');
    await expect(context.importOAuthFile({size:100,text:async()=>JSON.stringify({web:{client_id:'fixture'}})})).rejects.toThrow('桌面应用');
    await expect(context.importOAuthFile({size:100,text:async()=>secret})).rejects.toThrow('无法读取 JSON');
    await expect(context.importOAuthFile({size:2*1024*1024,text:vi.fn()})).rejects.toThrow('文件过大');
  });
  it('switches Gmail and enterprise inputs and clears credentials on provider changes',()=>{
    const {context,element}=fixture();
    element('provider').value='gmail'; element('authorization-code').value='fixture';
    context.updateProvider();
    expect(element('authorization-code').value).toBe('');
    expect(element('authorization-code').required).toBe(false);
    expect(element('gmail-fields').hidden).toBe(false);
    element('provider').value='netease-enterprise'; context.updateProvider();
    expect(element('enterprise-hint').hidden).toBe(false);
    expect(element('gmail-fields').hidden).toBe(true);
  });
});
