"use strict";
/* ==========================================================================
 * engine.js — the weaver engine. The single source of truth for printed-
 * weave geometry: lattice → crossings → dashes → op stream → metrics,
 * G-code text, and the feasibility report.
 *
 * Two faces, one implementation:
 *   browser   index.html loads this as a plain script and drives P
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
const DEFAULT_RETRACT_MIN_TRAVEL = 1.5;
const CREPE = [
  [1,0,1,1,0,0,1,0],[0,1,1,0,1,0,0,1],[1,1,0,0,1,1,0,0],[0,0,1,1,0,1,1,0],
  [1,0,0,1,1,0,0,1],[0,1,0,1,0,1,1,0],[1,1,0,0,1,0,0,1],[0,0,1,0,0,1,1,1]];
/* Core One profile resolved from the printer's device-authoritative 0.6 mm
   nozzle report and PrusaSlicer 2.9.5's matching standard/HF 0.6 mm
   Prusament PLA presets. M555 uses the rotation-aware swatch bbox. */
function coreOneStart(){
  const meshTemp=Math.min(P.ht,170);
  return [
    "M17 ; enable steppers",
    "M862.1 P0.6 ; 0.6 mm nozzle check (standard or high-flow)",
    'M862.3 P "COREONE" ; printer model check',
    "M862.5 P2 ; G-code level check",
    'M862.6 P"Input shaper" ; firmware feature check',
    "M115 U6.5.7+12836 ; firmware version check",
    "G90 ; absolute coordinates",
    "M83 ; relative extrusion",
    `M140 S${P.bt} ; set bed temperature`,
    `M109 R${meshTemp} ; wait for probing temperature`,
    "M84 E ; release extruder motor for probing",
    "G28 ; home without mesh bed leveling",
    "M141 S20 ; PLA chamber target",
    ...(P.bt<=60?["M106 S70 ; assist bed cooling before probing"]:[]),
    "G0 Z40 F10000",
    `M104 T0 S${meshTemp}`,
    `M190 S${P.bt} ; wait for bed temperature`,
    "M107",
    "G29 G ; absorb bed heat",
    `M109 T0 R${meshTemp} ; restore probing temperature`,
    "M302 S155 ; permit purge preparation",
    "G1 E-2 F2400 ; retract before nozzle cleaning",
    "M84 E",
    "G29 P9 X208 Y-2.5 W32 H4 ; clean nozzle",
    "M84 E",
    "G29 P1 ; invalidate mesh and probe print area",
    "G29 P1 X150 Y0 W100 H20 C ; probe purge area",
    "G29 P3.2 ; interpolate mesh",
    "G29 P3.13 ; extrapolate mesh",
    "G29 A ; activate mesh",
    `M104 S${P.ht}`,
    "G0 X249 Y-2.5 Z15 F4800 ; prepare purge",
    `M109 S${P.ht} ; wait for first-layer temperature`,
    "G92 E0",
    "M569 S0 E ; extruder spreadCycle",
    "M591 S0 ; disable stuck-filament detection during purge",
    "G1 E2 F2400 ; undo preparation retraction",
    "G0 E5 X235 Z0.2 F500 ; purge",
    "G0 X225 E4 F500 ; purge",
    "G0 X215 E4 F650 ; purge",
    "G0 X205 E4 F800 ; purge",
    "G0 X202 Z0.05 F8000 ; wipe near bed",
    "G0 X199 Z0.2 F8000 ; wipe away",
    "M591 R ; restore stuck-filament detection",
    "G92 E0",
    "M221 S100 ; reset flow",
    "M572 S0.022 ; Prusament PLA 0.6 pressure advance",
    "M142 S36 ; heatbreak target"
  ].join("\n");
}
function coreOneEnd(){
  return ["G1 Z5 F720 ; lift above swatch","M104 S0","M140 S0",
    "M141 S0 ; disable chamber control","M107",
    "G1 X242 Y211 F10200 ; park","G4","M572 S0 ; reset pressure advance",
    "M84 X Y E ; disable motors"].join("\n");
}
function mk4sPpStart(){
  const meshTemp=Math.min(P.ht,170);
  return [
    "; target Prusa MK4S, device-authoritative 0.5 mm nozzle",
    "M17 ; enable steppers",
    "M862.1 P0.5 A0 ; device-authoritative 0.5 mm non-abrasive nozzle check",
    'M862.3 P "MK4S" ; printer model check',
    "M862.5 P2 ; G-code level check",
    'M862.6 P"Input shaper" ; firmware feature check',
    "M115 U6.5.3+12780 ; minimum firmware expected by Prusa MK4S profile",
    "G90 ; absolute coordinates",
    "M83 ; relative extrusion",
    `M140 S${P.bt} ; bed temperature`,
    `M104 T0 S${meshTemp} ; probing temperature`,
    `M109 T0 R${meshTemp} ; wait for probing temperature`,
    "M84 E ; release extruder motor for probing",
    "G28 ; home without mesh bed leveling",
    "G1 X42 Y-4 Z5 F4800 ; nozzle-cleaning position",
    "M302 S155 ; permit purge preparation",
    "G1 E-2 F2400 ; retract before nozzle cleaning",
    "M84 E",
    "G29 P9 X10 Y-4 W32 H4 ; clean nozzle",
    "G0 Z40 F10000",
    `M190 S${P.bt} ; wait for bed temperature`,
    "M107 ; first-pass fan set by model",
    "M84 E",
    "G29 P1 ; invalidate mesh and probe configured print area",
    "G29 P1 X0 Y0 W50 H20 C ; probe purge area",
    "G29 P3.2 ; interpolate mesh",
    "G29 P3.13 ; extrapolate mesh outside probe area",
    "G29 A ; activate mesh",
    `M104 S${P.ht} ; nozzle temperature`,
    "G0 X0 Y-4 Z15 F4800 ; prepare purge",
    `M109 S${P.ht} ; wait for first-layer temperature`,
    "G92 E0",
    "M569 S0 E ; extruder spreadCycle",
    "M900 K0 ; material pressure advance",
    "M142 S36 ; heatbreak target",
    "G1 E2 F2400 ; undo preparation retraction",
    "G0 E7 X15 Z0.2 F500 ; purge",
    "G0 X25 E4 F500 ; purge",
    "G0 X35 E4 F650 ; purge",
    "G0 X45 E4 F800 ; purge",
    "G0 X48 Z0.05 F8000 ; wipe near bed",
    "G0 X51 Z0.2 F8000 ; wipe away",
    "G92 E0",
    "M201 X4000 Y4000 ; MK4S first-layer acceleration limit"
  ].join("\n");
}
function mk4sPpEnd(){
  return ["G1 Z5 F720 ; lift above swatch","M104 S0 ; turn off nozzle",
    "M140 S0 ; turn off bed","M107 ; turn off fan",
    "G1 X241 Y170 F3600 ; park","G1 Z25 F300 ; raise print head","G4 ; wait",
    "M572 S0 ; reset pressure advance","M593 X T2 F0 ; disable X input shaping",
    "M593 Y T2 F0 ; disable Y input shaping","M84 X Y E ; disable motors"].join("\n");
}
const PRINTERS={
  generic:{label:"Generic",short:"Generic",machine:"Custom printer",
    filament:"Custom",nozzle:"Custom",bed:[110,110],probe:false,
    note:"Generic 220 × 220 mm bed. Set the machine, material, nozzle, and start/end G-code for the target printer.",
    start:()=>"G28 ; home\nG92 E0",
    end:()=>"M104 S0\nM140 S0\nM107"},
  coreone:{label:"Prusa Core One 0.6 / Prusament PLA",short:"Core One",
    machine:"Prusa Core One",filament:"Prusament PLA",nozzle:"0.6 mm",
    bed:[125,110],probe:true,
    note:"Verified Core One 0.6 / PLA output setup: 230/60 °C, pass 1 fanless, pass 2 at 40%, 0.6 mm hop, and 0.8 mm retraction.",
    defaults:{lattice:"biaxial",pattern:"plain",pitch:4.5,size:120,rot:45,
      bd:2.1,bh:0.9,sw:0.4,sh:0.45,offd:false,offFrac:0.4,ovs:0.3,
      plies:1,pgap:0.25,tack:3,edge:true,join:true,nflat:0.6,ncone:120,
      ps:2400,bs:3600,ts:9000,pspd:300,pstep:3,pflow:1.1,acc:6000,
      flow:1,maxVflow:0,fan1:0,fan:40,ht:230,bt:60,
      zhop:0.6,retract:0.8,retMin:1.5,retSpeed:2700,primeSpeed:1500},
    start:coreOneStart,end:coreOneEnd},
  mk4spp:{label:"Prusa MK4S 0.5 / Fiberlogy PP",short:"MK4S",
    machine:"Prusa MK4S",filament:"Fiberlogy PP",nozzle:"0.5 mm",
    bed:[125,105],probe:true,
    note:"Physically successful MK4S 0.5 / PP output setup: 245/100 °C, 105% flow, fanless, and ≤5 mm³/s.",
    defaults:{lattice:"biaxial",pattern:"plain",pitch:4.5,size:60,rot:45,
      bd:2.1,bh:0.9,sw:0.4,sh:0.45,offd:false,offFrac:0.4,ovs:0.3,
      plies:1,pgap:0.25,tack:3,edge:true,join:true,nflat:0.5,ncone:120,
      ps:1500,bs:1500,ts:9000,pspd:118,pstep:3,pflow:1.1,acc:6000,
      flow:1.05,maxVflow:5,fan1:0,fan:0,ht:245,bt:100,
      zhop:0.6,retract:0.7,retMin:2,retSpeed:3600,primeSpeed:1200},
    start:mk4sPpStart,end:mk4sPpEnd}
};
const printerDef=()=>PRINTERS[P.printer]||PRINTERS.generic;

