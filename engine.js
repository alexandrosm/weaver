"use strict";
/* ==========================================================================
 * engine.js — the weaver engine. The single source of truth for printed-
 * weave geometry: lattice → crossings → dashes → op stream → metrics,
 * G-code text, and the feasibility report.
 *
 * Two faces, one implementation:
 *   browser   loomwright.html loads this as a plain script and drives P
 *   terminal  bun engine.js --report | --json | --check | --gcode out.gcode
 *             (node works too; --ops emits the op stream for fcexport.py)
 *
 * This file is DOM-free by construction and must stay that way.
 *
 * COORDINATE CONVENTION — all z values are nozzle-tip heights with the tip
 * at the TOP of the feature being deposited: low dashes at sh, every post
 * grown to bh, bridges at bh + sh. See NOTES.md § 2.4.
 * ========================================================================== */
const SQ3 = Math.sqrt(3) / 2;
const FIL_AREA = Math.PI * Math.pow(1.75 / 2, 2);
const CREPE = [
  [1,0,1,1,0,0,1,0],[0,1,1,0,1,0,0,1],[1,1,0,0,1,1,0,0],[0,0,1,1,0,1,1,0],
  [1,0,0,1,1,0,0,1],[0,1,0,1,0,1,1,0],[1,1,0,0,1,0,0,1],[0,0,1,0,0,1,1,1]];
const DEFAULT_START_G = "G28 ; home\nG92 E0";
const DEFAULT_END_G = "M104 S0\nM140 S0\nM107";

const P = {
  lattice:"biaxial", pattern:"twill", pitch:3.6, size:30, rot:45,
  bd:0.9, bh:0.45, sw:0.40, sh:0.20,
  offd:false, offFrac:0.40, ovs:0.30, plies:1, pgap:0.25, tack:3, edge:true,
  nflat:0.80, ncone:120,
  ps:2400, bs:3600, ts:9000, pspd:300, pstep:3, pflow:1.10, acc:6000,
  ht:230, bt:100, fan:40, bed:[110,110], draft:CREPE.map(r=>r.slice())
};
const z1=()=>P.sh, zPost=()=>P.bh, z3=()=>P.bh+P.sh;
const offAmt=()=>P.offd?P.bd*P.offFrac:0;
const plyDz=k=>k*(P.bh+P.sh+P.pgap);

