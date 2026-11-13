import net from 'node:net';
for (const p of process.argv.slice(2)) {
  for (let i = 0; i < 240; i++) {
    const ok = await new Promise((r) => { const s = net.connect(+p, '127.0.0.1', () => { s.end(); r(true); }); s.on('error', () => r(false)); });
    if (ok) break; await new Promise((r) => setTimeout(r, 500));
  }
}
