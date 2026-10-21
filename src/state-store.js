import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Separate plugin storage: never writes DSH session logs or prompt messages.
export class StateStore {
  constructor(directory,{limit=32}={}) {
    this.directory=directory;this.limit=limit;this.pending=new Map();this.timer=null;
    fs.mkdirSync(directory,{recursive:true});
  }
  filename(id) {return path.join(this.directory,createHash('sha256').update(id).digest('hex')+'.json');}
  read(id) {
    try {
      const file=this.filename(id);
      if(fs.statSync(file).size>1200000)return null;
      const value=JSON.parse(fs.readFileSync(file,'utf8'));
      return value.sessionId===id ? value : null;
    } catch {return null;}
  }
  readAll() {
    try {return fs.readdirSync(this.directory).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).slice(0,this.limit).flatMap(name=>{
      try {const file=path.join(this.directory,name);if(fs.statSync(file).size>1200000)return [];const state=JSON.parse(fs.readFileSync(file,'utf8'));return typeof state.sessionId==='string'&&this.filename(state.sessionId)===file?[state]:[];}catch{return [];}
    });}catch{return [];}
  }
  schedule(snapshot) {
    this.pending.set(snapshot.sessionId,snapshot);
    if(!this.timer)this.timer=setTimeout(()=>this.flush(),1000);
  }
  flush() {
    clearTimeout(this.timer);this.timer=null;
    for(const [id,snapshot] of this.pending) {
      try {
        const file=this.filename(id),temporary=file+'.tmp';
        const json=JSON.stringify(snapshot);
        if(Buffer.byteLength(json)>1200000)continue;
        fs.writeFileSync(temporary,json,{mode:0o600});
        fs.renameSync(temporary,file);
      } catch { /* Persistence failure must not affect the Agent. */ }
    }
    this.pending.clear();
    try {
      const files=fs.readdirSync(this.directory).filter(name=>/^[a-f0-9]{64}\.json$/.test(name))
        .map(name=>({file:path.join(this.directory,name),time:fs.statSync(path.join(this.directory,name)).mtimeMs}))
        .sort((a,b)=>b.time-a.time);
      for(const {file} of files.slice(this.limit))fs.unlinkSync(file);
    } catch {}
  }
}
