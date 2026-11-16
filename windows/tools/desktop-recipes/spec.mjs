// Changes to the official Windows Grok Bot 1.1.0 app.asar, built into
// windows/patchers/desktop/recipes by build.mjs. Each anchor must occur exactly once in
// its source; a different official build is refused instead of being half patched.
// Code that the recipes append lives in extensions/ (it is the source, not dead code).
//
// Edits: { prepend | append | replaceAll: text }, { insertBefore | insertAfter: anchor, text },
// { replace: anchor, text }, { cutFrom: anchor, text } (drops the rest of the file),
// { removeThrough: [startAnchor, endAnchor], text }.
import { readFileSync } from 'node:fs';

const extension = name => readFileSync(new URL(`./extensions/${name}`, import.meta.url), 'utf8');
const asset = name => `dist/renderer/assets/${name}`;
const edit = (name, edits) => ({ path: asset(name), source: asset(name), edits });
const I18N = "import { grokText } from './grok-local-i18n.js';\n";

export const SPEC = [
  // The local client (mac/clients/desktop) reuses a few original main-process modules. Each
  // copy stops before the original entry point runs and exports what the client needs.
  {
    path: 'dist/electron-main/local-browser.cjs', source: 'dist/electron-main/main-app.cjs',
    edits: [
      { prepend: 'require("./local-shared.cjs");\n' },
      { cutFrom: 'var l$t=y(I_()),d$t=y(w1t()),be=(0,o$t.readMainCoreHandoff)();',
        text: '\nmodule.exports={requestPasskey:lnt,requestPin:snt,updatePasskey:xRn,finishPasskey:qle};\n' },
    ],
  },
  {
    path: 'dist/electron-main/local-shared.cjs', source: 'dist/electron-main/main-core.cjs',
    edits: [
      { cutFrom: 'hj({killSwitch:process.env.CURSOR_DISABLE_HALF_OPEN_ASYNC_ITERATOR_FIX});var mH=ade(),gCe=bj({scope:"sand-desktop"});',
        text: '\nmodule.exports={activateLocale:Qc};\n' },
    ],
  },
  {
    path: 'dist/local-exec-daemon/main.cjs', source: 'dist/local-exec-daemon/main.cjs',
    edits: [
      { removeThrough: ['zqt().catch(r=>{let e=r instanceof Error?r:new Error(String(r));process.stderr.write(`[sand-local-exec-daemon] fatal:',
        'finally(()=>process.exit(1))});'],
        text: 'module.exports={Provider:Gw,ComputerUse:$w,findComputerHelper:bc,decideLocalUse:oW,isLocalUseBlocked:QSe,retireApproval:YSe,parseApproval:Zit};' },
    ],
  },
  {
    path: 'dist/node-agent-coordinator/local-browser.cjs', source: 'dist/node-agent-coordinator/main.cjs',
    edits: [
      { cutFrom: 't_e().catch(n=>{process.stderr.write(`node-agent-coordinator: composition failure:',
        text: '\nmodule.exports={passkeyProvider:tH,signer:lH,findSigner:aH,relyingParty:nH,interval:xs,reconnect:e_e,deadline:at,watchdog:Zr,delivery:qt,expiry:Oi};\n' },
    ],
  },

  { path: asset('grok-local-i18n.js'), source: null, edits: [{ append: extension('grok-local-i18n.js') }] },

  // No crash reports leave the local client.
  edit('chunk-sentry-sdk-CZU06Itw.js', [
    { replaceAll: 'const noop=()=>{};export function initSandSentrySdk(){return{captureException:noop,captureMessage:noop,setTag:noop,withScope:noop}}' },
  ]),
  edit('index.eager-common-DcDxc78C.js', [
    { insertBefore: 'if(Jt(e[0])){if(Ut.size===0)Kt({kind:`exception`,args:e})', text: 'return;' },
    { insertBefore: 'if(Ut.size===0)Kt({kind:`message`,args:e})', text: 'return;' },
  ]),

  // Connected apps: only apps the Host can serve, a local empty state and the Host's share link.
  edit('chunk-view-DWmS7c1N.js', [
    { replace: 'c=r?n.filter(Yc):n;', text: 'c=n.filter(Yc);' },
    { replace: 'onSelect:()=>y(Ee(O)),children:P', text: 'onSelect:()=>y(n.shareUrl),children:P' },
  ]),
  edit('chunk-plugin-detail-sharepoint-write-Djmzxo8M.js', [
    { prepend: I18N },
    { replace: ':e(ue)}function Rt(e){Rt.d=2606;', text: ':grokText(`暂无连接应用`,`No connected apps`)}function Rt(e){Rt.d=2606;' },
  ]),

  // Bot library: the Host accepts 20 MiB per file, 100 files and 100 MiB per Bot. Host Bots
  // keep one shared library and no per-user store; files can be picked as well as dropped.
  edit('chunk-bot-store-files-library-Cx0SHaX-.js', [
    { prepend: I18N + "import { WC as GrokButton } from './index.eager-app-BwKPFs1J.js';\n" },
    { replace: 'ae=26214400,A=1073741824', text: 'ae=20971520,A=104857600' },
    { replace: 'e.sizeBytes>26214400?{kind:`too-large`}:t.fileCount>=200?{kind:`too-many-files`}:t.totalBytes+e.sizeBytes>1073741824?',
      text: 'e.sizeBytes>20971520?{kind:`too-large`}:t.fileCount>=100?{kind:`too-many-files`}:t.totalBytes+e.sizeBytes>104857600?' },
    { replace: 'let he;return t[57]!==J||t[58]!==$?(he=(0,B.jsxs)(B.Fragment,{children:[J,$]}),t[57]=J,t[58]=$,t[59]=he):he=t[59],he}',
      text: 'return(0,B.jsxs)(B.Fragment,{children:[A?(0,B.jsx)(GrokLibraryUpload,{upload:N,disabled:P}):null,$]})}' },
    { append: extension('library.js') },
  ]),

  // Settings > General: the account card shows this Host and opens the connection dialog;
  // realtime voice is a local setting; no security key proxy.
  edit('chunk-general-pane-6er8RCj0.js', [
    { prepend: I18N },
    { replace: '(B=(0,$.jsx)(`span`,{className:L,children:O}),',
      text: '(B=typeof O==`string`?(0,$.jsx)(GrokAccountName,{className:L,name:O,onCommit:name=>r.updateName(name)}):(0,$.jsx)(`span`,{className:L,children:O}),' },
    { replace: '(H=(0,$.jsx)(`span`,{className:V,children:w}),', text: '(H=(0,$.jsx)(`span`,{className:V,children:(0,$.jsx)(GrokAccountHost,{})}),' },
    { replace: '(G=j?(0,$.jsx)(K,{disabled:ee,onClick:i?()=>void r.cancelLoginFlight():()=>void c(),size:`md`,style:gr.actionWeakBorder,variant:`secondary`,children:i?(0,$.jsx)(Y,{id:`dEgA5A`}):(0,$.jsx)(Y,{id:`MPPZ54`})}):null,',
      text: '(G=(0,$.jsx)(GrokHostConnection,{}),' },
    // Notification sounds are a development-only section upstream; show it without DEV markers.
    { replace: '(n=t?(0,$.jsx)(Zi,{}):null,', text: '(n=(0,$.jsx)(Zi,{}),' },
    { replace: '(f=(0,$.jsx)(j,{children:d}),', text: '(f=d,' },
    { replace: 'label:on(n({id:`6EhUT7`}))', text: 'label:n({id:`6EhUT7`})' },
    { replace: '"aria-label":on(n({id:`wm7RV4`}))', text: '"aria-label":n({id:`wm7RV4`})' },
    // Auto-review: a short description, and no team-rule hints.
    { replace: '(g=a(l==null?{id:`De8ppO`}:{id:`QqKsGg`}),', text: '(g=l==null?grokText(`运行操作前检查，需要时询问。`,`Review actions and ask when needed.`):a({id:`QqKsGg`}),' },
    { replace: '(0,$.jsx)(Un,{children:(0,$.jsx)(Y,{id:`NFRGrQ`})})', text: 'null' },
    { replace: '(0,$.jsx)(ge,{as:`span`,color:`tertiary`,level:`body2`,children:h})]}):null', text: 'null]}):null' },
    { replace: 'children:[l,f,p,m,b,x,h,g,_,v,y,S,C,w,T,E]', text: 'children:[l,f,(0,$.jsx)(GrokRealtimeVoiceSettings,{}),p,m,b,x,h,g,_,v,y,S,w,T,E]' },
    { append: extension('general-pane.js') },
  ]),

  // Settings > Computer: the Host manages the Bot's computer; this computer's access stays.
  edit('chunk-view-BLp8SFMI.js', [
    { prepend: I18N },
    { replace: '(0,Q.jsxs)(`div`,{...n,children:[i,a,o,s]})', text: '(0,Q.jsxs)(`div`,{...n,children:[(0,Q.jsx)(GrokRemoteDesktop,{}),i,a,o]})' },
    { append: extension('computer-view.js') },
  ]),

  // Settings > Updates: the local build has no updater.
  edit('chunk-view-D18ZK0A2.js', [
    { prepend: I18N },
    { replace: '(t=(0,S.jsx)(v,{children:(0,S.jsx)(E,{})}),', text: '(t=(0,S.jsx)(v,{children:(0,S.jsx)(GrokLocalVersion,{})}),' },
    { append: extension('update-view.js') },
  ]),

  // Marketplace: apps the Host provides form their own category without public links.
  edit('chunk-marketplace-browse-model-DJdVElaw.js', [
    { replace: 'var u=[`credentials`,', text: 'var u=[`host`,`credentials`,' },
    { replace: 'd={LOGIN_AND_CREDENTIAL_MANAGEMENT:`credentials`,', text: 'd={HOST:`host`,LOGIN_AND_CREDENTIAL_MANAGEMENT:`credentials`,' },
    { replace: 'var T={credentials:{id:`P+nzjE`},', text: 'var T={host:{id:`Host`,message:`Host`},credentials:{id:`P+nzjE`},' },
  ]),
  edit('chunk-plugin-detail-view-DCQFsFxs.js', [
    { replace: 'function yt(e){if(e.marketplace?.ownership===`user`)return null;',
      text: 'function yt(e){if(e.category===`Host`)return null;if(e.marketplace?.ownership===`user`)return null;' },
  ]),

  edit('index.eager-app-BwKPFs1J.js', [
    { prepend: I18N },
    { replace: 'qK={FEATURED:{id:`FkMol5`},', text: 'qK={HOST:{id:`Host`,message:`Host`},FEATURED:{id:`FkMol5`},' },
    // Account menu: connection settings instead of adding a cloud account; no mobile app offer.
    { replace: '(mt=(0,Z.jsxs)(aE.Section,{children:[lt,ut,pt]}),', text: '(mt=(0,Z.jsxs)(aE.Section,{children:[ut,pt]}),' },
    { replace: 'onSelect:Qe,children:(0,Z.jsx)(No,{id:`MPPZ54`})}):null,',
      text: 'onSelect:()=>{window.__grokLocalConnectionRequested=true;c(`general`);window.dispatchEvent(new Event(`grokbot-local:connect-request`))},children:grokText(`连接设置`,`Connection settings`)}):null,' },
    // Signing out disconnects from the Host; nothing stays on a cloud computer.
    { replace: 'get description(){return ba._(vk.description)}', text: 'get description(){return``}' },
    // Bot settings: title, instructions and library files are kept on the Host; the Host
    // chooses the voice, so neither the Bot nor a call offers voice settings.
    { replace: '(c=(0,Z.jsxs)(`div`,{...r,children:[i,o,s]}),', text: '(c=(0,Z.jsxs)(`div`,{...r,children:[i,o,s,(0,Z.jsx)(GrokLocalSettings,{agent:n})]}),' },
    { insertAfter: 'function gP(e){', text: 'return null;' },
    { replace: 'let M=j;!M&&(g===`settings`||v===`settings`)', text: 'let M=!1;!M&&(g===`settings`||v===`settings`)' },
    // Connected apps: no link to the cloud Bot templates.
    { insertAfter: 'function Qan(){', text: 'return null;' },
    // No crash reporter, heap samples or idle sampling.
    { insertAfter: 'function N5e(e,t,n=M5e){', text: 'return{load:async()=>{},setTag:()=>{}};' },
    { insertAfter: 'function qKr(e,t,n={}){', text: 'return()=>{};' },
    { insertAfter: 'function eqr(e,t=document){', text: 'return{sampleIdleMinutes:()=>void 0,stop:()=>{}};' },
    // Realtime calls go to the Host relay (host/server/voice-session.mjs), which transcribes,
    // runs the Bot, speaks and records the call. The client sends no presence, nudges,
    // written turns, greeting or tool results, keeps no call journal and never resumes.
    { replace: 'pe=(t,n)=>e.source.setVoiceCallPresence({id:t.agentId,callId:t.callId,isOnTheLine:n,acceptsOverheard:t.acceptsOverheard})',
      text: 'pe=(t,n)=>Promise.resolve()' },
    { insertAfter: 'Oe=async(t,n,r,i)=>{if(!SW.canHangUp(t.phase))return;', text: 'n===`hung-up`&&t.session?.localVoiceEndCall?.();' },
    { replace: 'I=e=>e.didConnect?(e.journalLine??=', text: 'I=e=>!1?(e.journalLine??=' },
    { insertBefore: 'let n=M();if(n===null||n.phase===`ending`||n.agentId!==t.agentId||n.callId!==t.callId', text: 'return;' },
    { insertBefore: 'let i=M();if(i===null||!SW.isCallerOnTheLine(i.phase)||i.agentId!==t||n!==i.thread.sessionId)return;je(i,r);', text: 'return;' },
    // Turning realtime voice off in Settings ends the current call.
    { insertAfter: 'Pe=e.transcript.observeEntriesFeed({onAppended:Me,onBaseline:Ne,onFetched:({agentId:e,sessionId:t,read:n})=>Ne({agentId:e,sessionId:t,entries:n})})',
      text: ',grokVoicePreferenceRelease=window.localBot.onVoicePreferenceChanged(enabled=>{enabled||void ae()})' },
    { replace: 'dispose(){Pe();', text: 'dispose(){grokVoicePreferenceRelease(),Pe();' },
    // The local client mints a short-lived ticket for this Host; only that address is dialable.
    { replace: 'let r=await e.desktop.mintVoiceCallCredential();',
      text: 'let r=await window.localBot.mintVoiceCredential(this.dial.agentId);grokVoiceEndpoint=r.ok?r.credential.websocketUrl:null;' },
    { replace: 'function FGr(e){return PGr(e.desktop,NGr(e))}',
      text: 'function FGr(e){return{session:async()=>({instructions:``,tools:[],hasOverheard:!1,greeting:{direction:``,withLandedWork:``}}),callTool:async()=>{throw Error(`Voice tools are managed by the Host`)}}}' },
    { replace: 'var yYr=class e{static DIALABLE_ORIGIN=`wss://api.x.ai/`;static isDialableURL(t){return t.startsWith(e.DIALABLE_ORIGIN)}',
      text: 'let grokVoiceEndpoint=null;var yYr=class e{static isDialableURL(t){return typeof t==`string`&&t===grokVoiceEndpoint}' },
    // Speech plays through a media element, and the Host hears when each reply finished
    // playing (response.playback.done) and when the caller hangs up (session.close).
    { replace: 'let s=r.createMediaStreamDestination(),c=new e(r,a,o,s,t);return c.hold(n,i),c}',
      text: 'let s=r.createMediaStreamDestination(),speaker=new Audio;speaker.autoplay=!0,speaker.srcObject=s.stream,await speaker.play();let c=new e(r,a,o,s,t);return c.localOutput=speaker,c.hold(n,i),c}' },
    { replace: 'n.connect(this.context.destination),n.connect(this.speakerTap);', text: 'n.connect(this.speakerTap);' },
    { replace: 'teardown(){this.dropScheduledSpeech(),', text: 'teardown(){this.localOutput?.pause(),this.localOutput&&(this.localOutput.srcObject=null),this.dropScheduledSpeech(),' },
    { replace: 'responseHeard=[];socket;router;responses;', text: 'responseHeard=[];localVoiceHeard=new Set;localVoiceGeneration=0;socket;router;responses;' },
    { replace: 'onCallerInterrupted:()=>{this.cancelUserFirstOpen(),', text: 'onCallerInterrupted:()=>{this.localVoiceGeneration++,this.localVoiceHeard.clear(),this.cancelUserFirstOpen(),' },
    { replace: 'onAssistantResponseEnded:e=>{this.sendTruncations(', text: 'onAssistantResponseEnded:e=>{e||void this.localVoicePlaybackDone(),this.sendTruncations(' },
    { replace: 't.speak(e,this.responses.speaksForNudgeId),this.args.handlers.onAudioReceived?.()',
      text: 't.speak(e,this.responses.speaksForNudgeId),e.itemId!==null&&this.localVoiceHeard.add(e.itemId),this.args.handlers.onAudioReceived?.()' },
    { insertAfter: 'thisResponseHasBeenHeard(){for(let e of this.responseHeard.splice(0))e()}',
      text: 'async localVoicePlaybackDone(){let items=[...this.localVoiceHeard],generation=this.localVoiceGeneration,audio=this.audio;if(audio===null||items.length===0)return;try{await audio.whenScheduledSpeechEnds()}catch{return}if(this.phase.kind!==`live`||generation!==this.localVoiceGeneration||this.router.callerIsSpeaking||this.socketSilentlyDiscardsFrames())return;for(let item_id of items)this.socket.send(JSON.stringify({type:`response.playback.done`,item_id}));this.localVoiceHeard.clear()}localVoiceEndCall(){this.socketSilentlyDiscardsFrames()||this.socket.send(JSON.stringify({type:`session.close`}))}' },
    { replace: 't.kind===`event`&&this.router.route(t.event)',
      text: 't.kind===`event`&&((t.event.type===`response.created`||t.event.type===`response.cancelled`)&&(this.localVoiceGeneration++,this.localVoiceHeard.clear()),this.router.route(t.event))' },
    { replace: 'openAfterUserFirstGrace(){let e=this.pendingConnectGreeting;e!==null&&(this.pendingConnectGreeting=null,this.responses.greet(e))}',
      text: 'openAfterUserFirstGrace(){this.cancelUserFirstOpen()}' },
    { replace: 'resumption:{enabled:!0}', text: 'resumption:{enabled:!1}' },
    { append: extension('eager-app.js') },
  ]),

  // The render-trace hook installs a React DevTools stub for the vendor's render sampling,
  // which this client does not run (0.71.2 drops it too).
  { path: 'dist/renderer/index.html', source: 'dist/renderer/index.html', edits: [
    { replace: '    <script src="./assets/dune-render-trace-hook-265eb7be.js"></script>\n', text: '' },
  ] },
];
