/**
 * A synthesised drum loop, so the page has something to analyse on load.
 *
 * Eight bars of 4/4 at 120 BPM: kick on 1 and 3 with a syncopated push every
 * other bar, snare on 2 and 4, eighth-note hats, and a tom fill in the last
 * bar. Written straight into an AudioBuffer rather than scheduled, so the same
 * analysis path runs over it as over a loaded file.
 */
export function makeDemo(ctx){
  const sr = ctx.sampleRate, bars = 8, beat = 0.5;
  const dur = bars*4*beat;
  const buf = ctx.createBuffer(1, Math.ceil(dur*sr)+sr/2, sr);
  const d = buf.getChannelData(0);
  const put = (i, v) => { if (i>=0 && i<d.length) d[i] += v; };

  function kick(t){
    const n = Math.floor(0.34*sr), i0 = Math.floor(t*sr);
    let ph = 0;
    for (let i=0; i<n; i++){
      const u = i/sr;
      const f = 45 + 125*Math.exp(-u*32);
      ph += 2*Math.PI*f/sr;
      put(i0+i, Math.sin(ph)*Math.exp(-u*8.5)*0.95);
    }
  }
  function snare(t){
    const n = Math.floor(0.2*sr), i0 = Math.floor(t*sr);
    let p = 0;
    for (let i=0; i<n; i++){
      const u = i/sr, r = Math.random()*2-1, hp = r-p; p = r;
      put(i0+i, (hp*0.75 + Math.sin(2*Math.PI*185*u)*0.4)*Math.exp(-u*23)*0.7);
    }
  }
  function hat(t, acc){
    const n = Math.floor(0.07*sr), i0 = Math.floor(t*sr);
    let p = 0;
    for (let i=0; i<n; i++){
      const u = i/sr, r = Math.random()*2-1, hp = r-p; p = r;
      put(i0+i, hp*Math.exp(-u*110)*(acc?0.4:0.22));
    }
  }
  function tom(t){
    const n = Math.floor(0.26*sr), i0 = Math.floor(t*sr);
    let ph = 0;
    for (let i=0; i<n; i++){
      const u = i/sr;
      ph += 2*Math.PI*(115 + 110*Math.exp(-u*14))/sr;
      put(i0+i, Math.sin(ph)*Math.exp(-u*11)*0.6);
    }
  }

  for (let bar=0; bar<bars; bar++){
    const b0 = bar*4;
    kick((b0)*beat); kick((b0+2)*beat);
    if (bar % 2 === 1) kick((b0+2.75)*beat);
    snare((b0+1)*beat); snare((b0+3)*beat);
    for (let h=0; h<8; h++) hat((b0+h*0.5)*beat, h%2===0);
    if (bar === 7){ for (let k=0; k<4; k++) tom((b0+3+k*0.25)*beat); }
  }
  for (let i=0; i<d.length; i++) d[i] = Math.max(-1, Math.min(1, d[i]*0.62));
  return buf;
}
