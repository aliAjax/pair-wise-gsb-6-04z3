import React from 'react';
import { renderToString } from 'react-dom/server';
const m = new Map<string,string>();
(globalThis as any).localStorage = {
  getItem:(k:string)=>m.has(k)?m.get(k)!:null, setItem:(k:string,v:string)=>m.set(k,String(v)),
  removeItem:(k:string)=>m.delete(k), clear:()=>m.clear(), key:()=>null, length:0,
};
(globalThis as any).React = React;
const mod = await import('../App.tsx');
const html = renderToString(React.createElement(mod.default));
for (const c of ['Find the right conversation','正式导出','版本日志']) if (!html.includes(c)) throw new Error('missing: '+c);
console.log('SSR ok, length', html.length);
process.exit(0);
