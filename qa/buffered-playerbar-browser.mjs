import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const results=[];
try{
  for(const width of [960,1440]){
    const page=await browser.newPage({viewport:{width,height:800}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('http://127.0.0.1:5173/__playerqa',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><link rel="stylesheet" href="/src/styles.css"></head><body><div id="root"></div></body></html>'}));
    await page.goto('http://127.0.0.1:5173/__playerqa');
    await page.evaluate(async()=>{const runtime=(await import('/@react-refresh')).default;runtime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;});
    await page.evaluate(async()=>{
      const[react,reactDom,{PlayerBar},{applyTheme,THEME_PALETTES}]=await Promise.all([import('/node_modules/.vite/deps/react.js'),import('/node_modules/.vite/deps/react-dom_client.js'),import('/src/PlayerBar.tsx'),import('/src/themes.ts')]);
      const{createElement}=react.default||react,{createRoot}=reactDom.default||reactDom;
      const root=createRoot(document.getElementById('root'));window.__palettes=THEME_PALETTES;
      const noop=()=>{};window.__props={current:{id:'one',title:'Long track title for a careful layout check across themes',artist:'Artist with a longer name',album:'',source:'vk',duration:245,url:'vk-web://one',addedAt:1,available:true},playing:true,buffering:false,advertising:false,position:65,duration:245,buffered:[[0,95],[135,170]],bufferedAhead:30,network:'ready',volume:.4,queueCount:3147,canShuffle:true,shuffle:false,repeat:'off',onToggle:noop,onPrevious:noop,onNext:noop,onSeek:noop,onVolume:noop,onQueue:noop,onShuffle:noop,onRepeat:noop,onArtist:noop,onInfo:noop,error:'',onRetry:noop,onDismissError:()=>{window.__props.error='';window.__render();}};
      window.__render=()=>root.render(createElement(PlayerBar,window.__props));
      window.__theme=theme=>applyTheme({theme:theme.mode,palette:theme.id,accent:theme.accent,style:'minimal',density:'comfortable',textScale:1,reducedMotion:false});
      window.__theme(THEME_PALETTES[0]);window.__render();
    });
    await page.locator('.player-bar').waitFor();
    for(const palette of await page.evaluate(()=>window.__palettes)){
      await page.evaluate(theme=>window.__theme(theme),palette);
      for(const expanded of [false,true]){
        if(expanded)await page.getByRole('button',{name:'Открыть громкость',exact:true}).click();
        await page.waitForTimeout(230);
        const rectangles=await page.evaluate(()=>{
          const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width};};
          return{bodyWidth:document.body.scrollWidth,bar:rect('.player-bar'),now:rect('.now-playing'),controls:rect('.player-controls'),options:rect('.player-options'),input:rect('.seek-input'),rail:rect('.seek-rail'),bottom:innerHeight};
        });
        assert.ok(rectangles.bodyWidth<=width,`${width} ${palette.id} page overflow`);
        assert.ok(rectangles.now.right<=rectangles.controls.left+1,`${width} ${palette.id} title overlaps transport`);
        assert.ok(rectangles.controls.right<=rectangles.options.left+1,`${width} ${palette.id} transport overlaps options`);
        assert.ok(rectangles.bar.bottom<=rectangles.bottom+1);
        assert.equal(rectangles.input.width,rectangles.rail.width);
        assert.ok(rectangles.input.width>=190);
        if(expanded)await page.getByRole('button',{name:'Открыть громкость',exact:true}).click();
      }
    }
    await page.evaluate(()=>{window.__props.error='Загрузка трека прервалась. Проверьте соединение и нажмите «Повторить», чтобы продолжить с места остановки.';window.__render();});
    await page.getByRole('button',{name:'Закрыть ошибку воспроизведения'}).click();
    assert.equal(await page.getByRole('alert').count(),0);
    await mkdir(new URL('./artifacts/',import.meta.url),{recursive:true});
    await page.screenshot({path:fileURLToPath(new URL(`./artifacts/buffered-playerbar-${width}.png`,import.meta.url))});
    assert.deepEqual(errors,[]);results.push({width,themes:15,expandedVolume:true,errorDismiss:true,bufferIslands:2});await page.close();
  }
  await writeFile(new URL('./buffered-playerbar-browser-result.json',import.meta.url),JSON.stringify({checkedAt:new Date().toISOString(),results},null,2)+'\n');
  console.log('PASS full PlayerBar 15 themes at960/1440, expanded volume, buffer rail, error dismiss');
}finally{await browser.close();}
