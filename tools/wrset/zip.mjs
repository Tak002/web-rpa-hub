// 진행 세트(.wrset)용 최소 zip 읽기·쓰기. 의존성 없음 — 허브 저장소의 CI 도 이 파일을 그대로 쓴다.
//   쓰기: 이름 순서·고정 시각·deflate 로 묶어 같은 내용이면 항상 같은 바이트(같은 sha256)가 나온다.
//   읽기: 경로 탈출(../, 절대 경로)과 지나치게 큰 압축을 거절한다.

import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const UTF8_FLAG = 0x0800;

/**
 * @param {{name: string, data: Buffer|string}[]} entries
 * @returns {Buffer}
 */
export function writeZip(entries) {
  const files = entries.map((e) => ({ name: e.name.replaceAll('\\', '/'), data: Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8') })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const local = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const deflated = zlib.deflateRawSync(f.data, { level: 9 });
    const useDeflate = deflated.length < f.data.length;
    const body = useDeflate ? deflated : f.data;
    const crc = crc32(f.data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(UTF8_FLAG, 6);
    head.writeUInt16LE(useDeflate ? 8 : 0, 8);
    head.writeUInt16LE(DOS_TIME, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(f.data.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    local.push(head, name, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(UTF8_FLAG, 8);
    cen.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cen.writeUInt16LE(DOS_TIME, 12);
    cen.writeUInt16LE(DOS_DATE, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(f.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += head.length + name.length + body.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cenBuf, end]);
}

/**
 * @param {Buffer} buf
 * @param {{maxEntries?: number, maxTotal?: number}} [limits]
 * @returns {Map<string, Buffer>}
 */
export function readZip(buf, { maxEntries = 300, maxTotal = 30 * 1024 * 1024 } = {}) {
  const fail = (m) => {
    throw Object.assign(new Error(`압축 파일을 읽지 못했습니다: ${m}`), { status: 400 });
  };
  if (!Buffer.isBuffer(buf) || buf.length < 22) fail('너무 작습니다');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) fail('zip 형식이 아닙니다');
  const count = buf.readUInt16LE(eocd + 10);
  const cenSize = buf.readUInt32LE(eocd + 12);
  let p = buf.readUInt32LE(eocd + 16);
  if (count > maxEntries) fail(`파일이 너무 많습니다 (${count}개)`);
  if (p + cenSize > buf.length) fail('목록이 잘렸습니다');
  const out = new Map();
  let total = 0;
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) fail('목록이 깨졌습니다');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const loc = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8').replaceAll('\\', '/');
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue; // 폴더 항목
    if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.split('/').includes('..')) fail(`허용하지 않는 경로: ${name}`);
    total += usize;
    if (total > maxTotal) fail('풀었을 때 크기가 너무 큽니다');
    if (buf.readUInt32LE(loc) !== 0x04034b50) fail(`${name} 의 머리가 깨졌습니다`);
    const start = loc + 30 + buf.readUInt16LE(loc + 26) + buf.readUInt16LE(loc + 28);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: maxTotal });
    else fail(`${name}: 지원하지 않는 압축 방식 ${method}`);
    if (data.length !== usize || crc32(data) !== crc) fail(`${name} 의 내용이 손상됐습니다`);
    out.set(name, data);
  }
  return out;
}
