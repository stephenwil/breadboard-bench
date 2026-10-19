// Starts the real server over stdio with the SDK client, against a temp HOME, for tests.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'server.js');

export async function startServer({ env = {}, home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-home-')) } = {}) {
  // This process may itself run inside a Claude Code session, so drop its variables unless a test sets them.
  const base = { ...process.env };
  delete base.CLAUDE_CODE_SESSION_ID; delete base.BREADBOARD_DESIGN; delete base.BREADBOARD_DESIGNS_DIR;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...base, HOME: home, BREADBOARD_PORT: String(5300 + Math.floor(Math.random() * 600)), ...env },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
  };
  const port = Number(/:(\d+)\//.exec((await call('get_viewer_url')).text)[1]);
  return { call, port, home, stop: () => client.close() };
}
