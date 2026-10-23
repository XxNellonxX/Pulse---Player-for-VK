//! First-party, metadata-only personal collection bridge. The normal Yandex
//! login remains inside an isolated persistent WebView; no session credentials
//! are extracted. These windows have no Tauri IPC capabilities.
use serde_json::{json, Value};
use std::{collections::HashSet, sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex}, time::Duration};
use tauri::{AppHandle, Manager, WebviewWindow};
use url::Url;

const LABEL: &str = "yandex-collection-import";
const SCRIPT: &str = include_str!("yandex_import.js");
const MAX_PAYLOAD: usize = 12 * 1024 * 1024;
static GENERATION: AtomicU64 = AtomicU64::new(0);
static NAVIGATION: AtomicU64 = AtomicU64::new(0);
static OPERATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static SESSION: Mutex<Option<Session>> = Mutex::new(None);

#[derive(Clone)]
struct Session { uid: String, name: String, descriptors: HashSet<String> }
fn numeric(value: &str) -> bool { !value.is_empty() && value.len() <= 19 && value.bytes().all(|b| b.is_ascii_digit()) }
fn origin(url: &Url) -> bool {
    url.scheme() == "https" && url.username().is_empty() && url.password().is_none() && url.port_or_known_default() == Some(443)
        && matches!(url.host_str(), Some("music.yandex.ru"|"music.yandex.com"|"music.yandex.kz"|"music.yandex.by"|"music.yandex.uz"))
}
fn navigation_allowed(url: &Url) -> bool {
    if origin(url) { return true; }
    url.scheme() == "https" && url.username().is_empty() && url.password().is_none() && url.port_or_known_default() == Some(443)
        && matches!(url.host_str(), Some("yandex.ru"|"yandex.com"|"passport.yandex.ru"|"passport.yandex.com"|"passport.yandex.kz"|"passport.yandex.by"|"passport.yandex.uz"|"id.yandex.ru"|"id.yandex.com"|"auth.yandex.ru"|"auth.yandex.com"))
}
fn check(epoch: u64) -> Result<(), String> { if GENERATION.load(Ordering::SeqCst) == epoch { Ok(()) } else { Err("Импорт Яндекса отменён или аккаунт отключён.".into()) } }
fn session() -> Result<Session, String> { SESSION.lock().unwrap().clone().ok_or("Сначала подключите аккаунт Яндекс Музыки.".into()) }
pub fn status() -> Value {
    let saved = SESSION.lock().unwrap();
    json!({"configured":true,"connected":saved.is_some(),"userName":saved.as_ref().map(|s|s.name.clone()),"message":if saved.is_some(){"Аккаунт подтверждён в официальном окне. Импорт читает только метаданные любимых треков и плейлистов; полнота проверяется отдельно для каждого списка."}else{"Подключите Яндекс Музыку через обычный вход в официальном окне. Пароли и токены не передаются в Pulse. Если сервис изменил формат, доступен экспорт CSV/JSON."}})
}
pub fn cancel() { let _session=SESSION.lock().unwrap(); GENERATION.fetch_add(1, Ordering::SeqCst); }
pub async fn disconnect(app: AppHandle) -> Result<Value, String> {
    { let mut session=SESSION.lock().unwrap(); GENERATION.fetch_add(1,Ordering::SeqCst); *session=None; }
    if let Some(window) = app.get_webview_window(LABEL) { let _ = window.close(); }
    Ok(status())
}
fn profile(app: &AppHandle) -> std::path::PathBuf { crate::data_dir(app).join("yandex-collection-webview") }
#[cfg(target_os = "macos")]
fn profile_identifier(app: &AppHandle) -> [u8;16] {
    use sha2::{Digest, Sha256}; let hash = Sha256::digest(profile(app).to_string_lossy().as_bytes()); let mut id=[0;16]; id.copy_from_slice(&hash[..16]); id
}
fn open(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(LABEL) { let _=window.show(); let _=window.set_focus(); return Ok(window); }
    let popup_app = app.clone();
    let builder=tauri::WebviewWindowBuilder::new(app,LABEL,tauri::WebviewUrl::External("https://music.yandex.ru/collection".parse().unwrap()))
        .title("Яндекс Музыка · вход для импорта в Pulse").inner_size(1100.,780.).visible(true)
        .on_navigation(|url| { let allowed=navigation_allowed(url); if allowed { NAVIGATION.fetch_add(1,Ordering::SeqCst); } allowed })
        .on_new_window(move |url,_| { if navigation_allowed(&url) { if let Some(window)=popup_app.get_webview_window(LABEL) { let _=window.navigate(url); let _=window.show(); } } tauri::webview::NewWindowResponse::Deny });
    #[cfg(not(target_os="macos"))]
    let builder=builder.data_directory(profile(app));
    #[cfg(target_os="macos")]
    let builder=builder.data_store_identifier(profile_identifier(app));
    builder.build().map_err(|_|"Не удалось открыть официальное окно Яндекс Музыки.".into())
}
async fn evaluate(window: &WebviewWindow, script: String) -> Result<Value,String> {
    let (sender,receiver)=tokio::sync::oneshot::channel(); let sender=Arc::new(Mutex::new(Some(sender)));
    window.eval_with_callback(script,move|value|{if let Some(sender)=sender.lock().unwrap().take(){let _=sender.send(value);}}).map_err(|_|"Окно Яндекса закрыто.")?;
    let raw=tokio::time::timeout(Duration::from_secs(8),receiver).await.map_err(|_|"Окно Яндекса не ответило вовремя.")?.map_err(|_|"Окно Яндекса закрыто.")?;
    if raw.len()>MAX_PAYLOAD{return Err("Метаданные Яндекса превышают лимит 12 МБ. Импортируйте коллекцию частями.".into());}
    serde_json::from_str(&raw).map_err(|_|"Яндекс вернул некорректный ответ страницы.".into())
}
async fn run(app:&AppHandle,window:&WebviewWindow,input:Value,epoch:u64,seconds:u64)->Result<Value,String>{
    check(epoch)?; if !app.get_webview_window(LABEL).is_some_and(|w|w.url().ok().is_some_and(|u|origin(&u))){return Err("Завершите вход на официальной странице Яндекс Музыки.".into());}
    let nav=NAVIGATION.load(Ordering::SeqCst); let key=format!("ya-{}-{}",epoch,rand::random::<u64>()); let encoded=serde_json::to_string(&key).unwrap();
    let scope="if(window.top!==window.self||!['https://music.yandex.ru','https://music.yandex.com','https://music.yandex.kz','https://music.yandex.by','https://music.yandex.uz'].includes(location.origin))return {complete:true,error:'Страница Яндекса изменилась.'};";
    let start=evaluate(window,format!("(()=>{{{scope}{SCRIPT};return {{accepted:window.__PULSE_YANDEX_IMPORT__?.start({encoded},{input})===true}};}})()")).await?;
    if start["accepted"]!=true{return Err("Официальная страница Яндекса ещё не готова к импорту.".into());}
    let deadline=tokio::time::Instant::now()+Duration::from_secs(seconds);
    let result=loop{
        if let Err(error)=check(epoch){break Err(error);}
        if NAVIGATION.load(Ordering::SeqCst)!=nav{break Err("Страница или аккаунт Яндекса изменились. Повторите импорт.".into());}
        if !app.get_webview_window(LABEL).is_some_and(|w|w.url().ok().is_some_and(|u|origin(&u))){break Err("Окно Яндекса закрыто или перешло на другую страницу.".into());}
        let receipt=match evaluate(window,format!("(()=>{{{scope}return window.__PULSE_YANDEX_IMPORT__?.read({encoded})||{{complete:true,error:'Страница Яндекса изменилась.'}};}})()")).await{Ok(v)=>v,Err(e)=>break Err(e)};
        if receipt["complete"]==true{if let Some(error)=receipt["error"].as_str(){break Err(error.chars().take(500).collect());}break receipt.get("result").cloned().ok_or("Яндекс не вернул метаданные.".into());}
        if tokio::time::Instant::now()>=deadline{break Err("Яндекс не завершил чтение коллекции вовремя. Попробуйте отдельные плейлисты или экспорт CSV/JSON.".into());}
        tokio::time::sleep(Duration::from_millis(250)).await;
    };
    let _=window.eval(format!("window.__PULSE_YANDEX_IMPORT__?.cancel({encoded})")); check(epoch)?; result
}
pub async fn connect(app:AppHandle)->Result<Value,String>{
    let _lock=OPERATION.try_lock().map_err(|_|"Импорт Яндекса уже выполняется.")?;
    let epoch={let mut session=SESSION.lock().unwrap();let epoch=GENERATION.fetch_add(1,Ordering::SeqCst)+1;*session=None;epoch};
    let window=open(&app)?; let deadline=tokio::time::Instant::now()+Duration::from_secs(180); let mut last=String::new();
    while tokio::time::Instant::now()<deadline{
        check(epoch)?;if app.get_webview_window(LABEL).is_none(){return Err("Окно входа Яндекса закрыто.".into());}
        if window.url().ok().is_some_and(|url|origin(&url)){
            match run(&app,&window,json!({"action":"connect"}),epoch,25).await{
                Ok(value)=>{let uid=value["uid"].as_str().filter(|v|numeric(v)&&*v!="0"&&!v.starts_with('0')).ok_or("Яндекс не подтвердил аккаунт.")?.to_string(); let name=value["userName"].as_str().unwrap_or("Яндекс Музыка").chars().filter(|c|!c.is_control()).take(200).collect();{let mut saved=SESSION.lock().unwrap();check(epoch)?;*saved=Some(Session{uid,name,descriptors:HashSet::new()});}let _=window.hide();return Ok(status());},Err(error)=>last=error,
            }
        }
        tokio::time::sleep(Duration::from_millis(800)).await;
    }
    Err(if last.is_empty(){"Завершите вход в открытом окне Яндекс Музыки и нажмите подключение снова.".into()}else{last})
}
pub async fn list(app:AppHandle)->Result<Value,String>{
    let _lock=OPERATION.try_lock().map_err(|_|"Импорт Яндекса уже выполняется.")?;let current=session()?;let epoch=GENERATION.load(Ordering::SeqCst);let window=app.get_webview_window(LABEL).ok_or("Подключите Яндекс Музыку заново.")?;
    let mut result=normalize_numbers(run(&app,&window,json!({"action":"list","uid":current.uid}),epoch,180).await?);
    let rows=result.as_array_mut().filter(|r|r.len()<=40001).ok_or("Яндекс вернул неверный список плейлистов.")?;let mut keys=HashSet::new();
    for row in rows{let url=row["sourceUrl"].as_str().ok_or("Некорректная ссылка коллекции Яндекса.")?.to_string();let expected=expected_id(&url,&current.uid).ok_or("Некорректная ссылка коллекции Яндекса.")?;if row["service"]!="yandex"||row["sourceId"]!=expected||!valid_text(&row["title"],500,false)||!valid_total(&row["total"]){return Err("Яндекс вернул некорректные данные плейлиста.".into());}sanitize_artwork(row);keys.insert(url);}
    let mut saved=SESSION.lock().unwrap();check(epoch)?;if saved.as_ref().map_or(true,|s|s.uid!=current.uid){return Err("Аккаунт Яндекса изменился.".into());}saved.as_mut().unwrap().descriptors=keys;Ok(result)
}
fn valid_url(value:&str)->bool{
    if value=="pulse:yandex:liked"{return true;}let parts:Vec<_>=value.split(':').collect();parts.len()==5&&parts[..3]==["pulse","yandex","playlist"]&&numeric(parts[3])&&parts[3]!="0"&&!parts[3].starts_with('0')&&numeric(parts[4])&&!parts[4].starts_with('0')&&parts[4].parse::<u64>().is_ok_and(|v|v<=9_007_199_254_740_991)
}
pub async fn read(app:AppHandle,url:String)->Result<Value,String>{
    let _lock=OPERATION.try_lock().map_err(|_|"Импорт Яндекса уже выполняется.")?;let current=session()?;
    if !valid_url(&url)||!current.descriptors.contains(&url){return Err("Выберите плейлист из заново загруженной коллекции этого аккаунта Яндекса.".into());}
    let epoch=GENERATION.load(Ordering::SeqCst);let window=app.get_webview_window(LABEL).ok_or("Подключите Яндекс Музыку заново.")?;
    let result=run(&app,&window,json!({"action":"read","uid":current.uid,"url":url}),epoch,600).await?;
    if result["service"]!="yandex"||result["sourceUrl"]!=url||result["entries"].as_array().map_or(true,|rows|rows.len()>20000){return Err("Яндекс вернул некорректную коллекцию.".into());}
    let mut result=normalize_numbers(result);let expected=expected_id(&url,&current.uid).ok_or("Некорректный идентификатор коллекции Яндекса.")?;if result["sourceId"]!=expected{return Err("Яндекс вернул другой плейлист. Импорт отменён.".into());}validate_collection(&result)?;sanitize_artwork(&mut result);for row in result["entries"].as_array_mut().unwrap(){sanitize_artwork(row);}let saved=SESSION.lock().unwrap();check(epoch)?;if saved.as_ref().map_or(true,|s|s.uid!=current.uid){return Err("Аккаунт Яндекса изменился.".into());}Ok(result)
}
fn expected_id(value:&str,uid:&str)->Option<String>{if !valid_url(value){return None;}Some(if value=="pulse:yandex:liked"{format!("{uid}:3")}else{value.trim_start_matches("pulse:yandex:playlist:").to_string()})}
fn valid_total(value:&Value)->bool{value.is_null()||value.as_u64().is_some_and(|n|n<=1_000_000)}
fn valid_text(value:&Value,max:usize,empty:bool)->bool{value.as_str().is_some_and(|s|(empty||!s.trim().is_empty())&&s.chars().count()<=max&&!s.chars().any(char::is_control))}
fn sanitize_artwork(value:&mut Value){let valid=value["artwork"].as_str().is_some_and(|s|s.len()<=4096&&Url::parse(s).is_ok_and(|u|u.scheme()=="https"&&u.username().is_empty()&&u.password().is_none()&&u.port_or_known_default()==Some(443)&&u.host_str().is_some_and(|h|h=="yandex.net"||h.ends_with(".yandex.net")||h=="yandex.ru"||h.ends_with(".yandex.ru"))));if !valid{value["artwork"]=Value::Null;}}
fn validate_collection(value:&Value)->Result<(),String>{
    let rows=value["entries"].as_array().ok_or("В ответе Яндекса нет списка метаданных.")?;
    let complete=value["complete"].as_bool().ok_or("Яндекс не подтвердил состояние коллекции.")?;
    if !valid_total(&value["total"])||!valid_text(&value["title"],1000,false)||!valid_text(&value["description"],2000,true)||value["warnings"].as_array().map_or(true,|rows|rows.len()>30||rows.iter().any(|row|!valid_text(row,1000,false))){return Err("Яндекс вернул некорректное описание коллекции.".into());}let mut previous=None;
    for (index,row) in rows.iter().enumerate(){
        let position=row["position"].as_u64().filter(|v|*v<20000).ok_or("Некорректный порядок треков Яндекса.")?;
        if previous.is_some_and(|v|position<=v)||complete&&position!=index as u64{return Err("Яндекс вернул повторяющийся или неполный порядок треков.".into());}previous=Some(position);
        if row["sourceId"].as_str().map_or(true,|v|!numeric(v)||v=="0")||!valid_text(&row["title"],1000,false)||!valid_text(&row["album"],500,true)||row["artists"].as_array().map_or(true,|v|v.is_empty()||v.len()>30||v.iter().any(|s|!valid_text(s,200,false)))||row["duration"].as_f64().map_or(true,|v|!v.is_finite()||!(0.0..=864000.0).contains(&v))||row.get("explicit").is_some_and(|v|!v.is_boolean())||row.get("isrc").is_some_and(|v|!valid_text(v,30,false))||row.get("addedAt").is_some_and(|v|v.as_i64().map_or(true,|n|!(0..=crate::now()+60000).contains(&n))){return Err("Яндекс вернул некорректные метаданные трека.".into());}
    }
    if complete&&value["total"].as_u64()!=Some(rows.len()as u64){return Err("Полнота коллекции Яндекса не подтверждена её размером.".into());}Ok(())
}
fn normalize_numbers(mut value:Value)->Value{
    fn visit(value:&mut Value){match value{Value::Array(rows)=>for row in rows{visit(row)},Value::Object(fields)=>for(key,value)in fields{if matches!(key.as_str(),"total"|"position"|"addedAt")&&value.is_number(){if let Some(n)=value.as_f64().filter(|n|n.is_finite()&&n.fract()==0.&&n.abs()<=9_007_199_254_740_991.){*value=json!(n as i64);}}else{visit(value)}},_=>{}}}visit(&mut value);value
}