function families(){
  if(P.lattice==="triaxial") return [
    {n:[0,1],d:[1,0],ph:0},{n:[-SQ3,0.5],d:[0.5,SQ3],ph:0},
    {n:[-SQ3,-0.5],d:[0.5,-SQ3],ph:0.5}];   // half-pitch phase avoids triple points
  return [{n:[0,1],d:[1,0],ph:0},{n:[1,0],d:[0,1],ph:0}];
}
function liftRule(){
  const m=(a,b)=>((a%b)+b)%b;
  switch(P.pattern){
    case "plain": return (i,j)=>m(i+j,2)===0;
    case "twill": return (i,j)=>m(j-i,4)<2;
    case "satin": return (i,j)=>m(j-2*i,5)!==0;
    case "crepe": return (i,j)=>CREPE[m(j,8)][m(i,8)]===1;
    default:{const D=P.draft,N=D.length;return (i,j)=>D[m(j,N)][m(i,N)]===1;}
  }
}
function highAt(A,B,rule){
  if(P.lattice==="triaxial") return (A.f+1)%3===B.f;      // A over B over C over A
  const i=A.f===1?A.i:B.i, j=A.f===0?A.i:B.i;
  const wo=rule(i,j);
  return A.f===1?wo:!wo;
}
function buildLines(){
  const half=P.size/2,out=[];
  families().forEach((F,f)=>{
    const reach=Math.abs(F.n[0])*half+Math.abs(F.n[1])*half;
    const k0=Math.ceil((-reach-F.ph*P.pitch)/P.pitch),k1=Math.floor((reach-F.ph*P.pitch)/P.pitch);
    for(let k=k0;k<=k1;k++) out.push({f,i:k,n:F.n,d:F.d,c:(k+F.ph)*P.pitch});
  });
  return out;
}
function crossings(L,lines,rule){
  const half=P.size/2,p0=[L.c*L.n[0],L.c*L.n[1]],out=[];
  for(const M of lines){
    if(M.f===L.f) continue;
    const den=L.d[0]*M.n[0]+L.d[1]*M.n[1];
    if(Math.abs(den)<1e-9) continue;
    const t=(M.c-(p0[0]*M.n[0]+p0[1]*M.n[1]))/den;
    const x=p0[0]+t*L.d[0],y=p0[1]+t*L.d[1];
    if(Math.abs(x)>half+1e-9||Math.abs(y)>half+1e-9) continue;
    out.push({t,hi:highAt(L,M,rule)});
  }
  out.sort((a,b)=>a.t-b.t); return out;
}
function dashesForLine(L,xs){
  if(xs.length<2) return [];
  const ts=xs.map(o=>o.t),step=(ts[ts.length-1]-ts[0])/(ts.length-1);
  const mid=i=>i<0?ts[0]-step/2:(i>=ts.length-1?ts[ts.length-1]+step/2:(ts[i]+ts[i+1])/2);
  const runs=[];let s=0;
  for(let i=1;i<xs.length;i++) if(xs[i].hi!==xs[s].hi){runs.push([s,i-1,xs[s].hi]);s=i;}
  runs.push([s,xs.length-1,xs[s].hi]);
  const last=runs.length-1;
  // built in +t order with pass-1-forward flags, mirrored below for serpentine
  const out=runs.map(([a,b,hi],k)=>({L,pa:mid(a-1),pb:mid(b),hi,post:k<last,postS:k>0}));
  if(P.edge){
    // ground the edges: a thread must not end in the air (NOTES §8 phase 3).
    // A boundary run that is high gets a post at its existing end — the same
    // pitch/2 from the perpendicular family as every interior post, so the
    // clearance envelope is untouched — fed by a short low stub on the bed
    // just outside. Stubs and anchors ride the normal two-pass machinery: a
    // leading stub is a pass-1 low whose travel end grows the post; a
    // trailing anchor post is grown by pass 2 like any origin post.
    const q=step/4;
    const h0=out[0];
    if(h0.hi){
      h0.postS=true;
      out.unshift({L,pa:h0.pa-q,pb:h0.pa,hi:false,post:true,postS:false});
    }
    const hn=out[out.length-1];
    if(hn.hi){
      hn.post=true;
      out.push({L,pa:hn.pb,pb:hn.pb+q,hi:false,post:false,postS:true});
    }
  }
  const rev=(((L.i%2)+2)%2)===1;                     // serpentine alternate threads
  if(rev){
    for(const D of out){
      const t=D.pa;D.pa=D.pb;D.pb=t;
      const p=D.post;D.post=D.postS;D.postS=p;
    }
    out.reverse();
  }
  return out;
}
function allDashes(){
  const lines=buildLines(),rule=liftRule(),out=[];
  for(const L of lines) out.push(...dashesForLine(L,crossings(L,lines,rule)));
  return out;
}
/* every dash runs -offset -> +offset, so consecutive dashes meet on opposite
   sides of a post and the post chord becomes the return leg — that chord is
   the stored extension; without it the offset is a cosmetic zigzag. */
function dashPts(D){
  const n=D.L.n,d=D.L.d,p0=[D.L.c*n[0],D.L.c*n[1]],pp=[-d[1],d[0]],o=offAmt();
  return [[p0[0]+D.pa*d[0]-o*pp[0],p0[1]+D.pa*d[1]-o*pp[1]],
          [p0[0]+D.pb*d[0]+o*pp[0],p0[1]+D.pb*d[1]+o*pp[1]]];
}
const postC=D=>[D.L.c*D.L.n[0]+D.pb*D.L.d[0], D.L.c*D.L.n[1]+D.pb*D.L.d[1]];
function place(p,shift){
  const a=P.rot*Math.PI/180,ca=Math.cos(a),sa=Math.sin(a);
  const x=p[0]+shift,y=p[1]+shift;
  return [x*ca-y*sa,x*sa+y*ca];
}
const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
function segDist(p,a,b){
  const dx=b[0]-a[0],dy=b[1]-a[1],L2=dx*dx+dy*dy;
  let t=L2?((p[0]-a[0])*dx+(p[1]-a[1])*dy)/L2:0;
  t=Math.max(0,Math.min(1,t));
  return Math.hypot(a[0]+t*dx-p[0],a[1]+t*dy-p[1]);
}
const postVol=()=>{
  const cyl=Math.PI*Math.pow(P.bd/2,2)*P.bh,had=P.sw*P.sh*P.bd;
  return Math.max(0.02,(cyl-had)*P.pflow);
};
/* pass 1 (+t) low dashes, each growing the post at its travel end — to the
   button top, so during the rest of pass 1 it stands only (bh - sh) proud of
   the tip plane. pass 2 (-t) high dashes, each growing its own post from the
   bed at the far end to the same button top, climbing onto bridge height
   over roughly the button radius (so the ramp is local and the span stays
   level), then bridging back and landing on pass 1's post by draping onto
   its top from sh above. Opposite directions is what makes the two passes
   claim disjoint posts — and what keeps z-low travels out of printed-bridge
   airspace: the region ahead of the sweep is always unprinted. Reordering
   dashes breaks that invariant; see NOTES § 3. */
