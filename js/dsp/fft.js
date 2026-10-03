/**
 * In-place iterative radix-2 FFT.
 *
 * re and im are the real and imaginary parts of the signal; both are
 * overwritten with the transform. Length must be a power of two.
 *
 * Two stages: first reorder the samples by bit-reversed index, then combine
 * them in butterflies of growing size (2, 4, 8, ... n). The twiddle factor is
 * advanced by repeated complex multiplication rather than calling cos/sin per
 * butterfly, which is most of the speed.
 */
export function fft(re, im) {
  const n = re.length;

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < half; j++) {
        const ur = re[i + j],        ui = im[i + j];
        const xr = re[i + j + half], xi = im[i + j + half];
        const vr = xr * cr - xi * ci;
        const vi = xr * ci + xi * cr;
        re[i + j] = ur + vr; im[i + j] = ui + vi;
        re[i + j + half] = ur - vr; im[i + j + half] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Hann window of length n, used to taper each analysis frame. */
export function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
  return w;
}