const P = {
  lattice:"biaxial", pattern:"twill", triPattern:"cyclic", pitch:3.6, size:30, rot:45,
  bd:0.9, bh:0.45, sw:0.40, sh:0.20,
  offd:false, offFrac:0.40, ovs:0.30, plies:1, pgap:0.25, tack:3, edge:true, join:true,
  nflat:0.80, ncone:120,
  ps:2400, bs:3600, ts:9000, pspd:300, pstep:3, pflow:1.10, acc:6000,
  flow:1, maxVflow:0, fan1:40, fan:40,
  zhop:0, retract:0, retMin:DEFAULT_RETRACT_MIN_TRAVEL, retSpeed:2400, primeSpeed:2400,
  ht:230, bt:100, printer:"generic", bed:[110,110], draft:CREPE.map(r=>r.slice())
};
function printBounds(){
  const a=P.rot*Math.PI/180;
  const factor=Math.abs(Math.cos(a))+Math.abs(Math.sin(a));
  const margin=2*P.pitch,modelHalf=P.size*factor/2,probeHalf=modelHalf+margin;
  const bedHalf=Math.min(P.bed[0],P.bed[1]);
  return {factor,margin,modelHalf,probeHalf,
    maxSize:Math.max(0,2*(bedHalf-margin)/factor),
    bedMargin:bedHalf-probeHalf};
}
const z1=()=>P.sh, zPost=()=>P.bh, z3=()=>P.bh+P.sh;
const offAmt=()=>P.offd?P.bd*P.offFrac:0;
const plyDz=k=>k*(P.bh+P.sh+P.pgap);

function families(){
  if(P.lattice==="triaxial") return [
    {n:[0,1],d:[1,0],ph:0},{n:[-SQ3,0.5],d:[0.5,SQ3],ph:0},
    {n:[-SQ3,-0.5],d:[0.5,-SQ3],ph:0.5}];   // half-pitch phase avoids triple points
  return [{n:[0,1],d:[1,0],ph:0},{n:[1,0],d:[0,1],ph:0}];
}
const mod=(a,b)=>((a%b)+b)%b;
function liftRule(){
  switch(P.pattern){
    case "plain": return (i,j)=>mod(i+j,2)===0;
    case "twill": return (i,j)=>mod(j-i,4)<2;
    case "satin": return (i,j)=>mod(j-2*i,5)!==0;
    case "crepe": return (i,j)=>CREPE[mod(j,8)][mod(i,8)]===1;
    default:{const D=P.draft,N=D.length;return (i,j)=>D[mod(j,N)][mod(i,N)]===1;}
  }
}
/* Triaxial crossings are pairwise because family C is half-pitch phased.
   Apply one rule to the cyclic pairs A→B, B→C, C→A, then complement it
   when queried in reverse. All modes therefore preserve exactly one high
   thread per crossing while changing the float sequence along each family. */
