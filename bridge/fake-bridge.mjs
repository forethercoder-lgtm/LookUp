// Симулятор моста для наушников: шлёт наклон головы по ws://127.0.0.1:8765 в том же формате,
// что и настоящий мост (bridge/mac). Нужен, чтобы проверить сайт без AirPods и на любой ОС.
// Запуск: node bridge/fake-bridge.mjs [--invert]
// Сценарий (от подключения или от сообщения сайта «calibrate»): 0–3,3 с прямо → кивок вниз → 6–9,5 с норма → 9,5–14 с наклон 30° → норма, по кругу.
import http from "node:http";
import crypto from "node:crypto";

const sign = process.argv.includes("--invert") ? -1 : 1;
const PORT = 8765;
const clients = new Set();

const server = http.createServer((_, res) => { res.writeHead(426); res.end("WebSocket only"); });
server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) return socket.destroy();
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const c = { socket, t0: Date.now() };
  clients.add(c);
  console.log("клиент подключён");
  socket.on("data", (buf) => {
    const op = buf[0] & 0x0f;
    if (op === 8) return socket.end(Buffer.from([0x88, 0x00])); // close
    if (op === 1 && (buf[1] & 0x80) && (buf[1] & 0x7f) < 126) { // короткий текстовый кадр от клиента (маскирован)
      const len = buf[1] & 0x7f, mask = buf.subarray(2, 6);
      const text = Buffer.from(buf.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4])).toString();
      if (text === "calibrate") { c.t0 = Date.now(); console.log("калибровка: сценарий с нуля"); }
    }
  });
  const drop = () => { clients.delete(c); console.log("клиент отключён"); };
  socket.on("close", drop);
  socket.on("error", drop);
});

function pitchAt(t) { // секунды от подключения
  const noise = (Math.random() - 0.5) * 0.6;
  if (t < 3.3) return noise;
  if (t < 6) return 12 + noise;
  const c = (t - 6) % 12;          // цикл 12 с
  if (c < 3.5) return 2 + noise;   // норма
  if (c < 8) return 30 + noise;    // наклон
  return 3 + noise;                // норма
}

setInterval(() => {
  for (const c of clients) {
    const t = (Date.now() - c.t0) / 1000;
    const p = Buffer.from(JSON.stringify({ pitch: +(sign * pitchAt(t)).toFixed(2), t: Date.now() }));
    c.socket.write(Buffer.concat([Buffer.from([0x81, p.length]), p]));
  }
}, 33);

server.listen(PORT, "127.0.0.1", () => console.log(`fake bridge: ws://127.0.0.1:${PORT}${sign < 0 ? " (инверсия)" : ""}`));
