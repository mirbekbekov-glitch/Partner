import { chromium } from 'playwright';
const b = await chromium.launch();
for (const [w,h,name] of [[1440,900,'cta-1440'],[390,844,'cta-390']]) {
  const p = await b.newPage({ viewport:{width:w,height:h}, deviceScaleFactor:2 });
  await p.goto('http://localhost:3000/ru', { waitUntil:'networkidle' });
  for (const a of await p.evaluate(()=>{document.getAnimations().forEach(a=>a.finish());return []}));
  await p.screenshot({ path:'/tmp/claude-0/-home-user-Partner/89b455a7-0661-5706-82aa-d7b90b6a693c/scratchpad/'+name+'.png' });
  await p.close();
}
await b.close();
