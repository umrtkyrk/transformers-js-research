import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT,save } from './common.mjs';
import { eligible } from './crm-search.mjs';
const listings=JSON.parse(await readFile(path.join(ROOT,'data/listings.json'),'utf8'));
const queries=JSON.parse(await readFile(path.join(ROOT,'data/queries.json'),'utf8'));
const gold=JSON.parse(await readFile(path.join(ROOT,'data/structured-filter-gold.json'),'utf8'));
const rows=queries.map(query=>{
 const actual=listings.filter(row=>eligible(row,query)).map(row=>row.id).sort();
 const expected=gold.find(row=>row.query_id===query.id).eligible_ids.slice().sort();
 return {id:query.id,actual,expected,passed:JSON.stringify(actual)===JSON.stringify(expected)};
});
const result={cases:rows.length,passed:rows.filter(row=>row.passed).length,failed:rows.filter(row=>!row.passed).length,note:'Runtime filter predicate compared with separately authored candidate ID gold; this tests the fixture application, not model authorization or a production security boundary.',rows};
await save('filter-tests.json',result);
console.log(JSON.stringify({cases:result.cases,passed:result.passed,failed:result.failed}));
