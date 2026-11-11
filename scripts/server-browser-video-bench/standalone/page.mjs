import http from "node:http";
// Barcode: 40 blocks of 12x12 px in row y=0..12 encode Date.now() (40 bits), with a white/black guard.
const BAR = `<canvas id=bc width=480 height=12 style="position:fixed;left:0;top:0;z-index:99"></canvas>
<script>const bc=document.getElementById('bc').getContext('2d');
function tick(){const t=Date.now();for(let i=0;i<40;i++){bc.fillStyle=(Math.floor(t/2**i)%2)?'#fff':'#000';bc.fillRect(i*12,0,12,12);}requestAnimationFrame(tick)}tick();</script>`;
const ANIM = `<!doctype html><body style="margin:0;background:#fff;font:16px sans-serif">${BAR}
<style>.b{position:absolute;width:120px;height:120px;border-radius:16px;animation:m 2s linear infinite}
@keyframes m{0%{transform:translate(0,40px) rotate(0)}50%{transform:translate(900px,400px) rotate(180deg)}100%{transform:translate(0,40px) rotate(360deg)}}</style>
${Array.from({ length: 12 }, (_, i) => `<div class=b style="left:${(i % 4) * 60}px;top:${Math.floor(i / 4) * 150 + 30}px;background:hsl(${i * 30} 80% 50%);animation-delay:-${i * 0.17}s"></div>`).join("")}
<p style="position:absolute;top:640px;left:20px;width:1100px">${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20)}</p></body>`;
const LONG = `<!doctype html><body style="margin:0;font:16px/1.5 sans-serif">${BAR}<div style="padding:20px 40px">${Array.from({ length: 400 }, (_, i) => `<h3 style="color:hsl(${(i * 37) % 360} 60% 40%)">Section ${i}</h3><p>${"The quick brown fox jumps over the lazy dog. ".repeat(8)}</p><div style="height:40px;background:linear-gradient(90deg,hsl(${(i * 37) % 360} 70% 60%),#fff)"></div>`).join("")}</div></body>`;
export function serve(port = 0) {
  return new Promise((res) => {
    const s = http.createServer((q, r) => {
      r.setHeader("content-type", "text/html");
      r.end(q.url.startsWith("/long") ? LONG : ANIM);
    });
    s.listen(port, "127.0.0.1", () => res(s));
  });
}
// Decode barcode from RGBA pixels (row-major, width W) at row y=6.
export function readBar(px, W, scale = 1) {
  let t = 0;
  for (let i = 39; i >= 0; i--) {
    const x = Math.round((i * 12 + 6) * scale),
      y = Math.round(6 * scale);
    const o = (y * W + x) * 4;
    const v = (px[o] + px[o + 1] + px[o + 2]) / 3;
    t = t * 2 + (v > 128 ? 1 : 0);
  }
  return t;
}
