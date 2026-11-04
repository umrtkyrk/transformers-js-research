export function eligible(record, request) {
  if (!['alpha','beta'].includes(request.allowed_office)) return false;
  if (record.office !== request.allowed_office) return false;
  const f = request.filters ?? {};
  if (record.active !== (f.active ?? true)) return false;
  if (f.city && record.city.toLowerCase() !== f.city.toLowerCase()) return false;
  if (f.tenure && record.tenure !== f.tenure) return false;
  if (f.max_price_gbp != null && record.price_gbp > f.max_price_gbp) return false;
  if (f.min_bedrooms != null && record.bedrooms < f.min_bedrooms) return false;
  return true;
}
const STOP = new Set('a an the is are was were be being been for to of with and or in on at by from me my i we you our please find show get would like want wants looking need needs property properties home homes'.split(' '));
export function words(text) { return new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(word => !STOP.has(word))); }
export function lexicalScore(query, text) {
  const a=words(query),b=words(text);let matches=0;
  for(const word of a)if(b.has(word))matches++;
  return a.size ? matches/a.size : 0;
}
export function rank(listings, request, score) {
  return listings.filter(record=>eligible(record,request)).map(record=>({id:record.id,score:score(record)})).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
}
export function metrics(rows) {
  const answerable=rows.filter(row=>row.relevant_ids.length);
  const hit = k => answerable.reduce((sum,row)=>sum+Number(row.ranking.slice(0,k).some(item=>row.relevant_ids.includes(item.id))),0)/Math.max(1,answerable.length);
  const recall = k => answerable.reduce((sum,row)=>sum+row.ranking.slice(0,k).filter(item=>row.relevant_ids.includes(item.id)).length/row.relevant_ids.length,0)/Math.max(1,answerable.length);
  const mrr=answerable.reduce((sum,row)=>{const i=row.ranking.findIndex(item=>row.relevant_ids.includes(item.id));return sum+(i<0?0:1/(i+1));},0)/Math.max(1,answerable.length);
  return { queries:rows.length,answerable:answerable.length,noResult:rows.length-answerable.length,hitAt1:hit(1),hitAt3:hit(3),hitAt5:hit(5),recallAt3:recall(3),recallAt5:recall(5),mrr };
}
export function answerability(rows, threshold) {
  let tp=0,tn=0,fp=0,fn=0;
  for(const row of rows){const actual=row.relevant_ids.length>0,predicted=row.ranking.length>0&&row.ranking[0].score>=threshold;if(actual&&predicted)tp++;else if(actual)fn++;else if(predicted)fp++;else tn++;}
  const positiveRecall=tp/(tp+fn||1),negativeRecall=tn/(tn+fp||1);
  return {tp,tn,fp,fn,threshold,accuracy:(tp+tn)/(rows.length||1),positiveRecall,negativeRecall,balancedAccuracy:(positiveRecall+negativeRecall)/2,f1:2*tp/(2*tp+fp+fn||1)};
}
export function calibrate(rows) {
  return Array.from({length:19},(_,i)=>answerability(rows,i*.05)).sort((a,b)=>b.balancedAccuracy-a.balancedAccuracy||b.f1-a.f1||a.threshold-b.threshold)[0];
}
