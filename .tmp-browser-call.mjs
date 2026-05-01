import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const port = process.argv[2];
const commands = process.argv.slice(3);
function textOf(result) {
  return (result?.content ?? []).map((entry) => entry.type === 'text' ? entry.text : `[${entry.type}]`).join('\n');
}
const client = new Client({ name: 'craft-browser-call', version: '0.0.1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
for (const command of commands) {
  console.log(`CALL ${command}`);
  const result = await client.callTool({ name: 'browser_tool', arguments: { command } });
  console.log(textOf(result).slice(0, 8000));
}
await client.close();
