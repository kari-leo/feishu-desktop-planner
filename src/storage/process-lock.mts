import { once } from 'node:events';
import { createServer } from 'node:net';

export async function lockApp(appKey: string) {
  const server = createServer(socket => socket.destroy());
  const name = '\\\\.\\pipe\\feishu-desktop-planner-' + appKey;
  try {
    server.listen(name);
    await once(server, 'listening');
    return () => new Promise<void>(resolve => server.close(() => resolve()));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error('该飞书应用已有同步或授权进程，请先结束原进程');
    }
    throw new Error('无法建立 Windows 本地进程锁');
  }
}
