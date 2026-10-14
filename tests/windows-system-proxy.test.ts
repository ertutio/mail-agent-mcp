import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
import { execFileSync } from 'node:child_process';
import { windowsLoopbackProxy } from '../src/utils/windows-system-proxy.js';
afterEach(() => { vi.restoreAllMocks(); vi.mocked(execFileSync).mockReset(); });
describe('portable Windows local proxy discovery', () => {
  it.each(['127.0.0.1:48123', 'http=localhost:20001;https=127.0.0.1:54321'])('detects changing ports from %s', setting => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.mocked(execFileSync).mockReturnValue(setting);
    expect(windowsLoopbackProxy()).toBe(setting.includes(';') ? 'http://127.0.0.1:54321' : 'http://127.0.0.1:48123');
    expect(vi.mocked(execFileSync).mock.calls[0]?.[2]).toMatchObject({ windowsHide: true, timeout: 5000 });
  });
  it.each(['', 'remote.example.test:8080', 'user:secret@127.0.0.1:7890', '127.0.0.1:99999'])('does not auto-import unsafe or disabled setting %s', setting => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.mocked(execFileSync).mockReturnValue(setting);
    expect(windowsLoopbackProxy()).toBeUndefined();
  });
  it('does not invoke Windows commands on Linux or macOS', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    expect(windowsLoopbackProxy()).toBeUndefined();
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
