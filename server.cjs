// Локальный запуск: node server.cjs  (Node 18+, зависимостей нет)
const http=require('http'),fs=require('fs'),path=require('path'),app=require('./app.js');
const PORT=process.env.PORT||3000,PUB=path.join(__dirname,'public');
http.createServer((req,res)=>{
  if(req.url.startsWith('/img/'))req.url='/api'+req.url; // старые ссылки на фото
  if(req.url.startsWith('/api/'))return app(req,res);
  const u=decodeURIComponent(req.url.split('?')[0]),f=path.join(PUB,u==='/'?'index.html':u);
  if(!f.startsWith(PUB)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('404')}
  res.writeHead(200,{'Content-Type':f.endsWith('.html')?'text/html; charset=utf-8':'application/octet-stream'});fs.createReadStream(f).pipe(res);
}).listen(PORT,()=>console.log('Открой http://localhost:'+PORT+'  ('+(process.env.REPLICATE_API_TOKEN?'фото включены':'фото ВЫКЛЮЧЕНЫ: нет REPLICATE_API_TOKEN')+')'));
