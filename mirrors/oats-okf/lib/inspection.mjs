import { fs, join, safePath, fail } from './io.mjs';

// Keep the v1 labeled-document contract, including its explicit per-document
// preview cap. The JSON envelope itself must drain in full through stdout.
const DOCUMENT_BYTES = 256 * 1024;
const missing = e => e.code === 'ENOENT' || e.code === 'ENOTDIR';
function regular(file, limit) {
  safePath(file);
  let stat;try { stat=fs.lstatSync(file); } catch(e) { if(missing(e)) return null;throw e; }
  if(!stat.isFile() || stat.nlink!==1) fail('E_PATH',`inspection requires a single-link regular file: ${file}`);
  const fd=fs.openSync(file,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened=fs.fstatSync(fd);
    if(!opened.isFile() || opened.nlink!==1 || opened.dev!==stat.dev || opened.ino!==stat.ino) fail('E_PATH',`inspection file changed: ${file}`);
    if(limit===undefined) return {text:fs.readFileSync(fd,'utf8')};
    const bytes=Buffer.alloc(Math.min(opened.size,limit));let length=0;
    while(length<bytes.length) { const n=fs.readSync(fd,bytes,length,bytes.length-length,null);if(!n) break;length+=n; }
    const truncated=opened.size>limit;
    let text=bytes.subarray(0,length).toString('utf8');
    if(truncated && text.endsWith('\uFFFD')) text=text.slice(0,-1);
    return {text,...(truncated?{truncated:true,bytes:opened.size}:{})};
  } finally {fs.closeSync(fd);}
}
/** The home's working memory (STATE.md, log.md, notes/*.md), each capped. */
function homeDocuments(home) {
  const documents=[];
  const doc=(label,file)=>{
    const content=regular(file,DOCUMENT_BYTES);
    if(content) documents.push({label,kind:'markdown',path:file,...content});
  };
  let error;
  try {
    doc('Working state (STATE.md)',join(home,'STATE.md'));
    doc('Log (log.md)',join(home,'log.md'));
    const notes=safePath(join(home,'notes'));
    function walk(dir,prefix='') {
      let entries;try {entries=fs.readdirSync(dir,{withFileTypes:true});} catch(e) {if(e.code==='ENOENT') return;throw e;}
      for(const entry of entries.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)) {
        const name=prefix+entry.name,file=join(dir,entry.name);
        // No symlink traversal, including directories or non-Markdown aliases.
        safePath(file);
        if(entry.isDirectory()) walk(file,name+'/');
        else if(entry.name.endsWith('.md')) doc(`Pending note: ${name}`,file);
      }
    }
    walk(notes);
  } catch(e) {error=e;}
  return {documents,error};
}
/** okf 5.0.0: what an instance consults (its declaration and the bases it
 *  reads) and its own working memory. There is no source, custody or harvest
 *  to report; `oats okf bases` shows the accepted state it reads. */
export function inspect(source) {
  const {documents,error}=homeDocuments(source.home),observedAt=new Date().toISOString();
  if(error) fail(error.code==='E_PATH'?'E_PATH':'E_INSPECT_FAILED',error.message);
  const path=join(source.home,'knowledge');let legacy=null;
  try {const stat=fs.lstatSync(path);legacy={status:'legacy-local-view',path,ignored:true,...(stat.isSymbolicLink()?{symlink:true}:{}),note:'okf 3.0.0 ignores this okf 2.x snapshot and reads knowledge remotely; it is safe to delete by hand'};} catch(e) {if(!missing(e)) throw e;}
  return {
    summary:`OKF: ${source.decl.version===2?`subjects ${source.decl.subjects.join(', ')}`:`owns ${source.decl.owns.join(', ') || 'none'}`}; ${documents.length} working-memory documents${legacy?'; legacy-local-view ./knowledge/ (ignored, safe to delete)':''}`,
    owns:source.decl.owns,reads:source.decl.reads,...(source.decl.version===2?{subjects:source.decl.subjects}:{}),bases:source.bindings.bases,legacyLocalView:legacy,liveMemory:{available:true,reason:'live',observedAt},documents
  };
}
