// TCP proxy that adds one-way delay and a bandwidth cap per direction: a WAN in front of a local relay.
// node shaper.mjs <listenPort> <targetPort> <oneWayDelayMs> <mbitPerSec>
import net from "node:net";
const [listenPort, targetPort, delayMs, mbit] = process.argv.slice(2).map(Number);
const bytesPerMs = (mbit * 1e6) / 8 / 1000;
function pipe(from, to) {
  // Serialise: each chunk leaves after the link is free (cap) plus the propagation delay.
  let linkFreeAt = 0;
  from.on("data", (chunk) => {
    const now = performance.now();
    linkFreeAt = Math.max(linkFreeAt, now) + chunk.length / bytesPerMs;
    const at = linkFreeAt + delayMs;
    setTimeout(() => {
      if (!to.destroyed) to.write(chunk);
    }, at - now);
  });
  from.on("close", () => setTimeout(() => to.destroy(), delayMs));
  from.on("error", () => {});
}
net
  .createServer((client) => {
    const upstream = net.connect(targetPort, "127.0.0.1");
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    pipe(client, upstream);
    pipe(upstream, client);
  })
  .listen(listenPort, "127.0.0.1", () =>
    console.log(`shaper ${listenPort} -> ${targetPort} ${delayMs}ms ${mbit}Mbit/s`),
  );
