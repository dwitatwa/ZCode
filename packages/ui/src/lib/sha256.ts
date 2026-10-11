/**
 * 浏览器侧 SHA-256：优先 WebCrypto（crypto.subtle），非安全上下文回退纯 JS 实现。
 *
 * 修复依据：WebCrypto 规范规定 crypto.subtle 仅在安全上下文（https / localhost）暴露，
 * Web 预览经 http://<lan-or-tailscale-ip>:port 远程访问时 subtle 为 undefined。
 * 附件上传事务第一步就要求 sha256 校验和（协议 begin/commit 均强制），此前在该场景
 * 每张图片都会抛 fault.attachment.checksumUnavailable；PPTX 元素指纹同理。
 * 与 useTaskSessionFilePath（workspace hash 改走 service）记录的是同一类问题，
 * 此处输入只能拿到浏览器内存字节，无法下放服务端，故提供本地回退实现。
 */

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const SHA256_H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** FIPS 180-4 SHA-256，输入可为带 offset 的 view，输出小写 hex。 */
function sha256DigestPure(bytes: Uint8Array): string {
  // 消息填充：原长 + 0x80 + 零 + 8 字节大端位长，凑齐 64 字节整数倍。
  const blockCount = Math.ceil((bytes.length + 9) / 64);
  const padded = new Uint8Array(blockCount * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = bytes.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bitLength / 4294967296));
  view.setUint32(padded.length - 4, bitLength % 4294967296);

  const words = new Uint32Array(64);
  const state = new Uint32Array(SHA256_H0);
  for (let block = 0; block < blockCount; block += 1) {
    const blockStart = block * 64;
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(blockStart + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const w15 = words[index - 15]!;
      const w2 = words[index - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) | 0;
    }
    let a = state[0]!;
    let b = state[1]!;
    let c = state[2]!;
    let d = state[3]!;
    let e = state[4]!;
    let f = state[5]!;
    let g = state[6]!;
    let h = state[7]!;
    for (let index = 0; index < 64; index += 1) {
      const bigS1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + bigS1 + choose + SHA256_K[index]! + words[index]!) | 0;
      const bigS0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (bigS0 + majority) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    state[0] = (state[0]! + a) | 0;
    state[1] = (state[1]! + b) | 0;
    state[2] = (state[2]! + c) | 0;
    state[3] = (state[3]! + d) | 0;
    state[4] = (state[4]! + e) | 0;
    state[5] = (state[5]! + f) | 0;
    state[6] = (state[6]! + g) | 0;
    state[7] = (state[7]! + h) | 0;
  }

  let hex = "";
  for (let index = 0; index < 8; index += 1) {
    hex += (state[index]! >>> 0).toString(16).padStart(8, "0");
  }
  return hex;
}

function toHex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** 对浏览器内存字节计算 SHA-256，返回小写 hex；非安全上下文自动走纯 JS 回退。 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    // WebCrypto 的 BufferSource 要求 ArrayBuffer；复制也避免调用期间底层 view 被复用。
    return toHex(await subtle.digest("SHA-256", Uint8Array.from(bytes).buffer));
  }
  return sha256DigestPure(bytes);
}
