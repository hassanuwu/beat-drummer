"""
rig_hand.py - turn a raw hand OBJ into the .bin/.json pair the page loads.

    python3 tools/rig_hand.py model.obj mummy  --target 52000
    python3 tools/rig_hand.py cyborg.obj cyborg --target 52000 --crop-axis 2 --crop-min 20

What it does, in order:

  1. load the OBJ and triangulate it
  2. optionally crop (some models come mounted on a stand) and keep the largest
     connected piece
  3. decimate by vertex clustering, because triangle indices must fit in 16 bits
  4. find the five fingertips by clustering the distal end IN SPACE. Walking the
     mesh surface instead is tempting, but a stray contact between two parts
     creates a shortcut that lets one digit annex another, and a detached
     fingertip shows up as a sixth digit.
  5. skin every vertex to its nearest fingertip (geodesically), with a weight
     that fades to zero at the knuckle
  6. rotate into a canonical frame: fingers along +z, palm facing -y. Finger
     direction comes from wrist -> knuckles, never knuckles -> tips, which
     points backwards on a curled hand.
  7. re-pose so all five fingertips rest at one height, then pitch the whole
     hand forward just enough that the fingertips are its lowest points - a
     hand that can actually reach the table it is resting on
  8. measure each finger's contact angle and write everything out

Needs numpy, scipy and matplotlib (matplotlib only for the preview image).
"""
import argparse
import numpy as np, heapq, json, os
import scipy.sparse as sp, scipy.sparse.csgraph as cs
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt

def largest_component(V, T):
    E = np.vstack([T[:,[0,1]],T[:,[1,2]],T[:,[2,0]]])
    A = sp.coo_matrix((np.ones(len(E)),(E[:,0],E[:,1])), shape=(len(V),len(V)))
    nc, lab = cs.connected_components(A, directed=False)
    keep = lab == np.argmax(np.bincount(lab))
    tm = keep[T].all(1); T = T[tm]
    idx = np.unique(T); remap = -np.ones(len(V), np.int64); remap[idx] = np.arange(len(idx))
    return V[idx], remap[T]

def crop(V, T, axis, lo):
    keep = V[:,axis] > lo
    tm = keep[T].all(1); T = T[tm]
    idx = np.unique(T); remap = -np.ones(len(V), np.int64); remap[idx] = np.arange(len(idx))
    return V[idx], remap[T]

