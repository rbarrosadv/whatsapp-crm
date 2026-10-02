// Converte o áudio gravado pelo Chromium (WebM/Opus) para OGG/Opus, que é
// o formato que o WhatsApp usa em mensagens de voz. Não recodifica nada:
// só tira os pacotes Opus de dentro do WebM e empacota em páginas OGG.

const ID = {
  Segment: 0x18538067,
  Cluster: 0x1f43b675,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  CodecPrivate: 0x63a2,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
};
const MASTER = new Set([ID.Segment, ID.Cluster, ID.Tracks, ID.TrackEntry, ID.BlockGroup]);

function readVint(buf, pos, keepMarker) {
  const first = buf[pos];
  if (first === undefined) return null;
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
  if (len > 8) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) {
    const b = buf[pos + i];
    if (b !== 0xff) allOnes = false;
    value = value * 256 + b;
  }
  return { value, len, unknown: !keepMarker && allOnes };
}

export function extractOpus(webm) {
  const packets = [];
  let opusHead = null;

  function walk(start, end) {
    let pos = start;
    while (pos < end) {
      const id = readVint(webm, pos, true);
      if (!id) return;
      const size = readVint(webm, pos + id.len, false);
      if (!size) return;
      const dataStart = pos + id.len + size.len;
      const dataEnd = size.unknown ? end : Math.min(end, dataStart + size.value);
      if (MASTER.has(id.value)) {
        walk(dataStart, dataEnd);
      } else if (id.value === ID.CodecPrivate) {
        opusHead = webm.subarray(dataStart, dataEnd);
      } else if (id.value === ID.SimpleBlock || id.value === ID.Block) {
        const track = readVint(webm, dataStart, false);
        const headerLen = track.len + 3; // track + timecode(2) + flags(1)
        packets.push(webm.subarray(dataStart + headerLen, dataEnd));
      }
      pos = dataEnd;
    }
  }
  walk(0, webm.length);
  return { opusHead, packets };
}

// Quantas amostras (a 48 kHz) um pacote Opus representa, pelo byte TOC.
function samplesPerPacket(pkt) {
  if (!pkt.length) return 0;
  const toc = pkt[0];
  const config = toc >> 3;
  let frameSize;
  if (config < 12) frameSize = [480, 960, 1920, 2880][config & 3]; // SILK
  else if (config < 16) frameSize = [480, 960][config & 1]; // híbrido
  else frameSize = [120, 240, 480, 960][config & 3]; // CELT
  const code = toc & 3;
  let frames = 1;
  if (code === 1 || code === 2) frames = 2;
  else if (code === 3) frames = pkt.length > 1 ? pkt[1] & 0x3f : 1;
  return frameSize * frames;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}

function oggPage(packets, { serial, seq, granule, bos, eos }) {
  const segs = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) { segs.push(255); n -= 255; }
    segs.push(n);
  }
  const header = Buffer.alloc(27 + segs.length);
  header.write('OggS', 0, 'ascii');
  header[4] = 0;
  header[5] = (bos ? 2 : 0) | (eos ? 4 : 0);
  header.writeBigInt64LE(BigInt(granule), 6);
  header.writeUInt32LE(serial, 14);
  header.writeUInt32LE(seq, 18);
  header.writeUInt32LE(0, 22);
  header[26] = segs.length;
  segs.forEach((s, i) => { header[27 + i] = s; });
  const page = Buffer.concat([header, ...packets]);
  page.writeUInt32LE(crc32(page), 22);
  return page;
}

function defaultOpusHead() {
  const h = Buffer.alloc(19);
  h.write('OpusHead', 0, 'ascii');
  h[8] = 1; // versão
  h[9] = 1; // canais
  h.writeUInt16LE(0, 10); // pre-skip
  h.writeUInt32LE(48000, 12);
  h.writeInt16LE(0, 16);
  h[18] = 0;
  return h;
}

/** @returns {{ogg: Buffer, seconds: number}} */
export function webmToOgg(webmBuf) {
  const webm = Buffer.from(webmBuf);
  const { opusHead, packets } = extractOpus(webm);
  if (!packets.length) throw new Error('Áudio vazio');
  const head = opusHead && opusHead.subarray(0, 8).toString('ascii') === 'OpusHead'
    ? Buffer.from(opusHead) : defaultOpusHead();
  const vendor = Buffer.from('whatsapp-crm');
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
  tags.write('OpusTags', 0, 'ascii');
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + vendor.length);

  const serial = (Math.random() * 0xffffffff) >>> 0;
  let seq = 0;
  const pages = [
    oggPage([head], { serial, seq: seq++, granule: 0, bos: true }),
    oggPage([tags], { serial, seq: seq++, granule: 0 }),
  ];
  let granule = 0;
  let batch = [];
  let segCount = 0;
  packets.forEach((p, i) => {
    const segsNeeded = Math.floor(p.length / 255) + 1;
    if (segCount + segsNeeded > 255) {
      pages.push(oggPage(batch, { serial, seq: seq++, granule }));
      batch = [];
      segCount = 0;
    }
    batch.push(p);
    segCount += segsNeeded;
    granule += samplesPerPacket(p);
    if (i === packets.length - 1) pages.push(oggPage(batch, { serial, seq: seq++, granule, eos: true }));
  });
  const preSkip = head.readUInt16LE(10);
  return { ogg: Buffer.concat(pages), seconds: Math.max(1, Math.round((granule - preSkip) / 48000)) };
}