#[cfg(test)]mod tests{use super::*;
    #[test]fn restricts_first_party_navigation(){for value in["https://music.yandex.ru/collection","https://passport.yandex.ru/auth","https://id.yandex.com/"]{assert!(navigation_allowed(&Url::parse(value).unwrap()));}for value in["http://music.yandex.ru","https://music.yandex.ru.evil.test","https://user:secret@music.yandex.ru","https://music.yandex.ru:444/","https://evil.test"]{assert!(!navigation_allowed(&Url::parse(value).unwrap()));}}
    #[test]fn restricts_collection_receipts(){for value in["pulse:yandex:liked","pulse:yandex:playlist:123:3"]{assert!(valid_url(value));}for value in["https://music.yandex.ru/users/a/playlists/3","pulse:yandex:playlist:123:3:evil","pulse:yandex:playlist:a:3","pulse:yandex:playlist:123:-1"]{assert!(!valid_url(value));}}
    #[test]fn normalizes_only_integer_protocol_fields(){let value=normalize_numbers(json!({"total":2.0,"entries":[{"position":0.0,"duration":123.4,"addedAt":1700000000000.0}]}));assert_eq!(value["total"].as_u64(),Some(2));assert_eq!(value["entries"][0]["duration"].as_f64(),Some(123.4));}
    #[test]fn complete_requires_verified_total_and_positions(){let row=json!({"sourceId":"123","title":"Song","artists":["Artist"],"album":"","duration":10.0,"position":0});let mut value=json!({"complete":true,"title":"Library","description":"","warnings":[],"total":1,"entries":[row]});assert!(validate_collection(&value).is_ok());value["total"]=Value::Null;assert!(validate_collection(&value).is_err());value["total"]=json!(1);value["entries"][0]["position"]=json!(1);assert!(validate_collection(&value).is_err());value["complete"]=json!(false);assert!(validate_collection(&value).is_ok());}
    #[test]fn artwork_and_receipt_identity_are_restricted(){assert_eq!(expected_id("pulse:yandex:liked","123"),Some("123:3".into()));assert_eq!(expected_id("pulse:yandex:playlist:44:5","123"),Some("44:5".into()));let mut row=json!({"artwork":"https://avatars.yandex.net/a.jpg"});sanitize_artwork(&mut row);assert!(row["artwork"].is_string());row["artwork"]=json!("https://yandex.net.evil.test/a.jpg");sanitize_artwork(&mut row);assert!(row["artwork"].is_null());}
}
