import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';

const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const host=fs.readFileSync('src/host.js','utf8');
if(!host.includes(`export const version = '${pkg.version}'`))throw Error('Host/package versions differ');
const client=fs.readFileSync('lib/client.js','utf8');
new vm.Script(client,{filename:'lib/client.js'});
if(Buffer.byteLength(client)>262144)throw Error('Client bundle exceeds 256 KiB');
const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
if(!files.length)throw Error('Stage the public source before checking the release');
const allowedDocs=new Set(['docs/user-guide.md','docs/architecture.md','docs/development.md']);
const allowedScripts=new Set(['scripts/build-client.mjs','scripts/release-check.mjs']);
const problems=[];
for(const file of files){
  if(/(?:^|\/)(?:\.local|node_modules|pelican-[^/]+)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:xml|pem|key|pfx|p12|tgz)$/i.test(file))problems.push(file+': private/generated path');
  if(file.startsWith('docs/')&&!allowedDocs.has(file))problems.push(file+': development material');
  if(file.startsWith('scripts/')&&!allowedScripts.has(file))problems.push(file+': local helper');
  const content=fs.readFileSync(file,'utf8');
  if(/sk-vsr-[A-Za-z0-9]{43}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/.test(content))problems.push(file+': credential-shaped value');
  if(/C:[\\/]+Users[\\/]+57752/i.test(content))problems.push(file+': personal machine path');
  if(file.endsWith('.md')){
    for(const match of content.matchAll(/\]\(([^)]+)\)/g)){
      const link=match[1].split('#')[0];if(!link||/^(?:https?:|mailto:)/.test(link))continue;
      if(!fs.existsSync(path.resolve(path.dirname(file),decodeURIComponent(link))))problems.push(file+': broken local link '+link);
    }
  }
}
if(problems.length)throw Error(problems.join('\n'));
console.log(`Release source checked: ${files.length} files; version ${pkg.version}; client ${Buffer.byteLength(client)} bytes`);