function triaxialPairHigh(ai,bi,pair){
  switch(P.triPattern){
    case "cyclic": return true;                         // every family: 1/1
    case "twill": return mod(bi-ai,2)===0;             // every family: 2/2
    case "directional":
      if(pair===0) return mod(ai,2)===0;               // A→B
      if(pair===1) return mod(ai+bi,2)===0;            // B→C
      return mod(bi,2)===0;                            // C→A
    default: throw new Error(`unknown triaxial pattern '${P.triPattern}'`);
  }
}
function highAt(A,B,rule){
  if(P.lattice==="triaxial"){
    const forward=(A.f+1)%3===B.f;
    const a=forward?A:B,b=forward?B:A;
    const ah=triaxialPairHigh(a.i,b.i,a.f);
    return forward?ah:!ah;
  }
  const i=A.f===1?A.i:B.i, j=A.f===0?A.i:B.i;
  const wo=rule(i,j);
  return A.f===1?wo:!wo;
}
const activePattern=()=>P.lattice==="triaxial"?P.triPattern:P.pattern;
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
const buttonArea=()=>Math.PI*Math.pow(P.bd/2,2);
/* Every dash owns a circular endpoint layer at its own z. The road already
   occupies half a button diameter inside that layer, so stationary extrusion
   only supplies the missing volume. A high dash that climbed through its top
   layer contributes one additional strand-height of road at its start. */
const endpointDotVol=(extraRoad=0)=>{
  const target=buttonArea()*P.sh;
  const occupied=P.sw*P.sh*(P.bd/2+Math.max(0,extraRoad));
  return Math.max(0.02,(target-occupied)*P.pflow);
};
/* The only tall feature is the virtual-middle riser, z_low -> z_post. Its
   drawn centre path already contributes road volume; stationary extrusion
   fills the balance required for a cylindrical section. */
const riserVol=(from,to,zf,zt)=>{
  const dz=Math.abs(zt-zf);
  const path=Math.hypot(to[0]-from[0],to[1]-from[1],zt-zf);
  return Math.max(0.02,(buttonArea()*dz-P.sw*P.sh*path)*P.pflow);
};
/* Pass 1 prints low dashes with a dot at both endpoints. At its travel end,
   the existing extra height builds only the virtual-middle riser to z_post.
   Pass 2 prints a top-level dot at both high-dash endpoints; when it owns the
   riser, it grows only to z_post, climbs through the top layer, caps it, then
   draws the bridge in reverse. The result at every transition is a bottom
   dot + middle riser + top dot rather than one variably stretched blob.
   Opposite pass directions still preserve disjoint riser ownership and the
   reverse-sweep z-safety invariant; see NOTES § 3. */
