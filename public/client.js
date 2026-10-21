import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

const $=id=>document.getElementById(id);
const overlay=$('overlay'), hud=$('hud'), status=$('status'), play=$('playButton');
let socket, myId=null, token=localStorage.getItem('fy-token')||'', joined=false, locked=false;
let reconnectTimer=null, reconnectAttempts=0, manualStop=false, handshakeTimer=null;
const MAX_RECONNECT_DELAY=15000;
function setConnectionState(state, message='') {
  status.textContent = message || state;
  status.dataset.state = state.toLowerCase();
  status.setAttribute('aria-live','polite');
  if (state !== 'Connected') { overlay.classList.remove('hidden'); hud.classList.add('hidden'); }
  play.disabled = state === 'Connecting' || state === 'Reconnecting';
  play.textContent = state === 'Reconnecting' ? 'RETRYING CONNECTION…' : 'ENTER THE YARD';
}
function scheduleReconnect() {
  if (manualStop || reconnectTimer) return;
  joined=false; locked=false; myId=null;
  const delay=Math.min(1000*Math.pow(2, Math.min(reconnectAttempts,4)),MAX_RECONNECT_DELAY);
  reconnectAttempts++;
  setConnectionState('Reconnecting', 'Reconnecting in '+Math.ceil(delay/1000)+'s…');
  reconnectTimer=setTimeout(()=>{reconnectTimer=null;openSocket(true)},delay);
}
let players=new Map(), yaw=0, pitch=0, keys=new Set(), health=100, phase='waiting', scores={1:0,2:0};
const scene=new THREE.Scene();scene.background=new THREE.Color(0x0b1014);scene.fog=new THREE.Fog(0x0b1014,45,105);
const camera=new THREE.PerspectiveCamera(76,innerWidth/innerHeight,.1,180);
const renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.5));renderer.setSize(innerWidth,innerHeight);renderer.shadowMap.enabled=true;renderer.outputColorSpace=THREE.SRGBColorSpace;document.body.prepend(renderer.domElement);
scene.add(new THREE.HemisphereLight(0xc9e5f0,0x30343a,2));const sun=new THREE.DirectionalLight(0xffd2a0,3);sun.position.set(-12,28,8);sun.castShadow=true;scene.add(sun);
const mat=(color,metalness=0)=>new THREE.MeshStandardMaterial({color,metalness,roughness:.7});
const floor=new THREE.Mesh(new THREE.PlaneGeometry(70,70),mat(0x39444b));floor.rotation.x=-Math.PI/2;floor.position.y=-.1;floor.receiveShadow=true;scene.add(floor);
function box(x,y,z,sx,sy,sz,color){const m=new THREE.Mesh(new THREE.BoxGeometry(sx,sy,sz),mat(color,.25));m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;scene.add(m);return m}
box(0,4.5,-35,70,9,1.4,0x202a30);box(0,4.5,35,70,9,1.4,0x202a30);box(-35,4.5,0,1.4,9,70,0x202a30);box(35,4.5,0,1.4,9,70,0x202a30);
box(0,.08,27,12,.2,8,0x146b78);box(0,.08,-27,12,.2,8,0x8e292c);box(0,1.4,0,5.4,2.8,5.4,0x303b42);box(0,2.85,0,5.8,.14,5.8,0xff994d);
for(const [x,z] of [[-8.75,-3.85],[8.75,3.85],[-8.75,3.85],[8.75,-3.85],[-25.5,-8],[-25.5,8],[25.5,-8],[25.5,8],[-28,22],[28,22],[-28,-22],[28,-22]])box(x,1,z,3.5,2,3.5,0x697981);
for(const x of [-23.5,23.5]){box(x,2.7,0,7,.55,30,0x303b42);box(x>0?17:-17,1.4,0,6.5,.35,30,0x697981)}
for(let i=0;i<12;i++){let x=(i%4)*15-22.5,z=Math.floor(i/4)*17-17;box(x,7,z,.45,14,.45,0x303b42);box(x,13.9,z,.9,.2,.9,0xff994d)}
const avatars=new Map();let localMesh=null;
function makeAvatar(p){const g=new THREE.Group();const body=new THREE.Mesh(new THREE.CapsuleGeometry(.42,.85,4,8),mat(p.team===1?0x5dd8e8:0xff5e5b));body.position.y=1.05;body.castShadow=true;g.add(body);const head=new THREE.Mesh(new THREE.SphereGeometry(.24,12,8),mat(0xe0c3a0));head.position.y=1.8;g.add(head);scene.add(g);return g}
function send(data){if(socket&&socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify(data))}
function connect(){manualStop=false;reconnectAttempts=0;if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null}openSocket(false)}
function openSocket(isRetry){
 if(socket && (socket.readyState===WebSocket.OPEN||socket.readyState===WebSocket.CONNECTING)) return;
 setConnectionState(isRetry?'Reconnecting':'Connecting',isRetry?'Reconnecting to game server…':'Connecting to game server…');
 const proto=location.protocol==='https:'?'wss:':'ws:';
 const url=proto+'//'+location.host;
 try { socket=new WebSocket(url); } catch(err) { scheduleReconnect(); return; }
 const current=socket;
 handshakeTimer=setTimeout(()=>{if(current===socket&&current.readyState!==WebSocket.CLOSED){try{current.close(4000,'Handshake timeout')}catch(_){}}},8000);
 current.onopen=()=>{send({type:'hello',name:$('playerName').value||'Player',token})};
 current.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch(err){console.warn('[Foundry Yard] Ignored malformed server message');return}
 if(m.type==='welcome'){
   if(typeof m.playerId!=='string'||typeof m.token!=='string'||!m.state||m.state.type!=='state'||!Array.isArray(m.state.players)){console.error('[Foundry Yard] Invalid welcome handshake');current.close(4002,'Invalid handshake');return}
   clearTimeout(handshakeTimer);handshakeTimer=null;
   myId=m.playerId;token=m.token;localStorage.setItem('fy-token',token);joined=true;reconnectAttempts=0;
   overlay.classList.add('hidden');hud.classList.remove('hidden');setConnectionState('Connected');applyState(m.state);return;
 }
 if(m.type==='state'){applyState(m);return}
 if(m.type==='error'){setConnectionState('Disconnected',m.message||'Server rejected connection');if(m.code==='server_full'){manualStop=true}return}
 if(m.type==='replaced'){manualStop=true;setConnectionState('Disconnected','This player session is active in another connection.');return}
 if(m.type==='hit'&&m.targetId===myId){health=m.health;$('health').textContent=health;$('healthBar').style.width=health+'%'}
 if(m.type==='death'&&m.playerId===myId){health=0;$('health').textContent='0';$('healthBar').style.width='0%';$('feed').textContent='ELIMINATED'}
 if(m.type==='roundEnd'){$('feed').textContent=m.matchWon?'MATCH COMPLETE':('TEAM '+m.winnerTeam+' TAKES ROUND')}
 if(m.type==='playerLeft'){$('feed').textContent='A player disconnected'}
 };
 current.onclose=()=>{if(handshakeTimer){clearTimeout(handshakeTimer);handshakeTimer=null}joined=false;if(!manualStop)scheduleReconnect();else setConnectionState('Disconnected','Disconnected. Press Enter to try again.')};
 current.onerror=()=>{setConnectionState('Reconnecting','WebSocket connection error');};
}
function applyState(s){if(!s)return;phase=s.phase;scores=s.roundScores||scores;$('score').textContent=(scores[1]||0)+' — '+(scores[2]||0);$('round').textContent=String(phase).toUpperCase();$('players').textContent=(s.playerCount||0)+' / '+(s.maxPlayers||10);
const present=new Set();for(const p of s.players||[]){present.add(p.id);let g=avatars.get(p.id);if(!g){g=makeAvatar(p);avatars.set(p.id,g)}g.position.set(p.x,p.y,p.z);g.rotation.y=p.yaw;if(p.id===myId){health=p.health;$('health').textContent=health;$('healthBar').style.width=health+'%';}}
for(const [id,g] of avatars)if(!present.has(id)){scene.remove(g);avatars.delete(id)}
}
play.addEventListener('click',connect);
setConnectionState('Disconnected','Disconnected. Press Enter to connect.');
document.addEventListener('keydown',e=>{keys.add(e.code);if(['Space','ArrowUp','ArrowDown'].includes(e.code))e.preventDefault();if(e.code==='Space')send({type:'jump'})});
document.addEventListener('keyup',e=>keys.delete(e.code));
renderer.domElement.addEventListener('click',()=>{if(joined&&!locked)renderer.domElement.requestPointerLock();else if(joined&&locked)send({type:'fire'})});
document.addEventListener('pointerlockchange',()=>{locked=document.pointerLockElement===renderer.domElement});
document.addEventListener('mousemove',e=>{if(!locked)return;yaw-=e.movementX*.0022;pitch-=e.movementY*.0022;pitch=Math.max(-1.2,Math.min(1.2,pitch))});
window.addEventListener('mousedown',e=>{if(joined&&locked&&e.button===0)send({type:'fire'})});
let last=0,lastInput=0;
function frame(t){requestAnimationFrame(frame);const dt=Math.min((t-last)/1000||0,.04);last=t;
if(joined){let x=0,z=0;if(keys.has('KeyW'))z-=1;if(keys.has('KeyS'))z+=1;if(keys.has('KeyA'))x-=1;if(keys.has('KeyD'))x+=1;const n=Math.hypot(x,z)||1;x/=n;z/=n;const wx=x*Math.cos(yaw)+z*Math.sin(yaw),wz=-x*Math.sin(yaw)+z*Math.cos(yaw);if(t-lastInput>45){send({type:'input',x:wx,z:wz,yaw,pitch});lastInput=t}}
const me=avatars.get(myId);if(me){camera.position.set(me.position.x,me.position.y+1.58,me.position.z);camera.rotation.order='YXZ';camera.rotation.y=yaw;camera.rotation.x=pitch}else{camera.position.set(0,8,44);camera.lookAt(0,0,0)}
renderer.render(scene,camera)}
requestAnimationFrame(frame);
window.addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight)});