function toolpath(){
  const ds=allDashes(),vol=postVol(),ops=[],segs=[];
  const st={dash:0,bridge:0,travel:0,posts:0,nd:0};
  let cur=null;
  const travel=(xy,z)=>{
    if(cur&&Math.abs(cur.p[0]-xy[0])<1e-9&&Math.abs(cur.p[1]-xy[1])<1e-9&&Math.abs(cur.z-z)<1e-9) return;
    if(cur){st.travel+=dist(cur.p,xy);segs.push({a:cur.p,az:cur.z,b:xy,bz:z,k:"t"});}
    ops.push({o:"T",x:xy[0],y:xy[1],z});cur={p:xy,z};
  };
  const draw=(xy,z,f,k,fam)=>{
    if(cur) segs.push({a:cur.p,az:cur.z,b:xy,bz:z,k,fam});
    ops.push({o:"D",x:xy[0],y:xy[1],z,f});cur={p:xy,z};
  };
  const grow=(from,to,zf,zt,tackFrom)=>{
    const z0=tackFrom!=null?tackFrom:zf,n=Math.max(1,P.pstep);
    for(let i=0;i<n;i++){
      const fr=(i+1)/n;
      ops.push({o:"S",v:vol/n});
      draw([from[0]+(to[0]-from[0])*fr,from[1]+(to[1]-from[1])*fr],z0+(zt-z0)*fr,P.ps,"p");
    }
    st.posts++;
  };
  for(let ply=0;ply<P.plies;ply++){
    const dz=plyDz(ply),shift=(ply%2)?P.pitch/2:0;
    const zl=z1()+dz,zt=zPost()+dz,zh=z3()+dz;let pi=0;
    const put=p=>place(p,shift);
    // on upper plies a post has no bed under it; every Nth one starts from
    // the top of the ply below so the stack is pinned down (both passes)
    const tackZ=k=>(ply>0&&P.tack>0&&k%P.tack===0)?z3()+plyDz(ply-1):null;
    for(const D of ds){
      if(D.hi) continue;
      const [s0,e0]=dashPts(D),s=put(s0),e=put(e0);
      travel(s,zl);draw(e,zl,P.ps,"lo",D.L.f);
      st.dash+=dist(s,e);st.nd++;
      if(D.post){
        const c=put(postC(D));
        const ex=offAmt()>0?[2*c[0]-e[0],2*c[1]-e[1]]:c;
        grow(c,ex,zl,zt,tackZ(pi));pi++;
      }
    }
    for(let i=ds.length-1;i>=0;i--){
      const D=ds[i];if(!D.hi) continue;
      const [s0,e0]=dashPts(D),s=put(s0),e=put(e0);
      let bStart=e;                 // where the level part of the bridge begins
      if(D.post){
        const c=put(postC(D));
        const base=offAmt()>0?[2*c[0]-e[0],2*c[1]-e[1]]:c;
        travel(base,zl);grow(base,e,zl,zt,tackZ(pi));pi++;
        // climb out of the post over ~the button radius; a climb spread
        // across the whole span would hang the mid-bridge low and eat the
        // vertical gap
        const span=dist(s,e);
        if(span>1e-6){
          const ml=Math.min(P.bd/2,span*0.25);
          bStart=[e[0]+(s[0]-e[0])/span*ml,e[1]+(s[1]-e[1])/span*ml];
          draw(bStart,zh,P.bs,"hi",D.L.f);
        }
      } else travel(e,zh);
      let end=s;
      if(P.ovs>0&&D.postS){
        // run past the landing post's centre so the strand lies across the
        // full disc; skipped at free thread ends — nothing to land on there
        const L=dist(s,e);
        if(L>1e-6){const ov=P.bd*P.ovs;end=[s[0]+(s[0]-e[0])/L*ov,s[1]+(s[1]-e[1])/L*ov];}
      }
      draw(end,zh,P.bs,"hi",D.L.f);st.bridge+=dist(e,bStart)+dist(bStart,end);st.nd++;
    }
  }
  return {ops,segs,st,ds};
}
const moveTime=(L,v,a)=>{
  if(L<=0) return 0;
  const ta=v/a,da=0.5*a*ta*ta;
  return (2*da>=L)?2*Math.sqrt(L/a):2*ta+(L-2*da)/v;
};
const nozHalf=()=>(P.nflat+2*Math.max(0,P.bh-P.sh)*Math.tan(P.ncone*Math.PI/360))/2;
function metrics(tp){
  const ds=tp.ds,st=tp.st,area=Math.pow(P.size/10,2);
  let longest=0;const lows=[],posts=[],spans=[];
  for(const D of ds){
    const [s,e]=dashPts(D);spans.push(dist(s,e));
    if(D.hi) longest=Math.max(longest,dist(s,e)-P.bd); else lows.push([s,e]);
    if(D.post) posts.push(postC(D));
  }
  const excl=P.bd*0.75;let gap=Infinity;
  for(const [s,e] of lows) for(const c of posts){
    if(dist(c,s)<excl||dist(c,e)<excl) continue;
    const d=segDist(c,s,e);if(d<gap) gap=d;
  }
  if(!isFinite(gap)) gap=P.pitch;
  /* While pass 1 runs the tip sits at z = strand_h and pass-1 posts are grown
     to button_h, so a post stands (bh - sh) proud of the tip plane. */
  const nh=nozHalf(),need=P.bd/2+nh,clear=gap-need;
  const minPitch=gap>1e-9?P.pitch*need/gap:Infinity;
  const freeDia=Math.sqrt(4*P.sw*P.sh/Math.PI);
  const vgap=P.bh-freeDia;
  const Lm=spans.length?spans.reduce((a,b)=>a+b,0)/spans.length:P.pitch;
  const o=offAmt();
  const stretch=o>0?(Math.sqrt(Lm*Lm+4*o*o)+2*o)/Lm-1:0;
  const nfam=P.lattice==="triaxial"?3:2;
  const cover=Math.min(1,nfam*P.sw/P.pitch)*P.plies;
  const nd=Math.max(1,st.nd);
  const tDash=nd*moveTime((st.dash+st.bridge)/nd,P.ps/60,P.acc);
  const nT=Math.max(1,st.posts*2);
  const tTrav=nT*moveTime(st.travel/nT,P.ts/60,P.acc);
  const tPost=st.posts*((postVol()/FIL_AREA)/(P.pspd/60));
  const tot=tDash+tTrav+tPost;
  return {dashes:ds.length,posts:st.posts,stops:st.posts/area,longest,clear,minPitch,
    vgap,stretch,cover,tpi:25.4/P.pitch,ext:st.dash+st.bridge,pvol:postVol(),
    gap,t:tot,fPost:tot?tPost/tot:0,fTrav:tot?tTrav/tot:0};
}
function gcode(tp,startG="",endG=""){
  const ePerMm=P.sw*P.sh/FIL_AREA,L=[];
  L.push("; Loomwright — printed weave");
  L.push(`; ${P.lattice} / ${P.pattern}  pitch ${P.pitch} mm  ${P.size} mm square  x${P.plies} ply  rot ${P.rot}deg`);
  L.push(`; button ${P.bd} x ${P.bh} mm   strand ${P.sw} x ${P.sh} mm   offset dashes ${P.offd?"on":"off"}`);
  L.push("G21 ; mm","G90 ; absolute moves","M83 ; relative extrusion");
  L.push(`M140 S${P.bt}`,`M104 S${P.ht}`,`M190 S${P.bt}`,`M109 S${P.ht}`,
         `M106 S${Math.round(P.fan*2.55)}`);
  if(startG) L.push(...startG.split("\n"));
  let cur=null,lastF=null;
  const nx=v=>v.toFixed(4).replace(/\.?0+$/,"")||"0";
  for(const op of tp.ops){
    if(op.o==="T"){
      L.push(`G0 F${P.ts} X${nx(op.x+P.bed[0])} Y${nx(op.y+P.bed[1])} Z${nx(op.z)}`);
      cur=[op.x,op.y,op.z];lastF=null;
    } else if(op.o==="D"){
      const d=cur?Math.hypot(op.x-cur[0],op.y-cur[1],op.z-cur[2]):0;
      const f=op.f!==lastF?` F${op.f}`:"";
      L.push(`G1${f} X${nx(op.x+P.bed[0])} Y${nx(op.y+P.bed[1])} Z${nx(op.z)} E${(d*ePerMm).toFixed(6)}`);
      cur=[op.x,op.y,op.z];lastF=op.f;
    } else { L.push(`G1 F${P.pspd} E${(op.v/FIL_AREA).toFixed(6)}`); lastF=null; }
  }
  if(endG) L.push(...endG.split("\n"));
  return L.join("\n")+"\n";
}
function report(m){
  const warn=[];
  if(m.clear<0)
    warn.push(`NOZZLE CLEARANCE -- the tip will clip posts. Needs pitch >= ${m.minPitch.toFixed(2)} mm, or a smaller/shorter button, or a sharper nozzle.`);
  else if(m.clear<0.10)
    warn.push(`NOZZLE CLEARANCE -- only ${m.clear.toFixed(2)} mm of margin. Verify against your actual nozzle before printing.`);
  if(m.vgap<0.08) warn.push("VERTICAL GAP -- bridges may weld to the layer below. Raise button height.");
  if(m.longest>4.5) warn.push("BRIDGE SPAN -- expect droop. Shorten floats or pitch.");
  if(P.plies>1)
    warn.push("TWO-PLY -- clearance and bridge figures above describe a single ply only. Ply 2 bridges over ply 1 rather than the bed; validate on a small swatch first.");
  const num=(v,dp,w=10)=>v.toFixed(dp).padStart(w);
  const L=["",
    `  ${P.lattice} / ${P.pattern}   pitch ${P.pitch} mm   ${P.size} mm square   x${P.plies} ply   rot ${P.rot} deg`,
    "  "+"-".repeat(62),
    `  dashes                ${String(m.dashes).padStart(10)}`,
    `  posts                 ${String(m.posts).padStart(10)}`,
    `  stops / cm2           ${num(m.stops,1)}`,
    `  threads / inch        ${num(m.tpi,1)}`,
    `  areal coverage        ${num(m.cover*100,1,9)}%`,
    "",
    `  longest bridge        ${num(m.longest,2)} mm`,
    `  nozzle clearance      ${num(m.clear,2)} mm`,
    `  min viable pitch      ${num(m.minPitch,2)} mm`,
    `  vertical gap          ${num(m.vgap,2)} mm`,
    `  in-plane stretch      ${num(m.stretch*100,1,9)}%`,
    "",
    `  extrusion length      ${num(m.ext,0)} mm`,
    `  post volume (each)    ${num(m.pvol,3)} mm3`,
    `  est. print time       ${num(m.t/60,1)} min`,
    `    in posts            ${num(m.fPost*100,1,9)}%`,
    `    in travel           ${num(m.fTrav*100,1,9)}%`,
  ];
  if(warn.length) L.push("",...warn.map(w=>"  ! "+w));
  L.push("","  Post fraction is the number that decides whether motion tuning is",
         "  worth it. If it dominates, pitch is your only real lever.","");
  return L.join("\n");
}
/* descriptive names for machine consumers; presentation only */
const JSON_NAMES={dashes:"dashes",posts:"posts",stops:"stops_per_cm2",
  longest:"longest_bridge_mm",clear:"nozzle_clearance_mm",vgap:"vertical_gap_mm",
  stretch:"in_plane_stretch",minPitch:"min_pitch_mm",cover:"coverage",
  tpi:"threads_per_inch",ext:"extrusion_mm",pvol:"post_volume_mm3",
  gap:"min_gap_mm",t:"t_total_s",fPost:"t_post_frac",fTrav:"t_travel_frac"};
