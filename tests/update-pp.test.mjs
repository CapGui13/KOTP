import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import { parseEmbedded, serializeEmbedded, applyGains, updateDocument, makeFfbClient, renewedForSeason } from '../scripts/update-pp.mjs';
const data=()=>({mode:'provence',season:{id:38,label:'2026/2027'},count:2,generated_at:'2026-10-31T20:00:00Z',province:{},players:[
  {person_id:17, first_name:'Zoé',last_name:'Z',pp_base:125,pp_withdrawal:-15,pp_gained:5,pp_total:115,ic:89,rank:2},
  {person_id:18, first_name:'Anne',last_name:'A',pp_base:250,pp_withdrawal:-28,pp_gained:10,pp_total:232,ic:95,rank:1}
]});
const html=()=>`<!doctype html><script>\n/*__RANKING_STALKING_DATA_START__*/\nconst EMBEDDED_DATA=${JSON.stringify(data())};\n/*__RANKING_STALKING_DATA_END__*/\n</script>`;
test('lecture du snapshot du HTML',()=>{assert.equal(parseEmbedded(html()).data.count,2)});
test('calcul bilans, total et rangs sans altérer PP Base',()=>{
 const d=data();applyGains(d,new Map([[17,100],[18,2]]),'2026-11-01T22:59:00.000Z');
 assert.equal(d.players[0].pp_total,210);assert.equal(d.players[0].pp_season,85);assert.equal(d.players[0].rank,2);
 assert.equal(d.players[1].pp_base,250);assert.equal(d.players[1].pp_total,224);assert.equal(d.province.last_pp_update_at,'2026-11-01T22:59:00.000Z');
 assert.equal(d.players[0].pp_history[0].gained,100);
});
test('sérialisation et comptage sans duplication',()=>{const updated=serializeEmbedded(html(),data());assert.equal(parseEmbedded(updated).data.count,2);assert.equal(updated.split('const EMBEDDED_DATA=').length,2)});
test('une saison différente bloque la publication',async()=>{
 await assert.rejects(()=>updateDocument(html(),{api:{currentSeason:async()=>({id:39}),ranking:async()=>({iv:{ppSeason:99}})}}),/Saison FFB différente/);
});
test('une erreur sur un joueur bloque la publication',async()=>{
 await assert.rejects(()=>updateDocument(html(),{api:{currentSeason:async()=>({id:38}),ranking:async pid=> pid===17?{iv:{ppSeason:1}}:({iv:{}})}}),/invalides\/indisponibles/);
});
test('un classement FFB complet peut être publié',async()=>{
 const res=await updateDocument(html(),{api:{currentSeason:async()=>({id:38}),ranking:async pid=>({iv:{ppSeason:pid===17?200:1}})},now:'2026-11-01T22:59:00.000Z'});
 assert.equal(res.count,2);assert.equal(parseEmbedded(res.html).data.players[0].pp_total,310);
});

test('ajustement PP négatif FFB accepté si le total concorde',async()=>{
 const result=await updateDocument(html(),{api:{
   currentSeason:async()=>({id:38}),
   ranking:async pid=>pid===17?{iv:{ppSeason:-4,ppTotal:106}}:{iv:{ppSeason:1,ppTotal:223}}
 }});
 const joueur=parseEmbedded(result.html).data.players.find(p=>p.person_id===17);
 assert.equal(joueur.pp_gained,-4);
 assert.equal(joueur.pp_total,106);
 assert.equal(joueur.pp_season,-19);
});
test('ajustement PP négatif FFB rejeté si le total ne concorde pas',async()=>{
 await assert.rejects(()=>updateDocument(html(),{api:{
   currentSeason:async()=>({id:38}),
   ranking:async pid=>pid===17?{iv:{ppSeason:-4,ppTotal:999}}:{iv:{ppSeason:1,ppTotal:223}}
 }}),/non confirmés par le total FFB/);
});

test('le véritable HTML contient aussi les noms des délimiteurs dans son code',()=>{
 const nested=html()+'<script>const marker=\'/*__RANKING_STALKING_DATA_START__*/\';</script>';
 assert.equal(parseEmbedded(nested).data.count,2);
});
test('la connexion échoue sans clé Firebase injectée par le workflow',async()=>{
  await assert.rejects(()=>makeFfbClient({email:'test@example.fr',password:'simulation',firebaseApiKey:''}),/FFB_FIREBASE_API_KEY/);
});

test('la page publique reste en lecture seule, sans clé ni connexion',async()=>{
 const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
 const data=parseEmbedded(html).data;
 assert.equal(data.players.length,342);
 assert.equal(/AIza[0-9A-Za-z_-]{25,}/.test(html),false);
 assert.equal(html.includes('identitytoolkit.googleapis.com'),false);
 assert.equal(html.includes('loginModal'),false);
});

test('licence renouvelée en saison courante : le joueur redevient visible',async()=>{
 const h=html().replace('"pp_total":115','"pp_total":115,"license_status":"non_renewed"');
 const res=await updateDocument(h,{api:{
   currentSeason:async()=>({id:38}),
   ranking:async()=>({iv:{ppSeason:4}}),
   registration:async()=>[{seasonId:38,isLicensee:true}]
 }});
 const players=parseEmbedded(res.html).data.players;
 assert.equal(players[0].license_status,'active');
});
test('licence non renouvelée et statut FFB ambigu : rester masqué',async()=>{
 const h=html().replace('"pp_total":115','"pp_total":115,"license_status":"non_renewed"');
 const res=await updateDocument(h,{api:{
   currentSeason:async()=>({id:38}),
   ranking:async()=>({iv:{ppSeason:4}}),
   registration:async()=>[{seasonId:37,isLicensee:true},{seasonId:38,isLicensee:false}]
 }});
 assert.equal(parseEmbedded(res.html).data.players[0].license_status,'non_renewed');
 assert.equal(renewedForSeason([{seasonId:38}],38),false);
});
test('erreur de consultation de licence : statut masqué conservé',async()=>{
 const h=html().replace('"pp_total":115','"pp_total":115,"license_status":"non_renewed"');
 const res=await updateDocument(h,{api:{
   currentSeason:async()=>({id:38}),
   ranking:async()=>({iv:{ppSeason:4}}),
   registration:async()=>{throw new Error('FFB indisponible')}
 }});
 assert.equal(parseEmbedded(res.html).data.players[0].license_status,'non_renewed');
});

test('les licences non renouvelées ne prennent aucun rang et les rangs visibles se suivent',()=>{
 const d=data();
 d.players[1].license_status='non_renewed';
 applyGains(d,new Map([[17,1],[18,200]]),'2026-11-01T23:00:00.000Z');
 assert.equal(d.players[1].rank,null);
 assert.equal(d.players[0].rank,1);
 assert.equal(d.players.length,2);
});
test('un joueur redevenu actif retrouve un rang au prochain calcul',()=>{
 const d=data();
 d.players[1].license_status='non_renewed';
 applyGains(d,new Map([[17,1],[18,200]]));
 assert.equal(d.players[1].rank,null);
 d.players[1].license_status='active';
 applyGains(d,new Map([[17,1],[18,200]]));
 assert.equal(d.players[1].rank,1);
 assert.equal(d.players[0].rank,2);
});
