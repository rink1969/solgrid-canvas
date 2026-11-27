function g(){let e=globalThis.InfiniteCanvasRuntime;if(!e)throw new Error("[plugin-sdk] Infinite Canvas \u8FD0\u884C\u65F6\u672A\u5C31\u7EEA:\u8BF7\u5728\u753B\u5E03\u5BBF\u4E3B\u4E2D\u52A0\u8F7D\u672C\u63D2\u4EF6");return e}function i(){return g().React}var p=((...e)=>i().useState(...e)),l=((...e)=>i().useEffect(...e));var c=((...e)=>i().useRef(...e));var k=`.cnv-md {
    height: 100%;
    width: 100%;
    overflow: auto;
    padding: 16px;
    font-size: 14px;
    line-height: 1.6;
}
.cnv-md h1,
.cnv-md h2,
.cnv-md h3 {
    margin: 0.6em 0 0.3em;
    font-weight: 600;
    line-height: 1.3;
}
.cnv-md h1 {
    font-size: 1.5em;
}
.cnv-md h2 {
    font-size: 1.3em;
}
.cnv-md p {
    margin: 0.5em 0;
}
.cnv-md a {
    color: #6366f1;
    text-decoration: underline;
}
.cnv-md code {
    padding: 0.1em 0.35em;
    border-radius: 4px;
    background: rgba(120, 120, 120, 0.16);
    font-family: monospace;
    font-size: 0.9em;
}
.cnv-md pre {
    padding: 12px;
    border-radius: 8px;
    background: rgba(120, 120, 120, 0.14);
    overflow: auto;
}
.cnv-md pre code {
    padding: 0;
    background: transparent;
}
.cnv-md ul,
.cnv-md ol {
    padding-left: 1.4em;
    margin: 0.5em 0;
}
.cnv-md blockquote {
    margin: 0.5em 0;
    padding-left: 0.8em;
    border-left: 3px solid rgba(120, 120, 120, 0.4);
    opacity: 0.85;
}
.cnv-md img {
    max-width: 100%;
}
`;var v=Symbol.for("infinite-canvas.jsx.fragment");function x(e,t,o){let r=i(),s=e===v?r.Fragment:e,a=o===void 0?t:{...t??{},key:o};return r.createElement(s,a)}function f(e,t,o){return x(e,t,o)}var d,m;function C(){return d?Promise.resolve(d):(m||(m=import("https://esm.sh/marked@14").then(e=>d=e.marked)),m)}var h="*\u9009\u4E2D\u8282\u70B9,\u70B9\u4E0A\u65B9\u5DE5\u5177\u6761\u7684 \u270E \u7F16\u8F91 Markdown*",R=new Map;function P(e){if(!d)return"";let t=e||h,o=R.get(t);return o===void 0&&(o=d.parse(t),R.set(t,o)),o}function b({ctx:e}){let[,t]=p(0),o=c(null),r=c(null);l(()=>{if(d)return;let n=!0;return C().then(()=>n&&t(u=>u+1)),()=>{n=!1}},[]);let s=e.node.metadata?.content||"",a=P(s);return l(()=>{let n=o.current;!n||r.current===a||(n.innerHTML=a,r.current=a)},[a]),f("div",{ref:o,className:"cnv-md","data-canvas-no-zoom":!0,onWheel:n=>n.stopPropagation(),style:{height:"100%",width:"100%",color:e.theme.node.text}})}function E({ctx:e}){let t=e.node.metadata?.content||"",[o,r]=p(t),s=c(!1),a=c(!1);return l(()=>{s.current||r(t)},[t]),f("textarea",{autoFocus:!0,value:o,placeholder:"# \u8F93\u5165 Markdown",onChange:n=>{let u=n.target.value;r(u),a.current||e.updateMetadata({content:u})},onCompositionStart:()=>{a.current=!0},onCompositionEnd:n=>{a.current=!1;let u=n.currentTarget.value;r(u),e.updateMetadata({content:u})},onFocus:()=>{s.current=!0},onBlur:()=>{s.current=!1},onMouseDown:n=>n.stopPropagation(),onPointerDown:n=>n.stopPropagation(),onWheel:n=>n.stopPropagation(),style:{height:"100%",width:"100%",resize:"none",background:e.theme.node.fill,borderRadius:16,boxSizing:"border-box",padding:16,fontFamily:"monospace",fontSize:14,outline:"none",border:"none",color:e.theme.node.text}})}function M({ctx:e}){return e.node.metadata?.editing?f(E,{ctx:e}):f(b,{ctx:e})}var O={id:"markdown",name:"Markdown \u8282\u70B9",version:"1.1.0",description:"\u5728\u753B\u5E03\u4E2D\u7F16\u8F91\u4E0E\u6E32\u67D3 Markdown",css:k,nodes:[{type:"markdown:doc",title:"Markdown",icon:"\u{1F4DD}",description:"\u7F16\u8F91\u4E0E\u6E32\u67D3 Markdown",defaultSize:{width:360,height:300},defaultMetadata:{content:""},minimapColor:"#6366f1",hidePanel:!0,interactionToggle:!0,forceInteractive:e=>!!e.metadata?.editing,resource:e=>({kind:"text",text:e.metadata?.content}),Content:M,toolbar:e=>{let t=!!e.node.metadata?.editing;return[{id:"md-toggle-edit",title:t?"\u9884\u89C8\u6E32\u67D3\u7ED3\u679C":"\u7F16\u8F91 Markdown \u6E90\u7801",label:t?"\u9884\u89C8":"\u7F16\u8F91",icon:t?"\u{1F441}":"\u270E",active:t,onClick:()=>e.updateMetadata({editing:!t})}]}}]};export{O as default};