function toolpath(){
  const ds=allDashes(),ops=[],segs=[],seq={},passStarts=[];
  const st={dash:0,bridge:0,travel:0,travels:0,retracts:0,
    posts:0,dots:0,buttonVol:0,nd:0,joins:0,ties:0};
  let cur=null;
  const travel=(xy,z)=>{
    if(cur&&Math.abs(cur.p[0]-xy[0])<1e-9&&Math.abs(cur.p[1]-xy[1])<1e-9&&Math.abs(cur.z-z)<1e-9) return;
    if(cur){
      const d=dist(cur.p,xy);st.travel+=d;
      if(d>1e-9){st.travels++;if(d>=Math.max(0,P.retMin)) st.retracts++;}
      segs.push({a:cur.p,az:cur.z,b:xy,bz:z,k:"t"});
    }
    ops.push({o:"T",x:xy[0],y:xy[1],z});cur={p:xy,z};
  };
  const draw=(xy,z,f,k,fam)=>{
    if(cur) segs.push({a:cur.p,az:cur.z,b:xy,bz:z,k,fam});
    ops.push({o:"D",x:xy[0],y:xy[1],z,f,k});cur={p:xy,z};
  };
  const stationary=(v,k)=>{
    if(!cur) throw new Error("stationary extrusion needs a current point");
    ops.push({o:"S",v,k,x:cur.p[0],y:cur.p[1],z:cur.z});
    st.buttonVol+=v;
  };
  const dot=(extraRoad=0,cornerWeld=false)=>{
    stationary(endpointDotVol(extraRoad),"dot");
    if(cornerWeld) ops[ops.length-1].weld="corner";
    st.dots++;
  };
  const grow=(from,to,zf,zt,tackFrom)=>{
    const z0=tackFrom!=null?tackFrom:zf,n=Math.max(1,P.pstep);
    const vol=riserVol(from,to,z0,zt);
    for(let i=0;i<n;i++){
      const fr=(i+1)/n;
      stationary(vol/n,"riser");
      draw([from[0]+(to[0]-from[0])*fr,from[1]+(to[1]-from[1])*fr],z0+(zt-z0)*fr,P.ps,"p");
    }
    st.posts++;
  };
  for(let ply=0;ply<P.plies;ply++){
    const dz=plyDz(ply),shift=(ply%2)?P.pitch/2:0;
    const zl=z1()+dz,zt=zPost()+dz,zh=z3()+dz;let pi=0;
    const put=p=>place(p,shift);
    passStarts.push({op:ops.length,pass:1,ply});
    // on upper plies a post has no bed under it; every Nth one starts from
    // the top of the ply below so the stack is pinned down (both passes)
    const tackZ=k=>(ply>0&&P.tack>0&&k%P.tack===0)?z3()+plyDz(ply-1):null;
    let prevL=null,prevDir=null;
    // Chain starts remain loose until a corner tie reaches them. Defer their
    // endpoint dot so the closure is buried by stationary extrusion at the
    // tie junction instead of remaining exposed on the curved road.
    const loose=[];                  // {p, dotPending}
    // Corner tie: gentle outward-bulging arc between endpoint centres.
    const arcTie=(A,B,fam)=>{
      const mid=[(A[0]+B[0])/2,(A[1]+B[1])/2],c0=put([0,0]);
      let bx=mid[0]-c0[0],by=mid[1]-c0[1];
      const bl=Math.hypot(bx,by)||1;bx/=bl;by/=bl;
      const w=dist(A,B),h=w*0.4;
      const p1=[A[0]+bx*h,A[1]+by*h],p2=[B[0]+bx*h,B[1]+by*h];
      const N=Math.max(3,Math.min(8,Math.round(w*1.2/0.6)));
      let pv=A;
      for(let k2=1;k2<=N;k2++){
        const t=k2/N,mt=1-t;
        const q=[mt*mt*mt*A[0]+3*mt*mt*t*p1[0]+3*mt*t*t*p2[0]+t*t*t*B[0],
                 mt*mt*mt*A[1]+3*mt*mt*t*p1[1]+3*mt*t*t*p2[1]+t*t*t*B[1]];
        draw(q,zl,P.ps,"lo",fam);
        st.dash+=dist(pv,q);pv=q;
      }
      st.ties++;
    };
    const nearestLoose=p=>{
      let ni=-1,bd2=2.5*P.pitch;
      for(let li=0;li<loose.length;li++){
        const dd=dist(loose[li].p,p);
        if(dd<bd2){bd2=dd;ni=li;}
      }
      return ni;
    };
    for(const D of ds){
      if(D.hi) continue;
      const [s0,e0]=dashPts(D),s=put(s0),e=put(e0);
      let deferStartDot=false;
      // selvedge U-turn: the serpentine puts consecutive lines' free low
      // ends side by side in the edge margin, so the inter-line hop can be
      // DRAWN on the bed instead of travelled — each family's low skeleton
      // becomes one continuous thread and the fringe closes into a woven
      // edge. The turn is a half-circle Bézier bulging outward (tangent =
      // the direction the head was travelling when the previous line
      // finished), sampled into short bed-level draws since the op stream
      // is straight moves only. Requires grounding, so every line's pass 1
      // ends at the margin; the fold-in order guarantees no neighbouring
      // post exists yet when the arc is drawn.
      if(P.join&&P.edge&&cur&&prevL&&prevDir&&D.L!==prevL&&D.L.f===prevL.f
         &&Math.abs(D.L.i-prevL.i)===1&&Math.abs(cur.z-zl)<1e-9
         &&dist(cur.p,s)<2.5*P.pitch){
        const A=cur.p,w=dist(A,s),h=w*2/3;         // cubic control ≈ semicircle (4r/3)
        const p1=[A[0]+prevDir[0]*h,A[1]+prevDir[1]*h];
        const p2=[s[0]+prevDir[0]*h,s[1]+prevDir[1]*h];
        const N=Math.max(4,Math.min(12,Math.round(w*1.6/0.6)));
        let pv=A;
        for(let k2=1;k2<=N;k2++){
          const t=k2/N,mt=1-t;
          const q=[mt*mt*mt*A[0]+3*mt*mt*t*p1[0]+3*mt*t*t*p2[0]+t*t*t*s[0],
                   mt*mt*mt*A[1]+3*mt*mt*t*p1[1]+3*mt*t*t*p2[1]+t*t*t*s[1]];
          draw(q,zl,P.ps,"lo",D.L.f);
          st.dash+=dist(pv,q);pv=q;
        }
        st.joins++;
      } else if(P.join&&P.edge&&(!prevL||D.L.f!==prevL.f)){
        // Family transition: tie to the nearest loose endpoint when possible.
        // A still-open chain start owns a deferred dot; emit it immediately
        // before leaving that point so any restart/weld is inside the dot.
        if(prevL&&cur) loose.push({p:cur.p,dotPending:false});
        const ni=nearestLoose(s);
        if(ni>=0){
          const a=loose.splice(ni,1)[0];
          travel(a.p,zl);
          if(a.dotPending) dot(0,true);
          arcTie(a.p,s,D.L.f);
        } else{
          travel(s,zl);
          loose.push({p:s,dotPending:true});
          deferStartDot=true;
        }
      } else travel(s,zl);
      if(!deferStartDot) dot();
      draw(e,zl,P.ps,"lo",D.L.f);
      dot();
      st.dash+=dist(s,e);st.nd++;
      prevL=D.L;
      const dl=dist(s,e);
      if(dl>1e-9) prevDir=[(e[0]-s[0])/dl,(e[1]-s[1])/dl];
      if(D.post){
        const c=put(postC(D));
        const ex=offAmt()>0?[2*c[0]-e[0],2*c[1]-e[1]]:c;
        grow(c,ex,zl,zt,tackZ(pi));pi++;
        seq[ply+":"+D.L.f+":"+D.L.i+":"+D.pb.toFixed(3)]=segs.length;
      }
    }
    // Close the final corner onto the remaining loose endpoint. When that
    // endpoint is a chain start, deposit its deferred dot after the arc so
    // the closure weld is fully encapsulated by the endpoint button.
    if(P.join&&P.edge&&cur&&Math.abs(cur.z-zl)<1e-9&&loose.length){
      const ni=nearestLoose(cur.p);
      if(ni>=0){
        const a=loose.splice(ni,1)[0];
        arcTie(cur.p,a.p,prevL?prevL.f:0);
        if(a.dotPending) dot(0,true);
      }
    }
    // Degenerate fields may leave an untied start; retain its endpoint dot.
    for(const a of loose) if(a.dotPending){travel(a.p,zl);dot();}
    passStarts.push({op:ops.length,pass:2,ply});
    for(let i=ds.length-1;i>=0;i--){
      const D=ds[i];if(!D.hi) continue;
      const [s0,e0]=dashPts(D),s=put(s0),e=put(e0);
      if(D.post){
        const c=put(postC(D));
        const base=offAmt()>0?[2*c[0]-e[0],2*c[1]-e[1]]:c;
        travel(base,zl);grow(base,e,zl,zt,tackZ(pi));pi++;
        seq[ply+":"+D.L.f+":"+D.L.i+":"+D.pb.toFixed(3)]=segs.length;
        // The riser stops at the virtual-middle plane. This short climb and
        // the following dot belong to the high dash's own endpoint layer.
        draw(e,zh,P.ps,"p");
        dot(P.sh);
      } else {
        travel(e,zh);
        dot();
      }
      draw(s,zh,P.bs,"hi",D.L.f);
      dot();
      st.bridge+=dist(e,s);
      if(P.ovs>0&&D.postS){
        // Preserve the landing overshoot, but place the endpoint dot at the
        // nominal post first so it remains concentric with the middle riser.
        const L=dist(s,e);
        if(L>1e-6){
          const ov=P.bd*P.ovs;
          const end=[s[0]+(s[0]-e[0])/L*ov,s[1]+(s[1]-e[1])/L*ov];
          draw(end,zh,P.bs,"hi",D.L.f);
          st.bridge+=dist(s,end);
        }
      }
      st.nd++;
    }
  }
  return {ops,segs,st,ds,seq,passStarts}; // passStarts drives per-pass process changes
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
  /* During pass 1 only the middle risers rise above the strand tip plane.
     Endpoint dots stay within their owning low or high deposition layer. */
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
  const nT=Math.max(1,st.travels);
  const tMove=st.travels?nT*moveTime(st.travel/nT,P.ts/60,P.acc):0;
  const tHop=st.travels*2*moveTime(Math.max(0,P.zhop),P.ts/60,P.acc);
  const ret=Math.max(0,P.retract);
  const tRet=ret&&st.retracts
    ? st.retracts*ret*(60/P.retSpeed+60/P.primeSpeed):0;
  const tTrav=tMove+tHop+tRet;
  const tButton=(st.buttonVol/FIL_AREA)/(P.pspd/60);
  const tot=tDash+tTrav+tButton,bounds=printBounds(),flow=Math.max(0,P.flow);
  const lineFlow=Math.max(P.ps,P.bs)/60*P.sw*P.sh*flow;
  const stationaryFlow=P.pspd/60*FIL_AREA*flow;
  return {dashes:ds.length,buttons:st.dots,posts:st.posts,stops:st.posts/area,
    longest,clear,minPitch,vgap,stretch,cover,tpi:25.4/P.pitch,
    ext:st.dash+st.bridge,bvol:st.buttonVol,gap,t:tot,
    bedMargin:bounds.bedMargin,maxSize:bounds.maxSize,lineFlow,stationaryFlow,
    fButton:tot?tButton/tot:0,fTrav:tot?tTrav/tot:0};
}
function gcode(tp,startG="",endG=""){
  const ePerMm=P.sw*P.sh/FIL_AREA,L=[];
  L.push("; Loomwright — printed weave");
  L.push(`; ${P.lattice} / ${activePattern()}  pitch ${P.pitch} mm  ${P.size} mm square  x${P.plies} ply  rot ${P.rot}deg`);
  L.push(`; button ${P.bd} x ${P.bh} mm   strand ${P.sw} x ${P.sh} mm   offset dashes ${P.offd?"on":"off"}`);
  L.push(`; model flow ${(P.flow*100).toFixed(0)}%   pass fans ${P.fan1}/${P.fan}%`);
  L.push(`; travel z-hop ${P.zhop} mm   retract ${P.retract} mm above ${P.retMin} mm @ ${P.retSpeed}/${P.primeSpeed} mm/min`);
  L.push("G21 ; mm","G90 ; absolute moves","M83 ; relative extrusion");
  if(printerDef().probe){
    const bounds=printBounds(),h=bounds.probeHalf;
    L.push(`M555 X${Math.max(0,P.bed[0]-h).toFixed(1)} Y${Math.max(0,P.bed[1]-h).toFixed(1)}`+
           ` W${(2*h).toFixed(1)} H${(2*h).toFixed(1)} ; probe print bounds plus ${(2*P.pitch).toFixed(1)} mm margin`);
  } else {
    L.push(`M140 S${P.bt}`,`M104 S${P.ht}`,`M190 S${P.bt}`,`M109 S${P.ht}`);
  }
  if(startG) L.push(...startG.split("\n"));
  const flowPct=Math.round(Math.max(0,P.flow)*100);
  L.push(`M221 S${flowPct} ; model extrusion multiplier`);
  let cur=null,lastF=null;
  const nx=v=>v.toFixed(4).replace(/\.?0+$/,"")||"0";
  const retract=Math.max(0,P.retract),zhop=Math.max(0,P.zhop);
  const passAt=new Map((tp.passStarts||[{op:0,pass:1,ply:0}]).map(s=>[s.op,s]));
  for(let oi=0;oi<tp.ops.length;oi++){
    const marker=passAt.get(oi);
    if(marker){
      const fan=marker.pass===1?P.fan1:P.fan;
      L.push(`M106 S${Math.round(fan*2.55)} ; ply ${marker.ply+1} pass ${marker.pass} fan ${fan}%`);
    }
    const op=tp.ops[oi];
    if(op.o==="T"){
      const xyDist=cur?Math.hypot(op.x-cur[0],op.y-cur[1]):0;
      const xyMove=xyDist>1e-9;
      const doRet=xyMove&&xyDist>=Math.max(0,P.retMin)&&retract>0;
      if(doRet) L.push(`G1 F${P.retSpeed} E-${nx(retract)}`);
      if(cur&&xyMove&&zhop>0){
        const hopZ=Math.max(cur[2],op.z)+zhop;
        L.push(`G0 F${P.ts} Z${nx(hopZ)}`);
        L.push(`G0 X${nx(op.x+P.bed[0])} Y${nx(op.y+P.bed[1])}`);
        L.push(`G0 Z${nx(op.z)}`);
      } else {
        L.push(`G0 F${P.ts} X${nx(op.x+P.bed[0])} Y${nx(op.y+P.bed[1])} Z${nx(op.z)}`);
      }
      if(doRet) L.push(`G1 F${P.primeSpeed} E${nx(retract)}`);
      cur=[op.x,op.y,op.z];lastF=null;
    } else if(op.o==="D"){
      const d=cur?Math.hypot(op.x-cur[0],op.y-cur[1],op.z-cur[2]):0;
      const f=op.f!==lastF?` F${op.f}`:"";
      L.push(`G1${f} X${nx(op.x+P.bed[0])} Y${nx(op.y+P.bed[1])} Z${nx(op.z)} E${(d*ePerMm).toFixed(6)}`);
      cur=[op.x,op.y,op.z];lastF=op.f;
    } else { L.push(`G1 F${P.pspd} E${(op.v/FIL_AREA).toFixed(6)}`); lastF=null; }
  }
  if(flowPct!==100) L.push("M221 S100 ; restore nominal flow");
  if(endG) L.push(...endG.split("\n"));
  return L.join("\n")+"\n";
}
function report(m){
  const warn=[];
  if(m.clear<0)
    warn.push(`NOZZLE CLEARANCE -- the tip will clip middle risers. Needs pitch >= ${m.minPitch.toFixed(2)} mm, or a smaller/shorter button, or a sharper nozzle.`);
  else if(m.clear<0.10)
    warn.push(`NOZZLE CLEARANCE -- only ${m.clear.toFixed(2)} mm of margin around middle risers. Verify against your actual nozzle before printing.`);
  if(m.vgap<0.08) warn.push("VERTICAL GAP -- bridges may weld to the layer below. Raise button height.");
  if(m.longest>4.5) warn.push("BRIDGE SPAN -- expect droop. Shorten floats or pitch.");
  if(m.bedMargin<0)
    warn.push(`PRINT AREA -- exceeds the selected bed's two-pitch safety margin. Maximum at this rotation is ${m.maxSize.toFixed(2)} mm.`);
  const maxFlow=Math.max(m.lineFlow,m.stationaryFlow);
  if(P.maxVflow>0&&maxFlow>P.maxVflow)
    warn.push(`VOLUMETRIC FLOW -- ${maxFlow.toFixed(2)} mm3/s exceeds the configured ${P.maxVflow.toFixed(2)} mm3/s limit.`);
  if(P.plies>1)
    warn.push("TWO-PLY -- clearance and bridge figures above describe a single ply only. Ply 2 bridges over ply 1 rather than the bed; validate on a small swatch first.");
  const num=(v,dp,w=10)=>v.toFixed(dp).padStart(w);
  const L=["",
    `  ${P.lattice} / ${activePattern()}   pitch ${P.pitch} mm   ${P.size} mm square   x${P.plies} ply   rot ${P.rot} deg`,
    "  "+"-".repeat(62),
    `  endpoint buttons      ${String(m.buttons).padStart(10)}`,
    `  middle risers         ${String(m.posts).padStart(10)}`,
    `  stops / cm2           ${num(m.stops,1)}`,
    `  threads / inch        ${num(m.tpi,1)}`,
    `  areal coverage        ${num(m.cover*100,1,9)}%`,
    "",
    `  longest bridge        ${num(m.longest,2)} mm`,
    `  nozzle clearance      ${num(m.clear,2)} mm`,
    `  min viable pitch      ${num(m.minPitch,2)} mm`,
    `  vertical gap          ${num(m.vgap,2)} mm`,
    `  in-plane stretch      ${num(m.stretch*100,1,9)}%`,
    `  bed safety margin     ${num(m.bedMargin,2)} mm`,
    `  max safe square       ${num(m.maxSize,2)} mm`,
    `  line flow             ${num(m.lineFlow,2)} mm3/s`,
    `  stationary flow       ${num(m.stationaryFlow,2)} mm3/s`,
    "",
    `  extrusion length      ${num(m.ext,0)} mm`,
    `  stationary material   ${num(m.bvol,1)} mm3`,
    `  est. print time       ${num(m.t/60,1)} min`,
    `    in buttons          ${num(m.fButton*100,1,9)}%`,
    `    in travel           ${num(m.fTrav*100,1,9)}%`,
  ];
  if(warn.length) L.push("",...warn.map(w=>"  ! "+w));
  L.push("","  Button fraction is the number that decides whether motion tuning is",
         "  worth it. If it dominates, pitch is your only real lever.","");
  return L.join("\n");
}
/* descriptive names for machine consumers; presentation only */
const JSON_NAMES={dashes:"dashes",buttons:"endpoint_buttons",posts:"middle_risers",
  stops:"stops_per_cm2",longest:"longest_bridge_mm",clear:"nozzle_clearance_mm",
  vgap:"vertical_gap_mm",stretch:"in_plane_stretch",minPitch:"min_pitch_mm",
  cover:"coverage",tpi:"threads_per_inch",ext:"extrusion_mm",
  bvol:"stationary_button_volume_mm3",gap:"min_gap_mm",t:"t_total_s",
  bedMargin:"bed_safety_margin_mm",maxSize:"max_safe_square_mm",
  lineFlow:"line_flow_mm3_s",stationaryFlow:"stationary_flow_mm3_s",
  fButton:"t_button_frac",fTrav:"t_travel_frac"};
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
    ["offset endpoint buttons",{offd:true,offFrac:0.4}],
    ["unjoined",{join:false}],
    ["plain, big button",{pattern:"plain",bd:1.2,bh:0.6,offd:false}],
    ["satin",{pattern:"satin",pitch:4.2}],
    ["custom draft",{pattern:"custom",draft:[[1,0,0,1],[0,1,1,0],[0,1,0,1],[1,0,1,0]]}],
    ["triaxial cyclic",{lattice:"triaxial",triPattern:"cyclic",pitch:6.8,offd:false,size:34},[1,1,1]],
    ["triaxial 2/2 twill",{lattice:"triaxial",triPattern:"twill",pitch:6.8,offd:false,size:34},[2,2,2]],
    ["triaxial directional",{lattice:"triaxial",triPattern:"directional",pitch:6.8,offd:false,size:34},[1,2,2]],
    ["two ply",{plies:2,size:26}],
    ["three ply",{plies:3,size:22}],
  ];
  let bad=0;
  for(const [name,cfg,expectedTriRuns] of cases){
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
    if(expectedTriRuns){
      const actual=[0,0,0];
      for(const L of lines){
        const xs=crossings(L,lines,rule);
        if(!xs.length) continue;
        let run=1,best=1;
        for(let i=1;i<xs.length;i++){
          run=xs[i].hi===xs[i-1].hi?run+1:1;
          best=Math.max(best,run);
        }
        actual[L.f]=Math.max(actual[L.f],best);
      }
      if(actual.some((v,i)=>v!==expectedTriRuns[i]))
        errs.push(`triaxial float runs ${actual.join("/")}, expected ${expectedTriRuns.join("/")}`);
    }
    const tp=toolpath();
    if(tp.passStarts.length!==2*P.plies)
      errs.push(`pass marker count ${tp.passStarts.length}, expected ${2*P.plies}`);
    else for(let ply=0;ply<P.plies;ply++){
      const lo=tp.passStarts[2*ply],hi=tp.passStarts[2*ply+1];
      if(lo.pass!==1||hi.pass!==2||lo.ply!==ply||hi.ply!==ply||lo.op>=hi.op){
        errs.push(`invalid pass markers for ply ${ply+1}`);break;
      }
    }
    // post sites strictly pairwise distinct (no contended transitions)
    const cs=tp.ds.filter(D=>D.post).map(D=>postC(D));
    pairs:
    for(let i=0;i<cs.length;i++) for(let j=i+1;j<cs.length;j++)
      if(dist(cs[i],cs[j])<1e-6){errs.push(`coincident posts at (${cs[i]})`);break pairs;}
    // grounding: with edges on, no high dash may end in the air
    if(P.edge) for(const D of tp.ds)
      if(D.hi&&(!D.post||!D.postS)){errs.push("ungrounded boundary high dash");break;}
    // every dash owns exactly one endpoint dot at each end and at its own z
    const dots=tp.ops.filter(op=>op.o==="S"&&op.k==="dot");
    const expectedDots=[];
    for(let ply=0;ply<P.plies;ply++){
      const dz=plyDz(ply),shift=(ply%2)?P.pitch/2:0;
      for(const D of tp.ds){
        const z=(D.hi?z3():z1())+dz;
        for(const p of dashPts(D)){
          const q=place(p,shift);
          expectedDots.push([q[0],q[1],z]);
        }
      }
    }
    const dotKey=p=>p.map(v=>v.toFixed(6)).join(":");
    const actualDotKeys=dots.map(op=>dotKey([op.x,op.y,op.z])).sort();
    const expectedDotKeys=expectedDots.map(dotKey).sort();
    if(tp.st.dots!==expectedDots.length||actualDotKeys.length!==expectedDotKeys.length)
      errs.push(`endpoint dot count ${actualDotKeys.length}, expected ${expectedDotKeys.length}`);
    else {
      const mismatch=actualDotKeys.findIndex((v,i)=>v!==expectedDotKeys[i]);
      if(mismatch>=0) errs.push(`endpoint dot misplaced at ${actualDotKeys[mismatch]}`);
    }
    const riserPulses=tp.ops.filter(op=>op.o==="S"&&op.k==="riser");
    if(riserPulses.length!==tp.st.posts*Math.max(1,P.pstep))
      errs.push(`riser pulse count ${riserPulses.length}`);
    const stationaryVolume=tp.ops.filter(op=>op.o==="S").reduce((v,op)=>v+op.v,0);
    if(Math.abs(stationaryVolume-tp.st.buttonVol)>1e-9)
      errs.push("stationary button volume accounting mismatch");
    // selvedge: joining must actually join, and only when enabled
    if(P.join&&P.edge&&tp.st.joins===0) errs.push("no selvedge joins recorded");
    if(!(P.join&&P.edge)&&tp.st.joins>0) errs.push("joins recorded while disabled");
    const weldDots=tp.ops.filter(op=>op.o==="S"&&op.k==="dot"&&op.weld==="corner");
    if(P.join&&P.edge&&tp.st.ties>0&&!weldDots.length)
      errs.push("corner ties do not close inside an endpoint dot");
    if(!(P.join&&P.edge)&&weldDots.length)
      errs.push("corner weld dots emitted while joining is disabled");
    for(const weld of weldDots){
      const wi=tp.ops.indexOf(weld),before=tp.ops[wi-1],after=tp.ops[wi+1];
      const arrives=before&&before.o==="D"&&before.k==="lo"&&
        dist([before.x,before.y],[weld.x,weld.y])<1e-9;
      const leaves=after&&after.o==="D"&&after.k==="lo";
      if(!arrives&&!leaves){errs.push("corner weld dot is not at a tie junction");break;}
    }
    // op stream sanity
    if(!tp.ops.length||tp.ops[0].o!=="T") errs.push("op stream does not open with a travel");
    for(const op of tp.ops){
      if(op.o==="S"){
        if(!(op.v>0)) errs.push("non-positive stationary volume");
        if(![op.x,op.y,op.z].every(Number.isFinite)) errs.push("non-finite stationary point");
      } else if(op.o==="T"||op.o==="D"){
        if(![op.x,op.y,op.z].every(Number.isFinite)) errs.push("non-finite coordinate");
      } else errs.push(`unknown op ${op.o}`);
      if(errs.length>4) break;
    }
    // metrics all finite
    const m=metrics(tp);
    for(const [k,v] of Object.entries(m))
      if(!Number.isFinite(v)){errs.push(`metric ${k} not finite`);break;}
    if(errs.length){bad++;log(`  FAIL  ${name}`);errs.slice(0,4).forEach(e=>log(`        ${e}`));}
    else log(`  ok    ${name}  (${tp.ops.length} ops, ${m.buttons} endpoint buttons, ${m.posts} middle risers)`);
  }
  Object.assign(P,base,PRINTERS.coreone.defaults,
    {printer:"coreone",bed:PRINTERS.coreone.bed.slice(),pattern:"twill"});
  const coreTp=toolpath(),coreM=metrics(coreTp);
  const coreG=gcode(coreTp,printerDef().start(),printerDef().end());
  const coreSeq=["M555 X","M862.1 P0.6","M109 R170","G28 ",
    "G29 P1 ;","M109 S230","M572 S0.022","M221 S100 ; model",
    "M106 S0 ; ply 1 pass 1",`G0 F${P.ts}`,"M106 S102 ; ply 1 pass 2",
    "M104 S0","G1 X242 Y211","M572 S0 ;"];
  const coreAt=coreSeq.map(s=>coreG.indexOf(s));
  let coreErr=coreAt.some(i=>i<0)
    ? `missing ${coreSeq[coreAt.findIndex(i=>i<0)]}`
    : coreAt.some((v,i)=>i&&v<=coreAt[i-1]) ? "startup/toolpath/shutdown order" : "";
  if(!coreErr){
    const lines=coreG.split("\n");
    const firstTravel=lines.findIndex(l=>l.startsWith(`G0 F${P.ts} X`));
    const retractLine=`G1 F${P.retSpeed} E-${P.retract}`;
    const primeLine=`G1 F${P.primeSpeed} E${P.retract}`;
    const firstRet=lines.indexOf(retractLine);
    const retracts=lines.filter(l=>l===retractLine).length;
    const primes=lines.filter(l=>l===primeLine).length;
    const hops=lines.filter(l=>l.startsWith(`G0 F${P.ts} Z`)).length;
    if(firstTravel<0||firstRet<=firstTravel)
      coreErr="initial positioning was retracted or travel is missing";
    else if(!retracts||retracts!==primes||retracts!==coreTp.st.retracts)
      coreErr=`travel retraction mismatch (${retracts} retract / ${primes} prime / ${coreTp.st.retracts} expected)`;
    else if(hops!==coreTp.st.travels)
      coreErr=`missing travel hops (${hops} emitted / ${coreTp.st.travels} travels)`;
    else if(!lines[firstRet+1].startsWith(`G0 F${P.ts} Z`)||
            !lines[firstRet+2].startsWith("G0 X")||
            !lines[firstRet+3].startsWith("G0 Z")||
            lines[firstRet+4]!==primeLine)
      coreErr="retract / lift / XY / lower / prime order";
  }
  if(!coreErr&&(coreM.clear<0.1||coreM.vgap<0.08||coreM.bedMargin<0))
    coreErr=`unsafe profile geometry (clear ${coreM.clear.toFixed(2)}, gap ${coreM.vgap.toFixed(2)}, bed ${coreM.bedMargin.toFixed(2)})`;
  if(coreErr){bad++;log("  FAIL  Core One PLA profile");log(`        ${coreErr}`);}
  else log("  ok    Core One PLA profile");

  Object.assign(P,base,PRINTERS.mk4spp.defaults,
    {printer:"mk4spp",bed:PRINTERS.mk4spp.bed.slice(),size:192,rot:90});
  const mkTp=toolpath(),mkM=metrics(mkTp);
  const mkG=gcode(mkTp,printerDef().start(),printerDef().end());
  const mkSeq=["M555 X20.0 Y0.0 W210.0 H210.0","M862.1 P0.5 A0",
    'M862.3 P "MK4S"',"M140 S100","M109 T0 R170","G28 ",
    "G29 P1 ;","M109 S245","M201 X4000 Y4000","M221 S105 ; model",
    "M106 S0 ; ply 1 pass 1",`G0 F${P.ts}`,"M106 S0 ; ply 1 pass 2",
    "M221 S100 ; restore","M104 S0","G1 X241 Y170"];
  const mkAt=mkSeq.map(s=>mkG.indexOf(s));
  let mkErr=mkAt.some(i=>i<0)
    ? `missing ${mkSeq[mkAt.findIndex(i=>i<0)]}`
    : mkAt.some((v,i)=>i&&v<=mkAt[i-1]) ? "startup/toolpath/shutdown order" : "";
  if(!mkErr&&["COREONE","M862.1 P0.6","M572 S0.022","M141 S20"].some(s=>mkG.includes(s)))
    mkErr="Core One command leaked into MK4S output";
  if(!mkErr&&mkG.split("\n").some(l=>l.startsWith("M106 S")&&!l.startsWith("M106 S0 ")))
    mkErr="nonzero fan in PP profile";
  if(!mkErr&&(Math.abs(mkM.bedMargin)>1e-8||
      Math.max(mkM.lineFlow,mkM.stationaryFlow)>P.maxVflow+1e-9))
    mkErr=`unsafe PP limits (bed ${mkM.bedMargin.toFixed(3)}, flow ${Math.max(mkM.lineFlow,mkM.stationaryFlow).toFixed(3)})`;
  if(mkErr){bad++;log("  FAIL  MK4S PP profile");log(`        ${mkErr}`);}
  else log("  ok    MK4S PP profile");
  Object.assign(P,base);
  log(`\n  ${cases.length+2-bad}/${cases.length+2} configurations pass`);
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
    "bridge-speed":"bs","travel-speed":"ts","z-hop":"zhop",retract:"retract",
    "retract-min":"retMin","retract-speed":"retSpeed","prime-speed":"primeSpeed",
    "post-speed":"pspd","post-steps":"pstep","post-flow":"pflow",accel:"acc",
    flow:"flow","max-volumetric-flow":"maxVflow",
    "pass1-fan":"fan1","pass2-fan":"fan",
    "nozzle-temp":"ht","bed-temp":"bt",
    "nozzle-flat":"nflat","nozzle-cone":"ncone"};
  const STR={lattice:"lattice",pattern:"pattern","triaxial-pattern":"triPattern"};
  const usage=`weaver engine — single-source printed-weave generator

  bun engine.js [options] [--report] [--json] [--gcode FILE] [--ops FILE|-]
  bun engine.js --check

options mirror the app's parameters:
  --lattice biaxial|triaxial   --pattern plain|twill|crepe|satin|custom
  --triaxial-pattern cyclic|twill|directional
  --pitch --size --rotate --button-d --button-h --strand-w --strand-h
  --offset-dashes / --no-offset-dashes   --offset-frac --overshoot
  --ground-edges / --no-ground-edges     bed-anchor boundary high runs (default on)
  --join / --no-join                     selvedge U-turns joining threads at the edge (default on)
  --plies --tack-every --ply-gap
  --print-speed --bridge-speed --travel-speed --z-hop --retract --retract-min
  --retract-speed --prime-speed --post-speed --post-steps --post-flow
  --flow --max-volumetric-flow --fan --pass1-fan --pass2-fan
  --accel --nozzle-temp --bed-temp --nozzle-flat --nozzle-cone
  --draft FILE    JSON NxN array of 0/1 (warp over = 1); implies custom
  --config FILE   JSON object of parameters (what the app's Save config emits)
  --printer generic|coreone|mk4spp   bed and start/end G-code profile

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
    else if(flag==="join") P.join=true;
    else if(flag==="no-join") P.join=false;
    else if(flag==="printer"){
      const v=a[++i];
      if(!PRINTERS[v]) die(`unknown printer ${v} (${Object.keys(PRINTERS).join(", ")})`);
      P.printer=v;P.bed=PRINTERS[v].bed.slice();Object.assign(P,PRINTERS[v].defaults||{});
    }
    else if(flag==="draft"){P.draft=loadDraft(a[++i]||die("--draft needs a path"));P.pattern="custom";}
    else if(flag==="config"){
      const cfg=JSON.parse(fs.readFileSync(a[++i]||die("--config needs a path"),"utf8"));
      const def=PRINTERS[cfg.printer],defaults=def&&def.defaults;
      if(defaults) Object.assign(P,defaults);
      if(def&&!Object.prototype.hasOwnProperty.call(cfg,"bed")) P.bed=def.bed.slice();
      if("fan" in cfg&&!("fan1" in cfg)) cfg.fan1=cfg.fan;
      Object.assign(P,cfg);
    }
    else if(flag==="fan"){
      const v=parseFloat(a[++i]);
      if(!Number.isFinite(v)) die("--fan needs a number");
      P.fan1=v;P.fan=v;
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
  const biaxialPatterns=["plain","twill","crepe","satin","custom"];
  const triaxialPatterns=["cyclic","twill","directional"];
  if(!["biaxial","triaxial"].includes(P.lattice)) die(`unknown lattice '${P.lattice}'`);
  if(!biaxialPatterns.includes(P.pattern)) die(`unknown biaxial pattern '${P.pattern}'`);
  if(!triaxialPatterns.includes(P.triPattern)) die(`unknown triaxial pattern '${P.triPattern}'`);
  if(P.pattern==="custom"&&!Array.isArray(P.draft)) die("pattern 'custom' needs --draft");
  const tp=toolpath(),m=metrics(tp);
  if(want.json)
    console.log(JSON.stringify({params:P,metrics:namedMetrics(m)},null,2));
  if(want.gcode){
    fs.writeFileSync(want.gcode,gcode(tp,printerDef().start(),printerDef().end()));
    console.error(`  wrote ${want.gcode}  (${tp.ops.length} ops)`);
  }
  if(want.ops){
    const payload=JSON.stringify({params:P,ops:tp.ops,stats:tp.st,metrics:namedMetrics(m)});
    if(want.ops==="-") console.log(payload);
    else{fs.writeFileSync(want.ops,payload);console.error(`  wrote ${want.ops}`);}
  }
  if(want.report||!(want.json||want.gcode||want.ops)) console.log(report(m));
}
