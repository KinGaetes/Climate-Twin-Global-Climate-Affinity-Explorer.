const DATA = new URL("../data/", import.meta.url);
const $ = id => document.getElementById(id);
const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
const fmt = (v,d=1) => v == null || Number.isNaN(+v) ? "—" : Number(v).toLocaleString("es-ES",{maximumFractionDigits:d});
const esc = s => String(s ?? "").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));

let cfg, positions, spatialOffsets, spatialIndices, regionCatalog = null;
let worker, workerReady = false, selectedIdx = null, currentScores = null, selectedDetail = null, currentRankingRows = [];
let studyCities = {left:null,right:null};
let topReferenceRows=[];
let hoveredIdx = -1;
const cityMetaCache = new Map();
const countryPickerViews={left:{lon:0,lat:18,zoom:1.55},right:{lon:0,lat:18,zoom:1.55}};
const countryPickerTiles=new Map();
let countryShapes=null;
const countryShapeIndex=new Map();
let resolveWorkerReady; const workerReadyPromise = new Promise(resolve => { resolveWorkerReady = resolve; });
let seq = 0, startupDone = false, rankingSeq = 0;
const pending = new Map();
const warm = {metadata:false,search:false,features:false};

function setStatus(text, persistent=false) {
  const e = $("status");
  e.textContent = text;
  e.classList.remove("hidden");
  clearTimeout(setStatus.t);
  if (!persistent) setStatus.t = setTimeout(()=>e.classList.add("hidden"),1600);
}
async function request(type,payload={},timeout=20000) {
  await workerReadyPromise;
  return new Promise((resolve,reject)=>{
    if (!worker) return reject(new Error("Worker no disponible"));
    const id=++seq;
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Timeout: ${type}`));},timeout);
    pending.set(id,{resolve,reject,timer});
    worker.postMessage({type,id,...payload});
  });
}
function createWorker(){
  worker = new Worker(new URL("./worker.js", import.meta.url));
  worker.onerror = e => setStatus("Error del motor de similitud: "+(e.message||"worker"),true);
  worker.onmessage = e => {
    const m=e.data||{};
    if(m.type==="ready"){
      workerReady=true; resolveWorkerReady();
      $("engine-state").textContent="Motor listo";
      worker.postMessage({type:"warm"});
      loadRegionCatalog();
      setTimeout(()=>worker.postMessage({type:"warmFeatures"}),700);
      return;
    }
    if(m.type==="warmStatus"){
      warm[m.part]=m.state==="ready";
      if(m.part==="features" && m.state==="loading") $("engine-state").textContent="Preparando fingerprint…";
      if(m.part==="features" && m.state==="ready") $("engine-state").textContent="Fingerprint listo";
      return;
    }
    if(m.type==="scores"){
      if(m.idx!==selectedIdx) return;
      currentScores=m.scores;
      mapView.setScores(m.scores);
      updateScoreCounts(m.scores);
      $("compute-ms").textContent=`${Math.round(m.ms)} ms`;
      refreshResults();
      setStatus("Heatmap actualizado");
      return;
    }
    if(m.type==="error"){
      if(m.id && pending.has(m.id)){
        const p=pending.get(m.id); clearTimeout(p.timer); pending.delete(m.id); p.reject(new Error(m.message));
      } else setStatus("Error: "+m.message,true);
      return;
    }
    if(["searchResults","detailResult","rankResults","regionCatalogResult","countryTopResult","countryComparisonResult","cityComparisonResult","hoverResult","labelResults"].includes(m.type)){
      const p=pending.get(m.id); if(!p) return;
      clearTimeout(p.timer); pending.delete(m.id); p.resolve(m.result ?? m.rows ?? m.row); return;
    }
  };
  worker.postMessage({type:"init",base:DATA.href});
}

class RasterMap {
  constructor(el,canvas,positions,offsets,indices,spatialCfg){
    this.el=el; this.canvas=canvas; this.positions=positions; this.offsets=offsets; this.indices=indices; this.spatial=spatialCfg;
    this.center={x:this.mx(-8),y:this.my(18)}; this.zoom=1.35; this.minZoom=1; this.maxZoom=11;
    this.tiles=new Map(); this.tileLayer=$("tiles"); this.selectedMarker=$("selected-marker");this.labelLayer=$("map-labels");
    this.drag=null; this.raf=0; this.heatmap=false; this.scoreBuffer=null;this.labelKey="";this.labelRows=[];this.labelNodes=new Map();this.labelTimer=0;
    this.initGL(); this.bind(); new ResizeObserver(()=>this.resize()).observe(el); this.resize();
  }
  mx(lon){return (lon+180)/360}
  my(lat){lat=clamp(lat,-85.051129,85.051129); const r=lat*Math.PI/180; return (1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2}
  lon(x){return x*360-180}
  lat(y){return Math.atan(Math.sinh(Math.PI*(1-2*y)))*180/Math.PI}
  world(){return 256*Math.pow(2,this.zoom)}
  initGL(){
    const gl=this.canvas.getContext("webgl",{alpha:true,antialias:false,preserveDrawingBuffer:false});
    if(!gl) throw new Error("WebGL no está disponible"); this.gl=gl;
    const vs=`attribute vec2 a_pos;attribute float a_score;attribute float a_visible;uniform vec2 u_center;uniform float u_world;uniform vec2 u_view;uniform float u_size;uniform float u_heat;varying float v_score;varying float v_heat;varying float v_visible;void main(){float dx=a_pos.x-u_center.x;if(dx>.5)dx-=1.;if(dx<-.5)dx+=1.;float dy=a_pos.y-u_center.y;vec2 clip=vec2(dx*u_world/(u_view.x*.5),-dy*u_world/(u_view.y*.5));gl_Position=vec4(clip,0.,1.);gl_PointSize=u_size;v_score=a_score;v_heat=u_heat;v_visible=a_visible;}`;
    const fs=`precision mediump float;varying float v_score;varying float v_heat;varying float v_visible;uniform float u_mid;uniform float u_high;uniform float u_min_score;vec3 gradient(float score){float s=clamp(score,0.,100.);vec3 low=vec3(.08,.25,.95);vec3 mid=vec3(.22,.83,.33);vec3 high=vec3(1.,.18,.28);if(s<=u_mid)return mix(low,mid,s/max(u_mid,.001));if(s<=u_high)return mix(mid,high,(s-u_mid)/max(u_high-u_mid,.001));return high;}void main(){vec2 p=gl_PointCoord-vec2(.5);if(dot(p,p)>.25||v_visible<.5||v_score<u_min_score)discard;vec4 c=v_heat<.5?vec4(.45,.18,.88,.92):vec4(gradient(v_score),.96);gl_FragColor=c;}`;
    const compile=(type,src)=>{const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s};
    const pr=gl.createProgram();gl.attachShader(pr,compile(gl.VERTEX_SHADER,vs));gl.attachShader(pr,compile(gl.FRAGMENT_SHADER,fs));gl.linkProgram(pr);if(!gl.getProgramParameter(pr,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(pr));
    this.program=pr; this.loc={pos:gl.getAttribLocation(pr,"a_pos"),score:gl.getAttribLocation(pr,"a_score"),visible:gl.getAttribLocation(pr,"a_visible"),center:gl.getUniformLocation(pr,"u_center"),world:gl.getUniformLocation(pr,"u_world"),view:gl.getUniformLocation(pr,"u_view"),size:gl.getUniformLocation(pr,"u_size"),heat:gl.getUniformLocation(pr,"u_heat"),mid:gl.getUniformLocation(pr,"u_mid"),high:gl.getUniformLocation(pr,"u_high"),minScore:gl.getUniformLocation(pr,"u_min_score")};
    const merc=new Float32Array(this.positions.length); for(let i=0;i<this.positions.length;i+=2){merc[i]=this.mx(this.positions[i]);merc[i+1]=this.my(this.positions[i+1]);}this.mercator=merc;
    this.posBuffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.posBuffer);gl.bufferData(gl.ARRAY_BUFFER,merc,gl.STATIC_DRAW);
    this.scoreBuffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.scoreBuffer);gl.bufferData(gl.ARRAY_BUFFER,new Uint8Array(this.positions.length/2),gl.DYNAMIC_DRAW);this.visibility=new Uint8Array(this.positions.length/2).fill(1);this.visibilityBuffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.visibilityBuffer);gl.bufferData(gl.ARRAY_BUFFER,this.visibility,gl.DYNAMIC_DRAW);this.heatMid=48;this.heatHigh=60;
  }
  bind(){
    this.el.addEventListener("wheel",e=>{e.preventDefault();const r=this.el.getBoundingClientRect(),sx=e.clientX-r.left,sy=e.clientY-r.top;const before=this.screenToNorm(sx,sy);const nz=clamp(this.zoom-e.deltaY*.0017,this.minZoom,this.maxZoom);if(nz===this.zoom)return;this.zoom=nz;const w=this.world();this.center.x=before.x-(sx-this.w/2)/w;this.center.y=before.y-(sy-this.h/2)/w;this.normalizeCenter();this.schedule();},{passive:false});
    this.el.addEventListener("pointerdown",e=>{if(e.button!==0&&e.button!==1)return;if(e.button===1)e.preventDefault();this.el.setPointerCapture(e.pointerId);this.drag={id:e.pointerId,button:e.button,x:e.clientX,y:e.clientY,cx:this.center.x,cy:this.center.y,moved:false};});
    this.el.addEventListener("pointermove",e=>{if(!this.drag){const r=this.el.getBoundingClientRect(),sx=e.clientX-r.left,sy=e.clientY-r.top;setMapHover(this.pick(sx,sy,Math.max(9,14-this.zoom*.35)),sx,sy);return;}if(e.pointerId!==this.drag.id)return;const dx=e.clientX-this.drag.x,dy=e.clientY-this.drag.y;if(Math.abs(dx)+Math.abs(dy)>4)this.drag.moved=true;const w=this.world();this.center.x=this.drag.cx-dx/w;this.center.y=this.drag.cy-dy/w;this.normalizeCenter();this.schedule();});
    this.el.addEventListener("pointerup",e=>{if(!this.drag||e.pointerId!==this.drag.id)return;const d=this.drag;this.drag=null;if(d.button===0&&!d.moved){const r=this.el.getBoundingClientRect();const idx=this.pick(e.clientX-r.left,e.clientY-r.top,12);if(idx>=0)selectCity(idx,false);}});this.el.addEventListener("auxclick",e=>{if(e.button===1)e.preventDefault();});
    this.el.addEventListener("dblclick",e=>{e.preventDefault();this.zoom=clamp(this.zoom+1,this.minZoom,this.maxZoom);this.schedule();});
    this.el.addEventListener("contextmenu",e=>{e.preventDefault();clearSelection();});this.el.addEventListener("pointerleave",()=>setMapHover(-1));
  }
  normalizeCenter(){this.center.x=((this.center.x%1)+1)%1;this.center.y=clamp(this.center.y,.00001,.99999)}
  resize(){const dpr=Math.min(devicePixelRatio||1,2);this.w=this.el.clientWidth;this.h=this.el.clientHeight;this.canvas.width=Math.max(1,Math.round(this.w*dpr));this.canvas.height=Math.max(1,Math.round(this.h*dpr));this.canvas.style.width=this.w+"px";this.canvas.style.height=this.h+"px";this.dpr=dpr;this.schedule();}
  schedule(){if(this.raf)return;this.raf=requestAnimationFrame(()=>{this.raf=0;this.render();});}
  render(){this.renderTiles();this.renderPoints();this.renderLabels();this.positionMarker();}
  renderTiles(){
    const z=Math.floor(this.zoom), scale=Math.pow(2,this.zoom-z), n=Math.pow(2,z), tile=256*scale, centerX=this.center.x*n*256, centerY=this.center.y*n*256;
    const x0=Math.floor((centerX-this.w/(2*scale))/256)-1,x1=Math.floor((centerX+this.w/(2*scale))/256)+1,y0=Math.max(0,Math.floor((centerY-this.h/(2*scale))/256)-1),y1=Math.min(n-1,Math.floor((centerY+this.h/(2*scale))/256)+1);const keep=new Set();
    for(let ty=y0;ty<=y1;ty++)for(let tx=x0;tx<=x1;tx++){const wx=((tx%n)+n)%n,key=`${z}/${wx}/${ty}/${tx}`;keep.add(key);let img=this.tiles.get(key);if(!img){img=document.createElement("img");img.alt="";img.draggable=false;img.src=`https://tile.openstreetmap.org/${z}/${wx}/${ty}.png`;img.onerror=()=>img.classList.add("tile-failed");this.tileLayer.appendChild(img);this.tiles.set(key,img);}img.style.width=tile+"px";img.style.height=tile+"px";img.style.transform=`translate(${(tx*256-centerX)*scale+this.w/2}px,${(ty*256-centerY)*scale+this.h/2}px)`;}
    for(const [k,img] of this.tiles)if(!keep.has(k)){img.remove();this.tiles.delete(k);}
  }
  renderPoints(){const gl=this.gl;gl.viewport(0,0,this.canvas.width,this.canvas.height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.useProgram(this.program);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.uniform2f(this.loc.center,this.center.x,this.center.y);gl.uniform1f(this.loc.world,this.world());gl.uniform2f(this.loc.view,this.w,this.h);const size=Math.min(10,Math.max(3.2,2.7+this.zoom*.46))*this.dpr;gl.uniform1f(this.loc.heat,this.heatmap?1:0);gl.uniform1f(this.loc.mid,this.heatMid);gl.uniform1f(this.loc.high,this.heatHigh);gl.bindBuffer(gl.ARRAY_BUFFER,this.posBuffer);gl.enableVertexAttribArray(this.loc.pos);gl.vertexAttribPointer(this.loc.pos,2,gl.FLOAT,false,0,0);gl.bindBuffer(gl.ARRAY_BUFFER,this.scoreBuffer);gl.enableVertexAttribArray(this.loc.score);gl.vertexAttribPointer(this.loc.score,1,gl.UNSIGNED_BYTE,false,0,0);gl.bindBuffer(gl.ARRAY_BUFFER,this.visibilityBuffer);gl.enableVertexAttribArray(this.loc.visible);gl.vertexAttribPointer(this.loc.visible,1,gl.UNSIGNED_BYTE,false,0,0);gl.uniform1f(this.loc.minScore,-1);gl.uniform1f(this.loc.size,size);gl.drawArrays(gl.POINTS,0,this.positions.length/2);if(this.heatmap){gl.uniform1f(this.loc.minScore,this.heatHigh);gl.uniform1f(this.loc.size,Math.max(size+3*this.dpr,7*this.dpr));gl.drawArrays(gl.POINTS,0,this.positions.length/2);}}
  labelCandidates(){const deg=this.spatial.bin_deg,nx=this.spatial.nx,ny=this.spatial.ny,top=this.screenToNorm(0,0),bottom=this.screenToNorm(this.w,this.h),latA=this.lat(top.y),latB=this.lat(bottom.y),y0=clamp(Math.floor((Math.min(latA,latB)+90)/deg),0,ny-1),y1=clamp(Math.floor((Math.max(latA,latB)+90)/deg),0,ny-1),centerLon=this.lon(this.center.x),span=Math.max(1,this.w/this.world()*360),cx=Math.floor((centerLon+180)/deg),bins=Math.ceil(span/deg)+1,chosen=[],cells=new Set();for(let y=y0;y<=y1;y++)for(let ox=-bins;ox<=bins;ox++){const x=((cx+ox)%nx+nx)%nx,bin=y*nx+x,start=this.offsets[bin],end=this.offsets[bin+1];for(let k=start;k<end;k++){const idx=this.indices[k];if(!this.visibility[idx])continue;const p=this.projectIdx(idx);if(p.x<8||p.x>this.w-8||p.y<8||p.y>this.h-8)continue;const cell=`${Math.floor(p.x/135)}:${Math.floor(p.y/42)}`;if(cells.has(cell))continue;cells.add(cell);chosen.push(idx);if(chosen.length===48)return chosen;}}return chosen;}
  renderLabels(){if(this.zoom<5.25||this.drag){this.labelLayer.classList.add("hidden");return;}this.labelLayer.classList.remove("hidden");const key=`${Math.round(this.center.x*1200)}:${Math.round(this.center.y*1200)}:${Math.round(this.zoom*4)}`;if(key!==this.labelKey){this.labelKey=key;this.labelRows=[];this.labelNodes.clear();this.labelLayer.replaceChildren();clearTimeout(this.labelTimer);this.labelTimer=setTimeout(()=>loadMapLabels(this.labelKey,this.labelCandidates()),120);}for(const row of this.labelRows){const node=this.labelNodes.get(row.idx);if(!node)continue;const p=this.projectIdx(row.idx);node.style.transform=`translate(${p.x+7}px,${p.y-8}px)`;node.classList.toggle("hidden",p.x<-20||p.x>this.w+20||p.y<-20||p.y>this.h+20);}}
  setLabelRows(key,rows){if(key!==this.labelKey)return;this.labelRows=rows;this.labelNodes.clear();const nodes=[];for(const row of rows){const node=document.createElement("span");node.textContent=row.city_name;this.labelNodes.set(row.idx,node);nodes.push(node);}this.labelLayer.replaceChildren(...nodes);this.schedule();}
  setScores(scores){this.scores=scores;const gl=this.gl;gl.bindBuffer(gl.ARRAY_BUFFER,this.scoreBuffer);gl.bufferSubData(gl.ARRAY_BUFFER,0,scores);this.heatmap=true;this.schedule();}
  setVisibility(mask){this.visibility=mask;const gl=this.gl;gl.bindBuffer(gl.ARRAY_BUFFER,this.visibilityBuffer);gl.bufferSubData(gl.ARRAY_BUFFER,0,mask);this.schedule();}
  setHeatScale(mid,high){this.heatMid=mid;this.heatHigh=high;this.schedule();}
  clearScores(){this.heatmap=false;this.schedule();}
  exportColor(score){const s=clamp(score,0,100),mid=this.heatMid,high=this.heatHigh;const mix=(a,b,t)=>a.map((v,i)=>Math.round(v+(b[i]-v)*t));const low=[20,64,242],middle=[56,212,84],top=[255,46,71];const rgb=s<=mid?mix(low,middle,s/Math.max(mid,.001)):s<=high?mix(middle,top,(s-mid)/Math.max(high-mid,.001)):top;return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;}
  exportPosition(idx,world,width,height){let dx=this.mercator[idx*2]-this.center.x;dx-=Math.round(dx);return{x:width/2+dx*world,y:height/2+(this.mercator[idx*2+1]-this.center.y)*world};}
  drawExportLabel(ctx,occupied,x,y,text,primary=false,limits=null){const font=primary?28:17,pad=primary?9:6,area=limits||{x:0,y:0,w:ctx.canvas.width,h:ctx.canvas.height};ctx.font=`${primary?700:600} ${font}px system-ui, sans-serif`;const w=Math.ceil(ctx.measureText(text).width)+pad*2,h=font+pad*2;const candidates=[[16,-h-12],[16,12],[-w-16,-h-12],[-w-16,12],[26,-h/2],[-w-26,-h/2]];let box=null;for(const [dx,dy] of candidates){const next={x:x+dx,y:y+dy,w,h};const inside=next.x>=area.x+8&&next.y>=area.y+8&&next.x+next.w<=area.x+area.w-8&&next.y+next.h<=area.y+area.h-8;if(inside&&!occupied.some(other=>next.x<other.x+other.w+5&&next.x+next.w+5>other.x&&next.y<other.y+other.h+5&&next.y+next.h+5>other.y)){box=next;break;}}if(!box){const slot=occupied.length;box={x:area.x+area.w-w-10,y:Math.min(area.y+area.h-h-10,area.y+12+slot*(h+5)),w,h};}occupied.push(box);ctx.strokeStyle=primary?"rgba(10,92,108,.82)":"rgba(20,72,83,.58)";ctx.lineWidth=primary?2:1;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(box.x< x?box.x+box.w:box.x,box.y+h/2);ctx.stroke();ctx.fillStyle=primary?"rgba(255,255,255,.94)":"rgba(255,255,255,.86)";ctx.fillRect(box.x,box.y,box.w,box.h);ctx.fillStyle=primary?"#0b5365":"#244f59";ctx.textAlign="left";ctx.textBaseline="middle";ctx.fillText(text,box.x+pad,box.y+h/2);}
  async export2160p(annotation={}){
    if(!this.heatmap)throw new Error("Selecciona una ciudad y calcula el heatmap antes de exportar.");
    const width=3840,height=2160,canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;const ctx=canvas.getContext("2d");
    ctx.fillStyle="#95dfe3";ctx.fillRect(0,0,width,height);
    const exportScale=Math.min(width/this.w,height/this.h),effectiveZoom=Math.min(19,this.zoom+Math.log2(exportScale)),z=Math.floor(effectiveZoom),scale=Math.pow(2,effectiveZoom-z),n=Math.pow(2,z),tile=256*scale,world=256*Math.pow(2,effectiveZoom),centerX=this.center.x*n*256,centerY=this.center.y*n*256;
    const x0=Math.floor((centerX-width/(2*scale))/256)-1,x1=Math.floor((centerX+width/(2*scale))/256)+1,y0=Math.max(0,Math.floor((centerY-height/(2*scale))/256)-1),y1=Math.min(n-1,Math.floor((centerY+height/(2*scale))/256)+1);const tiles=[];
    for(let ty=y0;ty<=y1;ty++)for(let tx=x0;tx<=x1;tx++)tiles.push({tx,ty,wx:((tx%n)+n)%n});
    await Promise.all(tiles.map(async t=>{try{const response=await fetch(`https://tile.openstreetmap.org/${z}/${t.wx}/${t.ty}.png`,{mode:"cors"});if(!response.ok)throw new Error("tile");const bitmap=await createImageBitmap(await response.blob());ctx.drawImage(bitmap,(t.tx*256-centerX)*scale+width/2,(t.ty*256-centerY)*scale+height/2,tile,tile);bitmap.close();}catch(_){}}));
    const point=Math.min(10,Math.max(3.2,2.7+this.zoom*.46))*exportScale,priorityPoint=Math.max(point+3*exportScale,7*exportScale),copies=Math.ceil(width/world)+1;ctx.globalAlpha=.96;
    for(let i=0;i<this.visibility.length;i++){if(!this.visibility[i])continue;const score=this.scores?.[i]||0,size=score>=this.heatHigh?priorityPoint:point;let dx=this.mercator[i*2]-this.center.x;dx-=Math.round(dx);const y=height/2+(this.mercator[i*2+1]-this.center.y)*world;if(y<-size||y>height+size)continue;const x=width/2+dx*world;ctx.fillStyle=this.exportColor(score);for(let copy=-copies;copy<=copies;copy++){const px=x+copy*world;if(px>=-size&&px<=width+size)ctx.fillRect(px-size/2,y-size/2,size,size);}}
    ctx.globalAlpha=1;
    const occupied=[];for(const row of annotation.labels||[]){if(row.idx==null||row.idx===this.selectedIdx)continue;const p=this.exportPosition(row.idx,world,width,height);if(p.x<0||p.x>width||p.y<0||p.y>height)continue;ctx.beginPath();ctx.arc(p.x,p.y,5*exportScale,0,Math.PI*2);ctx.fillStyle="#fff";ctx.fill();ctx.beginPath();ctx.arc(p.x,p.y,3*exportScale,0,Math.PI*2);ctx.fillStyle="#174f61";ctx.fill();this.drawExportLabel(ctx,occupied,p.x,p.y,`${row.city_name} · ${row.similarity_pct}%`);}
    if(this.selectedIdx!=null){const p=this.exportPosition(this.selectedIdx,world,width,height);ctx.beginPath();ctx.arc(p.x,p.y,12*exportScale,0,Math.PI*2);ctx.fillStyle="#fff";ctx.fill();ctx.beginPath();ctx.arc(p.x,p.y,8*exportScale,0,Math.PI*2);ctx.fillStyle="#0dc3c4";ctx.fill();this.drawExportLabel(ctx,occupied,p.x,p.y,annotation.reference?.city_name||"Ciudad seleccionada",true);}
    ctx.font="16px system-ui, sans-serif";ctx.textAlign="right";ctx.fillStyle="rgba(16,59,74,.72)";ctx.fillText("© OpenStreetMap contributors",width-22,height-22);
    return new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error("No se pudo codificar el PNG.")),"image/png"));
  }
  fitBounds(bounds,width,height,pad=.13){const minX=this.mx(bounds.minLon),maxX=this.mx(bounds.maxLon),minY=this.my(bounds.maxLat),maxY=this.my(bounds.minLat),spanX=Math.max(.002,maxX-minX),spanY=Math.max(.002,maxY-minY),world=Math.min(width/(spanX*(1+pad*2)),height/(spanY*(1+pad*2)));return{center:{x:(minX+maxX)/2,y:(minY+maxY)/2},world:clamp(world,256,256*Math.pow(2,16))};}
  async drawExportTiles(ctx,area,view){const zoom=Math.log2(view.world/256),z=Math.max(0,Math.min(19,Math.floor(zoom))),scale=Math.pow(2,zoom-z),n=Math.pow(2,z),tile=256*scale,centerX=view.center.x*n*256,centerY=view.center.y*n*256,x0=Math.floor((centerX-area.w/(2*scale))/256)-1,x1=Math.floor((centerX+area.w/(2*scale))/256)+1,y0=Math.max(0,Math.floor((centerY-area.h/(2*scale))/256)-1),y1=Math.min(n-1,Math.floor((centerY+area.h/(2*scale))/256)+1),tiles=[];for(let ty=y0;ty<=y1;ty++)for(let tx=x0;tx<=x1;tx++)tiles.push({tx,ty,wx:((tx%n)+n)%n});await Promise.all(tiles.map(async t=>{try{const response=await fetch(`https://tile.openstreetmap.org/${z}/${t.wx}/${t.ty}.png`,{mode:"cors"});if(!response.ok)throw new Error("tile");const bitmap=await createImageBitmap(await response.blob());ctx.drawImage(bitmap,area.x+(t.tx*256-centerX)*scale+area.w/2,area.y+(t.ty*256-centerY)*scale+area.h/2,tile,tile);bitmap.close();}catch(_){}}));}
  projectExportInView(idx,view,area){let dx=this.mercator[idx*2]-view.center.x;dx-=Math.round(dx);return{x:area.x+area.w/2+dx*view.world,y:area.y+area.h/2+(this.mercator[idx*2+1]-view.center.y)*view.world};}
  async drawCountryPanel(ctx,area,title,bounds,markers){const view=this.fitBounds(bounds,area.w,area.h),limits={x:area.x,y:area.y,w:area.w,h:area.h};ctx.save();ctx.beginPath();ctx.rect(area.x,area.y,area.w,area.h);ctx.clip();ctx.fillStyle="#95dfe3";ctx.fillRect(area.x,area.y,area.w,area.h);await this.drawExportTiles(ctx,area,view);const occupied=[];markers.forEach((marker,index)=>{const p=this.projectExportInView(marker.idx,view,area);if(p.x<area.x||p.x>area.x+area.w||p.y<area.y||p.y>area.y+area.h)return;ctx.beginPath();ctx.arc(p.x,p.y,7,0,Math.PI*2);ctx.fillStyle="#fff";ctx.fill();ctx.beginPath();ctx.arc(p.x,p.y,4.5,0,Math.PI*2);ctx.fillStyle=marker.color||"#0aafac";ctx.fill();this.drawExportLabel(ctx,occupied,p.x,p.y,marker.label||`${index+1} · ${marker.city_name}`,false,limits);});ctx.restore();ctx.font="700 19px system-ui, sans-serif";ctx.fillStyle="rgba(255,255,255,.93)";ctx.fillRect(area.x+14,area.y+14,Math.min(area.w-28,ctx.measureText(title).width+36),34);ctx.fillStyle="#0b5365";ctx.textAlign="left";ctx.textBaseline="middle";ctx.fillText(title,area.x+25,area.y+31);}
  async exportCountryDashboard(data){const width=1920,height=1080,canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;const ctx=canvas.getContext("2d"),area={x:0,y:0,w:width,h:height};const markers=data.rows.map((row,index)=>({idx:row.idx,city_name:row.city_name,label:`${index+1} · ${row.city_name} · ${row.similarity_pct}%`}));await this.drawCountryPanel(ctx,area,`${data.reference?.city_name||"Referencia"} → ${data.countryName} · Top 10`,data.bounds,markers);ctx.font="14px system-ui, sans-serif";ctx.textAlign="right";ctx.fillStyle="rgba(16,59,74,.72)";ctx.fillText("© OpenStreetMap contributors",width-18,height-16);return new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error("No se pudo codificar el PNG.")),"image/png"));}
  async exportCountryComparison(data){const width=3840,height=2160,canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;const ctx=canvas.getContext("2d"),gap=70,side=(width-gap)/2,areaLeft={x:0,y:100,w:side,h:height-100},areaRight={x:side+gap,y:100,w:side,h:height-100},colors=["#e63946","#f4a261","#e9c46a","#2a9d8f","#277da1","#7b2cbf","#ff5d8f","#6a994e","#bc6c25","#3a86ff"],left=data.pairs.map((pair,index)=>({idx:pair.left.idx,city_name:pair.left.city_name,color:colors[index],label:`${index+1} · ${pair.left.city_name} · ${pair.similarity_pct}%`})),right=data.pairs.map((pair,index)=>({idx:pair.right.idx,city_name:pair.right.city_name,color:colors[index],label:`${index+1} · ${pair.right.city_name} · ${pair.similarity_pct}%`}));ctx.fillStyle="#eefaf7";ctx.fillRect(0,0,width,height);ctx.fillStyle="#0b5365";ctx.font="700 34px system-ui, sans-serif";ctx.textAlign="center";ctx.fillText(`${data.leftCountry} ↔ ${data.rightCountry} · 10 pares climáticos principales`,width/2,52);await this.drawCountryPanel(ctx,areaLeft,data.leftCountry,data.leftBounds,left);await this.drawCountryPanel(ctx,areaRight,data.rightCountry,data.rightBounds,right);ctx.font="16px system-ui, sans-serif";ctx.textAlign="right";ctx.fillStyle="rgba(16,59,74,.72)";ctx.fillText("© OpenStreetMap contributors",width-20,height-18);return new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error("No se pudo codificar el PNG.")),"image/png"));}
  screenToNorm(sx,sy){const w=this.world();return{x:this.center.x+(sx-this.w/2)/w,y:this.center.y+(sy-this.h/2)/w}}
  projectIdx(idx){const x=this.mx(this.positions[idx*2]),y=this.my(this.positions[idx*2+1]);let dx=x-this.center.x;if(dx>.5)dx-=1;if(dx<-.5)dx+=1;return{x:this.w/2+dx*this.world(),y:this.h/2+(y-this.center.y)*this.world()}}
  pick(sx,sy,radius){
    const a=this.screenToNorm(sx-radius,sy-radius),b=this.screenToNorm(sx+radius,sy+radius);const lonA=this.lon(a.x),lonB=this.lon(b.x),latA=this.lat(a.y),latB=this.lat(b.y);const deg=this.spatial.bin_deg,nx=this.spatial.nx,ny=this.spatial.ny;const y0=clamp(Math.floor((Math.min(latA,latB)+90)/deg),0,ny-1),y1=clamp(Math.floor((Math.max(latA,latB)+90)/deg),0,ny-1);const centerLon=this.lon(((this.screenToNorm(sx,sy).x%1)+1)%1);const lonSpan=Math.max(1,Math.abs(lonB-lonA));const cx=Math.floor((centerLon+180)/deg);const bins=Math.ceil(lonSpan/deg)+1;let best=-1,bestD=radius*radius;
    for(let y=y0;y<=y1;y++)for(let ox=-bins;ox<=bins;ox++){const x=((cx+ox)%nx+nx)%nx,bin=y*nx+x,start=this.offsets[bin],end=this.offsets[bin+1];for(let k=start;k<end;k++){const i=this.indices[k];if(!this.visibility[i])continue;const p=this.projectIdx(i),dx=p.x-sx,dy=p.y-sy,d=dx*dx+dy*dy;if(d<=bestD){bestD=d;best=i;}}}return best;
  }
  setSelected(idx){this.selectedIdx=idx;this.selectedMarker.classList.remove("hidden");this.positionMarker();}
  clearSelected(){this.selectedIdx=null;this.selectedMarker.classList.add("hidden");}
  positionMarker(){if(this.selectedIdx==null)return;const p=this.projectIdx(this.selectedIdx);this.selectedMarker.style.transform=`translate(${p.x}px,${p.y}px)`;this.selectedMarker.classList.toggle("offscreen",p.x<-20||p.x>this.w+20||p.y<-20||p.y>this.h+20);}
  flyTo(idx){const tx=this.mx(this.positions[idx*2]),ty=this.my(this.positions[idx*2+1]),tz=Math.max(this.zoom,5);const sx=this.center.x,sy=this.center.y,sz=this.zoom;let dx=tx-sx;if(dx>.5)dx-=1;if(dx<-.5)dx+=1;const t0=performance.now(),dur=520;const step=now=>{const t=clamp((now-t0)/dur,0,1),e=1-Math.pow(1-t,3);this.center.x=sx+dx*e;this.center.y=sy+(ty-sy)*e;this.zoom=sz+(tz-sz)*e;this.normalizeCenter();this.schedule();if(t<1)requestAnimationFrame(step)};requestAnimationFrame(step);}
}
let mapView;