def find_digits(V, adj, n, span, longaxis):
    """Fingertips = spatial clusters of the distal end. Clustering in space
    rather than along the mesh ignores stray contacts between parts and
    detached fragments, both of which break a purely geodesic search."""
    from collections import defaultdict
    lowv = V[:,longaxis] < V[:,longaxis].min() + span[longaxis]*0.03
    dw = dij(adj, n, list(np.where(lowv)[0]))
    ok = np.isfinite(dw); dw[~ok] = -1
    print(f"  wrist seeds={lowv.sum()}  reachable={ok.sum()}/{n}")

    def cluster(frac, cell):
        sel = np.where(dw > frac*dw.max())[0]
        g = np.floor(V[sel]/cell).astype(np.int64)
        cells = defaultdict(list)
        for i,k in enumerate(map(tuple,g)): cells[k].append(i)
        keys=list(cells); idx={k:i for i,k in enumerate(keys)}; par=list(range(len(keys)))
        def f(x):
            while par[x]!=x: par[x]=par[par[x]]; x=par[x]
            return x
        for k in keys:
            for dx in(-1,0,1):
                for dy in(-1,0,1):
                    for dz in(-1,0,1):
                        nb=(k[0]+dx,k[1]+dy,k[2]+dz)
                        if nb in idx:
                            a,b=f(idx[k]),f(idx[nb])
                            if a!=b: par[b]=a
        gr=defaultdict(list)
        for k in keys:
            for i in cells[k]: gr[f(idx[k])].append(i)
        gs=[g for g in sorted(gr.values(),key=len,reverse=True) if len(g)>max(120,n//400)]
        return [int(sel[g][np.argmax(dw[sel[g]])]) for g in gs]

    best=None
    for frac in [0.60,0.55,0.50,0.65,0.45,0.70,0.40,0.75]:
        for cell in [span.max()*0.012, span.max()*0.022, span.max()*0.006]:
            t = cluster(frac, cell)
            if len(t)==5: best=t; print(f"  five tips at frac={frac} cell={cell:.2f}"); break
            if best is None and len(t)>5: best=t[:5]
        if best and len(best)==5: break
    return (best or []), dw

def canonicalize(V, tips, pivots, palmmask, dw):
    """fingers -> +z, palm faces -y.

    Finger direction comes from wrist -> knuckles, not knuckles -> tips: on a
    curled hand the tips fold back and that vector points the wrong way. The
    palm normal comes from the flat slab of the palm itself."""
    wristC = V[dw < 0.14*dw.max()].mean(0)
    knuckC = pivots[1:].mean(0)
    f = knuckC - wristC; f /= np.linalg.norm(f)

    P = V[palmmask]
    P = P - P.mean(0)
    nrm = np.linalg.svd(P[np.random.default_rng(0).choice(len(P), min(len(P),20000), replace=False)],
                        full_matrices=False)[2][2]          # thinnest direction of the slab
    nrm -= f*np.dot(nrm, f); nrm /= np.linalg.norm(nrm)

    d = V[tips[1:]].mean(0) - knuckC                        # where the fingers fold
    if np.dot(d, nrm) < 0: nrm = -nrm                       # ...toward the palm
    yv = -nrm
    xv = np.cross(yv, f); xv /= np.linalg.norm(xv)
    return np.stack([xv, yv, f])

def run(objpath, out, target, crop_axis=None, crop_lo=None, z_span=1.572, rest_frac=0.26, thumb_reach=0.52):
    print(f"\n=== {out} ===")
    V,T = load_obj(objpath)
    print(f"  loaded {len(V)} verts, {len(T)} tris")
    if crop_axis is not None:
        V,T = crop(V,T,crop_axis,crop_lo); print(f"  cropped -> {len(V)} verts")
    V,T = largest_component(V,T); print(f"  main component -> {len(V)} verts")
    V,T = decimate(V,T,target)
    V,T = largest_component(V,T); print(f"  after decimate -> {len(V)} verts, {len(T)} tris")
    n=len(V); adj=build_adj(V,T); span=V.max(0)-V.min(0); L=int(np.argmax(span))
    print(f"  long axis {'xyz'[L]}  span {np.round(span,2)}")

    tips,dw = find_digits(V,adj,n,span,L)
    if len(tips)<5: print("  !! found only",len(tips),"tips"); return None
    cand=[(t,float(dw[t]),V[t]) for t in tips]
    def residual(k):
        P=np.array([c[2] for j,c in enumerate(cand) if j!=k])
        c0=P.mean(0); d=np.linalg.svd(P-c0)[2][0]
        v=cand[k][2]-c0
        return np.linalg.norm(v-d*np.dot(v,d))
    ti=int(np.argmax([residual(k) for k in range(5)]))
    thumb=cand[ti]; others=[c for j,c in enumerate(cand) if j!=ti]
    print(f"  thumb picked by off-line residual: {np.round(thumb[2],2)}")
    P4=np.array([o[2] for o in others])
    sdir=np.linalg.svd(P4-P4.mean(0))[2][0]          # the line the four tips lie along
    proj=[float(np.dot(o[2],sdir)) for o in others]
    order=np.argsort(proj)
    # index is whichever end sits nearest the thumb
    if np.linalg.norm(P4[order[0]]-thumb[2]) > np.linalg.norm(P4[order[-1]]-thumb[2]):
        order=order[::-1]
    D=[thumb]+[others[k] for k in order]
    for nm,(vi,dd,p) in zip(NAMES,D): print(f"  {nm:7s} depth={dd:6.2f} xyz={np.round(p,2)}")

    def skin(V):
        Ln=np.array([thumb_reach if i==0 else 0.46 for i in range(5)])*np.array([d[1] for d in D])
        dist=np.stack([dij(adj,n,[vi]) for vi,_,_ in D])
        dist[~np.isfinite(dist)]=1e9
        fg=np.argmin(dist,axis=0).astype(np.uint8)
        r=np.clip(dist[fg,np.arange(n)]/Ln[fg],0,1)
        w=1.0-r; w=w*w*(3-2*w); palm=r>=1.0; fg[palm]=0; w[palm]=0.0
        return fg,w
    finger,w = skin(V)
    print("  verts/digit:",[int(((finger==i)&(w>0)).sum()) for i in range(5)],"palm",int((w==0).sum()))

    def knuckles(V):
        pv=[]
        for i in range(5):
            band=(finger==i)&(w>0.02)&(w<0.22)
            if band.sum()<20: band=(finger==i)&(w>0.0)&(w<0.45)
            if band.sum()<20: band=(finger==i)&(w>0.0)
            pv.append(V[band].mean(0) if band.sum()>5 else V[D[i][0]])
        return np.array(pv)

    R = canonicalize(V, [d[0] for d in D], knuckles(V), w==0, dw)
    V = V @ R.T
    print("  canonical bbox", np.round(V.min(0),2), np.round(V.max(0),2))

    piv = knuckles(V); ax=[]
    for i in range(5):
        dd=V[D[i][0]]-piv[i]; dd/=np.linalg.norm(dd)
        a=np.cross(dd,[0.0,-1.0,0.0]); a/=np.linalg.norm(a); ax.append(a)
    ax=np.array(ax)

    nrm=np.zeros((n,3))
    fn=np.cross(V[T[:,1]]-V[T[:,0]], V[T[:,2]]-V[T[:,0]])
    for k in range(3): np.add.at(nrm,T[:,k],fn)
    nl=np.linalg.norm(nrm,axis=1,keepdims=True); nl[nl==0]=1; nrm/=nl

    sz=V[:,2].max()-V[:,2].min()
    TABLE=V[w==0][:,1].min()
    Y_REST=TABLE+sz*0.085
    th0=[]
    for i in range(5):
        tp=V[D[i][0]]; ths=np.linspace(-1.6,1.1,541)
        ys=np.array([rot(tp,piv[i],ax[i],t)[1] for t in ths])
        err=np.abs(ys-Y_REST)+np.abs(ths)*0.02
        th0.append(float(ths[np.argmin(err)]))
    print("  re-pose deg:",[round(np.degrees(t),1) for t in th0])
    for i in range(5):
        m=(finger==i)&(w>0)
        if not m.any(): continue
        k=ax[i]/np.linalg.norm(ax[i]); th=th0[i]*w[m]
        c,s2=np.cos(th)[:,None],np.sin(th)[:,None]
        P=V[m]-piv[i]
        V[m]=piv[i]+P*c+np.cross(np.broadcast_to(k,P.shape),P)*s2+k[None,:]*(P@k)[:,None]*(1-c)
        Nv=nrm[m]
        nrm[m]=Nv*c+np.cross(np.broadcast_to(k,Nv.shape),Nv)*s2+k[None,:]*(Nv@k)[:,None]*(1-c)
    nrm/=np.linalg.norm(nrm,axis=1,keepdims=True)

    # A drumming hand sits wrist-up, fingers-down. Find the smallest forward
    # pitch that makes the fingertips the lowest thing on the hand, so they can
    # actually reach the table without the palm sinking through it.
    wristC = V[dw < 0.14*dw.max()].mean(0)
    fingertip_ids = [D[i][0] for i in range(5)]
    tipmask = np.zeros(len(V), bool)
    for i in range(5): tipmask |= (finger==i) & (w > 0.55)
    def pitched(phi):
        k = np.array([1.0,0,0])
        P = V - wristC
        c,s2 = np.cos(phi), np.sin(phi)
        return wristC + P*c + np.cross(np.broadcast_to(k,P.shape),P)*s2 + k[None,:]*(P@k)[:,None]*(1-c)
    best_phi = 0.0
    for phi in np.linspace(0, 0.9, 91):
        Vp = pitched(phi)
        pivp = wristC + (lambda P,c,s2,k: P*c + np.cross(np.broadcast_to(k,P.shape),P)*s2 + k[None,:]*(P@k)[:,None]*(1-c))(piv-wristC, np.cos(phi), np.sin(phi), np.array([1.0,0,0]))
        axp = ax.copy()
        lows=[]
        for i in range(5):
            tp=Vp[fingertip_ids[i]]
            lows.append(min(rot(tp,pivp[i],axp[i],t)[1] for t in np.linspace(0,0.75,76)))
        body_min = Vp[~tipmask][:,1].min()
        if max(lows) <= body_min:
            best_phi = float(phi); break
        best_phi = float(phi)
    print(f"  forward pitch {np.degrees(best_phi):.1f} deg")
    V = pitched(best_phi)
    k=np.array([1.0,0,0]); c,s2=np.cos(best_phi),np.sin(best_phi)
    P=piv-wristC
    piv = wristC + P*c + np.cross(np.broadcast_to(k,P.shape),P)*s2 + k[None,:]*(P@k)[:,None]*(1-c)
    nrm = nrm*c + np.cross(np.broadcast_to(k,nrm.shape),nrm)*s2 + k[None,:]*(nrm@k)[:,None]*(1-c)
    ax  = ax*c + np.cross(np.broadcast_to(k,ax.shape),ax)*s2 + k[None,:]*(ax@k)[:,None]*(1-c)

    TABLE=V[:,1].min()-sz*0.004
    contact=[]
    for i in range(5):
        tp=V[D[i][0]]; ths=np.linspace(0,1.2,1201)
        ys=np.array([rot(tp,piv[i],ax[i],t)[1] for t in ths])
        hit=np.where(ys<=TABLE)[0]
        contact.append(float(ths[hit[0]]) if len(hit) else float(ths[np.argmin(ys)]))
    print("  contact deg:",[round(np.degrees(c),1) for c in contact])
    for i in range(5):
        tp=V[D[i][0]]; ths=np.linspace(0,1.2,601)
        lo=min(rot(tp,piv[i],ax[i],t)[1] for t in ths)
        print(f"    {NAMES[i]:7s} rest y={tp[1]:+.3f} lowest reachable {lo:+.3f}  table {TABLE:+.3f}  gap {lo-TABLE:+.3f}")

    S=z_span/(V[:,2].max()-V[:,2].min())
    ctr=np.array([(V[:,0].min()+V[:,0].max())/2, TABLE, (V[:,2].min()+V[:,2].max())/2])
    Vo=(V-ctr)*S; pivo=(piv-ctr)*S; tips_pos=Vo[[d[0] for d in D]]

    mn, mx = Vo.min(0), Vo.max(0)
    sc = (mx-mn)/65534.0
    assert len(Vo) < 65536, f"{len(Vo)} vertices: too many for 16-bit indices, lower --target"
    q  = np.round((Vo-mn)/sc).astype(np.uint16)
    qn = np.clip(np.round(nrm*127), -127, 127).astype(np.int8)
    qf = finger.astype(np.uint8)
    qw = np.clip(np.round(w*255), 0, 255).astype(np.uint8)
    qi = T.astype(np.uint16)

    # Both 16-bit blocks go first. A Uint16Array view must start on an even byte
    # offset, and the single-byte blocks would push the second one odd whenever
    # the vertex count is odd.
    blob = q.tobytes() + qi.tobytes() + qn.tobytes() + qf.tobytes() + qw.tobytes()

    meta = {"n": int(len(Vo)), "t": int(len(T)), "name": out,
            "min": [round(float(x),6) for x in mn], "sc": [float(x) for x in sc],
            "piv": [[round(float(x),4) for x in p] for p in pivo],
            "axis": [[round(float(x),4) for x in a] for a in ax],
            "contact": [round(float(c),4) for c in contact],
            "tip": [[round(float(x),4) for x in t] for t in tips_pos],
            "bbox": [[round(float(x),3) for x in mn], [round(float(x),3) for x in mx]],
            "layout": ["position:uint16[n*3]", "index:uint16[t*3]", "normal:int8[n*3]",
                       "finger:uint8[n]", "weight:uint8[n]"]}
    os.makedirs("assets", exist_ok=True)
    open(f"assets/{out}.bin", "wb").write(blob)
    json.dump(meta, open(f"assets/{out}.json", "w"), separators=(",", ":"))
    print(f"  wrote assets/{out}.bin ({len(blob)/1e6:.2f} MB) and assets/{out}.json")
    print(f"  bbox {meta['bbox']}")


    cols=np.array([[1,.35,.24],[1,.62,.18],[1,.82,.29],[.47,.84,.64],[.42,.73,.92]])
    C=np.where(w[:,None]>0.02,cols[finger]*(0.35+0.65*w[:,None]),np.array([.45,.42,.40]))
    fig,axs=plt.subplots(1,3,figsize=(17,6))
    for a,(i,j,t) in zip(axs,[(0,1,"front"),(2,1,"side"),(0,2,"top")]):
        o=np.argsort(Vo[:,[k for k in range(3) if k not in (i,j)][0]])
        a.scatter(Vo[o,i],Vo[o,j],s=1.0,c=C[o]); a.set_aspect("equal")
        a.set_title(out+" "+t); a.grid(alpha=.2)
        if j==1: a.axhline(0,ls="--",c="k",lw=1.2)
    plt.tight_layout(); plt.savefig(out+"_rig.png",dpi=80); plt.close()
    return meta

NAMES = ["thumb","index","middle","ring","pinky"]

def load_obj(path):
    V=[]; F=[]
    for line in open(path):
        if line.startswith("v "): V.append([float(x) for x in line.split()[1:4]])
        elif line.startswith("f "):
            vi=[int(t.split("/")[0])-1 for t in line.split()[1:]]
            for k in range(1,len(vi)-1): F.append((vi[0],vi[k],vi[k+1]))
    return np.array(V,float), np.array(F,np.int64)

def decimate(V, T, target):
    """vertex clustering: snap to a grid, keep one representative per cell"""
    if len(V) <= target: return V, T
    lo, hi = V.min(0), V.max(0)
    span = hi-lo
    c_lo, c_hi = span.min()/900, span.max()/8
    for _ in range(40):
        c = (c_lo+c_hi)/2
        keys = np.floor((V-lo)/c).astype(np.int64)
        uniq = len(np.unique(keys[:,0]*73856093 ^ keys[:,1]*19349663 ^ keys[:,2]*83492791))
        if uniq > target: c_lo = c
        else: c_hi = c
    keys = np.floor((V-lo)/c).astype(np.int64)
    h = keys[:,0]*73856093 ^ keys[:,1]*19349663 ^ keys[:,2]*83492791
    _, inv, cnt = np.unique(h, return_inverse=True, return_counts=True)
    n = len(cnt)
    P = np.zeros((n,3))
    np.add.at(P, inv, V)
    P /= cnt[:,None]
    T2 = inv[T]
    keep = (T2[:,0]!=T2[:,1]) & (T2[:,1]!=T2[:,2]) & (T2[:,0]!=T2[:,2])
    print(f"  decimate: {len(V)} -> {n} verts, {len(T)} -> {keep.sum()} tris (cell {c:.4f})")
    return P, T2[keep]

def build_adj(V, T):
    adj = [[] for _ in range(len(V))]
    E = np.vstack([T[:,[0,1]], T[:,[1,2]], T[:,[2,0]]])
    E = np.unique(np.sort(E,axis=1), axis=0)
    W = np.linalg.norm(V[E[:,0]]-V[E[:,1]], axis=1)
    for (a,b),w in zip(E,W):
        adj[a].append((b,w)); adj[b].append((a,w))
    return adj

def dij(adj, n, srcs, limit=np.inf):
    d = np.full(n, np.inf); h=[]
    for s in srcs: d[s]=0.0; heapq.heappush(h,(0.0,s))
    while h:
        du,u = heapq.heappop(h)
        if du>d[u] or du>limit: continue
        for v,w in adj[u]:
            nd=du+w
            if nd<d[v]-1e-9: d[v]=nd; heapq.heappush(h,(nd,v))
    return d

def rot(p, piv, ax, th):
    k = ax/np.linalg.norm(ax); v = p-piv; c,s = np.cos(th), np.sin(th)
    return piv + v*c + np.cross(k,v)*s + k*np.dot(k,v)*(1-c)



if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="rig a hand OBJ for Table Drummer")
    ap.add_argument("obj")
    ap.add_argument("name", help="output name, e.g. mummy (writes assets/<name>.bin/.json)")
    ap.add_argument("--target", type=int, default=52000, help="vertex budget (must stay under 65536)")
    ap.add_argument("--crop-axis", type=int, default=None, help="0=x 1=y 2=z: drop everything below --crop-min")
    ap.add_argument("--crop-min", type=float, default=None)
    ap.add_argument("--thumb-reach", type=float, default=0.52,
                    help="how much of the thumb follows its bend; raise it for a stiff mechanical thumb")
    a = ap.parse_args()
    run(a.obj, a.name, a.target, crop_axis=a.crop_axis, crop_lo=a.crop_min, thumb_reach=a.thumb_reach)
