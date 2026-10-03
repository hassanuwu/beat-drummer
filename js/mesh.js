/**
 * Loader for the rigged hand meshes in assets/.
 *
 * Each hand is a .json of metadata plus a .bin of packed vertex data, written
 * by tools/rig_hand.py. The binary layout is, in order:
 *
 *   position  uint16[n*3]   quantised; world = min + value * sc
 *   index     uint16[t*3]   triangle indices
 *   normal    int8[n*3]     divided by 127
 *   finger    uint8[n]      0..4, which digit this vertex belongs to
 *   weight    uint8[n]      divided by 255, how much of the bend it follows
 *
 * The two 16-bit blocks come first on purpose. A Uint16Array view must start on
 * an even byte offset, and the single-byte blocks would push the second one odd
 * whenever the vertex count is odd.
 */
export async function loadMesh(name, base = "assets/") {
  const [meta, buf] = await Promise.all([
    fetch(`${base}${name}.json`).then(r => {
      if (!r.ok) throw new Error(`${name}.json: ${r.status}`);
      return r.json();
    }),
    fetch(`${base}${name}.bin`).then(r => {
      if (!r.ok) throw new Error(`${name}.bin: ${r.status}`);
      return r.arrayBuffer();
    })
  ]);

  const n = meta.n, t = meta.t;
  const expected = n * 6 + t * 6 + n * 3 + n + n;
  if (buf.byteLength !== expected) {
    throw new Error(`${name}.bin is ${buf.byteLength} bytes, expected ${expected}`);
  }

  let o = 0;
  const qp = new Uint16Array(buf, o, n * 3); o += n * 6;
  const qi = new Uint16Array(buf, o, t * 3); o += t * 6;
  const qn = new Int8Array(buf, o, n * 3);   o += n * 3;
  const qf = new Uint8Array(buf, o, n);      o += n;
  const qw = new Uint8Array(buf, o, n);

  const position = new Float32Array(n * 3);
  const normal   = new Float32Array(n * 3);
  const finger   = new Float32Array(n);
  const weight   = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      position[i * 3 + k] = meta.min[k] + qp[i * 3 + k] * meta.sc[k];
      normal[i * 3 + k] = qn[i * 3 + k] / 127;
    }
    finger[i] = qf[i];
    weight[i] = qw[i] / 255;
  }

  return { meta, position, normal, finger, weight, index: new Uint16Array(qi) };
}
