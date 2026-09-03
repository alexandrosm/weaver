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
  topology:"straight", lattice:"biaxial", pattern:"twill", triPattern:"cyclic", pitch:3.6, size:30, sizeY:0, rot:45,
  bd:0.9, bh:0.45, sw:0.40, sh:0.20,
  offd:false, offFrac:0.40, ovs:0.30, plies:1, pgap:0.25, tack:3, edge:true, join:true,
  nflat:0.80, ncone:120,
  ps:2400, bs:3600, ts:9000, pspd:300, pstep:3, pflow:1.10, acc:6000,
  flow:1, maxVflow:0, fan1:40, fan:40,
  zhop:0, retract:0, retMin:DEFAULT_RETRACT_MIN_TRAVEL, retSpeed:2400, primeSpeed:2400,
  ht:230, bt:100, printer:"generic", bed:[110,110], draft:CREPE.map(r=>r.slice())
};
const isExperimental=()=>P.topology!=="straight";
/* Field extents: `size` is the width; `sizeY` > 0 gives a rectangular field
   (straight family only — experimental coupons are always square). */
const fieldSize=()=>[P.size,!isExperimental()&&P.sizeY>0?P.sizeY:P.size];
const fieldLabel=()=>{
  const [W,H]=fieldSize();
  return isExperimental()?`${W} mm coupon`:W===H?`${W} mm square`:`${W} x ${H} mm`;
};
function printBounds(){
  const a=P.rot*Math.PI/180,c=Math.abs(Math.cos(a)),s=Math.abs(Math.sin(a));
  const factor=c+s,[W,H]=fieldSize();
  const margin=isExperimental()?Math.max(2,P.bd*2):2*P.pitch;
  const halfX=W/2*c+H/2*s,halfY=W/2*s+H/2*c;
  const probeHalfX=halfX+margin,probeHalfY=halfY+margin;
  const axisAligned=Math.abs(Math.round(P.rot/90)*90-P.rot)<1e-9;
  const swap=axisAligned&&Math.round(P.rot/90)%2!==0;
  return {factor,margin,probeHalfX,probeHalfY,
    maxSize:Math.max(0,2*(Math.min(P.bed[0],P.bed[1])-margin)/factor),
    maxRect:axisAligned?[2*(P.bed[swap?1:0]-margin),2*(P.bed[swap?0:1]-margin)]:null,
    bedMargin:Math.min(P.bed[0]-probeHalfX,P.bed[1]-probeHalfY)};
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
const activePattern=()=>isExperimental()?P.topology:
  (P.lattice==="triaxial"?P.triPattern:P.pattern);
function buildLines(){
  const [W,H]=fieldSize(),out=[];
  families().forEach((F,f)=>{
    const reach=Math.abs(F.n[0])*W/2+Math.abs(F.n[1])*H/2;
    const k0=Math.ceil((-reach-F.ph*P.pitch)/P.pitch),k1=Math.floor((reach-F.ph*P.pitch)/P.pitch);
    for(let k=k0;k<=k1;k++) out.push({f,i:k,n:F.n,d:F.d,c:(k+F.ph)*P.pitch});
  });
  return out;
}
function crossings(L,lines,rule){
  const [W,H]=fieldSize(),p0=[L.c*L.n[0],L.c*L.n[1]],out=[];
  for(const M of lines){
    if(M.f===L.f) continue;
    const den=L.d[0]*M.n[0]+L.d[1]*M.n[1];
    if(Math.abs(den)<1e-9) continue;
    const t=(M.c-(p0[0]*M.n[0]+p0[1]*M.n[1]))/den;
    const x=p0[0]+t*L.d[0],y=p0[1]+t*L.d[1];
    if(Math.abs(x)>W/2+1e-9||Math.abs(y)>H/2+1e-9) continue;
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
  if(isExperimental()) return topologyToolpath(topologyStudy(P.topology));
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
    const z0=tackFrom!=null?tackFrom:zf,n=Math.max(1,Math.round(P.pstep));
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
  if(tp.experimental) return topologyMetrics(tp);
  const ds=tp.ds,st=tp.st,[W,H]=fieldSize(),area=W*H/100;
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
  const nx=v=>v.toFixed(4).replace(/\.?0+$/,"")||"0";
  L.push(`; Loomwright — ${isExperimental()?"EXPERIMENTAL topology":"printed weave"}`);
  if(isExperimental()){
    const study=topologyStudy(P.topology);
    L.push(`; EXPERIMENTAL — ${study.title}; generated geometry is not physically validated`);
    L.push(`; class: ${study.contract.kind}`);
    L.push(`; invariant: ${study.contract.identity}`);
    L.push(`; ${study.components} physical components  ${study.crossings.length} crossings  ${P.size} mm coupon  rot ${P.rot}deg`);
    L.push(`; button ${nx(P.bd)} x ${nx(P.bh)} mm   strand ${nx(P.sw)} x ${nx(P.sh)} mm`);
    L.push("; transition-owned risers only; no sacrificial or foundation supports");
  } else {
    L.push(`; ${P.lattice} / ${activePattern()}  pitch ${P.pitch} mm  ${fieldLabel()}  x${P.plies} ply  rot ${P.rot}deg`);
    L.push(`; button ${P.bd} x ${P.bh} mm   strand ${P.sw} x ${P.sh} mm   offset dashes ${P.offd?"on":"off"}`);
  }
  L.push(`; model flow ${(P.flow*100).toFixed(0)}%   pass fans ${P.fan1}/${P.fan}%`);
  L.push(`; travel z-hop ${P.zhop} mm   retract ${P.retract} mm above ${P.retMin} mm @ ${P.retSpeed}/${P.primeSpeed} mm/min`);
  L.push("G21 ; mm","G90 ; absolute moves","M83 ; relative extrusion");
  if(printerDef().probe){
    const bounds=printBounds(),hx=bounds.probeHalfX,hy=bounds.probeHalfY;
    L.push(`M555 X${Math.max(0,P.bed[0]-hx).toFixed(1)} Y${Math.max(0,P.bed[1]-hy).toFixed(1)}`+
           ` W${(2*hx).toFixed(1)} H${(2*hy).toFixed(1)} ; probe print bounds plus ${bounds.margin.toFixed(1)} mm margin`);
  } else {
    L.push(`M140 S${P.bt}`,`M104 S${P.ht}`,`M190 S${P.bt}`,`M109 S${P.ht}`);
  }
  if(startG) L.push(...startG.split("\n"));
  const flowPct=Math.round(Math.max(0,P.flow)*100);
  L.push(`M221 S${flowPct} ; model extrusion multiplier`);
  let cur=null,lastF=null;
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
      const xyMove=xyDist>1e-9,lifted=op.hop!=null;
      const doRet=retract>0&&cur&&(lifted||(xyMove&&xyDist>=Math.max(0,P.retMin)));
      if(doRet) L.push(`G1 F${P.retSpeed} E-${nx(retract)}`);
      if(lifted||(cur&&xyMove&&zhop>0)){
        const hopZ=lifted?op.hop:Math.max(cur[2],op.z)+zhop;
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
function straightWarnings(m){
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
  return warn;
}
const warnings=m=>m.experimental?topologyWarnings(m):straightWarnings(m);
function report(m){
  if(m.experimental) return topologyReport(m);
  const warn=straightWarnings(m);
  const num=(v,dp,w=10)=>v.toFixed(dp).padStart(w);
  const L=["",
    `  ${P.lattice} / ${activePattern()}   pitch ${P.pitch} mm   ${fieldLabel()}   x${P.plies} ply   rot ${P.rot} deg`,
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
  fButton:"t_button_frac",fTrav:"t_travel_frac",
  roadClear:"unintended_road_clearance_mm",bendRadius:"minimum_bend_radius_mm",
  crossingGap:"minimum_crossing_interval_mm",reserve:"open_path_reserve",
  buttonClear:"button_road_margin_mm",recommendedSize:"recommended_coupon_size_mm"};
function namedMetrics(m){
  const out={};
  for(const [k,v] of Object.entries(m)) out[JSON_NAMES[k]||k]=v;
  return out;
}

/* ==========================================================================
 * experimental topology studies — one diagram grammar, preview and toolpath
 *
 * Every crossing has one explicit upper branch. The printable route converts
 * each sampled strand into low/high arclength runs, prints every low run
 * first, constructs risers separately, then prints high runs. All disconnected
 * travel is lifted above the complete z stack; it does not rely on the straight
 * weave's reverse-sweep proof. These paths are implemented but not yet
 * physically validated, so every output remains labelled EXPERIMENTAL.
 * ========================================================================== */
const TOPO_TAU=Math.PI*2;
const topoCross2=(a,b)=>a[0]*b[1]-a[1]*b[0];
function topoSample(count,closed,fn){
  const den=closed?count:count-1,out=[];
  for(let i=0;i<count;i++) out.push(fn(i/den));
  return out;
}
const topoPath=(id,family,points,closed=false,meta={})=>
  ({id,family,points,closed,meta});
function topoIntersections(paths){
  const segs=[],out=[],seen=new Set(),eps=1e-8;
  paths.forEach((path,pathIndex)=>{
    const count=path.closed?path.points.length:path.points.length-1;
    for(let seg=0;seg<count;seg++)
      segs.push({path:pathIndex,seg,count,a:path.points[seg],
        b:path.points[(seg+1)%path.points.length]});
  });
  for(let i=0;i<segs.length;i++) for(let j=i+1;j<segs.length;j++){
    const A=segs[i],B=segs[j],pathA=paths[A.path];
    if(A.path===B.path){
      const d=Math.abs(A.seg-B.seg);
      if(d<=1||(pathA.closed&&d===A.count-1)) continue;
    }
    if(Math.max(A.a[0],A.b[0])+eps<Math.min(B.a[0],B.b[0])||
       Math.max(B.a[0],B.b[0])+eps<Math.min(A.a[0],A.b[0])||
       Math.max(A.a[1],A.b[1])+eps<Math.min(B.a[1],B.b[1])||
       Math.max(B.a[1],B.b[1])+eps<Math.min(A.a[1],A.b[1])) continue;
    const r=[A.b[0]-A.a[0],A.b[1]-A.a[1]];
    const s=[B.b[0]-B.a[0],B.b[1]-B.a[1]],den=topoCross2(r,s);
    if(Math.abs(den)<eps) continue;
    const q=[B.a[0]-A.a[0],B.a[1]-A.a[1]];
    const u=topoCross2(q,s)/den,v=topoCross2(q,r)/den;
    if(u < -eps||u > 1+eps||v < -eps||v > 1+eps) continue;
    const p=[A.a[0]+u*r[0],A.a[1]+u*r[1]];
    const pair=A.path<=B.path?`${A.path}:${B.path}`:`${B.path}:${A.path}`;
    const key=`${pair}:${Math.round(p[0]*1e5)}:${Math.round(p[1]*1e5)}`;
    if(seen.has(key)) continue;
    seen.add(key);
    const az=A.a[2]||0,bz=A.b[2]||0,cz=B.a[2]||0,dz=B.b[2]||0;
    out.push({a:A.path,b:B.path,p,pa:A.seg+u,pb:B.seg+v,
      ta:r,tb:s,za:az+u*(bz-az),zb:cz+v*(dz-cz)});
  }
  return out;
}
function topoFinalize(study,resolver){
  const crossings=topoIntersections(study.paths),groups=new Map();
  for(const crossing of crossings){
    const key=crossing.a<=crossing.b
      ?`${crossing.a}:${crossing.b}`:`${crossing.b}:${crossing.a}`;
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(crossing);
  }
  for(const group of groups.values()){
    group.sort((a,b)=>(a.pa-b.pa)||(a.pb-b.pb));
    group.forEach((crossing,rank)=>{
      crossing.over=resolver?resolver(crossing,rank,group,study.paths)
        :(rank%2?"b":"a");
    });
  }
  if(!study.contract||!study.contract.verify)
    throw new Error(`${study.id}: missing topology design contract`);
  if(study.paths.length!==study.components)
    throw new Error(`${study.id}: ${study.paths.length} physical paths but ${study.components} declared components`);
  return Object.assign(study,{crossings,printable:true,experimental:true});
}
const topoBranch=(crossing,path,paths)=>paths[crossing.a]===path?"a":"b";
function topoCubic(a,b,c,d,count=16){
  const out=[];
  for(let i=0;i<=count;i++){
    const t=i/count,q=1-t;
    out.push([
      q*q*q*a[0]+3*q*q*t*b[0]+3*q*t*t*c[0]+t*t*t*d[0],
      q*q*q*a[1]+3*q*q*t*b[1]+3*q*t*t*c[1]+t*t*t*d[1],
      q*q*q*(a[2]||0)+3*q*q*t*(b[2]||0)+3*q*t*t*(c[2]||0)+t*t*t*(d[2]||0)
    ]);
  }
  return out;
}
function topoAppendPoints(target,source){
  for(const point of source){
    const last=target[target.length-1];
    if(!last||Math.hypot(last[0]-point[0],last[1]-point[1],
        (last[2]||0)-(point[2]||0))>1e-9) target.push(point.slice());
  }
}

function topoSinusoidalStudy(){
  const paths=[],n=6,pitch=0.25,amp=0.075,wave=0.72;
  for(let i=0;i<n;i++){
    const off=(i-(n-1)/2)*pitch;
    paths.push(topoPath(`weft-${i}`,0,topoSample(96,false,u=>{
      const x=-0.84+1.68*u;
      return [x,off+amp*Math.sin(TOPO_TAU*x/wave)];
    }),false,{kind:"weft",index:i}));
    paths.push(topoPath(`warp-${i}`,1,topoSample(96,false,u=>{
      const y=-0.84+1.68*u;
      return [off+amp*Math.sin(TOPO_TAU*y/wave+Math.PI/2),y];
    }),false,{kind:"warp",index:i}));
  }
  return topoFinalize({
    id:"sinusoidal",title:"Sinusoidal plain weave",tag:"deformed weave coupon",
    note:"A smooth deformation of plain weave, with measurable in-plane path reserve rather than a new topology.",
    paths,expectedCrossings:36,components:12,recommendedSize:32,
    contract:{
      kind:"Finite deformed biaxial weave",
      identity:"6 warp × 6 weft; one crossing per pair; plain-weave parity. Smooth curvature preserves the straight weave's topology.",
      mechanism:"Sinusoidal centre-lines store in-plane arclength that can be released by straightening before the polymer strand stretches.",
      strategy:"Only topology-owned low/high transitions become risers; no added foundation supports or welded crossing props.",
      risk:"The reserve is geometric, not measured strain. Curved strands may rotate or slip at free crossings instead of loading uniformly.",
      source:{label:"Textiles: from twisted yarn to topology and mechanics",
        url:"https://arxiv.org/html/2604.09005v1"},
      verify:{open:12,closed:0,self:{},pairs:{"1":36},alternating:true}
    }
  },(crossing,rank,group,all)=>{
    const a=all[crossing.a],b=all[crossing.b];
    const warp=a.meta.kind==="warp"?a:b,weft=warp===a?b:a;
    const over=(warp.meta.index+weft.meta.index)%2===0?warp:weft;
    return topoBranch(crossing,over,all);
  });
}

function topoAnnularStudy(){
  const paths=[],radii=[0.27,0.43,0.59,0.75],spokes=8;
  radii.forEach((radius,index)=>paths.push(topoPath(`ring-${index}`,0,
    topoSample(128,true,u=>{
      const a=TOPO_TAU*u;return [radius*Math.cos(a),radius*Math.sin(a)];
    }),true,{kind:"ring",index})));
  for(let index=0;index<spokes;index++){
    const base=index*TOPO_TAU/spokes;
    paths.push(topoPath(`spoke-${index}`,1,topoSample(96,false,u=>{
      const radius=0.15+0.67*u,a=base+0.22*(u-0.5);
      return [radius*Math.cos(a),radius*Math.sin(a)];
    }),false,{kind:"spoke",index}));
  }
  return topoFinalize({
    id:"annular",title:"Annular radial weave",tag:"finite radial weave coupon",
    note:"Four closed circumferential rings cross eight open radial spokes; the even spoke count closes every alternating ring word.",
    paths,expectedCrossings:32,components:12,recommendedSize:48,
    contract:{
      kind:"Finite annular weave",
      identity:"4 concentric closed circumferential rings × 8 open radial spokes; every ring-spoke pair crosses once and alternates by ring-plus-spoke parity.",
      mechanism:"Tests how a radial weave accommodates circumference-dependent yarn length and shear without pretending the density is uniform.",
      strategy:"Every high arc is supported only by its neighbouring low/high transition buttons; the centre is deliberately left open.",
      risk:"Fixed ring and spoke counts create a radial density gradient. This coupon does not implement the unequal-pick compensation of production annular cloth.",
      source:{label:"Chen & Guo, shear deformation of annular woven fabrics",
        url:"https://doi.org/10.4028/www.scientific.net/AMR.331.198"},
      verify:{open:8,closed:4,self:{},pairs:{"1":32},alternating:true}
    }
  },(crossing,rank,group,all)=>{
    const a=all[crossing.a],b=all[crossing.b];
    const ring=a.meta.kind==="ring"?a:b,spoke=ring===a?b:a;
    const over=(ring.meta.index+spoke.meta.index)%2===0?ring:spoke;
    return topoBranch(crossing,over,all);
  });
}

function topoCelticStudy(){
  const paths=[],centres=[[-0.38,-0.38],[0.38,-0.38],[-0.38,0.38],[0.38,0.38]];
  centres.forEach(([cx,cy],index)=>paths.push(topoPath(`trefoil-${index}`,index%3,
    topoSample(160,true,u=>{
      const t=TOPO_TAU*u,scale=0.34;
      return [cx+scale*(Math.sin(t)+2*Math.sin(2*t))/3,
        cy+scale*(Math.cos(t)-2*Math.cos(2*t))/3,-Math.sin(3*t)];
    }),true,{kind:"trefoil",index})));
  return topoFinalize({
    id:"celtic",title:"Celtic trefoil repeat",tag:"alternating knot coupons",
    note:"Four separate trefoil knots repeat ornamentally; this is a knot array, not a periodic textile or an interlinked fabric.",
    paths,expectedCrossings:12,components:4,recommendedSize:24,
    contract:{
      kind:"Repeated closed-knot coupon",
      identity:"Four disjoint alternating trefoil components; three self-crossings per component and no crossings between components.",
      mechanism:"Exercises seamless closed components, self-crossing words, and alternating transition ownership before attempting connected knotwork.",
      strategy:"Each trefoil is one continuous closed path with six alternating crossing encounters and transition-only risers.",
      risk:"The four components are neither mutually linked nor a load-bearing sheet. Mechanical use requires a later inter-component connection design.",
      source:{label:"University of Edinburgh, Celtic Knot Theory",
        url:"https://webhomes.maths.ed.ac.uk/~v1ranick/knots/celtic.pdf"},
      verify:{open:0,closed:4,self:{"3":4},pairs:{},alternating:true,
        componentDeterminant:{"3":4}}
    }
  },crossing=>crossing.za>=crossing.zb?"a":"b");
}

/* Closure lane for the strand leaving slot `slot` at the top: a vertical stub,
   a quarter arc, a horizontal run, a second arc, a vertical descent outside the
   braid box, and the mirror image back to the same slot at the bottom. Lanes
   nest with constant spacing and concentric outer arcs, so every bend radius is
   at least the innermost arc radius and no lane crosses another. */
function topoBraidClosure(slot,slots,bottom,top){
  const nest=slots.length-1-slot,spacing=0.06,r0=0.10;
  const x=slots[slot],r=r0+nest*spacing,level=top+r0+0.02+nest*spacing;
  const outer=slots[slots.length-1]+2*r0+0.02+nest*spacing,out=[];
  const arc=(cx,cy,from,to)=>{
    const steps=8;
    for(let i=0;i<=steps;i++){
      const a=from+(to-from)*i/steps;
      out.push([cx+r*Math.cos(a),cy+r*Math.sin(a),0]);
    }
  };
  out.push([x,top,0],[x,level-r,0]);
  arc(x+r,level-r,Math.PI,Math.PI/2);
  out.push([outer-r,level,0]);
  arc(outer-r,level-r,Math.PI/2,0);
  out.push([outer,-level+r,0]);
  arc(outer-r,-level+r,0,-Math.PI/2);
  out.push([x+r,-level,0]);
  arc(x+r,-level+r,-Math.PI/2,-Math.PI);
  out.push([x,bottom,0]);
  return out;
}
/* Braid convention: for generator +i the strand in slot i (left) passes OVER
   the strand in slot i+1 while they swap; -i puts it under. This is the mirror
   of Rolfsen's tutorial convention; the shipped words are amphichiral. */
function topoBraidStudy(spec,n,word){
  const bottom=-0.72,top=0.72,slots=Array.from({length:n},(_,i)=>
    n===1?0:-0.26+i*0.52/(n-1));
  const points=Array.from({length:n},(_,i)=>[[slots[i],bottom,0]]);
  const order=Array.from({length:n},(_,i)=>i);
  const push=(strand,x,y,z=0)=>{
    const list=points[strand],last=list[list.length-1];
    if(!last||Math.hypot(last[0]-x,last[1]-y,(last[2]||0)-z)>1e-9)
      list.push([x,y,z]);
  };
  const step=(top-bottom)/word.length,ease=24;
  for(let k=0;k<word.length;k++){
    const generator=word[k],slot=Math.abs(generator)-1;
    if(slot<0||slot>=n-1) throw new Error(`invalid braid generator ${generator}`);
    const y0=bottom+k*step,y1=y0+step;
    for(let s=0;s<n;s++) push(order[s],slots[s],y0,0);
    for(let q=1;q<=ease;q++){
      const u=q/ease,e=(1-Math.cos(Math.PI*u))/2,y=y0+(y1-y0)*u;
      for(let s=0;s<n;s++){
        let x=slots[s],z=0;
        if(s===slot){
          x=slots[slot]+(slots[slot+1]-slots[slot])*e;
          z=(generator>0?1:-1)*Math.sin(Math.PI*u);
        } else if(s===slot+1){
          x=slots[slot+1]+(slots[slot]-slots[slot+1])*e;
          z=(generator>0?-1:1)*Math.sin(Math.PI*u);
        }
        push(order[s],x,y,z);
      }
    }
    const left=order[slot];order[slot]=order[slot+1];order[slot+1]=left;
  }
  for(let s=0;s<n;s++) push(order[s],slots[s],top,0);
  const endSlot=Array(n);
  order.forEach((strand,slot)=>endSlot[strand]=slot);
  const paths=[],visited=Array(n).fill(false);
  for(let start=0;start<n;start++) if(!visited[start]){
    const merged=[];let strand=start;
    while(!visited[strand]){
      visited[strand]=true;
      topoAppendPoints(merged,points[strand]);
      const slot=endSlot[strand];
      topoAppendPoints(merged,topoBraidClosure(slot,slots,bottom,top));
      strand=slot;
    }
    if(merged.length>1&&Math.hypot(merged[0][0]-merged[merged.length-1][0],
        merged[0][1]-merged[merged.length-1][1])<1e-9) merged.pop();
    paths.push(topoPath(`${spec.id}-component-${paths.length}`,paths.length%3,
      merged,true,{kind:"closed-braid",component:paths.length,word:word.slice()}));
  }
  return topoFinalize(Object.assign({},spec,{paths,components:paths.length}),
    crossing=>crossing.za>=crossing.zb?"a":"b");
}

function topoChainmailStudy(){
  const paths=[],radius=0.30,spacing=0.45,h=spacing/Math.SQRT2;
  const theta=40*Math.PI/180,rowCounts=[3,4,3];
  let index=0;
  rowCounts.forEach((count,row)=>{
    const tilt=(row%2?1:-1)*theta,cy=(row-1)*h;
    for(let col=0;col<count;col++){
      const cx=(2*col-(count-1))*h,ringIndex=index++;
      paths.push(topoPath(`mail-${ringIndex}`,(row+col)%3,
        topoSample(160,true,u=>{
          const a=TOPO_TAU*u,c=Math.cos(a),s=Math.sin(a);
          return [cx+radius*c*Math.cos(tilt),cy+radius*s,
            -radius*c*Math.sin(tilt)];
        }),true,{kind:"ring",index:ringIndex,row,col,tilt}));
    }
  });
  return topoFinalize({
    id:"chainmail",title:"European 4-in-1 coupon",tag:"polycatenane sheet",
    note:"A staggered 3–4–3 patch of ten rings; all twelve adjacent-row pairs are two-crossing Hopf links.",
    paths,expectedCrossings:24,components:10,recommendedSize:96,
    contract:{
      kind:"Finite polycatenane network",
      identity:"Ten closed rings on a staggered 3–4–3 square-lattice patch; 12 adjacent-row pairs are Hopf-linked and the two interior middle-row rings have valence four.",
      mechanism:"Compliance comes from relative rotation and translation of linked rings, not shear between long warp and weft threads.",
      strategy:"The two-level print projects Klotz's row-alternating ±40° ring construction at centre spacing 1.5 radii; every declared neighbour has linking number ±1.",
      risk:"A planar two-height print must release every ring contact. Any accidental crossing weld converts a mobile link into a rigid lattice.",
      source:{label:"Klotz, geometric considerations for 4-in-1 chainmail",
        url:"https://arxiv.org/html/2507.20903#S4"},
      verify:{open:0,closed:10,self:{},pairs:{"2":12},linkingAbs:{"1":12},
        pairDeterminant:{"2":12},words:{"OUOU":6,"OOUU":2,"OOUOUUOU":2}}
    }
  },crossing=>crossing.za>=crossing.zb?"a":"b");
}

function topoLenoStudy(){
  const paths=[],centres=[-0.52,0,0.52],wefts=[-0.6,-0.2,0.2,0.6];
  centres.forEach((centre,pair)=>{
    for(let strand=0;strand<2;strand++){
      const sign=strand?1:-1;
      paths.push(topoPath(`leno-${pair}-${strand}`,strand?2:0,
        topoSample(160,false,u=>{
          const y=-0.74+1.48*u;
          return [centre+sign*0.11*Math.cos(Math.PI*(y+0.6)/0.4),y];
        }),false,{kind:"warp",pair,strand}));
    }
  });
  wefts.forEach((y,index)=>paths.push(topoPath(`leno-weft-${index}`,1,
    [[-0.84,y],[0.84,y]],false,{kind:"weft",index})));
  return topoFinalize({
    id:"leno",title:"True leno / gauze",tag:"paired doup warps",
    note:"Each doup end passes over every pick from alternating sides of its skeleton end, so the pair twists S then Z with no net twist.",
    paths,expectedCrossings:33,components:10,recommendedSize:28,
    contract:{
      kind:"Finite true-leno weave",
      identity:"Three doup/skeleton warp pairs × four wefts; the doup end passes over every pick from alternating sides of its skeleton end and under it between picks, so partner crossings alternate in sign and the pair carries no net twist.",
      mechanism:"The paired warps wrap around each weft to resist yarn slippage while preserving an intentionally open fabric.",
      strategy:"Partner crossings and warp-weft crossings share the same two-level transition grammar; no mock-leno substitution is used.",
      risk:"Printed transition buttons may make the doup crossings rigid instead of frictionally gripping. Openness is modelled; locking force is not.",
      source:{label:"US10023981B2, traditional leno structure",
        url:"https://patents.google.com/patent/US10023981B2/en"},
      verify:{open:10,closed:0,self:{},pairs:{"1":24,"3":3},alternating:true}
    }
  },(crossing,rank,group,all)=>{
    const a=all[crossing.a],b=all[crossing.b];
    if(a.meta.kind!==b.meta.kind){
      const warp=a.meta.kind==="warp"?a:b,weft=warp===a?b:a;
      const over=warp.meta.strand===0?warp:weft;
      return topoBranch(crossing,over,all);
    }
    return a.meta.strand===1?"a":"b";
  });
}

let TOPOLOGY_STUDIES=null;
function topologyStudies(){
  if(!TOPOLOGY_STUDIES){
    TOPOLOGY_STUDIES=[
      topoSinusoidalStudy(),
      topoAnnularStudy(),
      topoCelticStudy(),
      topoBraidStudy({
        id:"braid",title:"Figure-eight braid closure",tag:"closed braid knot",
        note:"The standard closure of β=(σ₁σ₂⁻¹)², assembled as one continuous four-crossing component.",
        expectedCrossings:4,recommendedSize:26,
        contract:{
          kind:"Closed-braid knot coupon",
          identity:"Closure of the 3-braid β=(σ₁σ₂⁻¹)²; one component and the reduced alternating diagram of the figure-eight knot 4₁.",
          mechanism:"A single strand carries the complete braid word and returns through a crossing-free closure lane of straight runs and constant-radius arcs.",
          strategy:"The closure is merged into the physical component before run splitting, eliminating the former duplicate seam dots.",
          risk:"The long outer closure dominates material and bend radius; its seam is computationally closed but not pull-tested.",
          source:{label:"Knot Atlas, 4_1: minimum braid BR(3,{-1,2,-1,2}), determinant 5",
            url:"https://katlas.org/wiki/4_1"},
          verify:{open:0,closed:1,self:{"4":1},pairs:{},alternating:true,determinant:5}
        }
      },3,[1,-2,1,-2]),
      topoChainmailStudy(),
      topoLenoStudy(),
      topoBraidStudy({
        id:"borromean",title:"Borromean / Brunnian",tag:"three-component Brunnian link",
        note:"The closure of β=(σ₁σ₂⁻¹)³: three components, six crossings, zero pairwise linking, collective entanglement.",
        expectedCrossings:6,recommendedSize:34,
        contract:{
          kind:"Brunnian link coupon",
          identity:"Closure of the pure 3-braid β=(σ₁σ₂⁻¹)³; three unknotted components, two crossings per component pair, and pairwise linking number zero.",
          mechanism:"All three components are required for the link: removing any one should release the other two if every crossing remains free.",
          strategy:"Three actual closed component paths are assembled before run splitting; no disconnected decorative closure strokes remain.",
          risk:"One accidental weld destroys the Brunnian release test, and the shallow braid crossings carry the atlas's longest overpasses. The topology is verified from the diagram, not yet by a physical cut-and-release trial.",
          source:{label:"Borromean braid representation, arXiv:math/0405248",
            url:"https://arxiv.org/abs/math/0405248"},
          verify:{open:0,closed:3,self:{},pairs:{"2":3},
            linkingAbs:{"0":3},alternating:true,determinant:16,pairDeterminant:{"0":3}}
        }
      },3,[1,-2,1,-2,1,-2])
    ];
  }
  return TOPOLOGY_STUDIES;
}


const topologyStudy=id=>{
  const study=topologyStudies().find(item=>item.id===id);
  if(!study) throw new Error(`unknown experimental topology '${id}'`);
  return study;
};
const TOPOLOGY_REFERENCE=Object.freeze({bd:0.90,sw:0.40,vgap:0.13,minBh:0.45});
function topologyDefaultParams(study){
  const freeDia=Math.sqrt(4*TOPOLOGY_REFERENCE.sw*P.sh/Math.PI);
  return {topology:study.id,size:study.recommendedSize,sizeY:0,plies:1,
    bd:TOPOLOGY_REFERENCE.bd,sw:TOPOLOGY_REFERENCE.sw,
    bh:Math.ceil(Math.max(TOPOLOGY_REFERENCE.minBh,freeDia+TOPOLOGY_REFERENCE.vgap)*100-1e-6)/100};
}

function topoArcData(path){
  const count=path.closed?path.points.length:path.points.length-1;
  const lens=[],cum=[0];
  for(let i=0;i<count;i++){
    const a=path.points[i],b=path.points[(i+1)%path.points.length];
    lens.push(dist(a,b));cum.push(cum[cum.length-1]+lens[lens.length-1]);
  }
  return {path,count,lens,cum,total:cum[cum.length-1],closed:path.closed};
}
function topoArcS(arc,param){
  const seg=Math.max(0,Math.min(arc.count-1,Math.floor(param)));
  const frac=Math.max(0,Math.min(1,param-seg));
  return arc.cum[seg]+arc.lens[seg]*frac;
}
function topoArcPoint(arc,s){
  if(arc.total<=1e-12) return arc.path.points[0].slice(0,2);
  if(arc.closed) s=mod(s,arc.total);
  else s=Math.max(0,Math.min(arc.total,s));
  if(!arc.closed&&s>=arc.total-1e-10)
    return arc.path.points[arc.path.points.length-1].slice(0,2);
  let lo=0,hi=arc.count-1;
  while(lo<hi){
    const mid=(lo+hi)>>1;
    if(arc.cum[mid+1]<s) lo=mid+1; else hi=mid;
  }
  const a=arc.path.points[lo],b=arc.path.points[(lo+1)%arc.path.points.length];
  const u=arc.lens[lo]>1e-12?(s-arc.cum[lo])/arc.lens[lo]:0;
  return [a[0]+(b[0]-a[0])*u,a[1]+(b[1]-a[1])*u];
}
/* Emit the source vertices inside [s0,s1] and subdivide only the segments that
   exceed the step, so the printed polyline never leaves the analysed one. */
function topoArcSlice(arc,s0,s1){
  const maxStep=Math.max(0.25,Math.min(0.6,P.sw*1.25)),stops=[s0];
  if(arc.total>1e-12){
    for(let wrap=0;wrap<(arc.closed?2:1);wrap++){
      const offset=wrap*arc.total;
      for(let i=0;i<arc.count;i++){
        const s=offset+arc.cum[i];
        if(s>s0+1e-9&&s<s1-1e-9) stops.push(s);
      }
    }
  }
  stops.push(Math.max(s0,s1));
  const out=[topoArcPoint(arc,stops[0])];
  for(let i=1;i<stops.length;i++){
    const gap=stops[i]-stops[i-1],n=Math.max(1,Math.ceil(gap/maxStep));
    for(let j=1;j<=n;j++) out.push(topoArcPoint(arc,stops[i-1]+gap*j/n));
  }
  return out;
}
/* Distance from p to the polyline of `arc`, optionally ignoring the segments
   within `excludeRadius` arclength of `excludeS` (the point's own strand). */
function topoPolylineDistance(p,arc,excludeS=null,excludeRadius=0){
  const pts=arc.path.points;let best=Infinity;
  for(let i=0;i<arc.count;i++){
    if(excludeS!=null){
      const s0=arc.cum[i],s1=arc.cum[i+1];
      let gap=Math.max(0,Math.max(s0-excludeS,excludeS-s1));
      if(arc.closed) gap=Math.min(gap,Math.max(0,arc.total-Math.max(s1,excludeS)+Math.min(s0,excludeS)));
      if(gap<excludeRadius) continue;
    }
    best=Math.min(best,topoPointSegDistance(p,pts[i],pts[(i+1)%pts.length]));
  }
  return best;
}
/* Overpass window for one over-branch event. The straight-strand estimate
   c/sin θ is the starting point; each side is then widened until the transition
   site clears the under strand's actual polyline by c = D/2 + w/2 + 0.10 mm,
   capped at 38% of the arclength to the nearest other crossing or open end so
   one overpass never swallows the next crossing. A capped side that still
   fails is reported by the button/road margin metric rather than hidden. */
function topoWindow(event,arc,underArc,nearest){
  const crossing=event.crossing;
  const la=Math.hypot(...crossing.ta),lb=Math.hypot(...crossing.tb);
  const sine=la>1e-12&&lb>1e-12
    ?Math.abs(topoCross2(crossing.ta,crossing.tb))/(la*lb):0;
  const c=P.bd/2+P.sw/2+0.10,cap=nearest*0.38;
  const base=Math.min(cap,Math.max(P.sw*2,0.8,c/Math.max(sine,0.10)));
  const self=underArc===arc;
  const clear=s=>topoPolylineDistance(topoArcPoint(arc,s),underArc,
    self?(arc.closed?mod(s,arc.total):Math.max(0,Math.min(arc.total,s))):null,
    self?P.bd*2:0)>=c-1e-9;
  const grow=dir=>{
    let half=base;
    while(half<cap-1e-9&&!clear(event.s+dir*half)) half=Math.min(cap,half+0.05);
    return half;
  };
  return {before:grow(-1),after:grow(1)};
}
function topoPathRuns(pathIndex,arc,events,arcs){
  const eps=1e-7,total=arc.total;
  events.sort((a,b)=>a.s-b.s);
  const over=events.filter(event=>event.hi).map(event=>{
    let nearest=arc.closed?total/2:Math.min(event.s,total-event.s);
    for(const other of events){
      if(other===event) continue;
      const delta=Math.abs(event.s-other.s);
      nearest=Math.min(nearest,arc.closed?Math.min(delta,total-delta):delta);
    }
    const underIndex=event.branch==="a"?event.crossing.b:event.crossing.a;
    return Object.assign({},event,topoWindow(event,arc,arcs[underIndex],nearest));
  });
  const isHigh=s=>over.some(event=>{
    let d=s-event.s;
    if(arc.closed) d=mod(d+total/2,total)-total/2;
    return d<0?-d<event.before:d<event.after;
  });
  const cuts=[0,total];
  for(const event of over){
    if(arc.closed){
      cuts.push(mod(event.s-event.before,total),mod(event.s+event.after,total));
    } else {
      cuts.push(Math.max(0,event.s-event.before),Math.min(total,event.s+event.after));
    }
  }
  cuts.sort((a,b)=>a-b);
  const unique=cuts.filter((value,index)=>!index||value-cuts[index-1]>eps);
  let runs=[];
  for(let i=0;i<unique.length-1;i++){
    const s0=unique[i],s1=unique[i+1];
    if(s1-s0<=eps) continue;
    const hi=isHigh((s0+s1)/2),last=runs[runs.length-1];
    if(last&&last.hi===hi) last.s1=s1;
    else runs.push({pathIndex,s0,s1,hi,closed:arc.closed});
  }
  if(arc.closed&&runs.length>1&&runs[0].hi===runs[runs.length-1].hi){
    const first=runs.shift(),last=runs.pop();
    runs.unshift({pathIndex,s0:last.s0,s1:first.s1+total,hi:first.hi,closed:true});
  }
  if(!runs.length) runs.push({pathIndex,s0:0,s1:total,hi:false,closed:arc.closed});
  const transitions=[];
  for(const run of runs) if(run.hi){
    transitions.push(arc.closed?mod(run.s0,total):run.s0);
    transitions.push(arc.closed?mod(run.s1,total):run.s1);
  }
  for(const run of runs){
    run.crossings=events.map(event=>{
      let s=event.s;
      if(arc.closed&&s<run.s0-eps) s+=total;
      return Object.assign({},event,{runS:s});
    }).filter(event=>event.runS>=run.s0-eps&&event.runS<=run.s1+eps);
  }
  return {runs,transitions};
}
const topoHist=values=>{
  const out={};
  for(const value of values) out[value]=(out[value]||0)+1;
  return out;
};
function topoDiagramFacts(study){
  const pairData=new Map(),selfData=new Map(),words=study.paths.map(()=>[]);
  for(const crossing of study.crossings){
    words[crossing.a].push({p:crossing.pa,hi:crossing.over==="a"});
    words[crossing.b].push({p:crossing.pb,hi:crossing.over==="b"});
    if(crossing.a===crossing.b){
      selfData.set(crossing.a,(selfData.get(crossing.a)||0)+1);
      continue;
    }
    const key=`${Math.min(crossing.a,crossing.b)}:${Math.max(crossing.a,crossing.b)}`;
    if(!pairData.has(key)) pairData.set(key,{count:0,writhe:0});
    const data=pairData.get(key),overA=crossing.over==="a";
    data.count++;
    data.writhe+=Math.sign(topoCross2(overA?crossing.ta:crossing.tb,
      overA?crossing.tb:crossing.ta));
  }
  let alternating=true;
  words.forEach((word,pathIndex)=>{
    word.sort((a,b)=>a.p-b.p);
    const end=study.paths[pathIndex].closed?word.length:word.length-1;
    for(let i=0;i<end;i++) if(word[i].hi===word[(i+1)%word.length].hi)
      alternating=false;
  });
  const closedWords=[];
  words.forEach((word,pathIndex)=>{
    if(study.paths[pathIndex].closed) closedWords.push(topoCanonicalWord(word));
  });
  return {
    open:study.paths.filter(path=>!path.closed).length,
    closed:study.paths.filter(path=>path.closed).length,
    self:topoHist([...selfData.values()]),
    pairs:topoHist([...pairData.values()].map(data=>data.count)),
    linkingAbs:topoHist([...pairData.values()].map(data=>Math.abs(data.writhe/2))),
    interacting:[...pairData.keys()].map(key=>key.split(":").map(Number)),
    words:topoHist(closedWords),
    alternating
  };
}
/* Canonical over/under word of a closed strand: the smallest rotation of the
   word or of its reverse, so a ring word compares equal regardless of where
   the sampled path starts or which way it runs. */
function topoCanonicalWord(word){
  const letters=word.map(entry=>entry.hi?"O":"U");
  let best=null;
  for(const seq of [letters,letters.slice().reverse()])
    for(let i=0;i<seq.length;i++){
      const rotation=seq.slice(i).concat(seq.slice(0,i)).join("");
      if(best===null||rotation<best) best=rotation;
    }
  return best||"";
}
/* Fox colouring determinant of the sub-diagram spanned by `pathSet`. Arcs run
   between consecutive undercrossings, each crossing contributes the row
   2·over − under_in − under_out, and the determinant of any (n−1) minor is the
   knot/link determinant: 3 trefoil, 5 figure-eight, 2 Hopf link, 16 Borromean
   rings, 0 for a split diagram. Exact BigInt Bareiss elimination. */
function topoDeterminant(study,pathSet){
  const inSet=new Set(pathSet);
  const crossings=study.crossings.filter(c=>inSet.has(c.a)&&inSet.has(c.b));
  if(!crossings.length) return pathSet.length===1?1:0;
  const encounters=new Map(pathSet.map(index=>[index,[]]));
  crossings.forEach((crossing,index)=>{
    encounters.get(crossing.a).push({p:crossing.pa,hi:crossing.over==="a",index,branch:"a"});
    encounters.get(crossing.b).push({p:crossing.pb,hi:crossing.over==="b",index,branch:"b"});
  });
  const arcOf=new Map();let arcs=0;
  for(const list of encounters.values()){
    list.sort((a,b)=>a.p-b.p);
    const unders=list.filter(entry=>!entry.hi).length;
    if(!unders&&pathSet.length>1) return 0;
    const k=Math.max(1,unders);let seen=0;
    for(const entry of list){
      if(entry.hi) arcOf.set(`${entry.index}:${entry.branch}`,{over:arcs+seen%k});
      else {
        arcOf.set(`${entry.index}:${entry.branch}`,{in:arcs+seen%k,out:arcs+(seen+1)%k});
        seen++;
      }
    }
    arcs+=k;
  }
  const n=crossings.length;
  if(arcs!==n) return 0;
  if(n===1) return 1;
  const M=crossings.map(()=>Array(n).fill(0n));
  crossings.forEach((crossing,index)=>{
    const over=arcOf.get(`${index}:${crossing.over}`).over;
    const under=arcOf.get(`${index}:${crossing.over==="a"?"b":"a"}`);
    M[index][over]+=2n;M[index][under.in]-=1n;M[index][under.out]-=1n;
  });
  const m=n-1,A=M.slice(0,m).map(row=>row.slice(0,m));
  let prev=1n,sign=1n;
  for(let k=0;k<m-1;k++){
    if(A[k][k]===0n){
      const swap=A.findIndex((row,i)=>i>k&&row[k]!==0n);
      if(swap<0) return 0;
      [A[k],A[swap]]=[A[swap],A[k]];sign=-sign;
    }
    for(let i=k+1;i<m;i++) for(let j=k+1;j<m;j++)
      A[i][j]=(A[i][j]*A[k][k]-A[i][k]*A[k][j])/prev;
    prev=A[k][k];
  }
  const det=A[m-1][m-1]*sign;
  return Number(det<0n?-det:det);
}
const topoSameHist=(actual,expected)=>{
  const keys=[...new Set([...Object.keys(actual),...Object.keys(expected)])].sort();
  return keys.every(key=>(actual[key]||0)===(expected[key]||0));
};
function topoContractErrors(study){
  const expected=study.contract.verify,actual=topoDiagramFacts(study),errors=[];
  if(actual.open!==expected.open||actual.closed!==expected.closed)
    errors.push(`component boundary ${actual.open} open/${actual.closed} closed, expected ${expected.open}/${expected.closed}`);
  if(!topoSameHist(actual.self,expected.self||{}))
    errors.push(`self-crossing profile ${JSON.stringify(actual.self)}, expected ${JSON.stringify(expected.self||{})}`);
  if(!topoSameHist(actual.pairs,expected.pairs||{}))
    errors.push(`pair-crossing profile ${JSON.stringify(actual.pairs)}, expected ${JSON.stringify(expected.pairs||{})}`);
  if(expected.linkingAbs&&!topoSameHist(actual.linkingAbs,expected.linkingAbs))
    errors.push(`pair-linking profile ${JSON.stringify(actual.linkingAbs)}, expected ${JSON.stringify(expected.linkingAbs)}`);
  if(expected.alternating===true&&!actual.alternating)
    errors.push("declared alternating crossing word is not alternating");
  if(expected.words&&!topoSameHist(actual.words,expected.words))
    errors.push(`ring words ${JSON.stringify(actual.words)}, expected ${JSON.stringify(expected.words)}`);
  if(expected.determinant!=null){
    const det=topoDeterminant(study,study.paths.map((_,index)=>index));
    if(det!==expected.determinant)
      errors.push(`diagram determinant ${det}, expected ${expected.determinant}`);
  }
  if(expected.componentDeterminant){
    const hist=topoHist(study.paths.map((path,index)=>path.closed?topoDeterminant(study,[index]):null)
      .filter(value=>value!==null));
    if(!topoSameHist(hist,expected.componentDeterminant))
      errors.push(`component determinants ${JSON.stringify(hist)}, expected ${JSON.stringify(expected.componentDeterminant)}`);
  }
  if(expected.pairDeterminant){
    const hist=topoHist(actual.interacting.map(pair=>topoDeterminant(study,pair)));
    if(!topoSameHist(hist,expected.pairDeterminant))
      errors.push(`pair determinants ${JSON.stringify(hist)}, expected ${JSON.stringify(expected.pairDeterminant)}`);
  }
  return errors;
}
function topoPointSegDistance(p,a,b){
  const dx=b[0]-a[0],dy=b[1]-a[1],den=dx*dx+dy*dy;
  if(den<1e-18) return dist(p,a);
  const t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/den));
  return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);
}
function topoSegmentDistance(a,b,c,d){
  const r=[b[0]-a[0],b[1]-a[1]],s=[d[0]-c[0],d[1]-c[1]];
  const den=topoCross2(r,s),q=[c[0]-a[0],c[1]-a[1]];
  if(Math.abs(den)>1e-12){
    const u=topoCross2(q,s)/den,v=topoCross2(q,r)/den;
    if(u>=0&&u<=1&&v>=0&&v<=1) return 0;
  }
  return Math.min(topoPointSegDistance(a,c,d),topoPointSegDistance(b,c,d),
    topoPointSegDistance(c,a,b),topoPointSegDistance(d,a,b));
}
function topoGeometryQuality(paths,study,arcs,events,runs,posts){
  const segments=[],crossingSites=new Map();
  const pairKey=(a,b)=>a<=b?`${a}:${b}`:`${b}:${a}`;
  for(const crossing of study.crossings){
    const a={path:crossing.a,s:topoArcS(arcs[crossing.a],crossing.pa)};
    const b={path:crossing.b,s:topoArcS(arcs[crossing.b],crossing.pb)};
    const over=crossing.over==="a"?a:b,under=over===a?b:a,arc=arcs[over.path];
    const highRun=runs.find(run=>{
      if(!run.hi||run.pathIndex!==over.path) return false;
      let s=over.s;
      if(arc.closed&&s<run.s0) s+=arc.total;
      return s>=run.s0-1e-7&&s<=run.s1+1e-7;
    });
    let s=over.s;
    if(highRun&&arc.closed&&s<highRun.s0) s+=arc.total;
    const reach=highRun?Math.min(s-highRun.s0,highRun.s1-s):0;
    const key=pairKey(a.path,b.path);
    if(!crossingSites.has(key)) crossingSites.set(key,[]);
    crossingSites.get(key).push({over,under,reach});
  }
  paths.forEach((path,pathIndex)=>{
    const arc=arcs[pathIndex],count=arc.count;
    for(let seg=0;seg<count;seg++) segments.push({pathIndex,seg,count,
      s0:arc.cum[seg],s1:arc.cum[seg+1],
      s:(arc.cum[seg]+arc.cum[seg+1])/2,
      a:path.points[seg],b:path.points[(seg+1)%path.points.length]});
  });
  const nearIntentionalCrossing=(a,b)=>{
    const sites=crossingSites.get(pairKey(a.pathIndex,b.pathIndex))||[];
    const near=(segment,site,reach)=>{
      if(segment.pathIndex!==site.path) return false;
      const arc=arcs[site.path];
      const linear=q=>q<segment.s0?segment.s0-q:q>segment.s1?q-segment.s1:0;
      const delta=arc.closed
        ?Math.min(linear(site.s),linear(site.s+arc.total),linear(site.s-arc.total))
        :linear(site.s);
      return delta<=reach;
    };
    return sites.some(site=>
      (near(a,site.over,site.reach)&&near(b,site.under,site.reach+P.sw))||
      (near(b,site.over,site.reach)&&near(a,site.under,site.reach+P.sw)));
  };
  let minCentreGap=Infinity;
  for(let i=0;i<segments.length;i++) for(let j=i+1;j<segments.length;j++){
    const a=segments[i],b=segments[j];
    if(a.pathIndex===b.pathIndex){
      const arc=arcs[a.pathIndex];
      let gap=Math.max(0,Math.max(a.s0,b.s0)-Math.min(a.s1,b.s1));
      if(arc.closed)
        gap=Math.min(gap,Math.max(0,Math.min(a.s0,b.s0)+arc.total-Math.max(a.s1,b.s1)));
      if(gap<Math.max(P.bd*2,P.sw*4)) continue;
    }
    if(nearIntentionalCrossing(a,b)) continue;
    const dx=Math.max(0,Math.max(Math.min(a.a[0],a.b[0]),Math.min(b.a[0],b.b[0]))-
      Math.min(Math.max(a.a[0],a.b[0]),Math.max(b.a[0],b.b[0])));
    const dy=Math.max(0,Math.max(Math.min(a.a[1],a.b[1]),Math.min(b.a[1],b.b[1]))-
      Math.min(Math.max(a.a[1],a.b[1]),Math.max(b.a[1],b.b[1])));
    if(dx>minCentreGap||dy>minCentreGap) continue;
    minCentreGap=Math.min(minCentreGap,topoSegmentDistance(a.a,a.b,b.a,b.b));
  }
  let minBendRadius=Infinity;
  for(const path of paths){
    const start=path.closed?0:1,end=path.closed?path.points.length:path.points.length-1;
    for(let i=start;i<end;i++){
      const a=path.points[mod(i-1,path.points.length)],b=path.points[i],
        c=path.points[(i+1)%path.points.length];
      const ab=dist(a,b),bc=dist(b,c),ac=dist(a,c);
      const twiceArea=Math.abs(topoCross2([b[0]-a[0],b[1]-a[1]],
        [c[0]-a[0],c[1]-a[1]]));
      if(ab>1e-9&&bc>1e-9&&twiceArea>ab*bc*1e-6)
        minBendRadius=Math.min(minBendRadius,ab*bc*ac/(2*twiceArea));
    }
  }
  let openLength=0,openChord=0,minCrossingGap=Infinity;
  arcs.forEach((arc,pathIndex)=>{
    if(!arc.closed){
      openLength+=arc.total;
      openChord+=dist(arc.path.points[0],arc.path.points[arc.path.points.length-1]);
    }
    const sites=events[pathIndex].map(event=>event.s).sort((a,b)=>a-b);
    for(let i=1;i<sites.length;i++)
      minCrossingGap=Math.min(minCrossingGap,sites[i]-sites[i-1]);
    if(arc.closed&&sites.length>1)
      minCrossingGap=Math.min(minCrossingGap,arc.total-sites[sites.length-1]+sites[0]);
  });
  /* Button / road margin: every transition riser and open-strand endpoint
     button is a D-wide dot on the plane of the road it terminates; measure each
     against every road of a foreign strand (or of its own strand beyond 2·D of
     arclength) and against every other button. Roads need D/2 + w/2, buttons
     need D. Negative means contact — the accidental weld the contracts forbid. */
  const buttons=posts.map(post=>({p:post.p,pathIndex:post.pathIndex,s:post.s}));
  arcs.forEach((arc,pathIndex)=>{
    if(arc.closed) return;
    buttons.push({p:topoArcPoint(arc,0),pathIndex,s:0});
    buttons.push({p:topoArcPoint(arc,arc.total),pathIndex,s:arc.total});
  });
  let buttonClear=Infinity;
  for(const button of buttons){
    arcs.forEach((arc,pathIndex)=>{
      const own=pathIndex===button.pathIndex;
      const d=topoPolylineDistance(button.p,arc,own?button.s:null,own?P.bd*2:0);
      buttonClear=Math.min(buttonClear,d-(P.bd/2+P.sw/2));
    });
  }
  for(let i=0;i<buttons.length;i++) for(let j=i+1;j<buttons.length;j++)
    buttonClear=Math.min(buttonClear,dist(buttons[i].p,buttons[j].p)-P.bd);
  return {
    minCentreGap:isFinite(minCentreGap)?minCentreGap:P.size,
    roadClear:(isFinite(minCentreGap)?minCentreGap:P.size)-P.sw,
    buttonClear:isFinite(buttonClear)?buttonClear:P.size,
    minBendRadius:isFinite(minBendRadius)?minBendRadius:P.size,
    minCrossingGap:isFinite(minCrossingGap)?minCrossingGap:P.size,
    reserve:openChord>1e-9?openLength/openChord-1:0
  };
}
function topologyModel(study){
  const source=study.paths.flatMap(path=>path.points);
  const minX=Math.min(...source.map(point=>point[0]));
  const maxX=Math.max(...source.map(point=>point[0]));
  const minY=Math.min(...source.map(point=>point[1]));
  const maxY=Math.max(...source.map(point=>point[1]));
  const edge=Math.max(P.bd*0.75,P.sw*2,0.6);
  const usable=Math.max(P.sw*4,P.size-2*edge);
  const scale=usable/Math.max(maxX-minX,maxY-minY,1e-9);
  const mx=(minX+maxX)/2,my=(minY+maxY)/2;
  const paths=study.paths.map(path=>topoPath(path.id,path.family,
    path.points.map(point=>[(point[0]-mx)*scale,(point[1]-my)*scale]),
    path.closed,path.meta));
  const arcs=paths.map(topoArcData),events=paths.map(()=>[]);
  for(const crossing of study.crossings){
    events[crossing.a].push({s:topoArcS(arcs[crossing.a],crossing.pa),
      hi:crossing.over==="a",crossing,branch:"a"});
    events[crossing.b].push({s:topoArcS(arcs[crossing.b],crossing.pb),
      hi:crossing.over==="b",crossing,branch:"b"});
  }
  const runs=[],transitionSites=[];
  arcs.forEach((arc,pathIndex)=>{
    const built=topoPathRuns(pathIndex,arc,events[pathIndex],arcs);
    runs.push(...built.runs);
    built.transitions.forEach(s=>transitionSites.push({pathIndex,s}));
  });
  const posts=[],postByPoint=new Map(),postBySite=new Map();
  const siteKey=(pathIndex,s)=>{
    const arc=arcs[pathIndex],q=arc.closed?mod(s,arc.total):s;
    return `${pathIndex}:${Math.round(q*1e6)}`;
  };
  for(const site of transitionSites){
    const p=topoArcPoint(arcs[site.pathIndex],site.s);
    const pointKey=`${Math.round(p[0]*1e5)}:${Math.round(p[1]*1e5)}`;
    if(postByPoint.has(pointKey))
      throw new Error(`${study.id}: coincident transition risers at (${p.map(v=>v.toFixed(3)).join(", ")})`);
    const post={key:pointKey,p,pathIndex:site.pathIndex,s:site.s};
    postByPoint.set(pointKey,post);postBySite.set(siteKey(site.pathIndex,site.s),post);
    posts.push(post);
  }
  for(const run of runs){
    run.length=run.s1-run.s0;
    if(!run.hi) continue;
    const first=postBySite.get(siteKey(run.pathIndex,run.s0));
    const last=postBySite.get(siteKey(run.pathIndex,run.s1));
    if(!first||!last)
      throw new Error(`${study.id}: high run lacks topology-owned transition support`);
    run.nodes=[{s:run.s0,post:first},{s:run.s1,post:last}];
  }
  const bridgeSpans=runs.filter(run=>run.hi).map(run=>run.length);
  const quality=topoGeometryQuality(paths,study,arcs,events,runs,posts);
  return {study,paths,arcs,events,runs,posts,bridgeSpans,scale,edge,quality,
    transitionSites,pathLength:arcs.reduce((sum,arc)=>sum+arc.total,0)};
}
function topologyToolpath(study){
  if(P.plies!==1)
    throw new Error("experimental topology coupons are single-ply; set plies to 1");
  const model=topologyModel(study),ops=[],segs=[],passStarts=[],postVisuals=[];
  const st={dash:0,bridge:0,travel:0,travelTime:0,drawTime:0,
    travels:0,retracts:0,posts:0,dots:0,buttonVol:0,nd:0,joins:0,ties:0};
  const zl=z1(),zt=zPost(),zh=z3(),safeZ=zh+Math.max(P.zhop,P.sh,0.2);
  const put=p=>place(p,0),feed=P.ts/60;
  let cur=null;
  /* One lifted travel per disconnected move. The G-code writer expands it into
     retract → lift to `hop` → XY → lower → prime, the order the production
     profiles were verified with, and always retracts: every hop here crosses
     over deposited strands. A pure z change stays a plain travel. */
  const travel=(xy,z)=>{
    if(cur&&dist(cur.p,xy)<1e-9){
      if(Math.abs(cur.z-z)<1e-9) return;
      st.travelTime+=moveTime(Math.abs(z-cur.z),feed,P.acc);
      segs.push({a:cur.p,az:cur.z,b:xy,bz:z,k:"t"});
      ops.push({o:"T",x:xy[0],y:xy[1],z});cur={p:xy,z};return;
    }
    if(cur){
      const dxy=dist(cur.p,xy);
      st.travel+=dxy;st.travels++;st.retracts++;
      st.travelTime+=moveTime(safeZ-cur.z,feed,P.acc)+moveTime(dxy,feed,P.acc)+
        moveTime(safeZ-z,feed,P.acc);
      segs.push({a:cur.p,az:cur.z,b:cur.p,bz:safeZ,k:"t"},
        {a:cur.p,az:safeZ,b:xy,bz:safeZ,k:"t"},{a:xy,az:safeZ,b:xy,bz:z,k:"t"});
    }
    ops.push({o:"T",x:xy[0],y:xy[1],z,hop:safeZ});cur={p:xy,z};
  };
  const draw=(xy,z,f,k,fam,timed=true)=>{
    if(cur){
      segs.push({a:cur.p,az:cur.z,b:xy,bz:z,k,fam});
      if(timed)
        st.drawTime+=moveTime(Math.hypot(xy[0]-cur.p[0],xy[1]-cur.p[1],z-cur.z),f/60,P.acc);
    }
    ops.push({o:"D",x:xy[0],y:xy[1],z,f,k});cur={p:xy,z};
  };
  const stationary=(v,k)=>{
    if(!cur) throw new Error("stationary extrusion needs a current point");
    ops.push({o:"S",v,k,x:cur.p[0],y:cur.p[1],z:cur.z});
    st.buttonVol+=v;
  };
  const dot=(extraRoad=0)=>{stationary(endpointDotVol(extraRoad),"dot");st.dots++;};
  const grow=(p,zf,zt)=>{
    const n=Math.max(1,Math.round(P.pstep)),vol=riserVol(p,p,zf,zt);
    for(let i=0;i<n;i++){
      const z=zf+(zt-zf)*(i+1)/n;
      stationary(vol/n,"riser");draw(p,z,P.ps,"p");
    }
    st.posts++;
  };
  /* A curved run is one continuous move for the time model; the chords it is
     emitted as are not stop-and-go segments on the printer. */
  const drawSlice=(arc,s0,s1,z,k,fam)=>{
    const points=topoArcSlice(arc,s0,s1).map(put),f=k==="hi"?P.bs:P.ps;
    let length=0;
    for(let i=1;i<points.length;i++){
      length+=dist(points[i-1],points[i]);
      draw(points[i],z,f,k,fam,false);
    }
    st.drawTime+=moveTime(length,f/60,P.acc);
    return points;
  };
  passStarts.push({op:ops.length,pass:1,ply:0});
  for(const run of model.runs){
    if(run.hi) continue;
    const arc=model.arcs[run.pathIndex],path=model.paths[run.pathIndex];
    travel(put(topoArcPoint(arc,run.s0)),zl);
    const seam=run.closed&&dist(topoArcPoint(arc,run.s0),topoArcPoint(arc,run.s1))<1e-7;
    if(!seam) dot();
    drawSlice(arc,run.s0,run.s1,zl,"lo",path.family);
    dot(seam?P.bd/2:0);
    st.dash+=run.length;st.nd++;
  }
  for(const post of model.posts){
    const p=put(post.p);
    travel(p,zl);grow(p,zl,zt);
    postVisuals.push({p,dz:0,seq:segs.length,ply:0});
  }
  passStarts.push({op:ops.length,pass:2,ply:0});
  for(const run of model.runs){
    if(!run.hi) continue;
    const arc=model.arcs[run.pathIndex],path=model.paths[run.pathIndex],nodes=run.nodes;
    travel(put(topoArcPoint(arc,nodes[0].s)),zh);dot();
    for(let i=1;i<nodes.length;i++){
      drawSlice(arc,nodes[i-1].s,nodes[i].s,zh,"hi",path.family);
      const closes=run.closed&&i===nodes.length-1&&
        dist(topoArcPoint(arc,nodes[0].s),topoArcPoint(arc,nodes[i].s))<1e-7;
      dot(i<nodes.length-1||closes?P.bd/2:0);
      st.bridge+=nodes[i].s-nodes[i-1].s;
    }
    st.nd++;
  }
  return {ops,segs,st,ds:[],seq:{},passStarts,postVisuals,experimental:true,
    topology:model,study};
}
function topologyMetrics(tp){
  const model=tp.topology,st=tp.st,area=Math.pow(P.size/10,2);
  let gap=Infinity;
  for(let i=0;i<model.posts.length;i++) for(let j=i+1;j<model.posts.length;j++)
    gap=Math.min(gap,dist(model.posts[i].p,model.posts[j].p));
  if(!isFinite(gap)) gap=P.size;
  const need=P.bd/2+nozHalf(),clear=gap-need;
  const freeDia=Math.sqrt(4*P.sw*P.sh/Math.PI),vgap=P.bh-freeDia;
  const longest=Math.max(0,...model.bridgeSpans.map(span=>Math.max(0,span-P.bd)));
  const bounds=printBounds(),flow=Math.max(0,P.flow),facts=topoDiagramFacts(model.study);
  const lineFlow=Math.max(P.ps,P.bs)/60*P.sw*P.sh*flow;
  const stationaryFlow=P.pspd/60*FIL_AREA*flow;
  const tButton=(st.buttonVol/FIL_AREA)/(P.pspd/60);
  const ret=Math.max(0,P.retract);
  const tRet=ret&&st.retracts
    ?st.retracts*ret*(60/P.retSpeed+60/P.primeSpeed):0;
  const tTrav=st.travelTime+tRet,t=st.drawTime+tTrav+tButton;
  const pairInteractions=Object.values(facts.pairs).reduce((sum,count)=>sum+count,0);
  return {experimental:true,topology:model.study.id,topologyTitle:model.study.title,
    topologyKind:model.study.contract.kind,topologyIdentity:model.study.contract.identity,
    components:model.study.components,openComponents:facts.open,closedComponents:facts.closed,
    pairInteractions,crossings:model.study.crossings.length,
    dashes:st.nd,buttons:st.dots,posts:st.posts,stops:st.posts/area,
    longest,clear,minPitch:0,vgap,stretch:0,
    roadClear:model.quality.roadClear,buttonClear:model.quality.buttonClear,
    bendRadius:model.quality.minBendRadius,
    crossingGap:model.quality.minCrossingGap,reserve:model.quality.reserve,
    cover:Math.min(1,model.pathLength*P.sw/(P.size*P.size)),tpi:0,
    ext:st.dash+st.bridge,bvol:st.buttonVol,gap,t,
    bedMargin:bounds.bedMargin,maxSize:bounds.maxSize,lineFlow,stationaryFlow,
    fButton:t?tButton/t:0,fTrav:t?tTrav/t:0,
    pathLength:model.pathLength,recommendedSize:model.study.recommendedSize,
    referenceButton:TOPOLOGY_REFERENCE.bd,referenceWidth:TOPOLOGY_REFERENCE.sw,
    referenceHeight:topologyDefaultParams(model.study).bh};
}
function topologyWarnings(m){
  const warn=[`EXPERIMENTAL -- ${m.topologyTitle} has passed diagram and toolpath checks but has no physical print validation.`];
  if(P.size+1e-9<m.recommendedSize)
    warn.push(`COUPON SCALE -- ${P.size.toFixed(1)} mm is below the ${m.recommendedSize.toFixed(1)} mm computationally checked default.`);
  if(Math.abs(P.bd-m.referenceButton)>1e-6||Math.abs(P.sw-m.referenceWidth)>1e-6||
      Math.abs(P.bh-m.referenceHeight)>1e-6)
    warn.push(`REFERENCE GEOMETRY -- the checked default uses a ${m.referenceButton.toFixed(2)} mm button, ${m.referenceWidth.toFixed(2)} mm strand, and ${m.referenceHeight.toFixed(2)} mm button height for this layer height.`);
  if(m.clear<0)
    warn.push("POST CLEARANCE -- neighbouring transition risers can contact the nozzle body. Increase coupon size or reduce button dimensions.");
  else if(m.clear<0.10)
    warn.push(`POST CLEARANCE -- only ${m.clear.toFixed(2)} mm between the nozzle envelope and a neighbouring transition riser.`);
  if(m.roadClear<0)
    warn.push("ROAD SEPARATION -- non-crossing strand segments overlap in plan and can fuse. Increase coupon size or reduce strand width.");
  else if(m.roadClear<0.10)
    warn.push(`ROAD SEPARATION -- only ${m.roadClear.toFixed(2)} mm remains between unrelated strand edges.`);
  if(m.buttonClear<0)
    warn.push("BUTTON ROAD MARGIN -- a transition riser or endpoint button touches a neighbouring strand or button. Increase coupon size or reduce button dimensions.");
  else if(m.buttonClear<0.10)
    warn.push(`BUTTON ROAD MARGIN -- only ${m.buttonClear.toFixed(2)} mm between a riser or endpoint button and a neighbouring strand.`);
  if(m.crossingGap<P.bd+P.sw)
    warn.push("CROSSING INTERVAL -- neighbouring crossings leave too little arclength for separate transition buttons.");
  if(m.bendRadius<P.sw)
    warn.push("BEND RADIUS -- local centre-line curvature is tighter than one strand width and can overfill.");
  if(m.vgap<0.08) warn.push("VERTICAL GAP -- bridges may weld to the strand below. Raise button height.");
  if(m.longest>4.5) warn.push("BRIDGE SPAN -- expect droop. Reduce the coupon size; no topology-changing helper supports are inserted.");
  if(m.bedMargin<0)
    warn.push(`PRINT AREA -- exceeds the selected bed safety margin. Maximum at this rotation is ${m.maxSize.toFixed(2)} mm.`);
  const maxFlow=Math.max(m.lineFlow,m.stationaryFlow);
  if(P.maxVflow>0&&maxFlow>P.maxVflow)
    warn.push(`VOLUMETRIC FLOW -- ${maxFlow.toFixed(2)} mm3/s exceeds the configured ${P.maxVflow.toFixed(2)} mm3/s limit.`);
  return warn;
}
function topologyReport(m){
  const study=topologyStudy(m.topology),warn=topologyWarnings(m);
  const num=(v,dp,w=10)=>v.toFixed(dp).padStart(w);
  const L=["",
    `  EXPERIMENTAL / ${m.topologyTitle}   ${P.size} mm coupon   rot ${P.rot} deg`,
    "  "+"-".repeat(70),
    `  structural class      ${study.contract.kind}`,
    `  physical components  ${String(m.components).padStart(10)}  (${m.openComponents} open / ${m.closedComponents} closed)`,
    `  interacting pairs     ${String(m.pairInteractions).padStart(10)}`,
    `  crossings             ${String(m.crossings).padStart(10)}`,
    `  curved runs           ${String(m.dashes).padStart(10)}`,
    `  endpoint buttons      ${String(m.buttons).padStart(10)}`,
    `  transition risers     ${String(m.posts).padStart(10)}`,
    `  stops / cm2           ${num(m.stops,1)}`,
    `  curve length          ${num(m.pathLength,1)} mm`,
    `  areal coverage        ${num(m.cover*100,1,9)}%`,
    `  open-path reserve     ${num(m.reserve*100,1,9)}%`,
    "",
    `  longest bridge        ${num(m.longest,2)} mm`,
    `  post clearance        ${num(m.clear,2)} mm`,
    `  unrelated road gap    ${num(m.roadClear,2)} mm`,
    `  button / road margin  ${num(m.buttonClear,2)} mm`,
    `  minimum bend radius   ${num(m.bendRadius,2)} mm`,
    `  crossing interval     ${num(m.crossingGap,2)} mm`,
    `  vertical gap          ${num(m.vgap,2)} mm`,
    `  recommended coupon    ${num(m.recommendedSize,1)} mm`,
    `  reference geometry    ${m.referenceButton.toFixed(2)} mm button / ${m.referenceWidth.toFixed(2)} mm strand / ${m.referenceHeight.toFixed(2)} mm height`,
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
    "",
    `  invariant: ${study.contract.identity}`,
    `  hypothesis: ${study.contract.mechanism}`,
    `  print strategy: ${study.contract.strategy}`,
    `  unresolved: ${study.contract.risk}`,
    `  source: ${study.contract.source.label} — ${study.contract.source.url}`,
    "",...warn.map(w=>"  ! "+w),""];
  return L.join("\n");
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
    ["rectangle 40 x 24",{pattern:"plain",size:40,sizeY:24,rot:0}],
    ["rectangle 40 x 24 at 90",{pattern:"plain",size:40,sizeY:24,rot:90,printer:"coreone",bed:[125,110]}],
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
    // rectangular fields: every dash stays inside the field plus one pitch, the
    // probe window follows the rotated rectangle, and the bed fit is per axis
    if(cfg.sizeY){
      const [W,H]=fieldSize(),bounds=printBounds(),swap=Math.round(P.rot/90)%2!==0;
      const wantX=(swap?H:W)/2+bounds.margin,wantY=(swap?W:H)/2+bounds.margin;
      if(Math.abs(bounds.probeHalfX-wantX)>1e-9||Math.abs(bounds.probeHalfY-wantY)>1e-9)
        errs.push(`probe window ${bounds.probeHalfX.toFixed(2)} x ${bounds.probeHalfY.toFixed(2)}, expected ${wantX} x ${wantY}`);
      if(Math.abs(bounds.bedMargin-Math.min(P.bed[0]-wantX,P.bed[1]-wantY))>1e-9)
        errs.push("rectangular bed margin is not the per-axis minimum");
      if(tp.ds.some(D=>dashPts(D).some(p=>Math.abs(p[0])>W/2+P.pitch||Math.abs(p[1])>H/2+P.pitch)))
        errs.push("dash leaves the rectangular field");
      if(printerDef().probe&&!gcode(tp).includes(`M555 X${(P.bed[0]-wantX).toFixed(1)} Y${(P.bed[1]-wantY).toFixed(1)} W${(2*wantX).toFixed(1)} H${(2*wantY).toFixed(1)}`))
        errs.push("rectangular probe window missing from G-code");
    }
    if(errs.length){bad++;log(`  FAIL  ${name}`);errs.slice(0,4).forEach(e=>log(`        ${e}`));}
    else log(`  ok    ${name}  (${tp.ops.length} ops, ${m.buttons} endpoint buttons, ${m.posts} middle risers)`);
  }
  const atlas=topologyStudies();
  const atlasIds=["sinusoidal","annular","celtic","braid","chainmail","leno","borromean"];
  if(atlas.map(study=>study.id).join(",")!==atlasIds.join(",")){
    bad++;log("  FAIL  experimental topology registry");
    log(`        study ids ${atlas.map(study=>study.id).join(",")}`);
  }
  /* Toolpath and metric invariants every experimental stream must satisfy,
     shared by the generic-profile loop and the printer-profile loop. */
  const topoStreamErrors=(study,tp,m)=>{
    const errs=[],model=tp.topology;
    const eventRuns=model.runs.flatMap(run=>run.crossings.map(event=>({run,event})));
    if(eventRuns.length!==study.crossings.length*2)
      errs.push(`crossing branches ${eventRuns.length}, expected ${study.crossings.length*2}`);
    if(eventRuns.some(({run,event})=>run.hi!==event.hi))
      errs.push("crossing branch assigned to wrong z run");
    if(model.runs.some(run=>run.hi&&(!run.nodes||run.nodes.length!==2||
        run.nodes[0].post===run.nodes[1].post)))
      errs.push("high run is not bracketed by two distinct transition risers");
    if(model.posts.length!==model.transitionSites.length)
      errs.push("transition site / riser count mismatch");
    if(tp.st.posts!==model.posts.length)
      errs.push(`riser count ${tp.st.posts}, expected ${model.posts.length}`);
    if(tp.passStarts.length!==2||tp.passStarts[0].pass!==1||tp.passStarts[1].pass!==2)
      errs.push("invalid experimental pass markers");
    if(!tp.ops.length||tp.ops[0].o!=="T") errs.push("op stream does not open with a travel");
    if(tp.ops.some(op=>!["T","D","S"].includes(op.o)||
        ("v" in op?!(op.v>0):![op.x,op.y,op.z].every(Number.isFinite))))
      errs.push("invalid experimental op");
    const safeZ=z3()+Math.max(P.zhop,P.sh,0.2);
    let prev=null,lifted=0;
    for(const op of tp.ops){
      if(op.o==="T"){
        if(prev&&dist([op.x,op.y],[prev.x,prev.y])>1e-9&&!(op.hop>=safeZ-1e-9)){
          errs.push("horizontal travel below safe z");break;
        }
        if(prev&&op.hop!=null) lifted++;
      }
      if(op.o!=="S") prev=op;
    }
    if(tp.st.travels!==lifted||tp.st.retracts!==lifted)
      errs.push(`travel accounting ${tp.st.travels}/${tp.st.retracts}, expected ${lifted} lifted hops`);
    const expectedDots=model.runs.reduce((n,run)=>{
      if(run.hi) return n+2;
      const arc=model.arcs[run.pathIndex];
      return n+(run.closed&&dist(topoArcPoint(arc,run.s0),topoArcPoint(arc,run.s1))<1e-7?1:2);
    },0);
    const dots=tp.ops.filter(op=>op.o==="S"&&op.k==="dot").length;
    if(dots!==expectedDots||tp.st.dots!==dots)
      errs.push(`endpoint dot count ${dots}, expected ${expectedDots}`);
    const pulses=tp.ops.filter(op=>op.o==="S"&&op.k==="riser").length;
    if(pulses!==model.posts.length*Math.max(1,Math.round(P.pstep)))
      errs.push(`riser pulse count ${pulses}`);
    const stationaryVolume=tp.ops.filter(op=>op.o==="S").reduce((v,op)=>v+op.v,0);
    if(Math.abs(stationaryVolume-tp.st.buttonVol)>1e-9)
      errs.push("stationary button volume accounting mismatch");
    if(!m.experimental||Object.entries(m).some(([,value])=>
        typeof value==="number"&&!Number.isFinite(value)))
      errs.push("invalid experimental metrics");
    if(m.clear<0.10) errs.push(`unsafe recommended post clearance ${m.clear.toFixed(2)} mm`);
    if(m.roadClear<0.10) errs.push(`unsafe recommended road gap ${m.roadClear.toFixed(2)} mm`);
    if(m.buttonClear<0.10) errs.push(`unsafe recommended button margin ${m.buttonClear.toFixed(2)} mm`);
    if(m.bendRadius<P.sw) errs.push(`unsafe recommended bend radius ${m.bendRadius.toFixed(2)} mm`);
    if(m.crossingGap<P.bd+P.sw)
      errs.push(`unsafe recommended crossing interval ${m.crossingGap.toFixed(2)} mm`);
    if(m.longest>4.5) errs.push(`unsafe recommended bridge ${m.longest.toFixed(2)} mm`);
    if(m.vgap<TOPOLOGY_REFERENCE.vgap-1e-9)
      errs.push(`vertical gap ${m.vgap.toFixed(3)} mm below the ${TOPOLOGY_REFERENCE.vgap} mm reference`);
    if(m.bedMargin<0) errs.push("recommended coupon exceeds the bed margin");
    return errs;
  };
  /* Printer-profile G-code contract for lifted travels: retract → lift → XY →
     lower → prime, one retract per lifted hop regardless of hop length. */
  const hopGcodeErrors=(tp,g)=>{
    const lines=g.split("\n"),errs=[];
    const retractLine=`G1 F${P.retSpeed} E-${P.retract}`,primeLine=`G1 F${P.primeSpeed} E${P.retract}`;
    const retracts=lines.filter(l=>l===retractLine).length;
    const primes=lines.filter(l=>l===primeLine).length;
    if(retracts!==tp.st.retracts||primes!==retracts)
      errs.push(`hop retraction ${retracts} retract / ${primes} prime / ${tp.st.retracts} lifted hops`);
    const first=lines.indexOf(retractLine);
    if(first<0||!lines[first+1].startsWith(`G0 F${P.ts} Z`)||!lines[first+2].startsWith("G0 X")||
        !lines[first+3].startsWith("G0 Z")||lines[first+4]!==primeLine)
      errs.push("retract / lift / XY / lower / prime order");
    return errs;
  };
  for(const study of atlas){
    Object.assign(P,base);
    Object.assign(P,topologyDefaultParams(study));
    const errs=[];
    if(study.printable!==true||study.experimental!==true)
      errs.push("missing printable experimental declaration");
    if(study.paths.length!==study.components)
      errs.push(`physical path count ${study.paths.length}, expected ${study.components}`);
    const required=["kind","identity","mechanism","strategy","risk"];
    if(!study.contract||required.some(key=>typeof study.contract[key]!=="string"||!study.contract[key]))
      errs.push("incomplete design contract");
    else {
      errs.push(...topoContractErrors(study));
      if(!study.contract.source||!study.contract.source.label||
          !/^https:\/\//.test(study.contract.source.url||""))
        errs.push("missing authoritative source");
    }
    if(!(study.recommendedSize>0)) errs.push("invalid recommended coupon size");
    if(!study.paths.length) errs.push("no strands");
    if(study.crossings.length!==study.expectedCrossings)
      errs.push(`crossings ${study.crossings.length}, expected ${study.expectedCrossings}`);
    if(study.paths.some(path=>path.points.length<2||
        path.points.some(point=>!point.slice(0,2).every(Number.isFinite))))
      errs.push("non-finite strand");
    if(study.crossings.some(crossing=>
        !["a","b"].includes(crossing.over)||!crossing.p.every(Number.isFinite)))
      errs.push("invalid crossing");
    let tp=null,m=null;
    if(!errs.length){
      try{
        tp=toolpath();m=metrics(tp);
        const g=gcode(tp);
        errs.push(...topoStreamErrors(study,tp,m));
        if(!g.includes(`; EXPERIMENTAL — ${study.title}`)||
            !g.includes(`; class: ${study.contract.kind}`)||
            !g.includes("; transition-owned risers only; no sacrificial or foundation supports")||
            !report(m).includes(`EXPERIMENTAL / ${study.title}`))
          errs.push("experimental design contract missing from output");
      } catch(error){ errs.push(`build threw: ${error.message}`); }
      if(study===atlas[0]){
        P.plies=2;
        try{topologyToolpath(study);errs.push("multi-ply experimental coupon was accepted");}
        catch(error){
          if(!String(error.message).includes("single-ply"))
            errs.push(`wrong multi-ply error: ${error.message}`);
        }
        P.plies=1;
      }
    }
    if(errs.length){
      bad++;log(`  FAIL  experimental ${study.id}`);
      errs.slice(0,4).forEach(error=>log(`        ${error}`));
    } else log(`  ok    experimental ${study.id}  (${tp.ops.length} ops, ${m.crossings} crossings, ${m.posts} risers)`);
  }
  for(const [profileName,printerName] of [["Core One","coreone"],["MK4S","mk4spp"]]){
    const def=PRINTERS[printerName],errs=[];
    for(const study of atlas){
      Object.assign(P,base,def.defaults,{printer:printerName,bed:def.bed.slice()});
      Object.assign(P,topologyDefaultParams(study));
      try{
        const tp=toolpath(),m=metrics(tp);
        const g=gcode(tp,printerDef().start(),printerDef().end());
        errs.push(...[...topoStreamErrors(study,tp,m),...hopGcodeErrors(tp,g)]
          .map(error=>`${study.id}: ${error}`));
      } catch(error){ errs.push(`${study.id}: build threw: ${error.message}`); }
    }
    if(errs.length){
      bad++;log(`  FAIL  experimental atlas on ${profileName} profile`);
      errs.slice(0,4).forEach(error=>log(`        ${error}`));
    } else log(`  ok    experimental atlas on ${profileName} profile`);
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
  const total=cases.length+atlas.length+4;
  log(`\n  ${total-bad}/${total} configurations pass`);
  return bad===0;
}

/* ==========================================================================
 * CLI — only reached outside the browser
 * ========================================================================== */
if(typeof window==="undefined"&&typeof process!=="undefined"&&process.argv){
  const fs=require("fs");
  const NUM={pitch:"pitch",size:"size","size-y":"sizeY",rotate:"rot","button-d":"bd","button-h":"bh",
    "strand-w":"sw","strand-h":"sh","offset-frac":"offFrac",overshoot:"ovs",
    plies:"plies","tack-every":"tack","ply-gap":"pgap","print-speed":"ps",
    "bridge-speed":"bs","travel-speed":"ts","z-hop":"zhop",retract:"retract",
    "retract-min":"retMin","retract-speed":"retSpeed","prime-speed":"primeSpeed",
    "post-speed":"pspd","post-steps":"pstep","post-flow":"pflow",accel:"acc",
    flow:"flow","max-volumetric-flow":"maxVflow",
    "pass1-fan":"fan1","pass2-fan":"fan",
    "nozzle-temp":"ht","bed-temp":"bt",
    "nozzle-flat":"nflat","nozzle-cone":"ncone"};
  const STR={topology:"topology",lattice:"lattice",pattern:"pattern","triaxial-pattern":"triPattern"};
  const usage=`weaver engine — single-source printed-weave generator

  bun engine.js [options] [--report] [--json] [--gcode FILE] [--ops FILE|-]
  bun engine.js --check

options mirror the app's parameters:
  --lattice biaxial|triaxial   --pattern plain|twill|crepe|satin|custom
  --triaxial-pattern cyclic|twill|directional
  --topology straight|sinusoidal|annular|celtic|braid|chainmail|leno|borromean
  --pitch --size --size-y --rotate --button-d --button-h --strand-w --strand-h
                  (--size-y > 0 makes a rectangular field; straight family only)
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
  /* Parse everything first, then apply in a fixed order: printer profile →
     --config → checked atlas default for an experimental topology (only the
     keys nothing else set) → explicit flags. Flag order never matters. */
  const a=process.argv.slice(2);
  const want={report:false,json:false,check:false,gcode:null,ops:null};
  const explicit={};let printer=null,config=null;
  for(let i=0;i<a.length;i++){
    const flag=a[i].replace(/^--/,"");
    if(a[i]==="--help"||a[i]==="-h"){console.log(usage);process.exit(0);}
    else if(flag==="report") want.report=true;
    else if(flag==="json") want.json=true;
    else if(flag==="check") want.check=true;
    else if(flag==="gcode") want.gcode=a[++i]||die("--gcode needs a path");
    else if(flag==="ops") want.ops=a[++i]||die("--ops needs a path or -");
    else if(flag==="offset-dashes") explicit.offd=true;
    else if(flag==="no-offset-dashes") explicit.offd=false;
    else if(flag==="ground-edges") explicit.edge=true;
    else if(flag==="no-ground-edges") explicit.edge=false;
    else if(flag==="join") explicit.join=true;
    else if(flag==="no-join") explicit.join=false;
    else if(flag==="printer"){
      printer=a[++i];
      if(!PRINTERS[printer]) die(`unknown printer ${printer} (${Object.keys(PRINTERS).join(", ")})`);
    }
    else if(flag==="draft"){explicit.draft=loadDraft(a[++i]||die("--draft needs a path"));explicit.pattern="custom";}
    else if(flag==="config") config=JSON.parse(fs.readFileSync(a[++i]||die("--config needs a path"),"utf8"));
    else if(flag==="fan"){
      const v=parseFloat(a[++i]);
      if(!Number.isFinite(v)) die("--fan needs a number");
      explicit.fan1=v;explicit.fan=v;
    }
    else if(flag in NUM){
      const v=parseFloat(a[++i]);
      if(!Number.isFinite(v)) die(`--${flag} needs a number`);
      explicit[NUM[flag]]=v;
    }
    else if(flag in STR) explicit[STR[flag]]=a[++i]||die(`--${flag} needs a value`);
    else die(`unknown option ${a[i]}\n\n${usage}`);
  }
  if(want.check) process.exit(runCheck(console.log)?0:1);
  const set=new Set(Object.keys(explicit));
  if(printer){P.printer=printer;P.bed=PRINTERS[printer].bed.slice();Object.assign(P,PRINTERS[printer].defaults||{});}
  if(config){
    const def=PRINTERS[config.printer],defaults=def&&def.defaults;
    if(defaults) Object.assign(P,defaults);
    if(def&&!Object.prototype.hasOwnProperty.call(config,"bed")) P.bed=def.bed.slice();
    if("fan" in config&&!("fan1" in config)) config.fan1=config.fan;
    Object.assign(P,config);
    Object.keys(config).forEach(key=>set.add(key));
  }
  const topologyIds=["straight",...topologyStudies().map(study=>study.id)];
  const topology=explicit.topology!=null?explicit.topology:P.topology;
  if(!topologyIds.includes(topology))
    die(`unknown topology '${topology}' (${topologyIds.join(", ")})`);
  if(topology!=="straight"){
    if("sh" in explicit) P.sh=explicit.sh;
    const defaults=topologyDefaultParams(topologyStudy(topology));
    for(const [key,value] of Object.entries(defaults)) if(!set.has(key)) P[key]=value;
  }
  Object.assign(P,explicit);
  const biaxialPatterns=["plain","twill","crepe","satin","custom"];
  const triaxialPatterns=["cyclic","twill","directional"];
  if(!["biaxial","triaxial"].includes(P.lattice)) die(`unknown lattice '${P.lattice}'`);
  if(!biaxialPatterns.includes(P.pattern)) die(`unknown biaxial pattern '${P.pattern}'`);
  if(!triaxialPatterns.includes(P.triPattern)) die(`unknown triaxial pattern '${P.triPattern}'`);
  if(P.pattern==="custom"&&!Array.isArray(P.draft)) die("pattern 'custom' needs --draft");
  if(!(P.size>0)) die(`size must be positive (got ${P.size})`);
  if(!(Number.isInteger(P.plies)&&P.plies>=1)) die(`plies must be a positive integer (got ${P.plies})`);
  if(isExperimental()&&P.plies!==1) die("experimental topology coupons are single-ply; use --plies 1");
  if(!(Number.isInteger(P.pstep)&&P.pstep>=1)) die(`post-steps must be a positive integer (got ${P.pstep})`);
  for(const [key,label] of [["ps","print-speed"],["bs","bridge-speed"],["ts","travel-speed"],
      ["pspd","post-speed"],["retSpeed","retract-speed"],["primeSpeed","prime-speed"],["acc","accel"]])
    if(!(P[key]>0)) die(`${label} must be positive (got ${P[key]})`);
  let tp,m;
  try{tp=toolpath();m=metrics(tp);}
  catch(error){die(String(error.message||error));}
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
  else if(want.gcode||want.ops) for(const w of warnings(m)) console.error(`  ! ${w}`);
}
