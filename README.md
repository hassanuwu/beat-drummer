Table Drummer

Load a song and a 3D hand drums along to it on a table. Each frequency band gets its own finger — kick on the thumb, hi-hats on the pinky.

Everything runs in the browser. Nothing gets uploaded.

The idea

On the bus home from uni I noticed I was tapping the seat in front of me to whatever was in my headphones. Thumb on the kick, fingers on the hats, without deciding to. Everyone does this.

Seemed like something you could actually compute, so I did.

How it works

Finding the beats. Every 10 ms, FFT a 1024-sample window. Subtract the previous frame's spectrum, keep only the rises, sum them per frequency band. That's spectral flux — it spikes when a drum lands. Peaks in it are the taps. No machine learning; a beat is a detection problem, not a prediction problem.

Finger	Band	Catches
Thumb	20–120 Hz	kick
Index	120–400 Hz	toms, bass
Middle	400–1200 Hz	snare body
Ring	1.2–3.5 kHz	snare crack
Pinky	3.5–14 kHz	hi-hats

Moving the fingers. Not keyframed. Each finger is a torsion spring:

θ'' = −k·θ − c·θ'        k = ωₙ², c = 2ζωₙ

A beat applies an impulse, the table is a hard stop with restitution, the spring pulls it back. Same system as a series RLC circuit, and both sliders are the real parameters — drag ζ from 0.06 to 1.1 and watch it go from ringing to dead.

The hand strikes ~46 ms early, so contact lands on the beat instead of after it. Drummers anticipate too.

The hand came as a plain mesh with no skeleton, so tools/rig_hand.py builds one: walk the mesh with Dijkstra from the wrist to find the fingertips, skin every vertex to its nearest one, then re-pose it so the fingers can actually reach the table. The bending itself happens in the vertex shader — one draw call.

Running it
bash
python3 -m http.server 8000     # then open localhost:8000

It needs a server because the meshes load with fetch. If you just want to run it, double-click standalone/table-drummer.html instead — same app, one file.

Watch mode drums for you. Play mode you tap A S D F G and get scored. Drag the hand to orbit.

Checks
bash
node tools/selftest.mjs    # tempo, onsets, spring reach, asset integrity
node tools/smoke.mjs       # boots the app with no browser
Stuff it doesn't do well

Tempo is estimated once and never updated, so it breaks on songs that change speed. Dense tracks give you sixty hi-hat taps where a person would play eight — flux knows something happened, not what a human would choose to play. Fixing that properly means learning from real tapping, which is the next version if there is one.

Credits

Hand models are third-party assets, used as-is — check their licences before reusing. Built while working through signals and systems.
