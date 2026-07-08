import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const publicDir = new URL("apps/web/public/", root);
const iconDir = new URL("icons/", publicDir);

const outputs = [
  ["apple-touch-icon.png", 180, false],
  ["icons/icon-192.png", 192, false],
  ["icons/icon-512.png", 512, false],
  ["icons/maskable-192.png", 192, true],
  ["icons/maskable-512.png", 512, true]
];

mkdirSync(iconDir, { recursive: true });

for (const [file, size, maskable] of outputs) {
  writeFileSync(new URL(file, publicDir), renderPng(size, maskable));
}

writeFileSync(new URL("favicon.ico", publicDir), icoFromPng(renderPng(32, false)));

function renderPng(size, maskable) {
  const rgba = new Uint8Array(size * size * 4);
  const scale = size / 512;
  const radius = maskable ? 96 : 112;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const ux = (x + 0.5) / scale;
      const uy = (y + 0.5) / scale;
      const pixel = pixelColor(ux, uy, radius);
      if (pixel) setPixel(rgba, size, x, y, pixel);
    }
  }

  return encodePng(size, size, rgba);
}

function pixelColor(x, y, radius) {
  if (!roundedRect(x, y, 0, 0, 512, 512, radius)) return [0, 0, 0, 0];

  let color = lerpColor([48, 48, 53, 255], [31, 31, 33, 255], (x + y) / 1024);

  if (roundedRect(x, y, 126, 117, 260, 220, 33)) color = [48, 48, 53, 255];
  if (roundedRect(x, y, 149, 153, 214, 150, 23)) color = [24, 25, 26, 255];
  if (rect(x, y, 256, 337, 28, 36)) color = [66, 67, 73, 255];
  if (roundedRect(x, y, 158, 364, 224, 36, 18)) color = [53, 215, 255, 255];

  color = ring(color, x, y, 159, 382, 37, 18, [53, 215, 255, 255]);
  color = ring(color, x, y, 364, 382, 37, 18, [74, 222, 128, 255]);
  if (circle(x, y, 159, 382, 11)) color = [53, 215, 255, 255];
  if (circle(x, y, 364, 382, 11)) color = [74, 222, 128, 255];

  if (chevron(x, y)) color = lerpColor([53, 215, 255, 255], [31, 249, 137, 255], (x - 188) / 69);
  if (roundedRect(x, y, 269, 270, 77, 32, 16)) color = [243, 246, 244, 255];

  return color;
}

function chevron(x, y) {
  return lineDistance(x, y, 200, 211, 245, 256) <= 17 || lineDistance(x, y, 200, 301, 245, 256) <= 17;
}

function ring(color, x, y, cx, cy, radius, width, ringColor) {
  const d = Math.hypot(x - cx, y - cy);
  if (d <= radius && d >= radius - width) return ringColor;
  if (d < radius - width) return [24, 25, 26, 255];
  return color;
}

function rect(x, y, rx, ry, width, height) {
  return x >= rx && x <= rx + width && y >= ry && y <= ry + height;
}

function roundedRect(x, y, rx, ry, width, height, radius) {
  if (!rect(x, y, rx, ry, width, height)) return false;
  const innerX = x >= rx + radius && x <= rx + width - radius;
  const innerY = y >= ry + radius && y <= ry + height - radius;
  if (innerX || innerY) return true;
  const cx = x < rx + radius ? rx + radius : rx + width - radius;
  const cy = y < ry + radius ? ry + radius : ry + height - radius;
  return Math.hypot(x - cx, y - cy) <= radius;
}

function circle(x, y, cx, cy, radius) {
  return Math.hypot(x - cx, y - cy) <= radius;
}

function lineDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function lerpColor(a, b, t) {
  const clamped = Math.max(0, Math.min(1, t));
  return a.map((value, index) => Math.round(value + (b[index] - value) * clamped));
}

function setPixel(rgba, width, x, y, [r, g, b, a]) {
  const index = (y * width + x) * 4;
  rgba[index] = r;
  rgba[index + 1] = g;
  rgba[index + 2] = b;
  rgba[index + 3] = a;
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr(width, height)),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function ihdr(width, height) {
  const buffer = Buffer.alloc(13);
  buffer.writeUInt32BE(width, 0);
  buffer.writeUInt32BE(height, 4);
  buffer[8] = 8;
  buffer[9] = 6;
  buffer[10] = 0;
  buffer[11] = 0;
  buffer[12] = 0;
  return buffer;
}

function chunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const buffer = Buffer.alloc(12 + data.length);
  buffer.writeUInt32BE(data.length, 0);
  name.copy(buffer, 4);
  data.copy(buffer, 8);
  buffer.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return buffer;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function icoFromPng(png) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = 32;
  header[7] = 32;
  header[8] = 0;
  header[9] = 0;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}