function positionMapTooltip(x,y){const tip=$("map-tooltip"),maxX=Math.max(8,mapView.w-210),maxY=Math.max(8,mapView.h-42);tip.style.transform=`translate(${Math.min(maxX,x+14)}px,${Math.min(maxY,y+14)}px)`;}
function setMapHover(idx,x=0,y=0){
  const tip=$("map-tooltip");
  if(idx<0){hoveredIdx=-1;tip.classList.add("hidden");return;}
  positionMapTooltip(x,y);
  if(idx===hoveredIdx){tip.classList.remove("hidden");return;}
  hoveredIdx=idx;
  const cached=cityMetaCache.get(idx);
  if(cached){tip.textContent=`${cached.city_name} · ${cached.country_name}`;tip.classList.remove("hidden");return;}
  tip.textContent="Cargando ciudad…";tip.classList.remove("hidden");
  request("hover",{idx}).then(row=>{cityMetaCache.set(idx,row);if(hoveredIdx===idx){tip.textContent=`${row.city_name} · ${row.country_name}`;tip.classList.remove("hidden");}}).catch(()=>{if(hoveredIdx===idx)tip.classList.add("hidden");});
}
function loadMapLabels(key,indices){if(!indices.length||!mapView||key!==mapView.labelKey)return;const cached=[],missing=[];for(const idx of indices){const row=cityMetaCache.get(idx);if(row)cached.push(row);else missing.push(idx);}const apply=rows=>{rows.forEach(row=>cityMetaCache.set(row.idx,row));mapView?.setLabelRows(key,[...cached,...rows]);};if(!missing.length){apply([]);return;}request("labels",{indices:missing}).then(apply).catch(()=>{});}

