const token = process.argv[2];
const r = await fetch("http://127.0.0.1:4317/api/events?team=team_mvs2t1yv1fpof&token=" + token);
const reader = r.body.getReader(); const dec = new TextDecoder();
let buf = "", frames = 0, types = new Set(); const t0 = Date.now();
while (Date.now() - t0 < 2500) {
  const { value, done } = await Promise.race([reader.read(), new Promise(res => setTimeout(() => res({ done: true }), 2600))]);
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i; while ((i = buf.indexOf("\n\n")) >= 0) { const f = buf.slice(0, i); buf = buf.slice(i + 2); const ev = /event: (\S+)/.exec(f); if (ev) { frames++; types.add(ev[1]); } }
  if (frames >= 3) break;
}
console.log(`SSE live: ${frames} frames, types=[${[...types].join(",")}]`);
