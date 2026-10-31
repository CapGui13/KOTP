import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEmbedded, serializeEmbedded, applyGains, updateDocument } from '../scripts/update-pp.mjs';
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

test('le véritable HTML contient aussi les noms des délimiteurs dans son code',()=>{
 const nested=html()+'<script>const marker=\'/*__RANKING_STALKING_DATA_START__*/\';</script>';
 assert.equal(parseEmbedded(nested).data.count,2);
});