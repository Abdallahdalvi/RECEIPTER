const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'receipts.db');
const ALLOWED_HOSTS = new Set(['aghanimsphones.in', 'www.aghanimsphones.in']);

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  receipt_number TEXT NOT NULL UNIQUE,
  receipt_date TEXT NOT NULL,
  customer_name TEXT,
  customer_mobile TEXT,
  product_name TEXT,
  payment_mode TEXT,
  total REAL NOT NULL DEFAULT 0,
  received REAL NOT NULL DEFAULT 0,
  balance REAL NOT NULL DEFAULT 0,
  saved_at TEXT NOT NULL,
  data_json TEXT NOT NULL
);`);
db.exec('CREATE INDEX IF NOT EXISTS idx_receipts_date ON receipts(receipt_date);');
db.exec('CREATE INDEX IF NOT EXISTS idx_receipts_customer ON receipts(customer_mobile);');

function dbAll(sql, params = []) { return db.prepare(sql).all(...params); }
function dbGet(sql, params = []) { return db.prepare(sql).get(...params); }
function dbRun(sql, params = []) { return db.prepare(sql).run(...params); }

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
function json(res, status, data) { send(res, status, JSON.stringify(data), 'application/json; charset=utf-8'); }
function readBody(req) { return new Promise((resolve, reject) => { let body=''; req.on('data', c => { body += c; if (body.length > 2_000_000) req.destroy(new Error('Request too large.')); }); req.on('end', () => resolve(body)); req.on('error', reject); }); }

function cleanText(value = '') {
  return String(value).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/\s+/g, ' ').trim();
}
function getAttribute(html, tag, attr, value) {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}=["']${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, 'i');
  const match = html.match(re); if (!match) return '';
  const tagText = match[0]; const content = tagText.match(/\bcontent=["']([^"']*)["']/i); const src = tagText.match(/\bsrc=["']([^"']*)["']/i);
  return (content && content[1]) || (src && src[1]) || '';
}
function getFirstMeta(html, pairs) { for (const [attr, value] of pairs) { const r = getAttribute(html, 'meta', attr, value); if (r) return cleanText(r); } return ''; }
function getFirstTagText(html, tags) { for (const tag of tags) { const m = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')); if (m) { const t=cleanText(m[1]); if(t) return t; } } return ''; }
function parseMoney(raw) { if (!raw) return null; const m=String(raw).replace(/,/g,'').match(/(\d+(?:\.\d{1,2})?)/); return m ? Number(m[1]) : null; }
function extractProduct(html, url) {
  let title=getFirstMeta(html,[['property','og:title'],['name','twitter:title']]) || getFirstTagText(html,['h1','title']);
  title=cleanText(title).replace(/\s*[—-]\s*Aghanims Phones.*$/i,'').trim();
  let priceRaw=getFirstMeta(html,[['property','product:price:amount'],['itemprop','price']]);
  if(!priceRaw){const m=html.match(/<[^>]*itemprop=["']price["'][^>]*>\s*([^<]+)/i);if(m)priceRaw=cleanText(m[1]);}
  let price=parseMoney(priceRaw);
  if(!price){const body=cleanText(html.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'')); const matches=body.match(/₹\s?[0-9][0-9,]*(?:\.\d{1,2})?/g)||[]; const c=[...new Set(matches.map(parseMoney).filter(n=>Number.isFinite(n)&&n>0&&n<10000000))]; price=(c.length>=2&&c[1]<c[0])?c[1]:(c[0]||null);}
  const image=getFirstMeta(html,[['property','og:image'],['name','twitter:image']]);
  if(!title) throw new Error('Could not find a product name on that page.');
  if(!price) throw new Error('Could not find the product price. You can enter the price manually.');
  return {title,price,image,url};
}
function fetchHttps(urlString){return new Promise((resolve,reject)=>{const request=https.get(urlString,{headers:{'User-Agent':'Aghanims-Receipt-Generator/2.0','Accept':'text/html,application/xhtml+xml'},timeout:15000},response=>{let data='';response.setEncoding('utf8');response.on('data',c=>data+=c);response.on('end',()=>resolve({statusCode:response.statusCode||0,body:data}));});request.on('timeout',()=>request.destroy(new Error('Product page request timed out.')));request.on('error',reject);});}
function contentType(filePath){return ({'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.json':'application/json; charset=utf-8','.ico':'image/x-icon'})[path.extname(filePath).toLowerCase()]||'application/octet-stream';}

async function handleProductApi(req,res,targetUrl){let parsed;try{parsed=new URL(targetUrl);}catch{return json(res,400,{error:'Please enter a valid Aghanims product URL.'});}
  if(parsed.protocol!=='https:'||!ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())) return json(res,400,{error:'For security, this receipt generator only fetches product pages from aghanimsphones.in.'});
  try{const result=await fetchHttps(parsed.href);if(result.statusCode<200||result.statusCode>=300)return json(res,502,{error:`The product page returned HTTP ${result.statusCode}.`});return json(res,200,extractProduct(result.body,parsed.href));}
  catch(error){return json(res,502,{error:error.message||'Unable to fetch the product page.'});}
}

function validateReceipt(data){
  if(!data || typeof data !== 'object') throw new Error('Invalid receipt data.');
  const receiptNumber=String(data.receiptNumber||'').trim();
  const receiptDate=String(data.receiptDate||'').trim();
  if(!receiptNumber) throw new Error('Receipt number is required.');
  if(!receiptDate) throw new Error('Receipt date is required.');
  const total=Number(data.total)||0, received=Number(data.received)||0, balance=Number(data.balance)||0;
  return {receiptNumber,receiptDate,total,received,balance};
}
async function nextReceiptNumber(req,res,date){
  const d=String(date||'').trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(d)) return json(res,400,{error:'Invalid date.'});
  const row=await dbGet('SELECT COUNT(*) AS count FROM receipts WHERE receipt_date=?',[d]);
  return json(res,200,{receiptNumber:`AGP-${d.replace(/-/g,'')}-${String((row?.count||0)+1).padStart(3,'0')}`});
}
async function listReceipts(req,res){
  const rows=await dbAll('SELECT * FROM receipts ORDER BY saved_at DESC');
  json(res,200,rows.map(r=>({...r,data:JSON.parse(r.data_json),data_json:undefined})).map(({data_json,...r})=>r));
}
async function upsertReceipt(req,res){
  const body=await readBody(req); let payload; try{payload=JSON.parse(body);}catch{return json(res,400,{error:'Invalid JSON.'});}
  const d=payload.data||payload; let v; try{v=validateReceipt(d);}catch(e){return json(res,400,{error:e.message});}
  const id=String(payload.id||d.receiptNumber||`receipt_${Date.now()}`); const savedAt=new Date().toISOString();
  try {
    await dbRun(`INSERT INTO receipts (id,receipt_number,receipt_date,customer_name,customer_mobile,product_name,payment_mode,total,received,balance,saved_at,data_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET receipt_number=excluded.receipt_number,receipt_date=excluded.receipt_date,customer_name=excluded.customer_name,customer_mobile=excluded.customer_mobile,product_name=excluded.product_name,payment_mode=excluded.payment_mode,total=excluded.total,received=excluded.received,balance=excluded.balance,saved_at=excluded.saved_at,data_json=excluded.data_json`,
      [id,v.receiptNumber,v.receiptDate,d.customerName||'',d.customerMobile||'',d.productName||'',d.paymentMode||'',v.total,v.received,v.balance,savedAt,JSON.stringify(d)]);
    const row=await dbGet('SELECT * FROM receipts WHERE id=?',[id]);
    return json(res,200,{...row,data:JSON.parse(row.data_json),data_json:undefined});
  } catch(e){
    if(String(e.message).includes('UNIQUE')) return json(res,409,{error:'That receipt number already exists.'});
    return json(res,500,{error:e.message});
  }
}
async function deleteReceipt(req,res,id){const result=await dbRun('DELETE FROM receipts WHERE id=?',[id]);json(res,200,{deleted:result.changes>0});}
async function clearReceipts(req,res){await dbRun('DELETE FROM receipts');json(res,200,{ok:true});}

const server=http.createServer(async(req,res)=>{
  try{
    const base=`http://${req.headers.host||'localhost'}`; const parsed=new URL(req.url,base);
    if(req.method==='GET'&&parsed.pathname==='/api/health') return json(res,200,{ok:true,service:'aghanims-receipt-generator'});
    if(req.method==='GET'&&parsed.pathname==='/api/product') return await handleProductApi(req,res,parsed.searchParams.get('url')||'');
    if(req.method==='GET'&&parsed.pathname==='/api/receipts/next-number') return await nextReceiptNumber(req,res,parsed.searchParams.get('date')||'');
    if(req.method==='GET'&&parsed.pathname==='/api/receipts') return await listReceipts(req,res);
    if(req.method==='POST'&&parsed.pathname==='/api/receipts') return await upsertReceipt(req,res);
    if(req.method==='DELETE'&&parsed.pathname==='/api/receipts') return await clearReceipts(req,res);
    if(req.method==='DELETE'&&parsed.pathname.startsWith('/api/receipts/')) return await deleteReceipt(req,res,decodeURIComponent(parsed.pathname.split('/').pop()));
    let filePath=path.normalize(path.join(PUBLIC,parsed.pathname==='/'?'index.html':parsed.pathname));
    if(!filePath.startsWith(PUBLIC)) return send(res,403,'Forbidden');
    fs.readFile(filePath,(err,data)=>{if(err)return send(res,404,'Not found');res.writeHead(200,{'Content-Type':contentType(filePath),'Cache-Control':'no-cache'});res.end(data);});
  }catch(error){json(res,500,{error:error.message||'Server error.'});}
});
server.listen(PORT,()=>console.log(`Aghanims Receipt Generator running on http://localhost:${PORT}`));
process.on('SIGTERM',()=>{db.close();process.exit(0);});
process.on('SIGINT',()=>{db.close();process.exit(0);});