let groups=[],groupLabels={};
const GENERAL_WEIGHTS=[2.0,1.8,1.6,0.9,0.9,1.0,1.0];
const ARCHITECTURE_WEIGHTS=[2.0,1.45,1.75,1.45,1.0,0.65,1.25];
const PRESET_NOTES={general:"Uso general: temperatura, lluvia y humedad dominan; los demás factores conservan influencia.",habitat:"Arquitectura bioclimática: prioriza confort térmico y humedad; mantiene sol, lluvia y viento para orientar envolvente, sombreado, ventilación y drenaje.",balanced:"Cada dominio climático tiene el mismo peso.",thermal:"Enfatiza el confort térmico y la moderación pasiva.",water:"Enfatiza agua, humedad y estacionalidad hídrica.",light:"Enfatiza radiación solar y luz diurna."};
function getParams(){return{mode:$("season-mode").value,season:$("season-filter").value,weights:groups.map(g=>Number($(`w-${g}`).value))}}
function applyPreset(name){const vals=name==="general"?GENERAL_WEIGHTS:name==="habitat"?ARCHITECTURE_WEIGHTS:cfg.presets[name];groups.forEach((g,i)=>{$(`w-${g}`).value=vals[i];$(`o-${g}`).textContent=Number(vals[i]).toFixed(2);});$("preset-note").textContent=PRESET_NOTES[name]||"";}
function heatBands(){return{mid:Number($("heat-mid").value),high:Number($("heat-high").value)}}
function scoreClass(score){const b=heatBands();return score>b.high?"high":score>=b.mid?"mid":"low"}
function updateScoreCounts(scores){const b=heatBands();let high=0,mid=0,low=0;for(const score of scores){if(score>b.high)high++;else if(score>=b.mid)mid++;else low++;}$("count-high").textContent=high.toLocaleString("es-ES");$("count-mid").textContent=mid.toLocaleString("es-ES");$("count-low").textContent=low.toLocaleString("es-ES");}
function updateHeatScale(changed){
  const mid=$("heat-mid"),high=$("heat-high");
  if(changed==="mid"&&Number(mid.value)>=Number(high.value))high.value=Math.min(99,Number(mid.value)+1);
  if(changed==="high"&&Number(high.value)<=Number(mid.value))mid.value=Math.max(1,Number(high.value)-1);
  const b=heatBands();mapView.setHeatScale(b.mid,b.high);
  $("o-heat-mid").textContent=`${b.mid}%`;$("o-heat-high").textContent=`${b.high}%`;
  $("band-high").textContent=`> ${b.high}%`;$("band-mid").textContent=`${b.mid}–${b.high}%`;$("band-low").textContent=`< ${b.mid}%`;
  if(currentScores)updateScoreCounts(currentScores);
  if(selectedIdx!=null&&currentScores)refreshResults();
}
function getFilters(){return{grid:$("f-grid").checked,country:$("f-country").checked,region:$("f-region").checked,continent:$("f-continent").checked}}
function getVisibility(){const mode=$("top-mode").value,max=mode==="count"?10000:100,fallback=mode==="count"?250:mode==="percentile"?1:75;return{onlyTop:$("top-only").checked,scope:$("top-scope").value,target:$("top-area").value,viewMode:mode,value:clamp(Math.round(Number($("top-value").value)||fallback),1,max)}}
function areaLabel(){const scope=$("top-scope").value;if(scope==="global")return"todo el mundo";return $("top-area").selectedOptions[0]?.textContent||"el área elegida"}
function updateVisibilityValue(){const mode=$("top-mode").value,input=$("top-value"),label=$("top-value-label");if(mode==="count"){label.textContent="Número de ciudades";input.min=1;input.max=10000;input.value=clamp(Math.round(Number(input.value)||250),1,10000);}else if(mode==="percentile"){label.textContent="Porcentaje superior";input.min=1;input.max=100;input.value=clamp(Math.round(Number(input.value)||1),1,100);}else{label.textContent="Afinidad mínima (%)";input.min=1;input.max=100;input.value=clamp(Math.round(Number(input.value)||75),1,100);}}
function populateAreaOptions(){const select=$("top-area"),scope=$("top-scope").value,previous=select.value;if(scope==="global"){select.innerHTML='<option value="">Todo el mundo</option>';select.disabled=true;return;}if(!regionCatalog){select.innerHTML='<option value="">Cargando áreas…</option>';select.disabled=true;return;}const rows=scope==="continent"?regionCatalog.continents:scope==="subcontinent"?regionCatalog.subcontinents:regionCatalog.countries;select.innerHTML="";rows.forEach(row=>{const option=document.createElement("option");option.value=row.id;option.textContent=row.label;select.appendChild(option);});select.disabled=false;if(rows.some(row=>row.id===previous))select.value=previous;}
function normalizeCountryText(value){return String(value||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();}
const COUNTRY_SHAPE_ALIASES={"united states":"united states of america","czechia":"czech republic","palestinian territory":"palestine","aland islands":"aland","the netherlands":"netherlands","u s virgin islands":"united states virgin islands","curacao":"curacao","brasil":"brazil"};
function countryShapeKey(label){const key=normalizeCountryText(label).replace(/[^a-z0-9 ]/g," ").replace(/\s+/g," ").trim();return COUNTRY_SHAPE_ALIASES[key]||key;}
function countryShapeFor(row){return countryShapeIndex.get(countryShapeKey(row?.label))||null;}
function showCountryPickerTooltip(event,row){
  let tip=$("country-picker-tooltip");if(!tip){tip=document.createElement("div");tip.id="country-picker-tooltip";tip.className="country-picker-tooltip";document.body.appendChild(tip);}
  tip.textContent=`${row.label} - ${Number(row.city_count).toLocaleString("es-ES")} ciudades`;tip.style.left=`${Math.min(window.innerWidth-230,event.clientX+14)}px`;tip.style.top=`${Math.min(window.innerHeight-36,event.clientY+14)}px`;tip.classList.remove("hidden");
}
function hideCountryPickerTooltip(){$("country-picker-tooltip")?.classList.add("hidden");}
async function loadCountryShapes(){
  try{
    const response=await fetch(new URL("./world-countries-50m.geojson",import.meta.url));if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const geo=await response.json();countryShapes=geo.features||[];
    countryShapes.forEach(feature=>{const p=feature.properties||{};[p.NAME_EN,p.NAME,p.ADMIN,p.NAME_LONG,p.FORMAL_EN].filter(Boolean).forEach(name=>countryShapeIndex.set(countryShapeKey(name),feature));});
    drawCountryPickerMap("left");drawCountryPickerMap("right");
  }catch(e){console.warn("Country silhouettes unavailable",e);}
}
function countryRowById(id){return regionCatalog?.countries.find(row=>row.id===String(id))||null;}
function countryPickerWorld(lon,lat,zoom){
  const scale=256*Math.pow(2,zoom),safeLat=clamp(Number(lat)||0,-85,85)*Math.PI/180;
  return{x:(Number(lon)+180)/360*scale,y:(1-Math.log(Math.tan(Math.PI/4+safeLat/2))/Math.PI)/2*scale};
}
function countryPickerLonLat(x,y,zoom){
  const scale=256*Math.pow(2,zoom),lon=x/scale*360-180,merc=Math.PI*(1-2*y/scale);
  return{lon,lat:Math.atan(Math.sinh(merc))*180/Math.PI};
}
function countryPickerScreenPoint(side,lon,lat){
  const canvas=$(`study-country-${side}-map`),view=countryPickerViews[side],center=countryPickerWorld(view.lon,view.lat,view.zoom),point=countryPickerWorld(lon,lat,view.zoom),world=256*Math.pow(2,view.zoom);
  let dx=point.x-center.x;if(dx>world/2)dx-=world;if(dx<-world/2)dx+=world;
  return{x:canvas.width/2+dx,y:canvas.height/2+point.y-center.y};
}
function countryPickerTile(tileZoom,x,y){
  const tiles=1<<tileZoom,wrapped=((x%tiles)+tiles)%tiles;
  if(y<0||y>=tiles)return null;
  const key=`${tileZoom}/${wrapped}/${y}`,cached=countryPickerTiles.get(key);if(cached)return cached;
  const pending={image:null};countryPickerTiles.set(key,pending);
  fetch(`https://tile.openstreetmap.org/${tileZoom}/${wrapped}/${y}.png`).then(response=>{
    if(!response.ok)throw new Error("tile unavailable");return response.blob();
  }).then(blob=>createImageBitmap(blob)).then(image=>{pending.image=image;drawCountryPickerMap("left");drawCountryPickerMap("right");}).catch(()=>{countryPickerTiles.delete(key);});
  return pending;
}
function countryShapePolygons(geometry){return geometry?.type==="Polygon"?[geometry.coordinates]:geometry?.type==="MultiPolygon"?geometry.coordinates:[];}
function traceCountryShape(ctx,side,feature){
  const view=countryPickerViews[side],canvas=$(`study-country-${side}-map`),center=countryPickerWorld(view.lon,view.lat,view.zoom),world=256*Math.pow(2,view.zoom);
  countryShapePolygons(feature.geometry).forEach(polygon=>polygon.forEach(ring=>{
    let previousX=null;ring.forEach(([lon,lat],index)=>{const raw=countryPickerWorld(lon,lat,view.zoom),y=canvas.height/2+raw.y-center.y;let x=raw.x-center.x;if(previousX==null){while(x>world/2)x-=world;while(x<-world/2)x+=world;}else{while(x-previousX>world/2)x-=world;while(x-previousX<-world/2)x+=world;}previousX=x;x+=canvas.width/2;if(index)ctx.lineTo(x,y);else ctx.moveTo(x,y);});ctx.closePath();
  }));
}
function pointInRing(point,ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const [xi,yi]=ring[i],[xj,yj]=ring[j],cross=(yi>point.lat)!==(yj>point.lat)&&point.lon<(xj-xi)*(point.lat-yi)/(yj-yi)+xi;if(cross)inside=!inside;}return inside;}
function countryShapeContains(feature,point){return countryShapePolygons(feature.geometry).some(polygon=>pointInRing(point,polygon[0]||[]));}
function countryShapeFill(row,side,active,hover){
  if(active)return side==="left"?"rgba(8,126,152,.82)":"rgba(231,122,56,.84)";
  if(hover)return "rgba(255,250,202,.9)";
  let hash=0;for(const char of row.label)hash=(hash*31+char.charCodeAt(0))>>>0;
  return `hsla(${166+hash%92},54%,${54+hash%13}%,.62)`;
}
function drawCountryPickerMap(side,hoverId=""){
  const canvas=$(`study-country-${side}-map`);if(!canvas||!regionCatalog)return;
  const ctx=canvas.getContext("2d"),width=canvas.width,height=canvas.height,selectedId=$(`study-country-${side}`).value,view=countryPickerViews[side],tileZoom=Math.max(0,Math.floor(view.zoom)),tileScale=Math.pow(2,view.zoom-tileZoom),tileSize=256*tileScale,center=countryPickerWorld(view.lon,view.lat,view.zoom),left=center.x-width/2,top=center.y-height/2;
  ctx.clearRect(0,0,width,height);ctx.fillStyle="#b8e5e2";ctx.fillRect(0,0,width,height);
  const tileLeft=left/tileScale,tileTop=top/tileScale,startX=Math.floor(tileLeft/256),endX=Math.floor((tileLeft+width/tileScale)/256),startY=Math.floor(tileTop/256),endY=Math.floor((tileTop+height/tileScale)/256);
  for(let tx=startX;tx<=endX;tx++)for(let ty=startY;ty<=endY;ty++){const tile=countryPickerTile(tileZoom,tx,ty);if(tile?.image)ctx.drawImage(tile.image,(tx*256-tileLeft)*tileScale,(ty*256-tileTop)*tileScale,tileSize,tileSize);}
  ctx.fillStyle="rgba(7,70,82,.13)";ctx.fillRect(0,0,width,height);
  regionCatalog.countries.forEach(row=>{const shape=countryShapeFor(row);if(!shape)return;const active=row.id===selectedId,hover=row.id===hoverId;ctx.beginPath();traceCountryShape(ctx,side,shape);ctx.fillStyle=countryShapeFill(row,side,active,hover);ctx.fill("evenodd");ctx.lineWidth=active?1.8:hover?1.4:.65;ctx.strokeStyle=active||hover?"rgba(255,255,255,.96)":"rgba(12,77,91,.55)";ctx.stroke();});
  regionCatalog.countries.forEach(row=>{if(countryShapeFor(row)||row.lon==null||row.lat==null)return;const point=countryPickerScreenPoint(side,row.lon,row.lat);if(point.x<-10||point.x>width+10||point.y<-10||point.y>height+10)return;const active=row.id===selectedId,hover=row.id===hoverId;ctx.beginPath();ctx.arc(point.x,point.y,active?6:hover?4.8:3,0,Math.PI*2);ctx.fillStyle=active?(side==="left"?"#087e98":"#e77a38"):hover?"#fff":"rgba(8,73,90,.68)";ctx.fill();if(active||hover){ctx.lineWidth=2;ctx.strokeStyle="#fff";ctx.stroke();}});
  ctx.fillStyle="rgba(255,255,255,.87)";ctx.fillRect(8,height-25,150,17);ctx.fillStyle="#285f6b";ctx.font="600 9px system-ui, sans-serif";ctx.fillText("Arrastra - rueda: zoom - doble clic: inicio",14,height-13);
  if(!hoverId){const selected=countryRowById(selectedId),note=$(`study-country-${side}-note`);if(selected&&note)note.textContent=`${Number(selected.city_count).toLocaleString("es-ES")} ciudades incluidas - arrastra o usa la rueda`;}
}
function countryAtMapPoint(side,event){
  const canvas=$(`study-country-${side}-map`),rect=canvas.getBoundingClientRect(),x=(event.clientX-rect.left)*canvas.width/rect.width,y=(event.clientY-rect.top)*canvas.height/rect.height,view=countryPickerViews[side],center=countryPickerWorld(view.lon,view.lat,view.zoom),geo=countryPickerLonLat(center.x+x-canvas.width/2,center.y+y-canvas.height/2,view.zoom);let closest=null,best=Infinity;
  const shapeMatch=regionCatalog?.countries.find(row=>{const shape=countryShapeFor(row);return shape&&countryShapeContains(shape,geo);});if(shapeMatch)return shapeMatch;
  regionCatalog?.countries.forEach(row=>{if(row.lon==null||row.lat==null)return;const point=countryPickerScreenPoint(side,row.lon,row.lat),d=Math.hypot(point.x-x,point.y-y);if(d<best){best=d;closest=row;}});
  return best<=14?closest:null;
}
function setStudyCountry(side,id){
  const row=countryRowById(id),select=$(`study-country-${side}`);if(!row||!select)return;
  select.value=row.id;$(`study-country-${side}-search`).value=row.label;$(`study-country-${side}-note`).textContent=`${row.label} · ${Number(row.city_count).toLocaleString("es-ES")} ciudades incluidas`;drawCountryPickerMap(side);
}
function setupCountryPicker(side){
  {
    const input=$(`study-country-${side}-search`),select=$(`study-country-${side}`),canvas=$(`study-country-${side}-map`),note=$(`study-country-${side}-note`);if(!input||!select||!canvas)return;
    canvas.style.cursor="grab";
    const chooseTypedCountry=()=>{const query=normalizeCountryText(input.value),matches=(regionCatalog?.countries||[]).filter(row=>normalizeCountryText(row.label)===query);if(matches.length===1)setStudyCountry(side,matches[0].id);else if(query)note.textContent="Elige un pais de las sugerencias o un punto de ciudades en el mapa.";};
    input.addEventListener("change",chooseTypedCountry);
    input.addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();chooseTypedCountry();}});
    select.addEventListener("change",()=>setStudyCountry(side,select.value));
    let drag=null,hoverId="";
    canvas.addEventListener("pointerdown",event=>{hideCountryPickerTooltip();drag={x:event.clientX,y:event.clientY,lon:countryPickerViews[side].lon,lat:countryPickerViews[side].lat,moved:false};canvas.setPointerCapture(event.pointerId);canvas.style.cursor="grabbing";});
    canvas.addEventListener("pointermove",event=>{
      if(drag){const rect=canvas.getBoundingClientRect(),dx=(event.clientX-drag.x)*canvas.width/rect.width,dy=(event.clientY-drag.y)*canvas.height/rect.height;if(Math.abs(dx)+Math.abs(dy)>3)drag.moved=true;const start=countryPickerWorld(drag.lon,drag.lat,countryPickerViews[side].zoom),next=countryPickerLonLat(start.x-dx,start.y-dy,countryPickerViews[side].zoom);countryPickerViews[side].lon=next.lon;countryPickerViews[side].lat=clamp(next.lat,-80,80);drawCountryPickerMap(side);return;}
      const row=countryAtMapPoint(side,event),nextHover=row?.id||"";canvas.style.cursor=row?"pointer":"grab";if(row)showCountryPickerTooltip(event,row);else hideCountryPickerTooltip();if(nextHover!==hoverId){hoverId=nextHover;if(row)note.textContent=`${row.label} - ${Number(row.city_count).toLocaleString("es-ES")} ciudades - clic para elegir`;drawCountryPickerMap(side,hoverId);}
    });
    const finish=event=>{if(!drag)return;const wasDrag=drag.moved;drag=null;canvas.style.cursor="grab";if(!wasDrag){const row=countryAtMapPoint(side,event);if(row){setStudyCountry(side,row.id);return;}}drawCountryPickerMap(side);};
    canvas.addEventListener("pointerup",finish);canvas.addEventListener("pointercancel",finish);
    canvas.addEventListener("pointerleave",()=>{hideCountryPickerTooltip();if(!drag){hoverId="";canvas.style.cursor="grab";drawCountryPickerMap(side);}});
    canvas.addEventListener("wheel",event=>{event.preventDefault();countryPickerViews[side].zoom=clamp(countryPickerViews[side].zoom+(event.deltaY<0?.28:-.28),1.2,5.5);drawCountryPickerMap(side);},{passive:false});
    canvas.addEventListener("dblclick",event=>{event.preventDefault();countryPickerViews[side]={lon:0,lat:18,zoom:1.55};drawCountryPickerMap(side);});
  }
}
function populateStudyCountryPicker(side){
  const select=$(`study-country-${side}`),list=$(`study-country-${side}-options`),previous=select.value;select.innerHTML="";list.innerHTML="";regionCatalog.countries.forEach(row=>{const option=document.createElement("option");option.value=row.id;option.textContent=row.label;select.appendChild(option);const suggestion=document.createElement("option");suggestion.value=row.label;list.appendChild(suggestion);});const fallback=side==="right"&&regionCatalog.countries.length>1?regionCatalog.countries[1].id:regionCatalog.countries[0]?.id;setStudyCountry(side,regionCatalog.countries.some(row=>row.id===previous)?previous:fallback);
}
function populateCountryDashboard(){if(!regionCatalog)return;["export-country","compare-country-left","compare-country-right"].forEach(id=>{const select=$(id),previous=select.value;select.innerHTML="";regionCatalog.countries.forEach(row=>{const option=document.createElement("option");option.value=row.id;option.textContent=row.label;select.appendChild(option);});if(regionCatalog.countries.some(row=>row.id===previous))select.value=previous;else if(id==="compare-country-right"&&regionCatalog.countries.length>1)select.selectedIndex=1;});populateStudyCountryPicker("left");populateStudyCountryPicker("right");}
async function loadRegionCatalog(){try{regionCatalog=await request("regionCatalog");populateAreaOptions();populateCountryDashboard();}catch(e){setStatus(`No se pudo cargar el catálogo geográfico: ${e.message}`,true)}}
function setupTopReferenceCompare(){
  $("top-list").addEventListener("click",event=>{
    const item=event.target.closest(".top-item");if(!item)return;
    const rank=[...$("top-list").querySelectorAll(".top-item")].indexOf(item),candidate=topReferenceRows[rank];
    if(!candidate)return;
    event.preventDefault();event.stopPropagation();openReferenceComparison(candidate);
  },true);
}
function setupControls(){
  const sliders=$("sliders");groups.forEach(g=>{const row=document.createElement("label");row.className="slider-row";row.innerHTML=`<span>${groupLabels[g]}</span><input id="w-${g}" type="range" min="0" max="3" step=".05"><output id="o-${g}"></output>`;sliders.appendChild(row);row.querySelector("input").addEventListener("input",e=>$(`o-${g}`).textContent=Number(e.target.value).toFixed(2));});
  $("heat-mid").value=65;$("heat-high").value=75;
  applyPreset("general");updateHeatScale();$("preset").addEventListener("change",e=>applyPreset(e.target.value));$("apply").addEventListener("click",()=>selectedIdx!=null&&recompute());$("export-2160").addEventListener("click",export2160p);$("clear").addEventListener("click",clearSelection);
  $("heat-mid").addEventListener("input",()=>updateHeatScale("mid"));$("heat-high").addEventListener("input",()=>updateHeatScale("high"));$("season-filter").addEventListener("change",()=>selectedIdx!=null&&recompute());updateVisibilityValue();populateAreaOptions();
  ["f-grid","f-country","f-region","f-continent","top-only","top-area","top-value"].forEach(id=>$(id).addEventListener("change",refreshResults));
  $("top-scope").addEventListener("change",()=>{populateAreaOptions();refreshResults();});$("top-mode").addEventListener("change",()=>{updateVisibilityValue();refreshResults();});
  $("export-country-map").addEventListener("click",exportCountryMap);$("export-country-comparison").addEventListener("click",exportCountryComparison);$("open-compare-studio").addEventListener("click",openCompareStudio);$("open-compare-studio-global").addEventListener("click",openCompareStudio);$("close-compare-studio").addEventListener("click",closeCompareStudio);$("compare-studio").addEventListener("pointerdown",e=>{if(e.target===$("compare-studio"))closeCompareStudio();});document.querySelectorAll("[data-study-mode]").forEach(button=>button.addEventListener("click",()=>setStudyMode(button.dataset.studyMode)));setupStudySearch("left");setupStudySearch("right");setupCountryPicker("left");setupCountryPicker("right");$("study-country-pair-limit").addEventListener("change",event=>$("run-country-study").textContent=`Encontrar ${event.target.value} pares distintos`);$("run-city-study").addEventListener("click",runCityStudy);$("run-country-study").addEventListener("click",runCountryStudy);
}
async function recompute(){if(selectedIdx==null)return;await workerReadyPromise;const p=getParams();setStatus(warm.features?"Calculando similitud…":"Cargando fingerprint y calculando…",true);worker.postMessage({type:"compute",idx:selectedIdx,mode:p.mode,season:p.season,weights:p.weights});}
async function export2160p(){
  const button=$("export-2160");if(selectedIdx==null||!currentScores)return setStatus("Selecciona una ciudad y calcula el heatmap antes de exportar.",true);
  button.disabled=true;button.textContent="Preparando PNG 2160p…";setStatus("Renderizando mapa 2160p…",true);
  const reference=selectedDetail||{idx:selectedIdx,city_name:$("city-name").textContent,continent:""},foreign=currentRankingRows.filter(row=>row.continent&&row.continent!==reference.continent),same=currentRankingRows.filter(row=>!foreign.includes(row));
  try{const blob=await mapView.export2160p({reference,labels:[...foreign,...same].slice(0,8)});const url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download=`neo-climate-twin-${Date.now()}-3840x2160.png`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setStatus("PNG 2160p exportado");}catch(e){setStatus(`No se pudo exportar: ${e.message}`,true);}finally{button.disabled=false;button.textContent="Exportar mapa PNG 2160p";}
}
async function downloadBlob(blob,name){const url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function exportCountryMap(){
  if(selectedIdx==null||!currentScores)return setStatus("Selecciona una ciudad y calcula el heatmap antes de exportar.",true);const button=$("export-country-map"),countryId=$("export-country").value;button.disabled=true;setStatus("Preparando mapa de país…",true);
  try{const result=await request("countryTop",{idx:selectedIdx,countryId,limit:10,filters:getFilters()});const blob=await mapView.exportCountryDashboard({countryName:result.countryName,bounds:result.bounds,reference:selectedDetail||{city_name:$("city-name").textContent},rows:result.rows});await downloadBlob(blob,`neo-climate-twin-${result.countryName}-top10.png`);$("country-dashboard-note").textContent=`Exportado: Top 10 de ${result.countryName}.`;setStatus("Mapa de país exportado");}catch(e){setStatus(`No se pudo exportar el país: ${e.message}`,true);}finally{button.disabled=false;}
}
async function exportCountryComparison(){
  const leftCountryId=$("compare-country-left").value,rightCountryId=$("compare-country-right").value,button=$("export-country-comparison");button.disabled=true;setStatus("Buscando pares climáticos entre países…",true);
  try{const params=getParams(),result=await request("compareCountries",{leftCountryId,rightCountryId,mode:params.mode,season:params.season,weights:params.weights},60000);const blob=await mapView.exportCountryComparison(result);await downloadBlob(blob,`neo-climate-twin-${result.leftCountry}-vs-${result.rightCountry}-pares.png`);$("country-dashboard-note").textContent=result.sampled?"Exportado con muestra de ciudades más pobladas por tamaño del cruce.":"Exportado con comparación exhaustiva de los pares de ciudades.";setStatus("Comparación de países exportada");}catch(e){setStatus(`No se pudo comparar países: ${e.message}`,true);}finally{button.disabled=false;}
}
async function selectCity(idx,fly){
  selectedIdx=idx;currentScores=null;selectedDetail=null;currentRankingRows=[];rankingSeq++;mapView.setVisibility(new Uint8Array(cfg.city_count).fill(1));mapView.setSelected(idx);if(fly)mapView.flyTo(idx);$("empty-state").classList.add("hidden");$("selected-view").classList.remove("hidden");$("city-name").textContent="Cargando…";$("city-place").textContent="";$("top-list").innerHTML='<div class="loading-row">Calculando ranking…</div>';setStatus("Calculando similitud…",true);
  request("detail",{idx}).then(r=>{if(idx===selectedIdx)renderDetail(r)}).catch(e=>setStatus(e.message,true));
  recompute();
}
function renderDetail(c){selectedDetail=c;$("city-name").textContent=c.city_name;$("city-place").textContent=[c.admin1_name,c.country_name].filter(Boolean).join(" · ");$("population").textContent=c.population?`${Number(c.population).toLocaleString("es-ES")} hab.`:"Población no disponible";$("m-temp").textContent=`${fmt(c.avg_temp_c)} °C`;$("m-range").textContent=`${fmt(c.min_week_temp_c)}–${fmt(c.max_week_temp_c)} °C`;$("m-rain").textContent=`${fmt(c.annual_precip_mm_est,0)} mm/año`;$("m-hum").textContent=`${fmt(c.avg_humidity_pct,0)} %`;$("m-sun").textContent=`${fmt(c.avg_sunshine_hours)} h/d`;$("m-cloud").textContent=`${fmt(c.avg_cloud_pct,0)} %`;}
function clearSelection(){selectedIdx=null;currentScores=null;selectedDetail=null;currentRankingRows=[];rankingSeq++;mapView.clearScores();mapView.setVisibility(new Uint8Array(cfg.city_count).fill(1));mapView.clearSelected();$("selected-view").classList.add("hidden");$("empty-state").classList.remove("hidden");["count-high","count-mid","count-low","compute-ms"].forEach(id=>$(id).textContent="");setStatus("Selección eliminada");}
async function refreshResults(){
  if(selectedIdx==null||!currentScores)return;
  const idx=selectedIdx, token=++rankingSeq, filters=getFilters(), visibility=getVisibility();
  try{
    const result=await request("rank",{idx,limit:10,filters,visibility});
    if(idx!==selectedIdx||token!==rankingSeq)return;
    mapView.setVisibility(result.visible);currentRankingRows=result.exportRows||result.rows||[];
    const modeText=visibility.viewMode==="count"?`las ${Number(result.shown).toLocaleString("es-ES")} ciudades con mayor afinidad`:visibility.viewMode==="percentile"?`el ${visibility.value}% superior (${Number(result.shown).toLocaleString("es-ES")} ciudades)`:`${Number(result.shown).toLocaleString("es-ES")} ciudades con afinidad ≥ ${visibility.value}%`;
    $("visibility-note").textContent=visibility.onlyTop
      ? `El mapa muestra únicamente ${modeText} dentro de ${areaLabel()}.`
      : `La lista compara ${Number(result.total).toLocaleString("es-ES")} ciudades de ${areaLabel()}; el mapa conserva todas las ciudades elegibles.`;
    const box=$("top-list");box.innerHTML="";topReferenceRows=result.rows;
    result.rows.forEach((r,i)=>{const el=document.createElement("button");el.className="top-item";const cls=scoreClass(r.similarity_pct);const factors=(r.factors||[]).map(f=>`${esc(f.label)} ${f.similarity_pct}%`).join(" · ");el.innerHTML=`<span class="rank">${i+1}</span><span class="top-copy"><b>${esc(r.city_name)}</b><small>${esc([r.admin1_name,r.country_name].filter(Boolean).join(" · "))}</small><small class="factor-line">${esc(r.seasonal_alignment||"")} · ${factors}</small></span><span class="score ${cls}">${r.similarity_pct}%</span>`;el.addEventListener("click",()=>selectCity(r.idx,true));box.appendChild(el);});
  }catch(e){setStatus(e.message,true)}
}

const STUDY_COLORS=["#e63946","#f4a261","#e9c46a","#2a9d8f","#277da1","#7b2cbf","#ff5d8f","#6a994e","#bc6c25","#3a86ff"];
const SEASON_LABELS={summer:"Verano",autumn:"Otoño",winter:"Invierno",spring:"Primavera"};
const ANNUAL_WORDS={temperature:"más cálida",rain:"más lluviosa",humidity:"más húmeda",wind:"más ventosa",cloud:"más nubosa",sun:"con más horas de sol",solar:"con mayor energía solar"};
async function openReferenceComparison(candidate){
  if(selectedIdx==null||!candidate)return;
  try{
    const reference=selectedDetail||await request("detail",{idx:selectedIdx});
    if(selectedIdx!==reference.idx&&reference.idx!=null)return;
    studyCities.left={idx:selectedIdx,...reference};studyCities.right={...candidate};
    $("study-city-left").value=`${reference.city_name} · ${reference.country_name}`;
    $("study-city-right").value=`${candidate.city_name} · ${candidate.country_name}`;
    openCompareStudio();setStudyMode("cities");$("compare-studio").querySelector(".compare-window").scrollTop=0;
    await runCityStudy();
  }catch(e){setStatus(`Could not open the comparison: ${e.message}`,true);}
}
function openCompareStudio(){
  $("compare-studio").classList.remove("hidden");
  if(selectedDetail&&!studyCities.left){studyCities.left={idx:selectedIdx,...selectedDetail};$("study-city-left").value=`${selectedDetail.city_name} · ${selectedDetail.country_name}`;}
}
function closeCompareStudio(){$("compare-studio").classList.add("hidden");}
function setStudyMode(mode){
  document.querySelectorAll("[data-study-mode]").forEach(button=>button.classList.toggle("active",button.dataset.studyMode===mode));
  $("study-cities").classList.toggle("hidden",mode!=="cities");$("study-countries").classList.toggle("hidden",mode!=="countries");
}
function setupStudySearch(side){
  const input=$(`study-city-${side}`),box=$(`study-city-${side}-results`);let timer=0;
  input.addEventListener("input",()=>{studyCities[side]=null;clearTimeout(timer);const q=input.value.trim();if(q.length<2){box.classList.add("hidden");box.innerHTML="";return;}timer=setTimeout(async()=>{try{const rows=await request("search",{q,limit:10});box.innerHTML="";rows.forEach(row=>{const button=document.createElement("button");button.type="button";button.innerHTML=`<b>${esc(row.city_name)}</b><small>${esc([row.admin1_name,row.country_name].filter(Boolean).join(" · "))}</small>`;button.addEventListener("click",()=>{studyCities[side]=row;input.value=`${row.city_name} · ${row.country_name}`;box.classList.add("hidden");});box.appendChild(button);});box.classList.toggle("hidden",rows.length===0);}catch(e){setStatus(e.message,true)}},120);});
}
function studyNumber(value, digits=1){return value==null?"—":Number(value).toLocaleString("es-ES",{maximumFractionDigits:digits});}
function annualSentence(row,data){
  if(row.difference==null)return `${row.label}: sin dato comparable.`;
  const precision=row.id==="rain"?0:1,delta=Math.abs(row.difference),winner=row.difference>0?data.right.city_name:data.left.city_name;
  if(delta<Math.pow(10,-precision)/2)return `${row.label}: valores prácticamente iguales.`;
  return `${winner} es ${ANNUAL_WORDS[row.id]||"más alta"} por ${studyNumber(delta,precision)} ${row.unit}.`;
}
function thermalRange(stats){
  if(!stats||stats.min==null||stats.max==null)return "Rango térmico no disponible";
  return `${studyNumber(stats.min)}–${studyNumber(stats.max)} °C · oscilación ${studyNumber(stats.range)} °C`;
}
function seasonalSentence(row,data){
  const thermal=row.thermal||{},left=thermal.left||{},right=thermal.right||{};
  if(left.mean==null||right.mean==null)return `${SEASON_LABELS[row.id]}: temperatura estacional no disponible.`;
  const delta=right.mean-left.mean,warmer=delta>0?data.right.city_name:data.left.city_name;
  const same=Math.abs(delta)<.25;
  const temperature=same?"las temperaturas estacionales son muy similares":`${warmer} es ${studyNumber(Math.abs(delta))} °C más cálida`;
  const rangeGap=(right.range==null||left.range==null)?"":` · diferencia de oscilación ${studyNumber(Math.abs(right.range-left.range))} °C`;
  return `${SEASON_LABELS[row.id]}: ${temperature}; afinidad ${row.score}%${rangeGap}.`;
}
function seasonQuickReading(row,data){
  const left=row.thermal?.left||{},right=row.thermal?.right||{},delta=right.mean-left.mean,contrast=[...(row.domains||[])].sort((a,b)=>a.similarity_pct-b.similarity_pct)[0];
  const temperature=!Number.isFinite(delta)?"temperatura estacional no disponible":Math.abs(delta)<.35?"temperaturas muy parecidas":`${delta>0?data.right.city_name:data.left.city_name} ${delta>0?"es":"es"} ${studyNumber(Math.abs(delta))} °C más cálida`;
  const domain=contrast?`Contraste principal: ${contrast.label.toLowerCase()} (${contrast.similarity_pct}% de afinidad).`:"Sin segundo contraste comparable.";
  return `${temperature}. ${domain}`;
}
function renderCityStudy(data){
  const panels=[data.left,data.right].map(city=>`<article class="study-city-card"><p class="eyebrow">${esc(city.country_name||"Urbe")}</p><h3>${esc(city.city_name)}</h3><p>${esc(city.admin1_name||"")}</p></article>`).join("");
  const domains=data.domains.map(row=>`<div class="domain-row"><span>${esc(row.label)}</span><b>${row.similarity_pct}%</b><i><em style="width:${row.similarity_pct}%"></em></i></div>`).join("");
  const seasons=data.seasons.map(row=>`<div class="season-row"><span>${SEASON_LABELS[row.id]}</span><i><em style="width:${row.score}%"></em></i><b>${row.score}%</b></div>`).join("");
  const seasonScan=data.seasons.map(row=>`<div class="season-scan-item"><b>${SEASON_LABELS[row.id]}</b><span>${esc(seasonQuickReading(row,data))}</span></div>`).join("");
  const seasonCards=data.seasons.map(row=>{
    const thermal=row.thermal||{},left=thermal.left||{},right=thermal.right||{};
    const difference=left.mean==null||right.mean==null?null:right.mean-left.mean;
    const differenceText=difference==null?"—":`${difference>0?"+":""}${studyNumber(difference)} °C`;
    const weakest=[...(row.domains||[])].sort((a,b)=>a.similarity_pct-b.similarity_pct).slice(0,3).map(domain=>`<span class="season-domain"><b>${esc(domain.label)}</b>${domain.similarity_pct}%</span>`).join("");
    return `<article class="season-card"><header><div><p class="eyebrow">${SEASON_LABELS[row.id]} local de ${esc(data.left.city_name)}</p><h3>${row.score}% de afinidad</h3></div><span class="season-alignment">${esc(row.seasonal_alignment)}</span></header><div class="season-temperature"><div><span>${esc(data.left.city_name)}</span><b>${studyNumber(left.mean)} °C</b><small>${thermalRange(left)}</small></div><div><span>${esc(data.right.city_name)}</span><b>${studyNumber(right.mean)} °C</b><small>${thermalRange(right)}</small></div><strong>${differenceText}<small>B − A</small></strong></div><p class="season-insight">${esc(seasonalSentence(row,data))}</p><div class="season-domains">${weakest}</div></article>`;
  }).join("");
  const annual=data.annual.map(row=>{const digits=row.id==="rain"?0:1,diff=row.difference==null?"—":`${row.difference>0?"+":""}${studyNumber(row.difference,digits)} ${row.unit}`;return `<tr><th>${esc(row.label)}</th><td>${studyNumber(row.left,digits)} ${row.unit}</td><td>${studyNumber(row.right,digits)} ${row.unit}</td><td>${diff}</td></tr>`;}).join("");
  const reading=data.annual.map(row=>`<li>${esc(annualSentence(row,data))}</li>`).join("");
  const seasonalReading=data.seasons.map(row=>`<li>${esc(seasonalSentence(row,data))}</li>`).join("");
  const thermalSummary=`<span>Amplitud térmica anual</span><b>${esc(data.left.city_name)} ${studyNumber(data.thermal?.left?.range)} °C · ${esc(data.right.city_name)} ${studyNumber(data.thermal?.right?.range)} °C</b>`;
  $("city-study-output").innerHTML=`<div class="study-city-head">${panels}<div class="study-score"><b>${data.similarity_pct}%</b><span>afinidad con los parámetros actuales · ${esc(data.seasonal_alignment)}</span></div></div><section class="seasonal-overview"><div><h3>Radiografía estacional</h3><p class="study-caption">Las estaciones se toman de ${esc(data.left.city_name)}. En modo adaptativo, ${esc(data.right.city_name)} se compara con su estación equivalente.</p></div><div class="thermal-summary">${thermalSummary}</div></section><section class="study-reading seasonal-reading"><h3>Lectura por estación</h3><ul>${seasonalReading}</ul></section><section class="season-cards">${seasonCards}</section><div class="study-grid"><section><h3>Afinidad anual por dominio</h3>${domains}</section><section><h3>Resumen de afinidad por estación</h3>${seasons}</section></div><details class="annual-context"><summary>Contexto anual y promedios</summary><section class="annual-table-wrap"><h3>Valores anuales y diferencia</h3><table class="annual-table"><thead><tr><th>Variable</th><th>${esc(data.left.city_name)}</th><th>${esc(data.right.city_name)}</th><th>B − A</th></tr></thead><tbody>${annual}</tbody></table></section><section class="study-reading"><h3>Lectura anual</h3><ul>${reading}</ul></section></details>`;
  $("city-study-output").querySelector(".study-grid>section:nth-child(2)")?.insertAdjacentHTML("beforeend",`<div class="season-scan">${seasonScan}</div>`);
}
async function runCityStudy(){
  if(!studyCities.left||!studyCities.right)return setStatus("Elige ambas urbes desde los resultados de búsqueda.",true);
  const button=$("run-city-study");button.disabled=true;setStatus("Comparando perfiles estacionales…",true);
  try{const p=getParams(),result=await request("compareCities",{leftIdx:studyCities.left.idx,rightIdx:studyCities.right.idx,mode:p.mode,season:p.season,weights:p.weights},60000);renderCityStudy(result);setStatus("Comparación de urbes lista");}catch(e){setStatus(`No se pudo comparar las urbes: ${e.message}`,true)}finally{button.disabled=false;}
}
async function drawStudyCountryMaps(result){
  const leftCanvas=$("study-country-map-left"),rightCanvas=$("study-country-map-right");if(!leftCanvas||!rightCanvas)return;
  const visiblePairs=result.pairs.slice(0,10);
  const left=visiblePairs.map((pair,index)=>({idx:pair.left.idx,city_name:pair.left.city_name,color:STUDY_COLORS[index],label:`${index+1} · ${pair.left.city_name} · ${pair.similarity_pct}%`}));
  const right=visiblePairs.map((pair,index)=>({idx:pair.right.idx,city_name:pair.right.city_name,color:STUDY_COLORS[index],label:`${index+1} · ${pair.right.city_name} · ${pair.similarity_pct}%`}));
  await Promise.all([mapView.drawCountryPanel(leftCanvas.getContext("2d"),{x:0,y:0,w:leftCanvas.width,h:leftCanvas.height},result.leftCountry,result.leftBounds,left),mapView.drawCountryPanel(rightCanvas.getContext("2d"),{x:0,y:0,w:rightCanvas.width,h:rightCanvas.height},result.rightCountry,result.rightBounds,right)]);
}
function openCountryPairStudy(pair){
  studyCities.left={...pair.left};studyCities.right={...pair.right};$("study-city-left").value=`${pair.left.city_name} · ${pair.left.country_name}`;$("study-city-right").value=`${pair.right.city_name} · ${pair.right.country_name}`;setStudyMode("cities");$("compare-studio").querySelector(".compare-window").scrollTop=0;runCityStudy();
}
function renderCountryStudy(result){
  const pairs=result.pairs.map((pair,index)=>`<li><button type="button" class="country-pair-item" data-country-pair="${index}"><i style="background:${STUDY_COLORS[index%STUDY_COLORS.length]}">${index+1}</i><span><b>${esc(pair.left.city_name)} ↔ ${esc(pair.right.city_name)}</b><small>${esc(pair.seasonal_alignment)} · ${pair.similarity_pct}% · ver estudio estacional</small></span><em>Ver</em></button></li>`).join("");
  const mapNote=result.pairs.length>10?`Los mapas muestran los primeros 10 de ${result.pairs.length} pares; la lista incluye todos los resultados.`:"Los números y colores vinculan cada ciudad en ambos mapas.";
  $("country-study-output").innerHTML=`<p class="study-caption">${result.sampled?"Cruce amplio: se usó una muestra de ciudades con mayor población para mantener la respuesta ágil.":"Cruce exhaustivo de los pares disponibles."} ${mapNote}</p><div class="country-map-pair"><section><canvas id="study-country-map-left" width="980" height="650"></canvas></section><section><canvas id="study-country-map-right" width="980" height="650"></canvas></section></div><ol class="country-pair-list">${pairs}</ol>`;
  document.querySelectorAll("[data-country-pair]").forEach(button=>button.addEventListener("click",()=>openCountryPairStudy(result.pairs[Number(button.dataset.countryPair)])));
  drawStudyCountryMaps(result).catch(e=>setStatus(`No se pudieron dibujar los mapas: ${e.message}`,true));
}
async function runCountryStudy(){
  const leftCountryId=$("study-country-left").value,rightCountryId=$("study-country-right").value,limit=Number($("study-country-pair-limit").value),button=$("run-country-study");button.disabled=true;setStatus("Buscando pares climáticos entre países…",true);
  try{const p=getParams(),result=await request("compareCountries",{leftCountryId,rightCountryId,mode:p.mode,season:p.season,weights:p.weights,limit},60000);renderCountryStudy(result);setStatus("Estudio de países listo");}catch(e){setStatus(`No se pudo comparar países: ${e.message}`,true)}finally{button.disabled=false;}
}

let searchTimer=0;
function setupSearch(){const input=$("search"),box=$("search-results");input.addEventListener("input",()=>{clearTimeout(searchTimer);const q=input.value.trim();if(q.length<2){box.classList.add("hidden");box.innerHTML="";return;}searchTimer=setTimeout(async()=>{try{const rows=await request("search",{q,limit:12});box.innerHTML="";rows.forEach(r=>{const el=document.createElement("button");el.className="search-item";el.innerHTML=`<span><b>${esc(r.city_name)}</b><small>${esc([r.admin1_name,r.country_name].filter(Boolean).join(" · "))}</small></span><em>${r.population?Number(r.population).toLocaleString("es-ES"):""}</em>`;el.onclick=()=>{input.value="";box.classList.add("hidden");selectCity(r.idx,true)};box.appendChild(el);});box.classList.toggle("hidden",rows.length===0);}catch(e){setStatus(e.message,true)}},110);});document.addEventListener("pointerdown",e=>{if(!e.target.closest(".search-wrap"))box.classList.add("hidden")});}

async function ab(name){const r=await fetch(new URL(name,DATA));if(!r.ok)throw new Error(`${name}: HTTP ${r.status}`);return r.arrayBuffer()}
async function init(){
  try{
    if(location.protocol==="file:") throw new Error("No abras index.html con doble clic. Ejecuta start_windows.bat / start_mac_linux.sh o `python serve.py`.");
    const cr=await fetch(new URL("config.json",DATA));if(!cr.ok)throw new Error(`config.json: HTTP ${cr.status}`);cfg=await cr.json();
    setStatus("Cargando coordenadas…",true);const [pb,ob,ib]=await Promise.all([ab(cfg.files.positions),ab(cfg.files.spatial_offsets),ab(cfg.files.spatial_indices)]);positions=new Float32Array(pb);spatialOffsets=new Uint32Array(ob);spatialIndices=new Uint32Array(ib);if(positions.length!==cfg.city_count*2)throw new Error("Coordenadas desalineadas");groups=cfg.groups.map(group=>group.id);groupLabels=Object.fromEntries(cfg.groups.map(group=>[group.id,group.label]));
    mapView=new RasterMap($("map"),$("city-canvas"),positions,spatialOffsets,spatialIndices,cfg.spatial);setupControls();setupTopReferenceCompare();setupSearch();loadCountryShapes();createWorker();startupDone=true;$("city-total").textContent=cfg.city_count.toLocaleString("es-ES");setStatus("Mapa listo");
  }catch(e){console.error(e);$("fatal").textContent=e.message;$("fatal").classList.remove("hidden");setStatus("No se pudo iniciar",true);}
}
window.addEventListener("error",e=>{if(!startupDone)setStatus("Error de inicio: "+(e.message||"desconocido"),true)});
init();