function namedMetrics(m){
  const out={};
  for(const [k,v] of Object.entries(m)) out[JSON_NAMES[k]||k]=v;
  return out;
}

/* ==========================================================================
 * geometry invariant checks — the regression net (bun engine.js --check)
 * ========================================================================== */
function runCheck(log){
  const base=JSON.parse(JSON.stringify(P));
  const cases=[
    ["defaults",{}],
    ["edges off",{edge:false}],
    ["plain, big button",{pattern:"plain",bd:1.2,bh:0.6,offd:false}],
    ["satin",{pattern:"satin",pitch:4.2}],
    ["custom draft",{pattern:"custom",draft:[[1,0,0,1],[0,1,1,0],[0,1,0,1],[1,0,1,0]]}],
    ["triaxial",{lattice:"triaxial",pitch:6.8,offd:false,size:34}],
    ["two ply",{plies:2,size:26}],
    ["three ply",{plies:3,size:22}],
  ];
  let bad=0;
  for(const [name,cfg] of cases){
    Object.assign(P,base,cfg);
    const errs=[];
    // exactly one high thread per crossing
    const lines=buildLines(),rule=liftRule();
    outer:
    for(let i=0;i<lines.length;i++) for(let j=i+1;j<lines.length;j++){
      const A=lines[i],B=lines[j];
      if(A.f===B.f) continue;
      if(highAt(A,B,rule)===highAt(B,A,rule)){
        errs.push(`double-high at ${A.f}:${A.i} x ${B.f}:${B.i}`);break outer;
      }
    }
    const tp=toolpath();
    // post sites strictly pairwise distinct (no contended transitions)
    const cs=tp.ds.filter(D=>D.post).map(D=>postC(D));
    pairs:
    for(let i=0;i<cs.length;i++) for(let j=i+1;j<cs.length;j++)
      if(dist(cs[i],cs[j])<1e-6){errs.push(`coincident posts at (${cs[i]})`);break pairs;}
    // grounding: with edges on, no high dash may end in the air
    if(P.edge) for(const D of tp.ds)
      if(D.hi&&(!D.post||!D.postS)){errs.push("ungrounded boundary high dash");break;}
    // op stream sanity
    if(!tp.ops.length||tp.ops[0].o!=="T") errs.push("op stream does not open with a travel");
    for(const op of tp.ops){
      if(op.o==="S"){ if(!(op.v>0)) errs.push("non-positive stationary volume"); }
      else if(![op.x,op.y,op.z].every(Number.isFinite)) errs.push("non-finite coordinate");
      if(errs.length>4) break;
    }
    // metrics all finite
    const m=metrics(tp);
    for(const [k,v] of Object.entries(m))
      if(!Number.isFinite(v)){errs.push(`metric ${k} not finite`);break;}
    if(errs.length){bad++;log(`  FAIL  ${name}`);errs.slice(0,4).forEach(e=>log(`        ${e}`));}
    else log(`  ok    ${name}  (${tp.ops.length} ops, ${m.posts} posts)`);
  }
  Object.assign(P,base);
  log(`\n  ${cases.length-bad}/${cases.length} configurations pass`);
  return bad===0;
}

/* ==========================================================================
 * CLI — only reached outside the browser
 * ========================================================================== */
if(typeof window==="undefined"&&typeof process!=="undefined"&&process.argv){
  const fs=require("fs");
  const NUM={pitch:"pitch",size:"size",rotate:"rot","button-d":"bd","button-h":"bh",
    "strand-w":"sw","strand-h":"sh","offset-frac":"offFrac",overshoot:"ovs",
    plies:"plies","tack-every":"tack","ply-gap":"pgap","print-speed":"ps",
    "bridge-speed":"bs","travel-speed":"ts","post-speed":"pspd","post-steps":"pstep",
    "post-flow":"pflow",accel:"acc","nozzle-temp":"ht","bed-temp":"bt",fan:"fan",
    "nozzle-flat":"nflat","nozzle-cone":"ncone"};
  const STR={lattice:"lattice",pattern:"pattern"};
  const usage=`weaver engine — single-source printed-weave generator

  bun engine.js [options] [--report] [--json] [--gcode FILE] [--ops FILE|-]
  bun engine.js --check

options mirror the app's parameters:
  --lattice biaxial|triaxial   --pattern plain|twill|crepe|satin|custom
  --pitch --size --rotate --button-d --button-h --strand-w --strand-h
  --offset-dashes / --no-offset-dashes   --offset-frac --overshoot
  --ground-edges / --no-ground-edges     bed-anchor boundary high runs (default on)
  --plies --tack-every --ply-gap
  --print-speed --bridge-speed --travel-speed --post-speed --post-steps
  --post-flow --accel --nozzle-temp --bed-temp --fan --nozzle-flat --nozzle-cone
  --draft FILE    JSON NxN array of 0/1 (warp over = 1); implies custom
  --config FILE   JSON object of parameters (what the app's Export config saves)

outputs (default: --report):
  --report        feasibility report to stdout
  --json          parameters + metrics as JSON
  --gcode FILE    write printable G-code (no FullControl needed)
  --ops FILE|-    op stream JSON for fcexport.py (FullControl plot/profiles)
  --check         run geometry invariant checks and exit`;
  const die=msg=>{console.error(msg);process.exit(2);};
  const loadDraft=path=>{
    const D=JSON.parse(fs.readFileSync(path,"utf8"));
    if(!Array.isArray(D)||!D.length||D.some(r=>!Array.isArray(r)||r.length!==D.length)
       ||D.some(r=>r.some(v=>v!==0&&v!==1)))
      die(`${path}: draft must be a square NxN array of 0/1`);
    return D;
  };
  const a=process.argv.slice(2);
  const want={report:false,json:false,check:false,gcode:null,ops:null};
  for(let i=0;i<a.length;i++){
    const flag=a[i].replace(/^--/,"");
    if(a[i]==="--help"||a[i]==="-h"){console.log(usage);process.exit(0);}
    else if(flag==="report") want.report=true;
    else if(flag==="json") want.json=true;
    else if(flag==="check") want.check=true;
    else if(flag==="gcode") want.gcode=a[++i]||die("--gcode needs a path");
    else if(flag==="ops") want.ops=a[++i]||die("--ops needs a path or -");
    else if(flag==="offset-dashes") P.offd=true;
    else if(flag==="no-offset-dashes") P.offd=false;
    else if(flag==="ground-edges") P.edge=true;
    else if(flag==="no-ground-edges") P.edge=false;
    else if(flag==="draft"){P.draft=loadDraft(a[++i]||die("--draft needs a path"));P.pattern="custom";}
    else if(flag==="config"){
      const cfg=JSON.parse(fs.readFileSync(a[++i]||die("--config needs a path"),"utf8"));
      Object.assign(P,cfg);
    }
    else if(flag in NUM){
      const v=parseFloat(a[++i]);
      if(!Number.isFinite(v)) die(`--${flag} needs a number`);
      P[NUM[flag]]=v;
    }
    else if(flag in STR) P[STR[flag]]=a[++i]||die(`--${flag} needs a value`);
    else die(`unknown option ${a[i]}\n\n${usage}`);
  }
  if(want.check) process.exit(runCheck(console.log)?0:1);
  if(P.pattern==="custom"&&!Array.isArray(P.draft)) die("pattern 'custom' needs --draft");
  const tp=toolpath(),m=metrics(tp);
  if(want.json)
    console.log(JSON.stringify({params:P,metrics:namedMetrics(m)},null,2));
  if(want.gcode){
    fs.writeFileSync(want.gcode,gcode(tp,DEFAULT_START_G,DEFAULT_END_G));
    console.error(`  wrote ${want.gcode}  (${tp.ops.length} ops)`);
  }
  if(want.ops){
    const payload=JSON.stringify({params:P,ops:tp.ops,stats:tp.st,metrics:namedMetrics(m)});
    if(want.ops==="-") console.log(payload);
    else{fs.writeFileSync(want.ops,payload);console.error(`  wrote ${want.ops}`);}
  }
  if(want.report||!(want.json||want.gcode||want.ops)) console.log(report(m));
}
